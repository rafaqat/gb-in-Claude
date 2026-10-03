// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { z } from "zod";
import { existsSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { AxCore, type Target } from "../ax/core.js";
import type { RootSpec } from "../ax/locators.js";
import type { HelperPort } from "../native/helper-port.js";
import { verified, uncertain, failed, type Envelope } from "../mcp/envelope.js";
import { readWavInfo } from "./wav.js";
import { callOp, FindResult } from "../native/protocol.js";
import { mutationGate } from "./gate.js";
import { isScreenLocked } from "./screen.js";
import { waitUntilIdle } from "./dialogs.js";
import { cleanText } from "../sound/text.js";

/** The save panel's file browser (≈17k rows in Downloads) is never walked: every lookup prunes it. */
const PRUNE = ["AXOutline", "AXBrowser", "AXTable"];
const PANEL: RootSpec = { kind: "dialog", identifier: "save-panel" };
const APP: RootSpec = { kind: "app" };
const inPanel = (selector: Target["selector"], kind: Target["kind"]): Target => ({ root: PANEL, selector, kind, prune_roles: PRUNE });

const SafeWavName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}\.wav$/, "letters, digits, space, _ or -, ending in .wav (no paths)");
export const GbExportInput = z.discriminatedUnion("command", [
  z.object({ command: z.literal("song"), filename: z.string(), format: z.enum(["WAVE"]).default("WAVE"), dry_run: z.boolean().optional().describe("check name, target and GarageBand's state only — no panel, no file") }).strict(),
]);
export const GB_EXPORT_COMMANDS = ["song"] as const;

