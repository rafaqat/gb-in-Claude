// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGbExport } from "./export.js";
import { FakeHelper } from "../ax/fake-helper.js";
import { findAll, type TreeNode } from "../ax/selector.js";
import { writeWav, sineStereo } from "../testing/wav.js";

const RECENT_PLACES = ["GarageBand", "Music", "Recent Places", "probe-export", "garageband"];

let ws: string;
let inbox: string;
let fake: FakeHelper;
let exportWrites: (name: string) => void;

/** Give the fixture save panel the behaviour the live panel has: radios are exclusive, Where lists recent places. */
function installPanelBehaviours(places = RECENT_PLACES) {
  const done = new WeakSet<TreeNode>();
  fake.beforeAction = () => {
    const panel = fake.app.windows.find((w) => w.id === "save-panel");
    if (!panel || done.has(panel)) return;
    done.add(panel);
    const radios = findAll(panel, { role: "AXRadioButton" }).matches.map((m) => m.node);
    for (const r of radios) fake.on(r, { onPress: (n) => radios.forEach((o) => (o.value = o === n ? 1 : 0)) });
    const where = findAll(panel, { role: "AXPopUpButton", identifier: "where popup" }).matches[0]!.node;
    fake.on(where, {
      onPress: () => {
        const menu: TreeNode = { role: "AXMenu", children: places.map((title) => ({ role: "AXMenuItem", title, actions: ["AXPress"] })) };
        for (const item of menu.children!) {
          fake.on(item, { onPress: () => { where.value = item.title; where.children = []; } });
        }
        where.children = [menu];
      },
    });
    const okButton = findAll(panel, { role: "AXButton", identifier: "OKButton" }).matches[0]!.node;
    const name = findAll(panel, { role: "AXTextField", identifier: "saveAsNameTextField" }).matches[0]!.node;
    fake.on(okButton, { onPress: () => { fake.app.windows.splice(fake.app.windows.indexOf(panel), 1); exportWrites(String(name.value)); } });
  };
}

const deps = (over = {}) => ({
  workspaceDir: ws, inboxDir: inbox, helper: fake,
  sleep: async () => {}, pollMs: 1, timeoutMs: 50,
  screenLocked: async () => false, // hermetic: never read the real machine's lock state
  ...over,
});

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "gbmcp-exp-")));
  inbox = join(ws, "probe-export");
  mkdirSync(inbox);
  fake = new FakeHelper();
  exportWrites = (name) => writeWav(join(inbox, `${name}.wav`), sineStereo(1.5, 44100, -12), 44100);
  installPanelBehaviours();
});

describe("gb_export song: the panel's folder changes after the popup label (live finding)", () => {
  let defaultDir: string;
  let changeAt: number;
  beforeEach(() => {
    defaultDir = join(ws, "Music-GarageBand");
    mkdirSync(defaultDir);
    changeAt = Number.POSITIVE_INFINITY;
    const done = new WeakSet<TreeNode>();
    fake.beforeAction = () => {
      const panel = fake.app.windows.find((w) => w.id === "save-panel");
      if (!panel || done.has(panel)) return;
      done.add(panel);
      const radios = findAll(panel, { role: "AXRadioButton" }).matches.map((m) => m.node);
      for (const r of radios) fake.on(r, { onPress: (n) => radios.forEach((o) => (o.value = o === n ? 1 : 0)) });
      const where = findAll(panel, { role: "AXPopUpButton", identifier: "where popup" }).matches[0]!.node;
      fake.on(where, { onPress: () => {
        const menu: TreeNode = { role: "AXMenu", children: RECENT_PLACES.map((title) => ({ role: "AXMenuItem", title, actions: ["AXPress"] })) };
        for (const item of menu.children!) fake.on(item, { onPress: () => { where.value = item.title; where.children = []; changeAt = fake.clockMs + 800; } });
        where.children = [menu];
      } });
      const ok = findAll(panel, { role: "AXButton", identifier: "OKButton" }).matches[0]!.node;
      const name = findAll(panel, { role: "AXTextField", identifier: "saveAsNameTextField" }).matches[0]!.node;
      fake.on(ok, { onPress: () => {
        fake.app.windows.splice(fake.app.windows.indexOf(panel), 1);
        const dir = fake.clockMs >= changeAt ? inbox : defaultDir; // the folder lags the label
        writeWav(join(dir, `${String(name.value)}.wav`), sineStereo(1, 44100, -12), 44100);
      } });
    };
  });

  it("waits for the folder change after picking the place, so the file lands in the inbox", async () => {
    const r = await createGbExport(deps({ sleep: async (ms: number) => fake.sleep(ms), defaultExportDir: defaultDir }))(
      { command: "song", filename: "settled.wav" });
    expect(r).toMatchObject({ status: "verified", data: { path: join(inbox, "settled.wav") } });
    expect(existsSync(join(defaultDir, "settled.wav"))).toBe(false);
  });

  it("recovers a file that still landed in GarageBand's default folder, and says so", async () => {
    const r = await createGbExport(deps({ placeSettleMs: 0, defaultExportDir: defaultDir }))({ command: "song", filename: "strayed.wav" });
    expect(r).toMatchObject({ status: "verified", data: { path: join(inbox, "strayed.wav"), relocated_from: join(defaultDir, "strayed.wav") } });
    expect(existsSync(join(defaultDir, "strayed.wav"))).toBe(false);
    expect(existsSync(join(inbox, "strayed.wav"))).toBe(true);
  });
});

