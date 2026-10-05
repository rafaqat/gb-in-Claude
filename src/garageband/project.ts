// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { z } from "zod";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { AxCore } from "../ax/core.js";
import { GB_10_4_14, parseSavePrompt, type RootSpec } from "../ax/locators.js";
import type { Selector } from "../ax/selector.js";
import type { HelperPort } from "../native/helper-port.js";
import { callOp, AppStateResult, FindResult } from "../native/protocol.js";
import { readSmfSummary } from "../midi/smf-read.js";
import { resolveWorkspaceBand, resolveWorkspaceFile, workspaceOutputDir } from "../workspace/paths.js";
import { ok, err, type Result } from "../result.js";
import { verified, uncertain, failed, type Envelope, type ErrorCode, type Failed } from "../mcp/envelope.js";

/**
 * The closed error code for a refused `open -b com.apple.garageband10 <file>`. `reason` is the OS's
 * stderr, e.g. "Unable to find application named 'com.apple.garageband10'" or "The file … does not exist."
 * The code is what the agent acts on: each one should point to a different fix.
 */
/**
 * MIDI stores tempo as whole microseconds per beat, so most tempos are not exact: 174 BPM is 344,828 µs, which
 * GarageBand shows as 173.9998. That rounding is at most bpm² / 60,000,000 (0.0015 BPM at 300), so 0.01 BPM separates
 * it from a real difference.
 */
export function sameTempo(read: number | null, file: number): boolean {
  return read !== null && Math.abs(read - file) < 0.01;
}

export function openFailureCode(reason: string): ErrorCode {
  // Only the two texts `open` prints in English on macOS 26; anything else (another language, a new macOS text) keeps
  // the general code: a wrong specific code would send the agent to the wrong fix.
  if (/LSCopyApplicationURLsForBundleIdentifier\(\) failed|Unable to find application named /.test(reason)) return "DEPENDENCY_MISSING";
  if (/^The file .* does not exist\.$/m.test(reason)) return "FILE_NOT_FOUND";
  return "INTERNAL_ERROR";
}
import { bandDifferences, inspectBand } from "../band/inspect.js";
import { parseProjectData } from "../band/projectdata.js";
import { visibleTracks } from "../band/tracks.js";
import { mutationGate } from "./gate.js";
import { isScreenLocked } from "./screen.js";
import { classifyDialogs, waitUntilIdle } from "./dialogs.js";
import { pickFields, readTracks } from "./session.js";
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
  z.object({ command: z.literal("open_band"), path: z.string(), dry_run: z.boolean().optional().describe("read the project and plan only — opens and saves nothing") }).strict(),
  z.object({
    command: z.literal("save_copy"),
    filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}\.band$/, "a .band name such as my-song-donor.band (no folders)"),
    dry_run: z.boolean().optional().describe("plan only — saves nothing"),
  }).strict(),
]);
export const GB_PROJECT_COMMANDS = ["status", "open_midi", "open_band", "save_copy"] as const;
const DONORS = "donors";
/** Anything at a name — file, folder, link (dangling or not) — counts: a copy is never written through it. */
const occupied = (path: string) => { try { lstatSync(path); return true; } catch { return false; } };

export type GbProjectDeps = {
  workspaceDir: string;
  helper: HelperPort;
  core?: AxCore;
  scripts: ProjectScripts;
  /** `open -b com.apple.garageband10 <file>` in production. */
  /** Asks macOS to open the file in GarageBand; an error is the OS's reason (text with paths: context only). */
  openFile: (path: string) => Promise<Result<void, string>>;
  /** Defaults to reading the console session's lock flag. */
  screenLocked?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
  /** extra wait for a late save prompt of a project backed up in the same call (default 60 s) */
  promptGraceMs?: number;
};

