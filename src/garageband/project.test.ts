// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeEach } from "vitest";
import { cpSync, mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, realpathSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGbProject, openFailureCode, type ProjectScripts } from "./project.js";
import { FakeHelper } from "../ax/fake-helper.js";
import type { TreeNode } from "../ax/selector.js";
import { writeSmf } from "../midi/smf.js";
import { execFileSync } from "node:child_process";
import { parseBinaryPlist } from "../sound/bplist.js";

const SONG_TRACKS = [
  { name: "Drums", channel: 10, program: 24, patch: "Boutique 808" },
  { name: "Strings", channel: 1, program: 48, patch: "String Ensemble" },
];

function projectWindow(title: string, tempo: number, tracks = SONG_TRACKS): TreeNode {
  return {
    role: "AXWindow", subrole: "AXStandardWindow", title: `${title} - Tracks`, children: [
      { role: "AXGroup", desc: "Control Bar", children: [{ role: "AXSlider", desc: "Tempo", value: tempo, settable: true }] },
      { role: "AXGroup", desc: "Tracks header", children: tracks.map((t, i) => ({ role: "AXLayoutItem", desc: `Track ${i + 1} “${t.patch}”` })) },
      { role: "AXGroup", desc: "Tracks contents", children: tracks.map((t) => ({ role: "AXLayoutItem", desc: t.name })) },
    ],
  };
}

function savePrompt(doc: string): TreeNode {
  return {
    role: "AXWindow", subrole: "AXDialog", title: "", children: [
      { role: "AXStaticText", value: `Do you want to save the document “${doc}”?` },
      { role: "AXButton", title: "Save", actions: ["AXPress"] },
      { role: "AXButton", title: "Don’t Save", actions: ["AXPress"] },
      { role: "AXButton", title: "Cancel", actions: ["AXPress"] },
    ],
  };
}

let ws: string;
let fake: FakeHelper;
let docs: { name: string; modified: boolean }[];
let backups: { name: string; path: string }[];
let opened: string[];
let midPath: string;

/** What GarageBand does on `open file.mid`: prompt about an unsaved document, then show the new project. */
/** What `open` returns when macOS accepts the file. */
const OPENED = { ok: true as const, value: undefined };

function simulateOpen(newTitle = "Untitled 9", tempo = 126, tracks = SONG_TRACKS) {
  return async (path: string) => {
    opened.push(path);
    const show = () => { fake.app.windows = [projectWindow(newTitle, tempo, tracks)]; };
    const dirty = docs.find((d) => d.modified);
    if (!dirty) { show(); return OPENED; }
    const prompt = savePrompt(dirty.name);
    const dontSave = prompt.children!.find((c) => c.title === "Don’t Save")!;
    fake.on(dontSave, { onPress: () => show() });
    fake.app.windows = [...fake.app.windows, prompt];
    return OPENED;
  };
}

const scripts = (over: Partial<ProjectScripts> = {}): ProjectScripts => ({
  listDocuments: async () => ({ ok: true, value: docs }),
  backupDocument: async (name, path) => { backups.push({ name, path }); mkdirSync(path, { recursive: true }); writeFileSync(join(path, "projectData"), "x"); return { ok: true, value: undefined }; },
  ...over,
});

const deps = (over = {}) => ({
  workspaceDir: ws, helper: fake, scripts: scripts(), openFile: simulateOpen(), sleep: async () => {}, pollMs: 1, timeoutMs: 20,
  screenLocked: async () => false, // hermetic: never read the real machine's lock state
  ...over,
});

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "gbmcp-prj-")));
  fake = new FakeHelper();
  fake.app.windows = [projectWindow("Ascent-v4-session.band", 132, [{ name: "Drums", channel: 10, program: 0, patch: "SoCal" }])];
  docs = [{ name: "Ascent-v4-session.band", modified: false }];
  backups = [];
  opened = [];
  const smf = writeSmf({ ppq: 480, tempoBpm: 126, timeSignature: [4, 4], tracks: SONG_TRACKS.map((t) => ({
    name: t.name, channel: t.channel, program: t.program, notes: [{ pitch: 60, startTick: 0, durationTicks: 480, velocity: 90 }] })) });
  if (!smf.ok) throw new Error(smf.error.message);
  midPath = join(ws, "ascent-v2.mid");
  writeFileSync(midPath, smf.value);
});