describe("screen lock", () => {
  it("refuses at once with SCREEN_LOCKED instead of timing out, touching nothing", async () => {
    const r = await createGbExport(deps({ screenLocked: async () => true }))({ command: "song", filename: "locked.wav" });
    expect(r).toMatchObject({ status: "failed", error: "SCREEN_LOCKED", write_attempted: false });
    expect(fake.calls.some((c) => ["ax.press", "ax.menu", "ax.set"].includes(c.op))).toBe(false);
  });
});

describe("gb_export song", () => {
  it("exports WAVE into the workspace inbox, reading every step back, and proves the file", async () => {
    const r = await createGbExport(deps())({ command: "song", filename: "ascent-v2.wav" });
    expect(r).toMatchObject({
      status: "verified", op: "gb_export.song",
      data: { path: join(inbox, "ascent-v2.wav"), seconds: 1.5, sampleRate: 44100, channels: 2, format: "WAVE", destination: "probe-export" },
    });
    expect(fake.app.windows.some((w) => w.id === "save-panel")).toBe(false);
    // the file browser is never walked: every lookup inside the panel prunes outlines
    for (const c of fake.calls.filter((c) => c.op === "ax.find" && (c.params.root as { identifier?: string })?.identifier === "save-panel")) {
      expect(c.params.prune_roles).toEqual(expect.arrayContaining(["AXOutline", "AXBrowser", "AXTable"]));
    }
  });

  it("never overwrites: an existing target fails before anything is pressed", async () => {
    writeFileSync(join(inbox, "taken.wav"), "keep");
    const r = await createGbExport(deps())({ command: "song", filename: "taken.wav" });
    expect(r).toMatchObject({ status: "failed", error: "FILE_EXISTS", write_attempted: false });
    expect(fake.calls.some((c) => c.op === "ax.menu" || c.op === "ax.press")).toBe(false);
  });

  it("refuses when the inbox is not a recent place, and cancels the panel it opened", async () => {
    installPanelBehaviours(["GarageBand", "Music"]);
    const r = await createGbExport(deps())({ command: "song", filename: "a.wav" });
    expect(r).toMatchObject({ status: "failed", error: "TARGET_NOT_FOUND" });
    expect(r.status === "failed" && r.hint).toMatch(/recent place/i);
    expect(fake.app.windows.some((w) => w.id === "save-panel")).toBe(false);
  });

  it("is uncertain (not verified) when the panel closes but no finished file appears", async () => {
    exportWrites = () => {};
    const r = await createGbExport(deps())({ command: "song", filename: "ghost.wav" });
    expect(r).toMatchObject({ status: "uncertain", reason: "readback_timeout", write_attempted: true, safe_to_retry: false });
  });

  it("refuses to act while a dialog is already open (it may be the user's)", async () => {
    fake.app.windows.push({ role: "AXWindow", subrole: "AXDialog", title: "", children: [{ role: "AXStaticText", value: "Do you want to save the document “Mine”?" }] });
    const r = await createGbExport(deps())({ command: "song", filename: "a.wav" });
    expect(r).toMatchObject({ status: "failed", error: "DIALOG_UNEXPECTED", write_attempted: false });
    expect(fake.calls.some((c) => c.op === "ax.menu")).toBe(false);
  });

  it("waits for a buttonless loading window to go away before exporting", async () => {
    const loading: TreeNode = { role: "AXWindow", subrole: "AXDialog", title: "GarageBand", children: [{ role: "AXStaticText", value: "GarageBand" }] };
    fake.app.windows.push(loading);
    let polls = 0;
    const port = {
      call: async (op: string, params?: Record<string, unknown>, opts?: { deadlineMs?: number }) => {
        if (op === "app.state" && ++polls === 3) fake.app.windows.splice(fake.app.windows.indexOf(loading), 1);
        return fake.call(op, params, opts);
      },
      close: () => fake.close(),
    };
    const r = await createGbExport(deps({ helper: port }))({ command: "song", filename: "after-loading.wav" });
    expect(r).toMatchObject({ status: "verified", data: { path: join(inbox, "after-loading.wav") } });
  });

  it("waits for the Export button to become enabled (the panel loads asynchronously) before pressing", async () => {
    let finds = 0;
    const port = {
      call: async (op: string, params?: Record<string, unknown>, opts?: { deadlineMs?: number }) => {
        const panel = fake.app.windows.find((w) => w.id === "save-panel");
        const ok = panel ? findAll(panel, { role: "AXButton", identifier: "OKButton" }).matches[0]?.node : undefined;
        if (ok && op === "ax.find" && (params?.selector as { identifier?: string })?.identifier === "OKButton") {
          ok.enabled = ++finds >= 3; // disabled for the first two looks, like the live panel while it loads
        }
        return fake.call(op, params, opts);
      },
      close: () => fake.close(),
    };
    const r = await createGbExport(deps({ helper: port }))({ command: "song", filename: "after-enable.wav" });
    expect(r).toMatchObject({ status: "verified" });
  });

  it("fails clearly (and cancels) when Export never becomes enabled", async () => {
    const port = {
      call: async (op: string, params?: Record<string, unknown>, opts?: { deadlineMs?: number }) => {
        const panel = fake.app.windows.find((w) => w.id === "save-panel");
        const ok = panel ? findAll(panel, { role: "AXButton", identifier: "OKButton" }).matches[0]?.node : undefined;
        if (ok) ok.enabled = false;
        return fake.call(op, params, opts);
      },
      close: () => fake.close(),
    };
    const r = await createGbExport(deps({ helper: port }))({ command: "song", filename: "never.wav" });
    expect(r).toMatchObject({ status: "failed", error: "TARGET_DISABLED", write_attempted: false });
    expect(r.status === "failed" && r.hint).toMatch(/loading|enabled/i);
    expect(fake.app.windows.some((w) => w.id === "save-panel")).toBe(false);
  });

  it("reports GarageBand not running", async () => {
    fake.app.running = false;
    expect(await createGbExport(deps())({ command: "song", filename: "a.wav" })).toMatchObject({ status: "failed", error: "GB_NOT_RUNNING" });
  });

  it("only accepts safe .wav names", async () => {
    for (const filename of ["../x.wav", "a.mp3", ".hidden.wav", "a/b.wav"]) {
      expect(await createGbExport(deps())({ command: "song", filename })).toMatchObject({ status: "failed", error: "PATH_INVALID" });
    }
    expect(existsSync(join(inbox, "x.wav"))).toBe(false);
  });
});