export type GbExportDeps = {
  workspaceDir: string;
  /** Folder inside the workspace that GarageBand's save panel lists as a recent place (the export inbox). */
  inboxDir: string;
  helper: HelperPort;
  core?: AxCore;
  /** Defaults to reading the console session's lock flag. */
  screenLocked?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
  stableReads?: number;
  /** Pause after choosing the destination: the panel updates the popup label before it changes folder (live finding). */
  placeSettleMs?: number;
  /** How long to wait for the Export button to become enabled (the remote save panel loads asynchronously). */
  enableTimeoutMs?: number;
  /** Pause before one new panel when the first did not list the inbox (live: right after a project opened). */
  placesRetryMs?: number;
  /** GarageBand's default export folder (~/Music/GarageBand): a file that still lands there is moved into the inbox. */
  defaultExportDir?: string;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createGbExport(deps: GbExportDeps) {
  const core = deps.core ?? new AxCore(deps.helper);
  const sleep = deps.sleep ?? realSleep;
  const pollMs = deps.pollMs ?? 1_000;
  const timeoutMs = deps.timeoutMs ?? 300_000;
  const stableReads = deps.stableReads ?? 2;
  const placeSettleMs = deps.placeSettleMs ?? 1_500;
  const enableTimeoutMs = deps.enableTimeoutMs ?? 20_000;
  const placesRetryMs = deps.placesRetryMs ?? 3_000;
  /** The "inbox not among the places" failures, after their panel was cancelled cleanly: the one case worth a new panel. */
  const placesMissing = new WeakSet<Envelope>();

  /**
   * Poll the Export button until it reports enabled (live: it stays disabled while the panel loads). Its own fixed
   * interval: deriving the attempt count from the file-poll interval made 20,000 lookups when that was 1 ms.
   */
  async function waitEnabled(): Promise<boolean> {
    const every = 250;
    const attempts = Math.max(2, Math.ceil(enableTimeoutMs / every));
    for (let i = 0; i < attempts; i++) {
      const r = await callOp(deps.helper, "ax.find", { root: PANEL, selector: { role: "AXButton", identifier: "OKButton" }, max_results: 2, prune_roles: PRUNE }, FindResult, { deadlineMs: 4_000 });
      if (r.ok && r.value.count === 1 && r.value.matches[0]!.enabled !== false) return true;
      await sleep(every);
    }
    return false;
  }
  const inboxName = basename(deps.inboxDir);

  async function cancelIfOpen(op: string): Promise<void> {
    const open = await core.wait({ root: APP, selector: { role: "AXWindow", identifier: "save-panel" }, condition: "present", timeoutMs: 300 });
    if (open.ok && open.value.satisfied) await core.press(op, inPanel({ role: "AXButton", identifier: "CancelButton" }, "button"));
  }

  /** A path whose size is unchanged for `stableReads` polls and whose WAV header is finalized. */
  function finished(path: string, sizes: Map<string, { last: number; stable: number }>) {
    const size = existsSync(path) ? statSync(path).size : -1;
    const prev = sizes.get(path) ?? { last: -1, stable: 0 };
    const stable = size > 0 && size === prev.last ? prev.stable + 1 : 0;
    sizes.set(path, { last: size, stable });
    if (size <= 0 || stable < stableReads - 1) return undefined;
    const info = readWavInfo(path);
    return info.ok ? info.value : undefined;
  }

  /** Wait for the export in the inbox — or, if GarageBand put it in its default folder anyway, move it in. */
  async function waitForFinishedFile(target: string, stray: string | undefined) {
    const sizes = new Map<string, { last: number; stable: number }>();
    for (let i = 0; i < Math.max(1, Math.ceil(timeoutMs / pollMs)); i++) {
      const info = finished(target, sizes);
      if (info) return { info };
      if (stray) {
        const strayInfo = finished(stray, sizes);
        if (strayInfo && !existsSync(target)) {
          try {
            renameSync(stray, target);
            return { info: strayInfo, relocatedFrom: stray };
          } catch {
            return { info: strayInfo, strandedAt: stray };
          }
        }
      }
      await sleep(pollMs);
    }
    return undefined;
  }

  async function exportSong(op: string, filename: string, format: string, dryRun = false): Promise<Envelope> {
    const name = SafeWavName.safeParse(filename);
    if (!name.success) return failed(op, "PATH_INVALID", `filename: ${name.error.issues[0]!.message}`);
    const target = join(deps.inboxDir, name.data);
    if (existsSync(target)) {
      return failed(op, "FILE_EXISTS", `${name.data} already exists in ${inboxName}/; nothing exported`, { hint: "choose a new filename (e.g. add -v2); exports never overwrite" });
    }
    if (await (deps.screenLocked ?? isScreenLocked)()) {
      return failed(op, "SCREEN_LOCKED", "the Mac's screen is locked: GarageBand has no usable windows", { hint: "unlock the Mac, then retry" });
    }
    const idle = await waitUntilIdle(deps.helper, sleep, Math.min(pollMs, 500), 20);
    if (idle.kind === "unknown") return failed(op, "HELPER_UNAVAILABLE", idle.message, { hint: "run gb_system doctor" });
    if (idle.kind === "not_running") return failed(op, "GB_NOT_RUNNING", "GarageBand is not running", { hint: "open the song first with gb_project open_midi" });
    if (idle.kind !== "none") {
      return failed(op, "DIALOG_UNEXPECTED", idle.kind === "busy" ? "GarageBand is still busy (a progress window stays open)" : "a dialog is open in GarageBand; refusing to act (it may be yours)", {
        hint: "deal with the dialog first (gb_system ui_snapshot panel=dialog shows it)",
        ...(idle.kind === "save_prompt" || idle.kind === "other" ? { context: { dialog: idle.texts.map((t) => cleanText(t)) } } : {}),
      });
    }

    if (dryRun) {
      return verified(op, {
        dry_run: true, path: target, format, destination: inboxName,
        plan: ["Share ▸ Export Song to Disk…", `choose ${format}, name, and ${inboxName} (read back)`, "press Export when enabled", "wait for a finished WAV"],
      });
    }
    const first = await viaPanel(op, name.data, target, format);
    if (!placesMissing.has(first)) return first;
    // the first panel right after a project opened lacked the inbox; a new panel listed it.
    await sleep(placesRetryMs);
    const second = await viaPanel(op, name.data, target, format);
    if (second.status !== "verified") return second;
    return { ...second, warnings: [...(second.warnings ?? []), "the first save panel did not list the inbox; a new panel did (retried once)"] };
  }

  /** Share ▸ Export Song to Disk… → format, name, the inbox → Export → a finished WAV. The panel is cancelled on failure. */
  async function viaPanel(op: string, filename: string, target: string, format: string): Promise<Envelope> {
    const opened = await core.menu(op, ["Share", "Export Song to Disk…"], {
      postCondition: { root: PANEL, selector: { role: "AXButton", identifier: "OKButton" }, condition: "present", timeoutMs: 10_000 },
    });
    if (opened.status !== "verified") {
      await cancelIfOpen(op);
      return opened;
    }
    // A same-named file already in GarageBand's default folder is not ours: never move it (decided before anything runs).
    const stray = deps.defaultExportDir && !existsSync(join(deps.defaultExportDir, filename)) ? join(deps.defaultExportDir, filename) : undefined;
    // From here on the panel is ours: a failure cancels it before returning — unless it is already gone. Then gb-mcp
    // did not close it and GarageBand may be exporting (found live: 19:16: the panel closed by itself and the file
    // was written while gb-mcp reported "nothing exported"), so the evidence decides, never the failed step.
    const abort = async (e: Envelope): Promise<Envelope> => {
      const w = await core.wait({ root: APP, selector: { role: "AXWindow", identifier: "save-panel" }, condition: "present", timeoutMs: 300 });
      if (w.ok && w.value.satisfied) {
        await core.press(op, inPanel({ role: "AXButton", identifier: "CancelButton" }, "button"));
        return e;
      }
      const done = await waitForFinishedFile(target, stray);
      if (done?.info) {
        return verified(op, {
          path: done.relocatedFrom ? target : (done.strandedAt ?? target), ...done.info, format, destination: inboxName,
          panel_closed_unexpectedly: true, ...(done.relocatedFrom ? { relocated_from: done.relocatedFrom } : {}),
        });
      }
      return uncertain(op, "readback_timeout", {
        write_attempted: true, safe_to_retry: false, data: { path: target },
        hint: `the export panel closed without gb-mcp closing it and no finished file appeared in ${inboxName}/; check GarageBand and the folder before exporting again`,
      });
    };

    const radio = await core.press(op, inPanel({ role: "AXRadioButton", title: format }, "radio"));
    if (radio.status !== "verified") return abort(radio);
    const stem = filename.replace(/\.wav$/, "");
    const named = await core.set(op, inPanel({ role: "AXTextField", identifier: "saveAsNameTextField" }, "text"), stem);
    if (named.status !== "verified") return abort(named);

    const where = inPanel({ role: "AXPopUpButton", identifier: "where popup" }, "popup");
    const current = await core.read(op, where);
    if (current.status === "verified" && (current.data as { value: unknown }).value !== inboxName) {
      const listed = await core.press(op, where, {
        postCondition: { root: PANEL, selector: { role: "AXMenuItem", title: inboxName }, condition: "present", timeoutMs: 5_000 },
      });
      if (listed.status !== "verified") {
        const missing = failed(op, "TARGET_NOT_FOUND", `“${inboxName}” is not among the save panel's places`, {
          hint: `the export inbox must be a recent place: export to ${deps.inboxDir} once by hand (Where ▸ …), or point GB_MCP_EXPORT_INBOX at a folder that is`,
        });
        placesMissing.add(missing);
        return abort(missing);
      }
      const picked = await core.press(op, inPanel({ role: "AXMenuItem", title: inboxName }, "button"));
      if (picked.status === "failed") return abort(picked);
      await sleep(placeSettleMs); // the label changes at once; the panel's folder follows a moment later
    }
    const destination = await core.read(op, where);
    const dest = destination.status === "verified" ? (destination.data as { value: unknown }).value : null;
    if (dest !== inboxName) {
      return abort(failed(op, "READBACK_MISMATCH", "the save panel's destination is not the export inbox; nothing exported", { write_attempted: false, context: { destination: dest, expected: inboxName } }));
    }

    if (!(await waitEnabled())) {
      return abort(failed(op, "TARGET_DISABLED", "the Export button never became enabled; nothing exported", {
        hint: "the save panel may still be loading or be waiting for input — check GarageBand, then retry",
      }));
    }
    const panelGone = { root: APP, selector: { role: "AXWindow", identifier: "save-panel" }, condition: "absent" as const, timeoutMs: 15_000 };
    const pressed = await core.press(op, inPanel({ role: "AXButton", identifier: "OKButton" }, "button"), { postCondition: panelGone });
    // GarageBand can tear the panel down while AX is still handling the press, so the press reports
    // an AX error (-25205) although the export runs. An AX error here means "outcome unknown": the evidence decides.
    let pressError: number | undefined;
    if (pressed.status === "failed") {
      const axError = (pressed.context as { ax_error?: unknown } | undefined)?.ax_error;
      if (!pressed.write_attempted || typeof axError !== "number") return abort(pressed);
      const gone = await core.wait(panelGone);
      if (!gone.ok) {
        return uncertain(op, "readback_unavailable", {
          write_attempted: true, safe_to_retry: false, data: { path: target },
          hint: `the Export press reported an error and the panel state could not be read; check ${inboxName}/ and gb_project status before exporting again`,
        });
      }
      if (!gone.value.satisfied) {
        await cancelIfOpen(op);
        return failed(op, pressed.error, `${pressed.message}; the panel stayed open, so nothing was exported (cancelled)`, { safe_to_retry: true, context: { ax_error: axError } });
      }
      pressError = axError;
    }

    const done = await waitForFinishedFile(target, stray);
    if (done?.strandedAt) {
      return uncertain(op, "readback_timeout", {
        write_attempted: true, safe_to_retry: false,
        hint: `GarageBand exported to ${done.strandedAt} instead of the inbox and it could not be moved; analyze it there or move it into ${inboxName}/`,
        data: { path: done.strandedAt },
      });
    }
    if (!done) {
      return uncertain(op, "readback_timeout", {
        write_attempted: true, safe_to_retry: false,
        hint: `Export was pressed but ${filename} did not appear finished in ${inboxName}/ in time; check the folder before exporting again (a retry with the same name will refuse)`,
        data: { path: target },
      });
    }
    return verified(op, {
      path: target, ...done.info, format, destination: inboxName,
      ...(done.relocatedFrom ? { relocated_from: done.relocatedFrom } : {}),
      ...(pressError !== undefined ? { press_error: pressError } : {}),
    });
  }

  return async function gbExport(input: unknown): Promise<Envelope> {
    const parsed = GbExportInput.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return failed("gb_export", "INPUT_INVALID", `${issue.path.join(".") || "command"}: ${issue.message}`, { hint: `commands: ${GB_EXPORT_COMMANDS.join(", ")}` });
    }
    const op = `gb_export.${parsed.data.command}`;
    const { filename, format, dry_run } = parsed.data;
    if (dry_run === true) return exportSong(op, filename, format, true);
    return mutationGate.run(op, () => exportSong(op, filename, format));
  };
}