describe("gb_project open_midi", () => {
  it("opens the MIDI file and verifies regions, patches and tempo against the file", async () => {
    const r = await createGbProject(deps())({ command: "open_midi", path: "ascent-v2.mid" });
    expect(r).toMatchObject({
      status: "verified", op: "gb_project.open_midi",
      data: { document: "Untitled 9", tempo: 126, tracks: [{ name: "Drums", patch: "Boutique 808" }, { name: "Strings", patch: "String Ensemble" }], backups: [] },
    });
    expect(opened).toEqual([midPath]);
  });

  it("refuses to back up through a sessions/ link that leads outside the workspace — nothing saved there, nothing opened", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "gbmcp-elsewhere-")));
    symlinkSync(outside, join(ws, "sessions"));
    docs = [{ name: "Untitled 3", modified: true }];
    const r = await createGbProject(deps())({ command: "open_midi", path: "ascent-v2.mid" });
    expect(r).toMatchObject({ status: "failed", error: "PATH_OUTSIDE_WORKSPACE" });
    expect(backups).toEqual([]);
    expect(readdirSync(outside)).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("accepts the tempo MIDI cannot store exactly: 174 BPM is 344,828 µs per beat, which GarageBand shows as 173.9998", async () => {
    const smf = writeSmf({ ppq: 480, tempoBpm: 174, timeSignature: [4, 4], tracks: SONG_TRACKS.map((t) => ({
      name: t.name, channel: t.channel, program: t.program, notes: [{ pitch: 60, startTick: 0, durationTicks: 480, velocity: 90 }] })) });
    if (!smf.ok) throw new Error(smf.error.message);
    writeFileSync(join(ws, "dnb.mid"), smf.value);
    const r = await createGbProject(deps({ openFile: simulateOpen("Untitled 9", 173.9998016357422) }))({ command: "open_midi", path: "dnb.mid" });
    expect(r).toMatchObject({ status: "verified", data: { tempo: 173.9998016357422 } });
  });

  it("still refuses a tempo that is really different (126 in the file, 128 in GarageBand)", async () => {
    const r = await createGbProject(deps({ openFile: simulateOpen("Untitled 9", 128) }))({ command: "open_midi", path: "ascent-v2.mid" });
    expect(r).toMatchObject({ status: "uncertain" });
  });

  it("waits past the time limit for a late save prompt of the project it backed up in this call, then opens (m9b)", async () => {
    docs = [{ name: "Untitled 3", modified: true }];
    let polls = 0;
    const lateOpen = async (path: string) => { opened.push(path); return OPENED; }; // GarageBand is slow: nothing yet
    const sleep = async () => {
      polls++;
      if (polls === 35) { // after the 20-poll limit: the prompt for the backed-up project finally appears
        const prompt = savePrompt("Untitled 3");
        fake.on(prompt.children!.find((c) => c.title === "Don’t Save")!, { onPress: () => { fake.app.windows = [projectWindow("Untitled 9", 126, SONG_TRACKS)]; } });
        fake.app.windows = [...fake.app.windows, prompt];
      }
    };
    const r = await createGbProject(deps({ openFile: lateOpen, sleep }))({ command: "open_midi", path: "ascent-v2.mid" });
    expect(r).toMatchObject({ status: "verified", data: { document: "Untitled 9" } });
  });

  it("does not wait longer when nothing was backed up (no prompt can be owed)", async () => {
    let polls = 0;
    const r = await createGbProject(deps({ openFile: async () => OPENED, sleep: async () => { polls++; } }))({ command: "open_midi", path: "ascent-v2.mid" });
    expect(r).toMatchObject({ status: "uncertain" });
    expect(polls).toBeLessThanOrEqual(21);
  });

  it("backs up an unsaved project before opening, then discards only that project's prompt", async () => {
    docs = [{ name: "Untitled 3", modified: true }];
    const r = await createGbProject(deps())({ command: "open_midi", path: "ascent-v2.mid" });
    expect(r.status).toBe("verified");
    expect(backups).toHaveLength(1);
    expect(backups[0]!.name).toBe("Untitled 3");
    expect(backups[0]!.path.startsWith(join(ws, "sessions", "Untitled 3-"))).toBe(true);
    expect(existsSync(join(backups[0]!.path, "projectData"))).toBe(true);
    if (r.status === "verified") expect((r.data as { backups: string[] }).backups).toEqual([backups[0]!.path]);
  });

  it("never presses Don’t Save for a document it did not back up", async () => {
    docs = [{ name: "My Song", modified: true }];
    const r = await createGbProject(deps({ scripts: scripts({ backupDocument: async () => ({ ok: true, value: undefined }) }) }))(
      { command: "open_midi", path: "ascent-v2.mid" });
    // backup claimed success but produced nothing → refuse before opening
    expect(r).toMatchObject({ status: "failed", error: "WRITE_FAILED", write_attempted: false });
    expect(opened).toEqual([]);
  });

  it("stops at an unexpected dialog without pressing anything", async () => {
    docs = [{ name: "Untitled 3", modified: true }];
    const openWithForeignPrompt = async (path: string) => { opened.push(path); fake.app.windows = [...fake.app.windows, savePrompt("Someone Else's Song")]; return OPENED; };
    const r = await createGbProject(deps({ openFile: openWithForeignPrompt }))({ command: "open_midi", path: "ascent-v2.mid" });
    expect(r).toMatchObject({ status: "failed", error: "DIALOG_UNEXPECTED", write_attempted: true });
    expect(fake.calls.some((c) => c.op === "ax.press")).toBe(false);
  });

  it("refuses to start while a dialog is already open", async () => {
    fake.app.windows = [...fake.app.windows, savePrompt("Ascent-v4-session.band")];
    const r = await createGbProject(deps())({ command: "open_midi", path: "ascent-v2.mid" });
    expect(r).toMatchObject({ status: "failed", error: "DIALOG_UNEXPECTED", write_attempted: false });
    expect(opened).toEqual([]);
  });

  it("is uncertain when the project that appears does not match the file", async () => {
    const r = await createGbProject(deps({ openFile: simulateOpen("Untitled 9", 126, [{ name: "Something", channel: 1, program: 0, patch: "Steinway Grand Piano" }]) }))(
      { command: "open_midi", path: "ascent-v2.mid" });
    expect(r).toMatchObject({ status: "uncertain", reason: "readback_timeout", write_attempted: true });
  });

  it.each([["../x.mid", "PATH_OUTSIDE_WORKSPACE"], ["missing.mid", "FILE_NOT_FOUND"], ["song.wav", "NOT_SUPPORTED"]])(
    "validates the path %s → %s", async (path, code) => {
      writeFileSync(join(ws, "song.wav"), "RIFF");
      const r = await createGbProject(deps())({ command: "open_midi", path });
      expect(r).toMatchObject({ status: "failed", error: code });
      expect(opened).toEqual([]);
    });
});