describe("gb_export song dry_run", () => {
  it("checks the name, the target and GarageBand's state — opens no panel, writes nothing", async () => {
    const r = await createGbExport(deps())({ command: "song", filename: "plan.wav", dry_run: true });
    expect(r).toMatchObject({ status: "verified", data: { dry_run: true, path: join(inbox, "plan.wav"), format: "WAVE", destination: "probe-export" } });
    expect(fake.calls.some((c) => ["ax.menu", "ax.press", "ax.set"].includes(c.op))).toBe(false);
    expect(existsSync(join(inbox, "plan.wav"))).toBe(false);
  });
});

describe("gb_export song: the Export press can report an AX error although it worked", () => {
  const okPressErrs = (exportHappens: boolean) => ({
    call: async (op: string, params?: Record<string, unknown>, opts?: { deadlineMs?: number }) => {
      if (op === "ax.press" && (params?.selector as { identifier?: string })?.identifier === "OKButton") {
        if (exportHappens) await fake.call(op, params, opts); // the panel closes and the file is written…
        return { ok: false as const, error: { code: "NOT_SUPPORTED", message: "press failed (AXError -25205)", details: { ax_error: -25205 } } }; // …yet AX reports an error
      }
      return fake.call(op, params, opts);
    },
    close: () => fake.close(),
  });

  it("judges by the evidence: panel closed + finished WAV → verified, noting the AX error", async () => {
    const r = await createGbExport(deps({ helper: okPressErrs(true) }))({ command: "song", filename: "raced.wav" });
    expect(r).toMatchObject({ status: "verified", data: { path: join(inbox, "raced.wav"), press_error: -25205 } });
  });

  it("panel closed but no file → uncertain, not safe to retry (the export may still land)", async () => {
    exportWrites = () => {};
    const r = await createGbExport(deps({ helper: okPressErrs(true) }))({ command: "song", filename: "lost.wav" });
    expect(r).toMatchObject({ status: "uncertain", write_attempted: true, safe_to_retry: false });
  });

  it("if even the panel check fails after such an error, the state is unknown → uncertain, not safe to retry", async () => {
    const port = okPressErrs(true);
    const wrapped = {
      call: async (op: string, params?: Record<string, unknown>, opts?: { deadlineMs?: number }) =>
        op === "ax.wait" && (params?.selector as { identifier?: string })?.identifier === "save-panel"
          ? { ok: false as const, error: { code: "HELPER_UNAVAILABLE", message: "helper restarted" } }
          : port.call(op, params, opts),
      close: () => fake.close(),
    };
    const r = await createGbExport(deps({ helper: wrapped }))({ command: "song", filename: "unknown.wav" });
    expect(r).toMatchObject({ status: "uncertain", write_attempted: true, safe_to_retry: false });
  });

  it("panel still open after the error → the press really failed: cancel the panel, fail, safe to retry", async () => {
    const r = await createGbExport(deps({ helper: okPressErrs(false) }))({ command: "song", filename: "never.wav" });
    expect(r).toMatchObject({ status: "failed", error: "NOT_SUPPORTED", safe_to_retry: true });
    expect(fake.app.windows.some((w) => w.id === "save-panel")).toBe(false);
  });
});

