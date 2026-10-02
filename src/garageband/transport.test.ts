// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeEach } from "vitest";
import { createGbTransport } from "./transport.js";
import { FakeHelper } from "../ax/fake-helper.js";
import { findAll } from "../ax/selector.js";

let fake: FakeHelper;
const deps = (over = {}) => ({
  helper: fake, sleep: async () => {}, pollMs: 1,
  screenLocked: async () => false, // hermetic: never read the real machine's lock state
  ...over,
});
const MUTATING = ["ax.press", "ax.set", "ax.converge", "ax.click", "ax.perform", "app.activate"];
const mutated = () => fake.calls.some((c) => MUTATING.includes(c.op) || (c.op === "ax.menu" && c.params.dry_run !== true));

beforeEach(() => {
  fake = new FakeHelper(); // fixture: playing, 120 BPM, metronome on, count-in 1 bar, playhead bar 2 beat 4
});

describe("gb_transport state", () => {
  it("reads playing, tempo, metronome, cycle, count-in and the playhead — read-only (menus only dry-run)", async () => {
    const r = await createGbTransport(deps())({ command: "state" });
    expect(r).toMatchObject({
      status: "verified", op: "gb_transport.state",
      data: { playing: true, tempo: 120, metronome: true, cycle: false, count_in_bars: 1, playhead: { bar: 2, beat: 4 } },
    });
    expect(mutated()).toBe(false);
  });
});

describe("gb_transport play / stop — explicit target state", () => {
  it("stop while playing presses Stop and is proven by Play reading 0", async () => {
    const r = await createGbTransport(deps())({ command: "stop" });
    expect(r).toMatchObject({ status: "verified", op: "gb_transport.stop", data: { playing: false, changed: true } });
  });

  it("play while already playing is a verified no-op; after a stop, play presses Play and reads it back", async () => {
    const t = createGbTransport(deps());
    expect(await t({ command: "play" })).toMatchObject({ status: "verified", data: { changed: false } });
    expect(mutated()).toBe(false);
    await t({ command: "stop" });
    expect(await t({ command: "play" })).toMatchObject({ status: "verified", data: { playing: true, changed: true } });
  });

  it("dry_run touches nothing", async () => {
    expect(await createGbTransport(deps())({ command: "stop", dry_run: true })).toMatchObject({ status: "verified", data: { dry_run: true, playing: true } });
    expect(mutated()).toBe(false);
  });

  it("Stop pressed but playback never reads stopped → uncertain, never verified, not safe to retry", async () => {
    const stop = findAll(fake.app.windows[0]!, { role: "AXButton", description: "Stop" }).matches[0]!.node;
    fake.on(stop, { onPress: () => {} });
    expect(await createGbTransport(deps())({ command: "stop" })).toMatchObject({ status: "uncertain", write_attempted: true, safe_to_retry: false });
  });
});

describe("gb_transport rewind — the Stop button reads “Go to Beginning” only while stopped (live)", () => {
  it("while stopped: presses Go to Beginning, proven by the playhead reading bar 1 beat 1", async () => {
    const t = createGbTransport(deps());
    await t({ command: "stop" });
    expect(await t({ command: "rewind" })).toMatchObject({ status: "verified", op: "gb_transport.rewind", data: { playhead: { bar: 1, beat: 1 }, changed: true } });
  });

  it("while playing: refuses (pressing that button would stop playback instead), touching nothing", async () => {
    const r = await createGbTransport(deps())({ command: "rewind" });
    expect(r).toMatchObject({ status: "failed", error: "NOT_SUPPORTED", write_attempted: false });
    expect(r.status === "failed" && r.hint).toMatch(/stop/);
    expect(mutated()).toBe(false);
  });
});