describe("gb_project open_midi: GarageBand's transient loading window", () => {
  const loading = (): TreeNode => ({ role: "AXWindow", subrole: "AXDialog", title: "GarageBand", children: [{ role: "AXStaticText", value: "GarageBand" }] });

  it("waits out a buttonless loading window instead of calling it unexpected", async () => {
    let polls = 0;
    const port = {
      call: async (op: string, params?: Record<string, unknown>, opts?: { deadlineMs?: number }) => {
        if (op === "app.state" && ++polls === 4) fake.app.windows = [projectWindow("Untitled 9", 126)];
        return fake.call(op, params, opts);
      },
      close: () => fake.close(),
    };
    const openWithLoading = async (path: string) => { opened.push(path); fake.app.windows = [...fake.app.windows, loading()]; return OPENED; };
    const r = await createGbProject(deps({ helper: port, openFile: openWithLoading }))({ command: "open_midi", path: "ascent-v2.mid" });
    expect(r).toMatchObject({ status: "verified", data: { document: "Untitled 9" } });
    expect(fake.calls.some((c) => c.op === "ax.press")).toBe(false);
  });

  it("still stops at a dialog that has buttons and is not a save prompt", async () => {
    const alert: TreeNode = { role: "AXWindow", subrole: "AXDialog", title: "", children: [
      { role: "AXStaticText", value: "This project needs content that is not installed." }, { role: "AXButton", title: "Download", actions: ["AXPress"] }] };
    const r = await createGbProject(deps({ openFile: async (p: string) => { opened.push(p); fake.app.windows = [...fake.app.windows, alert]; return OPENED; } }))(
      { command: "open_midi", path: "ascent-v2.mid" });
    expect(r).toMatchObject({ status: "failed", error: "DIALOG_UNEXPECTED" });
    expect(fake.calls.some((c) => c.op === "ax.press")).toBe(false);
  });
});

describe("screen lock", () => {
  it("refuses at once with SCREEN_LOCKED instead of timing out, touching nothing", async () => {
    const r = await createGbProject(deps({ screenLocked: async () => true }))({ command: "open_midi", path: "ascent-v2.mid" });
    expect(r).toMatchObject({ status: "failed", error: "SCREEN_LOCKED", write_attempted: false });
    expect(fake.calls.some((c) => ["ax.press", "ax.menu", "ax.set"].includes(c.op))).toBe(false);
  });
});

