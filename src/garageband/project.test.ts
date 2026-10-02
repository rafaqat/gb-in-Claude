// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, realpathSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGbProject, type ProjectScripts } from "./project.js";
import { FakeHelper } from "../ax/fake-helper.js";
import type { TreeNode } from "../ax/selector.js";
import { writeSmf } from "../midi/smf.js";

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
function simulateOpen(newTitle = "Untitled 9", tempo = 126, tracks = SONG_TRACKS) {
  return async (path: string) => {
    opened.push(path);
    const show = () => { fake.app.windows = [projectWindow(newTitle, tempo, tracks)]; };
    const dirty = docs.find((d) => d.modified);
    if (!dirty) return show();
    const prompt = savePrompt(dirty.name);
    const dontSave = prompt.children!.find((c) => c.title === "Don’t Save")!;
    fake.on(dontSave, { onPress: () => show() });
    fake.app.windows = [...fake.app.windows, prompt];
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
    const openWithForeignPrompt = async (path: string) => { opened.push(path); fake.app.windows = [...fake.app.windows, savePrompt("Someone Else's Song")]; };
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
    const openWithLoading = async (path: string) => { opened.push(path); fake.app.windows = [...fake.app.windows, loading()]; };
    const r = await createGbProject(deps({ helper: port, openFile: openWithLoading }))({ command: "open_midi", path: "ascent-v2.mid" });
    expect(r).toMatchObject({ status: "verified", data: { document: "Untitled 9" } });
    expect(fake.calls.some((c) => c.op === "ax.press")).toBe(false);
  });

  it("still stops at a dialog that has buttons and is not a save prompt", async () => {
    const alert: TreeNode = { role: "AXWindow", subrole: "AXDialog", title: "", children: [
      { role: "AXStaticText", value: "This project needs content that is not installed." }, { role: "AXButton", title: "Download", actions: ["AXPress"] }] };
    const r = await createGbProject(deps({ openFile: async (p: string) => { opened.push(p); fake.app.windows = [...fake.app.windows, alert]; } }))(
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

describe("gb_project status: silent tracks", () => {
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
