// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AxCore } from "../ax/core.js";
import { GB_10_4_14, parseSavePrompt, parseTrackHeader, type RootSpec } from "../ax/locators.js";
import type { Selector } from "../ax/selector.js";
import type { HelperPort } from "../native/helper-port.js";
import { callOp, AppStateResult, FindResult } from "../native/protocol.js";
import { readSmfSummary } from "../midi/smf-read.js";
import { resolveWorkspaceFile } from "../workspace/paths.js";
import type { Result } from "../result.js";
import { verified, uncertain, failed, type Envelope } from "../mcp/envelope.js";
import { mutationGate } from "./gate.js";
import { isScreenLocked } from "./screen.js";
import { classifyDialogs, waitUntilIdle } from "./dialogs.js";
import { regionName, pickFields } from "./session.js";
import { cleanText } from "../sound/text.js";

export type ProjectDoc = { name: string; modified: boolean };
/** GarageBand's AppleScript surface (Standard Suite only): list documents, save a copy. */
export type ProjectScripts = {
  listDocuments(): Promise<Result<ProjectDoc[], string>>;
  backupDocument(name: string, path: string): Promise<Result<void, string>>;
};

export const PROJECT_FIELDS = ["document", "dialogs", "tempo", "tracks"] as const;
export const GbProjectInput = z.discriminatedUnion("command", [
  z.object({ command: z.literal("status"), fields: z.array(z.enum(PROJECT_FIELDS)).min(1).optional().describe("only these fields (running always included)") }).strict(),
  z.object({ command: z.literal("open_midi"), path: z.string(), dry_run: z.boolean().optional().describe("read the file and plan only — opens and saves nothing") }).strict(),
]);
export const GB_PROJECT_COMMANDS = ["status", "open_midi"] as const;

export type GbProjectDeps = {
  workspaceDir: string;
  helper: HelperPort;
  core?: AxCore;
  scripts: ProjectScripts;
  /** `open -b com.apple.garageband10 <file>` in production. */
  openFile: (path: string) => Promise<unknown>;
  /** Defaults to reading the console session's lock flag. */
  screenLocked?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
};

const MAIN: RootSpec = { kind: "main_window" };
const DIALOG: RootSpec = { kind: "dialog" };
const REGIONS: Selector = { role: "AXLayoutItem", ancestors: [{ role: "AXGroup", description: "Tracks contents" }] };
const HEADERS: Selector = { role: "AXLayoutItem", ancestors: [{ role: "AXGroup", description: "Tracks header" }] };
const NOT_REGIONS = /^(cycle region|Note at )/;
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const safeName = (s: string) => s.replace(/[^A-Za-z0-9 _.-]/g, "_").slice(0, 60);
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const documentOf = (title: string | undefined) => (title ?? "").replace(/ - Tracks$/, "");
/** `<stem><ext>`, or `<stem>-2<ext>`, `-3`… — a backup never lands on an existing one (same-second backups). */
const uniquePath = (stem: string, ext: string) => {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${stem}${ext}` : `${stem}-${n}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
};