describe("gb_project status", () => {
  it("reports the open document, its tracks and tempo, read-only", async () => {
    const r = await createGbProject(deps())({ command: "status" });
    expect(r).toMatchObject({ status: "verified", data: { running: true, document: "Ascent-v4-session.band", tempo: 132, dialogs: 0, tracks: [{ name: "Drums", patch: "SoCal" }] } });
    expect(fake.calls.some((c) => ["ax.press", "ax.set", "ax.menu", "ax.converge"].includes(c.op))).toBe(false);
    expect(readdirSync(ws)).not.toContain("sessions");
  });

  it("pairs each region with its own track when a track has no region (M11b: an empty audio track added to a MIDI import)", async () => {
    const win = fake.app.windows[0]!;
    win.children!.find((c) => c.desc === "Tracks header")!.children = [
      { role: "AXLayoutItem", desc: "Track 1 “Audio 1”" },
      { role: "AXLayoutItem", desc: "Track 2 “Steinway Grand Piano”" },
    ];
    win.children!.find((c) => c.desc === "Tracks contents")!.children = [
      { role: "AXLayoutArea", desc: "Track 1 “Audio 1”", children: [] },
      { role: "AXLayoutArea", desc: "Track 2 “Steinway Grand Piano”", children: [{ role: "AXLayoutItem", desc: "Piano" }] },
    ];
    const r = await createGbProject(deps())({ command: "status" });
    expect((r as { data: { tracks: unknown } }).data.tracks).toEqual([
      { number: 1, name: null, patch: "Audio 1" },
      { number: 2, name: "Piano", patch: "Steinway Grand Piano" },
    ]);
  });
});

describe("gb_project open_midi dry_run", () => {
  it("reads the file and lists what would be backed up — opens nothing, saves nothing", async () => {
    docs = [{ name: "Untitled 3", modified: true }];
    const r = await createGbProject(deps())({ command: "open_midi", path: "ascent-v2.mid", dry_run: true });
    expect(r).toMatchObject({ status: "verified", data: { dry_run: true, path: midPath, tracks: ["Drums", "Strings"], tempo: 126, would_back_up: ["Untitled 3"] } });
    expect(opened).toEqual([]);
    expect(backups).toEqual([]);
  });
});

describe("gb_project status: silent tracks (found live)", () => {
  it("reports the region name without GarageBand's “, muted” suffix", async () => {
    const regions = fake.app.windows[0]!.children!.find((c) => c.desc === "Tracks contents")!;
    regions.children![0]!.desc = "Drums, muted";
    expect(await createGbProject(deps())({ command: "status" })).toMatchObject({ status: "verified", data: { tracks: [{ name: "Drums", patch: "SoCal" }] } });
  });
});

describe("gb_project open_midi: the window title lags the regions (document came back empty)", () => {
  it("waits briefly for the title instead of reporting an empty document name", async () => {
    let states = 0;
    let opened: TreeNode | undefined;
    const port = {
      call: async (op: string, params?: Record<string, unknown>, opts?: { deadlineMs?: number }) => {
        opened ??= fake.app.windows.find((w) => String(w.title).startsWith("Untitled 9"));
        if (op === "app.state" && opened) {
          opened.title = ++states < 4 ? "" : "Untitled 9 - Tracks"; // regions are already there; the title arrives later
        }
        return fake.call(op, params, opts);
      },
      close: () => fake.close(),
    };
    const r = await createGbProject(deps({ helper: port, openFile: simulateOpen("Untitled 9") }))({ command: "open_midi", path: "ascent-v2.mid" });
    expect(r).toMatchObject({ status: "verified", data: { document: "Untitled 9" } });
  });
});

describe("gb_project open_midi: the old project can look like the new one (same region names)", () => {
  it("waits for a NEW document instead of verifying the project that was already open", async () => {
    docs = [{ name: "Untitled 8", modified: false }];
    fake.app.windows = [projectWindow("Untitled 8", 126)]; // same tracks and tempo as ascent-v2.mid
    const slow = async (path: string) => {
      opened.push(path);
      fake.schedule(fake.clockMs + 1_000, () => { fake.app.windows = [projectWindow("Untitled 9", 126)]; });
      return OPENED;
    };
    const r = await createGbProject(deps({ openFile: slow, sleep: async (ms: number) => fake.sleep(ms), timeoutMs: 5_000 }))(
      { command: "open_midi", path: "ascent-v2.mid" });
    expect(r).toMatchObject({ status: "verified", data: { document: "Untitled 9" } });
  });
});