describe("gb_transport set_tempo / set_metronome / set_count_in", () => {
  it("set_tempo converges the stepwise tempo slider and reads it back", async () => {
    const r = await createGbTransport(deps())({ command: "set_tempo", bpm: 126 });
    expect(r).toMatchObject({ status: "verified", op: "gb_transport.set_tempo", data: { tempo: 126, from: 120, changed: true } });
    expect(fake.calls.some((c) => c.op === "ax.converge")).toBe(true);
  });

  it("set_metronome to an explicit state: off presses once and reads back; off again is a no-op", async () => {
    const t = createGbTransport(deps());
    expect(await t({ command: "set_metronome", enabled: false })).toMatchObject({ status: "verified", data: { metronome: false, changed: true } });
    const presses = fake.calls.filter((c) => c.op === "ax.press").length;
    expect(await t({ command: "set_metronome", enabled: false })).toMatchObject({ status: "verified", data: { changed: false } });
    expect(fake.calls.filter((c) => c.op === "ax.press").length).toBe(presses);
  });

  it("set_count_in picks Record ▸ Count-in ▸ 2 Bars and is proven by the checkmark moving there", async () => {
    const t = createGbTransport(deps());
    expect(await t({ command: "set_count_in", bars: 2 })).toMatchObject({ status: "verified", data: { count_in_bars: 2, before: 1 } });
    expect(await t({ command: "state" })).toMatchObject({ data: { count_in_bars: 2 } });
  });

  it("every setter's dry_run plans and touches nothing", async () => {
    const t = createGbTransport(deps());
    for (const cmd of [{ command: "set_tempo", bpm: 140 }, { command: "set_metronome", enabled: false }, { command: "set_count_in", bars: 0 }]) {
      expect(await t({ ...cmd, dry_run: true })).toMatchObject({ status: "verified", data: { dry_run: true } });
    }
    expect(mutated()).toBe(false);
  });

  it("a count-in choice whose checkmark never moves is uncertain, not verified", async () => {
    const two = findAll(fake.app.menubar, { role: "AXMenuItem", title: "2 Bars", ancestors: [{ title: "Count-in" }] }).matches[0]!.node;
    fake.on(two, { onPress: () => {} });
    expect(await createGbTransport(deps())({ command: "set_count_in", bars: 2 })).toMatchObject({ status: "uncertain", write_attempted: true });
  });

  it("set_tempo to the current tempo is a verified no-op with no write", async () => {
    expect(await createGbTransport(deps())({ command: "set_tempo", bpm: 120 })).toMatchObject({ status: "verified", data: { tempo: 120, changed: false } });
    expect(mutated()).toBe(false);
  });

  it("GarageBand refreshes the checkmark lazily — a stale mark never yields a false no-op", async () => {
    // pressing an item moves the mark only ~0.8 s later (the press itself works at once)
    const items = findAll(fake.app.menubar, { role: "AXMenuItem", ancestors: [{ title: "Count-in" }] }).matches.map((m) => m.node);
    for (const item of items) fake.on(item, { onPress: (n) => fake.schedule(fake.clockMs + 800, () => { for (const o of items) o.mark = o === n ? "✓" : undefined; }) });
    const t = createGbTransport(deps({ sleep: async (ms: number) => fake.sleep(ms) }));
    expect(await t({ command: "set_count_in", bars: 2 })).toMatchObject({ status: "verified", data: { count_in_bars: 2 } });
    // the user switches back to 1 bar by hand; the mark has not caught up yet and still shows 2
    const one = items.find((i) => i.title === "1 Bar")!;
    await fake.call("ax.menu", { path: ["Record", "Count-in", "1 Bar"] });
    expect(one.mark).toBeUndefined();
    // asking for 2 bars must still choose “2 Bars” (idempotent), not trust the stale mark and do nothing
    const before = fake.calls.length;
    expect(await t({ command: "set_count_in", bars: 2 })).toMatchObject({ status: "verified", data: { count_in_bars: 2 } });
    expect(fake.calls.slice(before).some((c) => c.op === "ax.menu" && c.params.dry_run !== true && JSON.stringify(c.params.path).includes("2 Bars"))).toBe(true);
  });
});

describe("an unreadable control is unknown — never “off”, never a verified no-op", () => {
  const removePlay = () => {
    const bar = findAll(fake.app.windows[0]!, { role: "AXGroup", description: "Control Bar" }).matches[0]!.node;
    const strip = (n: { children?: { role?: string; title?: string }[] }) => {
      n.children = (n.children ?? []).filter((c) => !(c.role === "AXCheckBox" && c.title === "Play"));
      n.children.forEach((c) => strip(c as never));
    };
    strip(bar as never);
  };

  it("stop with the Play button unreadable fails instead of claiming playback is already stopped", async () => {
    removePlay();
    const r = await createGbTransport(deps())({ command: "stop" });
    expect(r.status).toBe("failed");
    expect(mutated()).toBe(false);
  });

  it("state reports unknown (null), not false", async () => {
    removePlay();
    expect(await createGbTransport(deps())({ command: "state" })).toMatchObject({ status: "verified", data: { playing: null } });
  });

  it("after a press the ABSOLUTE state is checked (a stale pre-read must not be trusted)", async () => {
    const metronome = findAll(fake.app.windows[0]!, { role: "AXCheckBox", title: "Metronome Click" }).matches[0]!.node;
    // the user switched the metronome off by hand just before: our pre-read (on) is stale by press time
    let switched = false;
    fake.beforeAction = () => { if (!switched && metronome.value === 1) { metronome.value = 0; switched = true; } };
    const r = await createGbTransport(deps())({ command: "set_metronome", enabled: false });
    expect(r.status).not.toBe("verified"); // the press turned it back ON: reporting "off, verified" would be a lie
  });
});

describe("gb_transport state fields mask", () => {
  it("returns only the requested fields and skips reads it does not need (no count-in menu walk)", async () => {
    const r = await createGbTransport(deps())({ command: "state", fields: ["playing", "tempo"] });
    expect((r as { data: unknown }).data).toEqual({ playing: true, tempo: 120 });
    expect(fake.calls.some((c) => c.op === "ax.menu")).toBe(false);
  });
});