describe("gb_export song: a slow Where menu (1 of 13 exports needed > 2 s)", () => {
  it("waits up to 5 s for the recent places to appear before giving up", async () => {
    const done = new WeakSet<TreeNode>();
    fake.beforeAction = () => {
      const panel = fake.app.windows.find((w) => w.id === "save-panel");
      if (!panel || done.has(panel)) return;
      done.add(panel);
      const radios = findAll(panel, { role: "AXRadioButton" }).matches.map((m) => m.node);
      for (const r of radios) fake.on(r, { onPress: (n) => radios.forEach((o) => (o.value = o === n ? 1 : 0)) });
      const where = findAll(panel, { role: "AXPopUpButton", identifier: "where popup" }).matches[0]!.node;
      fake.on(where, { onPress: () => fake.schedule(fake.clockMs + 3_000, () => {
        const menu: TreeNode = { role: "AXMenu", children: RECENT_PLACES.map((title) => ({ role: "AXMenuItem", title, actions: ["AXPress"] })) };
        for (const item of menu.children!) fake.on(item, { onPress: () => { where.value = item.title; where.children = []; } });
        where.children = [menu];
      }) });
      const ok = findAll(panel, { role: "AXButton", identifier: "OKButton" }).matches[0]!.node;
      const name = findAll(panel, { role: "AXTextField", identifier: "saveAsNameTextField" }).matches[0]!.node;
      fake.on(ok, { onPress: () => { fake.app.windows.splice(fake.app.windows.indexOf(panel), 1); exportWrites(String(name.value)); } });
    };
    const r = await createGbExport(deps({ sleep: async (ms: number) => fake.sleep(ms) }))({ command: "song", filename: "slow-menu.wav" });
    expect(r).toMatchObject({ status: "verified", data: { path: join(inbox, "slow-menu.wav") } });
  });
});

describe("gb_export song: the panel closes by itself mid-flow", () => {
  const panelClosesOnNameSet = (writesFile: boolean) => {
    const done = new WeakSet<TreeNode>();
    fake.beforeAction = () => {
      const panel = fake.app.windows.find((w) => w.id === "save-panel");
      if (!panel || done.has(panel)) return;
      done.add(panel);
      const radios = findAll(panel, { role: "AXRadioButton" }).matches.map((m) => m.node);
      for (const r of radios) fake.on(r, { onPress: (n) => radios.forEach((o) => (o.value = o === n ? 1 : 0)) });
      const name = findAll(panel, { role: "AXTextField", identifier: "saveAsNameTextField" }).matches[0]!.node;
      fake.on(name, { onSet: (n, v) => {
        n.value = v;
        fake.app.windows.splice(fake.app.windows.indexOf(panel), 1); // GarageBand went ahead on its own
        if (writesFile) exportWrites(String(v));
      } });
    };
  };

  it("judges by the evidence: a finished WAV in the inbox → verified (noting the panel closed by itself), not 'nothing exported'", async () => {
    panelClosesOnNameSet(true);
    const r = await createGbExport(deps())({ command: "song", filename: "self-closed.wav" });
    expect(r).toMatchObject({ status: "verified", data: { path: join(inbox, "self-closed.wav"), panel_closed_unexpectedly: true } });
  });

  it("no file appears → uncertain (an export may still be running): never 'failed, nothing exported, safe to retry'", async () => {
    panelClosesOnNameSet(false);
    const r = await createGbExport(deps())({ command: "song", filename: "vanished.wav" });
    expect(r).toMatchObject({ status: "uncertain", write_attempted: true, safe_to_retry: false });
  });
});