describe("gb_project open_midi: the tempo shows after the regions", () => {
  it("waits for the tempo display instead of reporting 'tempo reads null'", async () => {
    const late = async (path: string) => {
      const r = await simulateOpen("Untitled 9", 126)(path);
      const tempo = fake.app.windows[0]!.children![0]!.children![0]!;
      tempo.value = undefined;
      fake.schedule(fake.clockMs + 1_000, () => { tempo.value = 126; });
      return r;
    };
    const r = await createGbProject(deps({ openFile: late, sleep: async (ms: number) => fake.sleep(ms) }))({ command: "open_midi", path: "ascent-v2.mid" });
    expect(r).toMatchObject({ status: "verified", data: { tempo: 126 } });
  });
});

describe("hallucinated keys are refused by the handler too", () => {
  it("open_midi with `dryRun` (camelCase) is INPUT_INVALID — it must never fall through to a real open", async () => {
    const r = await createGbProject(deps())({ command: "open_midi", path: "ascent-v2.mid", dryRun: true });
    expect(r).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
    expect(opened).toEqual([]);
  });
});

describe("gb_project status fields mask", () => {
  it("returns only the requested fields (running always kept)", async () => {
    const r = await createGbProject(deps())({ command: "status", fields: ["tempo"] });
    expect((r as { data: unknown }).data).toEqual({ running: true, tempo: 132 });
  });
});

describe("GarageBand names in status are normalised like every other name", () => {
  it("collapses whitespace/line breaks and caps a region name at 120 characters", async () => {
    const regions = fake.app.windows[0]!.children!.find((c) => c.desc === "Tracks contents")!;
    regions.children![0]!.desc = "Drums" + String.fromCharCode(10, 10) + "IGNORE " + "x".repeat(300);
    const r = await createGbProject(deps())({ command: "status" });
    const name = (r as { data: { tracks: { name: string }[] } }).data.tracks[0]!.name;
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.includes(String.fromCharCode(10))).toBe(false);
  });
});