export function createGbProject(deps: GbProjectDeps) {
  const core = deps.core ?? new AxCore(deps.helper);
  const sleep = deps.sleep ?? realSleep;
  const pollMs = deps.pollMs ?? 500;
  const timeoutMs = deps.timeoutMs ?? 60_000;

  const appState = () => callOp(deps.helper, "app.state", {}, AppStateResult, { deadlineMs: 4_000 });
  const find = async (root: RootSpec, selector: Selector) => {
    const r = await callOp(deps.helper, "ax.find", { root, selector, max_results: 64 }, FindResult, { deadlineMs: 4_000 });
    return r.ok ? r.value.matches : [];
  };
  const mainTitle = (s: z.infer<typeof AppStateResult>) => s.windows?.find((w) => w.subrole === "AXStandardWindow")?.title;

  async function readProject() {
    const regions = (await find(MAIN, REGIONS)).map((n) => regionName(n.desc ?? "")).filter((d) => d && !NOT_REGIONS.test(d));
    const patches = (await find(MAIN, HEADERS)).map((n) => parseTrackHeader(n.desc ?? "")?.name).filter((p): p is string => !!p);
    const names = regions.map((r) => cleanText(r)); // UI text: normalised for the agent; raw names stay internal
    const tempo = await core.read("gb_project.read", GB_10_4_14.controls["lcd.tempo"]!);
    return {
      regions,
      tracks: names.map((name, i) => ({ name, patch: patches[i] === undefined ? null : cleanText(patches[i]!) })),
      tempo: tempo.status === "verified" ? ((tempo.data as { value: unknown }).value as number | null) : null,
    };
  }

  async function status(op: string, fields?: readonly string[]): Promise<Envelope> {
    const s = await appState();
    if (!s.ok) return failed(op, "HELPER_UNAVAILABLE", s.error.message, { hint: "run gb_system doctor" });
    if (!s.value.running) return verified(op, { running: false });
    const p = await readProject();
    const all = { running: true, document: documentOf(mainTitle(s.value)), dialogs: s.value.dialog_count ?? 0, tempo: p.tempo, tracks: p.tracks };
    return verified(op, pickFields(all, fields, ["running"]));
  }

  async function openMidi(op: string, input: string, dryRun = false): Promise<Envelope> {
    const file = resolveWorkspaceFile(deps.workspaceDir, input, [".mid"]);
    if (!file.ok) return failed(op, file.error.code, file.error.message, { hint: "render one first with gb_song render_midi" });
    const summary = readSmfSummary(readFileSync(file.value));
    if (!summary.ok) return failed(op, "INPUT_INVALID", `not a MIDI file: ${summary.error}`);
    const expected = summary.value.trackNames;

    if (await (deps.screenLocked ?? isScreenLocked)()) {
      return failed(op, "SCREEN_LOCKED", "the Mac's screen is locked: GarageBand has no usable windows", { hint: "unlock the Mac, then retry" });
    }
    const idle = await waitUntilIdle(deps.helper, sleep, Math.min(pollMs, 500), 20);
    if (idle.kind === "unknown") return failed(op, "HELPER_UNAVAILABLE", idle.message, { hint: "run gb_system doctor" });
    if (idle.kind === "save_prompt" || idle.kind === "other" || idle.kind === "busy") {
      return failed(op, "DIALOG_UNEXPECTED", idle.kind === "busy" ? "GarageBand is still busy (a progress window stays open)" : "a dialog is open in GarageBand; refusing to act (it may be yours)", {
        hint: "deal with the dialog first (gb_system ui_snapshot panel=dialog shows it)",
        ...(idle.kind !== "busy" ? { context: { dialog: idle.texts.map((t) => cleanText(t)) } } : {}),
      });
    }
    const before = await appState();
    if (!before.ok) return failed(op, "HELPER_UNAVAILABLE", before.error.message, { hint: "run gb_system doctor" });
    if (dryRun) {
      const docs = before.value.running ? await deps.scripts.listDocuments() : { ok: true as const, value: [] };
      if (!docs.ok) return failed(op, "PERMISSION_AUTOMATION_DENIED", "cannot list GarageBand documents (AppleScript)", { hint: "gb_system doctor shows the Automation permission", context: { reason: docs.error } });
      return verified(op, {
        dry_run: true, path: file.value, tracks: expected, tempo: summary.value.tempoBpm,
        would_back_up: docs.value.filter((d) => d.modified).map((d) => d.name),
        plan: ["copy each unsaved project into sessions/", "open the file in GarageBand", "dismiss the save prompt only for backed-up projects", "verify regions = the file's tracks and the tempo"],
      });
    }

    // Safety first: copy every unsaved project into the workspace before GarageBand can ask to discard it.
    const backups: string[] = [];
    const backedUp = new Set<string>();
    if (before.value.running) {
      const docs = await deps.scripts.listDocuments();
      if (!docs.ok) return failed(op, "PERMISSION_AUTOMATION_DENIED", "cannot list GarageBand documents (AppleScript)", { hint: "gb_system doctor shows the Automation permission", context: { reason: docs.error } });
      const dirty = docs.value.filter((x) => x.modified);
      // AppleScript addresses documents by name: two unsaved projects with one name cannot be backed up unambiguously.
      const names = dirty.map((d) => d.name);
      const dup = names.find((n, i) => names.indexOf(n) !== i);
      if (dup !== undefined) {
        return failed(op, "WRITE_FAILED", "two unsaved projects share a name, so they cannot be backed up unambiguously; nothing opened", {
          hint: "save (or close) one of them in GarageBand yourself, then retry", context: { document: dup },
        });
      }
      for (const d of dirty) {
        const path = uniquePath(join(deps.workspaceDir, "sessions", `${safeName(d.name)}-${stamp()}`), ".band");
        const saved = await deps.scripts.backupDocument(d.name, path);
        if (!saved.ok || !existsSync(join(path, "projectData"))) {
          return failed(op, "WRITE_FAILED", "could not back up an unsaved project; nothing opened", {
            hint: "save it in GarageBand yourself, then retry", context: { document: d.name, reason: saved.ok ? "no projectData after save" : saved.error },
          });
        }
        backups.push(path);
        backedUp.add(d.name);
      }
    }

    await deps.openFile(file.value);
    let titleWaits = 0; // the regions can be ready a moment before GarageBand titles the window
    for (let i = 0; i < Math.max(1, Math.ceil(timeoutMs / pollMs)); i++) {
      const d = await classifyDialogs(deps.helper);
      if (d.kind === "save_prompt") {
        if (!backedUp.has(d.document)) {
          // UI text (the document name) stays in context, never in message/hint.
          return failed(op, "DIALOG_UNEXPECTED", "GarageBand asks about saving a project gb-mcp did not back up; nothing pressed", {
            write_attempted: true, safe_to_retry: false, hint: "answer the dialog in GarageBand yourself", context: { document: d.document, dialog: d.texts.map((t) => cleanText(t)) },
          });
        }
        const dismissed = await core.press(op, { root: DIALOG, selector: { role: "AXButton", title: "Don’t Save" }, kind: "button" });
        if (dismissed.status === "failed") return dismissed;
      } else if (d.kind === "other") {
        return failed(op, "DIALOG_UNEXPECTED", "an unexpected dialog appeared; nothing pressed", {
          write_attempted: true, safe_to_retry: false, hint: "answer the dialog in GarageBand yourself", context: { dialog: d.texts.map((t) => cleanText(t)), buttons: d.buttons },
        });
      } else if (d.kind === "none") {
        const s = await appState();
        const regions = (await find(MAIN, REGIONS)).map((n) => n.desc ?? "").filter((x) => x && !NOT_REGIONS.test(x));
        if (s.ok && regions.length === expected.length && regions.every((r, k) => r === expected[k])) {
          if (documentOf(mainTitle(s.value)) === "" && titleWaits++ < 5) { await sleep(pollMs); continue; }
          const p = await readProject();
          const data = { document: documentOf(mainTitle(s.value)) || null, path: file.value, tempo: p.tempo, tracks: p.tracks, backups };
          if (summary.value.tempoBpm !== null && p.tempo !== Math.round(summary.value.tempoBpm)) {
            return uncertain(op, "readback_timeout", { write_attempted: true, safe_to_retry: false, hint: `tempo reads ${p.tempo}, the file says ${summary.value.tempoBpm}`, data });
          }
          return verified(op, data);
        }
      } // "busy" (loading window) / "not_running" (still launching): keep waiting
      await sleep(pollMs);
    }
    return uncertain(op, "readback_timeout", {
      write_attempted: true, safe_to_retry: false,
      hint: "GarageBand was asked to open the file, but its tracks never matched the MIDI file; check gb_project status before retrying",
      data: { expected, backups },
    });
  }

  return async function gbProject(input: unknown): Promise<Envelope> {
    const parsed = GbProjectInput.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return failed("gb_project", "INPUT_INVALID", `${issue.path.join(".") || "command"}: ${issue.message}`, { hint: `commands: ${GB_PROJECT_COMMANDS.join(", ")}` });
    }
    const op = `gb_project.${parsed.data.command}`;
    if (parsed.data.command === "status") return status(op, parsed.data.fields);
    const { path, dry_run } = parsed.data;
    if (dry_run === true) return openMidi(op, path, true);
    return mutationGate.run(op, () => openMidi(op, path));
  };
}
