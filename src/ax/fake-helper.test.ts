// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeEach } from "vitest";
import { FakeHelper, garageBandFixtureApp } from "./fake-helper.js";
import type { TreeNode } from "./selector.js";

const MAIN = { kind: "main_window" };
let fake: FakeHelper;
beforeEach(() => {
  fake = new FakeHelper(garageBandFixtureApp());
});

const value = async (selector: object) => {
  const r = await fake.call("ax.find", { root: MAIN, selector });
  return r.ok ? (r.value as { matches: { value?: unknown }[] }).matches[0]?.value : undefined;
};

describe("FakeAX: app state from the 10.4.14 fixtures", () => {
  it("hello/app.state/perm.check describe a running, trusted GarageBand 10.4.14", async () => {
    expect((await fake.call("hello")).ok).toBe(true);
    expect(await fake.call("app.state")).toMatchObject({ ok: true, value: { running: true, installed: { version: "10.4.14" } } });
    expect(await fake.call("perm.check")).toMatchObject({ ok: true, value: { accessibility: true } });
  });

  it("ax ops fail with GB_NOT_RUNNING when GarageBand is not running (hello still works)", async () => {
    fake.app.running = false;
    expect(await fake.call("ax.find", { root: MAIN, selector: { role: "AXSlider" } })).toMatchObject({ ok: false, error: { code: "GB_NOT_RUNNING" } });
    expect((await fake.call("hello")).ok).toBe(true);
  });

  it("ax ops fail with PERMISSION_AX_DENIED when the helper is not trusted", async () => {
    fake.app.axTrusted = false;
    expect(await fake.call("ax.find", { root: MAIN, selector: { role: "AXSlider" } })).toMatchObject({ ok: false, error: { code: "PERMISSION_AX_DENIED" } });
  });

  it("finds the fixture tempo slider (120 BPM) at the same relative position as the live app", async () => {
    const r = await fake.call("ax.find", { root: MAIN, selector: { role: "AXSlider", description: "Tempo" } });
    expect(r).toMatchObject({ ok: true, value: { count: 1, matches: [{ desc: "Tempo", value: 120, settable: true }] } });
  });
});

describe("FakeAX: simulated GarageBand semantics", () => {
  it("pressing Play toggles it and reports before/after", async () => {
    const r = await fake.call("ax.press", { root: MAIN, selector: { role: "AXCheckBox", title: "Play" } });
    expect(r).toMatchObject({ ok: true, value: { before: { value: 1 }, after: { value: 0 } } });
  });

  it("muting a track appends ', mute' to the track's description ", async () => {
    const track1 = { role: "AXLayoutItem", description: "Track 1 “Soft Saw Lead”" };
    await fake.call("ax.press", { root: MAIN, selector: { role: "AXCheckBox", description: "Mute", ancestors: [track1] } });
    const items = await fake.call("ax.find", { root: MAIN, selector: { role: "AXLayoutItem", ancestors: [{ description: "Tracks header" }] } });
    expect(items.ok && (items.value as { matches: { desc: string }[] }).matches.map((m) => m.desc)).toEqual([
      "Track 1 “Soft Saw Lead”, mute", "Track 2 “Taureg Moon Bass”",
    ]);
    expect(await fake.call("ax.find", { root: MAIN, selector: track1 })).toMatchObject({ ok: true, value: { count: 0 } });
  });

  it("a tempo set moves ONE step ; converge reaches the target with read-back", async () => {
    const tempo = { role: "AXSlider", description: "Tempo" };
    expect(await fake.call("ax.set", { root: MAIN, selector: tempo, value: 98 })).toMatchObject({ ok: true, value: { before: 120, after: 119 } });
    expect(await fake.call("ax.converge", { root: MAIN, selector: tempo, target: 98 }, { deadlineMs: 10_000 })).toMatchObject({
      ok: true, value: { converged: true, after: 98, steps: 21 },
    });
  });

  it("a converge that outruns its deadline reports partial progress instead of pretending", async () => {
    const r = await fake.call("ax.converge", { root: MAIN, selector: { role: "AXSlider", description: "Tempo" }, target: 60 }); // default 2 s
    expect(r).toMatchObject({ ok: true, value: { converged: false, deadline_exceeded: true, before: 120 } });
    expect(r.ok && (r.value as { after: number }).after).toBeLessThan(120);
  });

  it("Share ▸ Export Song to Disk… opens the export dialog; Cancel closes it", async () => {
    const opened = await fake.call("ax.menu", { path: ["Share", "Export Song to Disk…"] });
    expect(opened).toMatchObject({ ok: true, value: { pressed: true } });
    const dialog = { kind: "dialog", identifier: "save-panel" };
    expect(await fake.call("ax.find", { root: dialog, selector: { identifier: "saveAsNameTextField" } })).toMatchObject({ ok: true, value: { count: 1 } });
    await fake.call("ax.press", { root: dialog, selector: { role: "AXButton", identifier: "CancelButton" } });
    expect(await fake.call("ax.wait", { root: dialog, selector: { role: "AXWindow" }, condition: "absent" })).toMatchObject({ ok: true, value: { satisfied: true } });
  });

  it("ambiguity, identity drift and unknown ops use the same codes as the Swift helper", async () => {
    expect(await fake.call("ax.press", { root: MAIN, selector: { role: "AXCheckBox", description: "Mute" } }))
      .toMatchObject({ ok: false, error: { code: "TARGET_AMBIGUOUS" } });
    expect(await fake.call("ax.press", { root: MAIN, selector: { role: "AXCheckBox", title: "Play" }, expect: { desc: "Record" } }))
      .toMatchObject({ ok: false, error: { code: "TARGET_CHANGED" } });
    expect(await fake.call("shell.exec", {})).toMatchObject({ ok: false, error: { code: "UNKNOWN_OP" } });
  });

  it("failNext injects a helper failure for the next call of an op", async () => {
    fake.failNext("ax.find", { code: "DEADLINE_EXCEEDED", message: "simulated" });
    expect(await fake.call("ax.find", { root: MAIN, selector: { role: "AXSlider" } })).toMatchObject({ ok: false, error: { code: "DEADLINE_EXCEEDED" } });
    expect((await fake.call("ax.find", { root: MAIN, selector: { role: "AXSlider", description: "Tempo" } })).ok).toBe(true);
  });

  it("records every call so tests can prove nothing was pressed", async () => {
    await value({ role: "AXSlider", description: "Tempo" });
    expect(fake.calls.map((c) => c.op)).toEqual(["ax.find"]);
  });
});

describe("FakeAX main_window: the project chooser is never the project", () => {
  it("skips the chooser, and finds nothing when only the chooser is open", async () => {
    const fake = new FakeHelper();
    const chooser: TreeNode = { role: "AXWindow", subrole: "AXStandardWindow", title: "Choose a Project", id: "newProjectDialog",
      children: [{ role: "AXButton", title: "Choose", actions: ["AXPress"] }] };
    fake.app.windows.unshift(chooser);
    expect(await fake.call("ax.find", { root: { kind: "main_window" }, selector: { role: "AXSlider", description: "Tempo" } })).toMatchObject({ ok: true, value: { count: 1 } });
    fake.app.windows = [chooser];
    expect(await fake.call("ax.find", { root: { kind: "main_window" }, selector: { role: "AXButton", title: "Choose" } })).toMatchObject({ ok: false, error: { code: "TARGET_NOT_FOUND" } });
  });
});