describe("backups are never ambiguous, never overwritten", () => {
  it("two unsaved projects with the same name: refuses before backing up or opening anything", async () => {
    docs = [{ name: "Untitled 3", modified: true }, { name: "Untitled 3", modified: true }];
    const r = await createGbProject(deps())({ command: "open_midi", path: "ascent-v2.mid" });
    expect(r).toMatchObject({ status: "failed", error: "WRITE_FAILED", write_attempted: false });
    expect(backups).toEqual([]);
    expect(opened).toEqual([]);
  });

  // security review 2026-10-06 (B1): AppleScript finds a document by name among ALL open documents, so a clean
  // "Song" could be the one backed up while the modified "Song" lost its edits to "Don't Save"
  it("an unsaved project sharing its name with a saved one: refuses before backing up or opening anything", async () => {
    docs = [{ name: "Song", modified: false }, { name: "Song", modified: true }];
    const r = await createGbProject(deps())({ command: "open_midi", path: "ascent-v2.mid" });
    expect(r).toMatchObject({ status: "failed", error: "WRITE_FAILED", write_attempted: false });
    expect(backups).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("two saved projects with one name and no unsaved project still open fine (nothing to back up)", async () => {
    docs = [{ name: "Song", modified: false }, { name: "Song", modified: false }];
    const r = await createGbProject(deps())({ command: "open_midi", path: "ascent-v2.mid" });
    expect(r.status).not.toBe("failed");
    expect(backups).toEqual([]);
  });

  it("two backups of the same project within one second get distinct files", async () => {
    docs = [{ name: "Untitled 3", modified: true }];
    await createGbProject(deps())({ command: "open_midi", path: "ascent-v2.mid" });
    fake.app.windows = [projectWindow("Untitled 3", 132)];
    docs = [{ name: "Untitled 3", modified: true }];
    await createGbProject(deps())({ command: "open_midi", path: "ascent-v2.mid" });
    expect(backups).toHaveLength(2);
    expect(backups[0]!.path).not.toBe(backups[1]!.path);
  });
});

describe("gb_project open_band", () => {
  const AV_TRACKS = ["smp1", "smp2", "Keys", "Bass"].map((name, i) => ({ name, channel: 1, program: 0, patch: `Track ${i + 1}` }));
  let band: string;
  beforeEach(() => {
    band = join(ws, "bands", "av.band");
    cpSync(fileURLToPath(new URL("../../test/fixtures/band/donor-av.band", import.meta.url)), band, { recursive: true });
  });
  /** What GarageBand does on `open av.band`: a new document named after the file. */
  const openBand = (name = "av.band") => async (path: string) => {
    opened.push(path);
    docs.push({ name, modified: false });
    fake.app.windows = [projectWindow(name, 120, AV_TRACKS)];
    return OPENED;
  };
  /** GarageBand's `save … in` for the opened project: the copy it writes (here the file itself, or `as`). */
  const resave = (as?: string) => scripts({
    backupDocument: async (name, path) => {
      backups.push({ name, path });
      if (name === "av.band") cpSync(as ?? band, path, { recursive: true });
      else { mkdirSync(path, { recursive: true }); writeFileSync(join(path, "projectData"), "x"); }
      return { ok: true, value: undefined };
    },
  });

  it.each(["open_band", "open_midi"] as const)("%s: a refused `open` fails at once, never waits for a window that cannot come", async (command) => {
    const refused = async () => ({ ok: false as const, error: "Unable to find application named 'com.apple.garageband10'" });
    const path = command === "open_band" ? "bands/av.band" : "ascent-v2.mid";
    const r = await createGbProject(deps({ openFile: refused, scripts: resave() }))({ command, path });
    expect(r).toMatchObject({ status: "failed", op: `gb_project.${command}` });
  });

  it("opens a built .band and verifies it through GarageBand's own re-save: same audio, MIDI and song length", async () => {
    const r = await createGbProject(deps({ openFile: openBand(), scripts: resave() }))({ command: "open_band", path: "bands/av.band" });
    expect(r).toMatchObject({
      status: "verified", op: "gb_project.open_band",
      data: {
        document: "av.band", path: band, tempo: 120, bars: 2, backups: [],
        audio: [{ track: 1, bar: 1, file: "smp1.wav" }, { track: 2, bar: 2, file: "smp2.wav" }],
        midi: [{ region: "Keys" }, { region: "Bass" }],
      },
    });
    const readback = (r as { data: { readback: string } }).data.readback;
    expect(readback.startsWith(join(ws, "bands", "readback", "av-"))).toBe(true);
    expect(existsSync(join(readback, "Alternatives", "000", "ProjectData"))).toBe(true);
    expect(opened).toEqual([band]);
  });

  /** The window is titled at once, but its tempo and track headers read empty until `afterMs`. */
  const drawnLate = (afterMs: number) => async (path: string) => {
    const r = await openBand()(path);
    const w = fake.app.windows[0]!;
    const tempo = w.children![0]!.children![0]!;
    const header = w.children![1]!;
    const headers = header.children ?? [];
    tempo.value = undefined;
    header.children = [];
    fake.schedule(fake.clockMs + afterMs, () => { tempo.value = 120; header.children = headers; });
    return r;
  };

  it("waits for the window to show the tempo and the tracks before it compares (live: empty for a moment after the open)", async () => {
    const r = await createGbProject(deps({ openFile: drawnLate(1_500), scripts: resave(), sleep: async (ms: number) => fake.sleep(ms) }))(
      { command: "open_band", path: "bands/av.band" });
    expect(r).toMatchObject({ status: "verified", data: { tempo: 120 } });
    expect((r as { data: { tracks: unknown[] } }).data.tracks).toHaveLength(4);
  });

  it("a tempo display that never reads: verified on GarageBand's own copy, with a warning (unknown is not a mismatch)", async () => {
    const r = await createGbProject(deps({ openFile: drawnLate(60_000), scripts: resave(), sleep: async (ms: number) => fake.sleep(ms) }))(
      { command: "open_band", path: "bands/av.band" });
    expect(r).toMatchObject({ status: "verified", data: { tempo: 120 } });
    expect((r as { warnings?: string[] }).warnings?.join(" ")).toMatch(/tempo.*could not be read.*copy/i);
  });

  it("a tempo display that shows ANOTHER tempo stays uncertain (a real difference, not a slow window)", async () => {
    const otherTempo = async (path: string) => { const r = await openBand()(path); fake.app.windows[0]!.children![0]!.children![0]!.value = 100; return r; };
    const r = await createGbProject(deps({ openFile: otherTempo, scripts: resave() }))({ command: "open_band", path: "bands/av.band" });
    expect(r).toMatchObject({ status: "uncertain", hint: "tempo reads 100, the file says 120" });
  });

  it("fails with READBACK_MISMATCH when GarageBand's own copy differs from the file — the format guess was wrong", async () => {
    const other = fileURLToPath(new URL("../../test/fixtures/band/donor-one-region.band", import.meta.url));
    const r = await createGbProject(deps({ openFile: openBand(), scripts: resave(other) }))({ command: "open_band", path: "bands/av.band" });
    expect(r).toMatchObject({ status: "failed", error: "READBACK_MISMATCH", write_attempted: true, safe_to_retry: false });
    const differences = (r as { context: { differences: string[] } }).context.differences;
    expect(differences).toEqual(expect.arrayContaining([
      "bars: 2 in the file, 32 in GarageBand's copy",
      "audio missing in GarageBand's copy: smp1.wav on track 1 at bar 1 beat 1 (1 s)",
      "midi missing in GarageBand's copy: Keys: 6 notes over 2 bars",
    ]));
  });

  it.each(["av.band", "av"])("refuses DOCUMENT_ALREADY_OPEN when %s is open — GarageBand would not read the file again", async (name) => {
    docs = [{ name, modified: true }];
    const r = await createGbProject(deps({ openFile: openBand(), scripts: resave() }))({ command: "open_band", path: "bands/av.band" });
    expect(r).toMatchObject({ status: "failed", error: "DOCUMENT_ALREADY_OPEN", write_attempted: false });
    expect(opened).toEqual([]);
    expect(backups).toEqual([]);
  });

  it("backs up an unsaved project first and dismisses only that project's save prompt (same flow as open_midi)", async () => {
    docs = [{ name: "Untitled 3", modified: true }];
    const openWithPrompt = async (path: string) => {
      const prompt = savePrompt("Untitled 3");
      fake.on(prompt.children!.find((c) => c.title === "Don’t Save")!, { onPress: () => openBand()(path) });
      fake.app.windows = [...fake.app.windows, prompt];
      return OPENED;
    };
    const r = await createGbProject(deps({ openFile: openWithPrompt, scripts: resave() }))({ command: "open_band", path: "bands/av.band" });
    expect(r).toMatchObject({ status: "verified", data: { document: "av.band", backups: [expect.stringContaining(join(ws, "sessions", "Untitled 3-"))] } });
    expect(backups.map((b) => b.name)).toEqual(["Untitled 3", "av.band"]);
  });

  it("dry_run reads the project and plans — opens nothing, saves nothing, no readback copy", async () => {
    docs = [{ name: "Untitled 3", modified: true }];
    const r = await createGbProject(deps({ openFile: openBand(), scripts: resave() }))({ command: "open_band", path: "bands/av.band", dry_run: true });
    expect(r).toMatchObject({ status: "verified", data: { dry_run: true, path: band, bars: 2, would_back_up: ["Untitled 3"] } });
    expect(opened).toEqual([]);
    expect(backups).toEqual([]);
    expect(existsSync(join(ws, "bands", "readback"))).toBe(false);
  });

  it("refuses a path that is not a .band package (NOT_SUPPORTED) before touching GarageBand", async () => {
    const r = await createGbProject(deps({ openFile: openBand(), scripts: resave() }))({ command: "open_band", path: "ascent-v2.mid" });
    expect(r).toMatchObject({ status: "failed", error: "NOT_SUPPORTED" });
    expect(opened).toEqual([]);
  });

  it("a bands/readback/ that links out of the workspace gets no copy — uncertain, nothing written there", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "gbmcp-outside-")));
    symlinkSync(outside, join(ws, "bands", "readback"));
    const r = await createGbProject(deps({ openFile: openBand(), scripts: resave() }))({ command: "open_band", path: "bands/av.band" });
    expect(r).toMatchObject({ status: "uncertain", reason: "readback_unavailable", write_attempted: true, safe_to_retry: false });
    expect(readdirSync(outside)).toEqual([]);
    expect(backups.filter((b) => b.name === "av.band")).toEqual([]);
  });
});