const MAIN: RootSpec = { kind: "main_window" };
const DIALOG: RootSpec = { kind: "dialog" };
const REGIONS: Selector = { role: "AXLayoutItem", ancestors: [{ role: "AXGroup", description: "Tracks contents" }] };
const NOT_REGIONS = /^(cycle region|Note at )/;
/** How long open_* waits for the window to show the tempo and the tracks after it is titled, and how often it reads. */
const SETTLE_MS = 5_000;
const SETTLE_POLL_MS = 250;
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
  const promptGraceMs = deps.promptGraceMs ?? 60_000;

  const appState = () => callOp(deps.helper, "app.state", {}, AppStateResult, { deadlineMs: 4_000 });
  const find = async (root: RootSpec, selector: Selector) => {
    const r = await callOp(deps.helper, "ax.find", { root, selector, max_results: 64 }, FindResult, { deadlineMs: 4_000 });
    return r.ok ? r.value.matches : [];
  };
  const mainTitle = (s: z.infer<typeof AppStateResult>) => s.windows?.find((w) => w.subrole === "AXStandardWindow")?.title;

  /** Tracks by header, each with the first region in its own lane (a track may have none: M11b's empty audio track). */
  async function readProject() {
    const read = await readTracks("gb_project.read", deps.helper);
    const tempo = await core.read("gb_project.read", GB_10_4_14.controls["lcd.tempo"]!);
    return {
      tracks: read.ok ? read.value.map((t) => ({ number: t.number, name: t.region, patch: t.patch })) : [],
      tempo: tempo.status === "verified" ? ((tempo.data as { value: unknown }).value as number | null) : null,
    };
  }

  /**
   * right after an open, the window can carry its title while the tempo and the track headers still
   * read empty. Read until both show — on its own interval, not pollMs — for at most SETTLE_MS.
   */
  async function readProjectSettled() {
    let p = await readProject();
    for (let waited = 0; (p.tempo === null || p.tracks.length === 0) && waited < SETTLE_MS; waited += SETTLE_POLL_MS) {
      await sleep(SETTLE_POLL_MS);
      p = await readProject();
    }
    return p;
  }

  async function status(op: string, fields?: readonly string[]): Promise<Envelope> {
    const s = await appState();
    if (!s.ok) return failed(op, "HELPER_UNAVAILABLE", s.error.message, { hint: "run gb_system doctor" });
    if (!s.value.running) return verified(op, { running: false });
    const p = await readProject();
    const all = { running: true, document: documentOf(mainTitle(s.value)), dialogs: s.value.dialog_count ?? 0, tempo: p.tempo, tracks: p.tracks };
    return verified(op, pickFields(all, fields, ["running"]));
  }

  const listFailed = (op: string, reason: string) => failed(op, "PERMISSION_AUTOMATION_DENIED", "cannot list GarageBand documents (AppleScript)", {
    hint: "gb_system doctor shows the Automation permission", context: { reason },
  });

  /** Before opening anything: the screen is usable and GarageBand is idle with no dialog. The app state on success. */
  async function preflight(op: string): Promise<Result<z.infer<typeof AppStateResult>, Failed>> {
    if (await (deps.screenLocked ?? isScreenLocked)()) {
      return err(failed(op, "SCREEN_LOCKED", "the Mac's screen is locked: GarageBand has no usable windows", { hint: "unlock the Mac, then retry" }));
    }
    const idle = await waitUntilIdle(deps.helper, sleep, Math.min(pollMs, 500), 20);
    if (idle.kind === "unknown") return err(failed(op, "HELPER_UNAVAILABLE", idle.message, { hint: "run gb_system doctor" }));
    if (idle.kind === "save_prompt" || idle.kind === "other" || idle.kind === "busy") {
      return err(failed(op, "DIALOG_UNEXPECTED", idle.kind === "busy" ? "GarageBand is still busy (a progress window stays open)" : "a dialog is open in GarageBand; refusing to act (it may be yours)", {
        hint: "deal with the dialog first (gb_system ui_snapshot panel=dialog shows it)",
        ...(idle.kind !== "busy" ? { context: { dialog: idle.texts.map((t) => cleanText(t)) } } : {}),
      }));
    }
    const before = await appState();
    if (!before.ok) return err(failed(op, "HELPER_UNAVAILABLE", before.error.message, { hint: "run gb_system doctor" }));
    return ok(before.value);
  }

  /** The open documents (none while GarageBand is not running). */
  async function documents(op: string, running: boolean): Promise<Result<ProjectDoc[], Failed>> {
    if (!running) return ok([]);
    const docs = await deps.scripts.listDocuments();
    return docs.ok ? docs : err(listFailed(op, docs.error));
  }

  /** Safety first: copy every unsaved project into the workspace before GarageBand can ask to discard it. */
  async function backUpUnsaved(op: string, docs: ProjectDoc[]): Promise<Result<{ backups: string[]; backedUp: Set<string> }, Failed>> {
    const backups: string[] = [];
    const backedUp = new Set<string>();
    const dirty = docs.filter((x) => x.modified);
    // AppleScript addresses documents by name: two unsaved projects with one name cannot be backed up unambiguously.
    const names = dirty.map((d) => d.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup !== undefined) {
      return err(failed(op, "WRITE_FAILED", "two unsaved projects share a name, so they cannot be backed up unambiguously; nothing opened", {
        hint: "save (or close) one of them in GarageBand yourself, then retry", context: { document: dup },
      }));
    }
    // the backup folder must still be inside the workspace after links are followed, like bands/readback/
    const sessions = dirty.length > 0 ? workspaceOutputDir(deps.workspaceDir, "sessions", true) : null;
    if (sessions && !sessions.ok) {
      return err(failed(op, sessions.error.code, `sessions/: ${sessions.error.message}; nothing backed up, nothing opened`, {
        hint: "sessions/ must be a plain folder inside the workspace",
      }));
    }
    for (const d of dirty) {
      const path = uniquePath(join(sessions!.value, `${safeName(d.name)}-${stamp()}`), ".band");
      const saved = await deps.scripts.backupDocument(d.name, path);
      if (!saved.ok || !existsSync(join(path, "projectData"))) {
        return err(failed(op, "WRITE_FAILED", "could not back up an unsaved project; nothing opened", {
          hint: "save it in GarageBand yourself, then retry", context: { document: d.name, reason: saved.ok ? "no projectData after save" : saved.error },
        }));
      }
      backups.push(path);
      backedUp.add(d.name);
    }
    return ok({ backups, backedUp });
  }

  /**
   * After `open`: dismiss only the save prompts of backed-up projects, stop at any other dialog, and ask `ready`
   * each time no dialog is up. null = the deadline passed and `ready` never answered.
   */
  async function awaitOpen(op: string, backedUp: ReadonlySet<string>, ready: () => Promise<Envelope | null>): Promise<Envelope | null> {
    // A project backed up in this call still owes its save prompt; GarageBand can show it more than a minute late
    //. While one is owed, wait up to promptGraceMs longer — same call, same rule.
    const owed = new Set(backedUp);
    const base = Math.max(1, Math.ceil(timeoutMs / pollMs));
    const grace = Math.ceil(promptGraceMs / pollMs);
    let limit = base; // the song's own wait; restarts after a late dismissal, so the new song gets its full time
    for (let i = 0; i < limit || (owed.size > 0 && i < base + grace); i++) {
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
        owed.delete(d.document);
        limit = Math.max(limit, i + base);
      } else if (d.kind === "other") {
        return failed(op, "DIALOG_UNEXPECTED", "an unexpected dialog appeared; nothing pressed", {
          write_attempted: true, safe_to_retry: false, hint: "answer the dialog in GarageBand yourself", context: { dialog: d.texts.map((t) => cleanText(t)), buttons: d.buttons },
        });
      } else if (d.kind === "none") {
        const done = await ready();
        if (done) return done;
      } // "busy" (loading window) / "not_running" (still launching): keep waiting
      await sleep(pollMs);
    }
    return null;
  }

  async function openMidi(op: string, input: string, dryRun = false): Promise<Envelope> {
    const file = resolveWorkspaceFile(deps.workspaceDir, input, [".mid"]);
    if (!file.ok) return failed(op, file.error.code, file.error.message, { hint: "render one first with gb_song render_midi" });
    const summary = readSmfSummary(readFileSync(file.value));
    if (!summary.ok) return failed(op, "INPUT_INVALID", `not a MIDI file: ${summary.error}`);
    const expected = summary.value.trackNames;

    const pre = await preflight(op);
    if (!pre.ok) return pre.error;
    const docs = await documents(op, pre.value.running);
    if (!docs.ok) return docs.error;
    if (dryRun) {
      return verified(op, {
        dry_run: true, path: file.value, tracks: expected, tempo: summary.value.tempoBpm,
        would_back_up: docs.value.filter((d) => d.modified).map((d) => d.name),
        plan: ["copy each unsaved project into sessions/", "open the file in GarageBand", "dismiss the save prompt only for backed-up projects", "verify regions = the file's tracks and the tempo"],
      });
    }
    const saved = await backUpUnsaved(op, docs.value);
    if (!saved.ok) return saved.error;
    const { backups, backedUp } = saved.value;

    const opened = await deps.openFile(file.value);
    if (!opened.ok) return failed(op, openFailureCode(opened.error), "macOS refused to open the file in GarageBand; nothing changed", {
      hint: "gb_system status checks GarageBand and its permissions", context: { reason: cleanText(opened.error) },
    });
    let titleWaits = 0; // the regions can be ready a moment before GarageBand titles the window
    // a project that was already open can show the same region names — only a new document counts
    const before = new Set(docs.value.map((d) => d.name));
    const done = await awaitOpen(op, backedUp, async () => {
      const s = await appState();
      const regions = (await find(MAIN, REGIONS)).map((n) => n.desc ?? "").filter((x) => x && !NOT_REGIONS.test(x));
      if (!s.ok || regions.length !== expected.length || !regions.every((r, k) => r === expected[k])) return null;
      if (before.has(documentOf(mainTitle(s.value)))) return null;
      if (documentOf(mainTitle(s.value)) === "" && titleWaits++ < 5) return null;
      const p = await readProjectSettled();
      const data = { document: documentOf(mainTitle(s.value)) || null, path: file.value, tempo: p.tempo, tracks: p.tracks, backups };
      if (summary.value.tempoBpm !== null && !sameTempo(p.tempo, summary.value.tempoBpm)) {
        return uncertain(op, "readback_timeout", { write_attempted: true, safe_to_retry: false, hint: `tempo reads ${p.tempo}, the file says ${summary.value.tempoBpm}`, data });
      }
      return verified(op, data);
    });
    return done ?? uncertain(op, "readback_timeout", {
      write_attempted: true, safe_to_retry: false,
      hint: "GarageBand was asked to open the file, but its tracks never matched the MIDI file; check gb_project status before retrying",
      data: { expected, backups },
    });
  }

  /**
   * Open a .band (gb_band build) and verify it the strongest way available: GarageBand saves its own copy of what it
   * loaded into bands/readback/, and that copy must hold the same tempo, song length, audio placements and MIDI notes.
   */
  async function openBand(op: string, input: string, dryRun = false): Promise<Envelope> {
    const band = resolveWorkspaceBand(deps.workspaceDir, input);
    if (!band.ok) return failed(op, band.error.code, band.error.message, { hint: "build one first with gb_band build" });
    const expected = inspectBand(band.value);
    if (!expected.ok) return failed(op, "INPUT_INVALID", `not a readable GarageBand project: ${expected.error.message}`);
    const file = basename(band.value);
    const names = new Set([file, file.replace(/\.band$/i, "")]); // GarageBand names the document with or without the extension

    const pre = await preflight(op);
    if (!pre.ok) return pre.error;
    const docs = await documents(op, pre.value.running);
    if (!docs.ok) return docs.error;
    if (docs.value.some((d) => names.has(d.name))) {
      // `open` would only bring that window forward: GarageBand would not read the file again.
      return failed(op, "DOCUMENT_ALREADY_OPEN", "a project with this name is already open in GarageBand, so it would not read the file again; nothing opened", {
        hint: "close that project in GarageBand (save it first to keep its changes), or build under a new filename",
      });
    }
    if (dryRun) {
      return verified(op, {
        dry_run: true, path: band.value, ...expected.value,
        would_back_up: docs.value.filter((d) => d.modified).map((d) => d.name),
        plan: ["copy each unsaved project into sessions/", "open the project in GarageBand", "dismiss the save prompt only for backed-up projects",
          "let GarageBand save its own copy into bands/readback/", "verify the copy holds the same tempo, length, audio and MIDI"],
      });
    }
    const saved = await backUpUnsaved(op, docs.value);
    if (!saved.ok) return saved.error;
    const { backups, backedUp } = saved.value;

    const opened = await deps.openFile(band.value);
    if (!opened.ok) return failed(op, openFailureCode(opened.error), "macOS refused to open the file in GarageBand; nothing changed", {
      hint: "gb_system status checks GarageBand and its permissions", context: { reason: cleanText(opened.error) },
    });
    const done = await awaitOpen(op, backedUp, async () => {
      const s = await appState();
      if (!s.ok || !names.has(documentOf(mainTitle(s.value)))) return null;
      const list = await deps.scripts.listDocuments();
      const doc = list.ok ? list.value.find((d) => names.has(d.name)) : undefined;
      if (!doc) return null;
      const dir = workspaceOutputDir(deps.workspaceDir, join("bands", "readback"), true);
      if (!dir.ok) {
        return uncertain(op, "readback_unavailable", {
          write_attempted: true, safe_to_retry: false, data: { document: doc.name, path: band.value, backups },
          hint: "the project opened, but bands/readback/ is not a plain folder inside the workspace, so GarageBand wrote no copy to compare",
        });
      }
      const readback = uniquePath(join(dir.value, `${safeName(file.replace(/\.band$/i, ""))}-${stamp()}`), ".band");
      const copy = await deps.scripts.backupDocument(doc.name, readback);
      const actual = copy.ok && existsSync(join(readback, "Alternatives", "000", "ProjectData")) ? inspectBand(readback) : null;
      if (!actual || !actual.ok) {
        return uncertain(op, "readback_unavailable", {
          write_attempted: true, safe_to_retry: false, data: { document: doc.name, path: band.value, backups },
          hint: "the project opened, but GarageBand wrote no readable copy to compare; check gb_project status, then export it and listen",
        });
      }
      const differences = bandDifferences(expected.value, actual.value);
      if (differences.length > 0) {
        return failed(op, "READBACK_MISMATCH", "GarageBand loaded the project differently from the file", {
          write_attempted: true, safe_to_retry: false, recoverable: false, context: { differences, readback },
          hint: "the .band format guess is wrong for this donor or edit: compare gb_band inspect of the file and of the readback copy",
        });
      }
      const p = await readProjectSettled();
      const data = { document: doc.name, path: band.value, readback, ...expected.value, tracks: p.tracks, backups };
      if (p.tempo === null && expected.value.tempo !== null) { // unknown, not different: GarageBand's own copy holds it
        return verified(op, data, [`the tempo display could not be read; GarageBand's own copy holds ${expected.value.tempo} BPM`]);
      }
      if (expected.value.tempo !== null && !sameTempo(p.tempo, expected.value.tempo)) {
        return uncertain(op, "readback_timeout", { write_attempted: true, safe_to_retry: false, hint: `tempo reads ${p.tempo}, the file says ${expected.value.tempo}`, data });
      }
      return verified(op, data);
    });
    return done ?? uncertain(op, "readback_timeout", {
      write_attempted: true, safe_to_retry: false,
      hint: "GarageBand was asked to open the project, but its window never showed it; check gb_project status before retrying",
      data: { path: band.value, backups },
    });
  }

  /**
   * The open project saved as a copy into donors/ (M11b) — GarageBand keeps working on its own document — then read
   * back: the copy must parse, and its tracks (number, audio or instrument, name) are what gb_band build can fill.
   */
  async function saveCopy(op: string, filename: string, dryRun: boolean): Promise<Envelope> {
    const s = await appState();
    if (!s.ok) return failed(op, "HELPER_UNAVAILABLE", s.error.message, { hint: "run gb_system doctor" });
    if (!s.value.running) return failed(op, "GB_NOT_RUNNING", "GarageBand is not running");
    const document = documentOf(mainTitle(s.value));
    if (!document) return failed(op, "NO_PROJECT_OPEN", "no GarageBand project is open", { hint: "open one with gb_project open_midi" });
    if (occupied(join(deps.workspaceDir, DONORS, filename))) {
      return failed(op, "FILE_EXISTS", `${DONORS}/${filename} already exists; nothing saved`, { hint: "choose a new filename" });
    }
    if (dryRun) return verified(op, { dry_run: true, document, path: join(deps.workspaceDir, DONORS, filename), plan: ["save a copy of the open project (AppleScript save … in)", "read the copy back: its tracks"] });
    const dir = workspaceOutputDir(deps.workspaceDir, DONORS, true);
    if (!dir.ok) return failed(op, dir.error.code, dir.error.message);
    const path = join(dir.value, filename);
    if (occupied(path)) return failed(op, "FILE_EXISTS", `${DONORS}/${filename} already exists; nothing saved`);
    return mutationGate.run(op, async () => {
      const saved = await deps.scripts.backupDocument(document, path);
      if (!saved.ok) return failed(op, "WRITE_FAILED", `GarageBand did not save the copy: ${saved.error}`, { write_attempted: true, safe_to_retry: false });
      rmSync(join(path, "Alternatives", "000", "Autosave"), { recursive: true, force: true }); // a donor copy never asks "Saved / Auto-saved"
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(join(path, "Alternatives", "000", "ProjectData")));
      } catch {
        return failed(op, "WRITE_FAILED", "the copy has no ProjectData", { write_attempted: true, safe_to_retry: false });
      }
      const pd = parseProjectData(bytes);
      if (!pd.ok) return failed(op, "WRITE_FAILED", `the copy cannot be read: ${pd.error.message}`, { write_attempted: true, safe_to_retry: false });
      return verified(op, { document, path, tracks: visibleTracks(pd.value).map(({ number, kind, name }) => ({ number, kind, name: cleanText(name) })) });
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
    if (parsed.data.command === "save_copy") return saveCopy(op, parsed.data.filename, parsed.data.dry_run === true);
    const { command, path, dry_run } = parsed.data;
    const open = command === "open_band" ? openBand : openMidi;
    if (dry_run === true) return open(op, path, true);
    return mutationGate.run(op, () => open(op, path));
  };
}