describe("openFailureCode: a refused `open` → the code the agent acts on", () => {
  it.each([
    // execFile's message as seen on macOS 26: "Command failed: <command>\n" + open's stderr
    ["Command failed: open -b com.apple.garageband10 /x/a.band\nLSCopyApplicationURLsForBundleIdentifier() failed while trying to determine the application with bundle identifier com.apple.garageband10.\n", "DEPENDENCY_MISSING"],
    ["Unable to find application named 'com.apple.garageband10'", "DEPENDENCY_MISSING"], // older macOS
    ["Command failed: open -b com.apple.garageband10 /x/a.band\nThe file /x/a.band does not exist.\n", "FILE_NOT_FOUND"],
    ["The application cannot be opened for an unexpected reason, error=Error Domain=NSOSStatusErrorDomain Code=-10661", "INTERNAL_ERROR"],
    ["", "INTERNAL_ERROR"],
  ])("%j → %s", (reason, code) => expect(openFailureCode(reason)).toBe(code));
});

describe("gb_project save_copy (M11b): the open project as a donor for gb_band", () => {
  const fixture = fileURLToPath(new URL("../../test/fixtures/band/midi-plus-empty-audio.band", import.meta.url));
  const copying = () => scripts({
    backupDocument: async (name, path) => { backups.push({ name, path }); cpSync(fixture, path, { recursive: true }); return { ok: true, value: undefined }; },
  });
  it("saves a copy into donors/ and lists its tracks — audio or instrument — for gb_band build", async () => {
    const r = await createGbProject(deps({ scripts: copying() }))({ command: "save_copy", filename: "song-donor.band" });
    expect(r).toMatchObject({ status: "verified", data: { path: join(ws, "donors", "song-donor.band") } });
    expect((r as { data: { tracks: unknown[] } }).data.tracks).toEqual([
      { number: 1, kind: "audio", name: "Audio 1" }, { number: 2, kind: "instrument", name: "Steinway Grand Piano" },
    ]);
    expect(backups).toHaveLength(1);
  });
  it("scrubs a local folder GarageBand wrote into the copy (an Alchemy DataLoc), keeping the file's size", async () => {
    const leaky = scripts({
      backupDocument: async (name, path) => {
        backups.push({ name, path });
        cpSync(fixture, path, { recursive: true });
        const pd = join(path, "Alternatives", "000", "ProjectData");
        const bytes = new Uint8Array(readFileSync(pd));
        bytes.set(new TextEncoder().encode("DataLoc = /Users/someone/Music/x.band/Media/Alchemy Samples".padEnd(90, "X")), 105833);
        writeFileSync(pd, bytes);
        return { ok: true, value: undefined };
      },
    });
    const r = await createGbProject(deps({ scripts: leaky }))({ command: "save_copy", filename: "leaky-donor.band" });
    expect(r).toMatchObject({ status: "verified" });
    const written = new TextDecoder("latin1").decode(readFileSync(join(ws, "donors", "leaky-donor.band", "Alternatives", "000", "ProjectData")));
    expect(written).not.toContain("someone");
    expect(written).toContain("/Users/Shared/gb-mcp");
  });

  it("scrubs the local folders GarageBand lists in the copy's MetaData.plist (AudioFiles)", async () => {
    const files = ["/Users/someone/Documents/projects/x.band/Media/Audio Files/a.wav", "/Users/someone/Music/Sampler Files/Harp/h.wav", "Audio Files/b.wav"];
    const leaky = scripts({
      backupDocument: async (name, path) => {
        backups.push({ name, path });
        cpSync(fixture, path, { recursive: true });
        execFileSync("plutil", ["-replace", "AudioFiles", "-json", JSON.stringify(files), join(path, "Alternatives", "000", "MetaData.plist")]);
        return { ok: true, value: undefined };
      },
    });
    const r = await createGbProject(deps({ scripts: leaky }))({ command: "save_copy", filename: "leaky-meta.band" });
    expect(r).toMatchObject({ status: "verified" });
    const meta = parseBinaryPlist(new Uint8Array(readFileSync(join(ws, "donors", "leaky-meta.band", "Alternatives", "000", "MetaData.plist"))));
    expect(meta.ok).toBe(true);
    const audio = (meta.ok ? (meta.value as { AudioFiles: string[] }).AudioFiles : []);
    expect(audio).toHaveLength(3);
    expect(audio.join("\n")).not.toMatch(/someone|Documents|projects/);
    expect(audio[0]).toMatch(/^\/Users\/Shared\/gb-mcp-*\/x\.band\/Media\/Audio Files\/a\.wav$/);
    expect(audio[1]).toMatch(/^\/Users\/Shared\/gb-mcp/);
    expect(audio[2]).toBe("Audio Files/b.wav");
  });

  it("never overwrites: an existing donors/<name> (or a link there) is FILE_EXISTS and nothing is saved", async () => {
    mkdirSync(join(ws, "donors", "taken.band"), { recursive: true });
    const r = await createGbProject(deps({ scripts: copying() }))({ command: "save_copy", filename: "taken.band" });
    expect(r).toMatchObject({ status: "failed", error: "FILE_EXISTS" });
    expect(backups).toEqual([]);
  });
  it("dry_run plans only; a name with a folder is refused", async () => {
    const gb = createGbProject(deps({ scripts: copying() }));
    expect(await gb({ command: "save_copy", filename: "x.band", dry_run: true })).toMatchObject({ status: "verified", data: { dry_run: true } });
    expect((await gb({ command: "save_copy", filename: "../x.band" })).status).toBe("failed");
    expect(backups).toEqual([]);
  });
});
