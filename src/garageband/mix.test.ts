// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeEach } from "vitest";
import { createGbMix } from "./mix.js";
import { FakeHelper } from "../ax/fake-helper.js";

let fake: FakeHelper;
const deps = (over = {}) => ({
  helper: fake, sleep: async () => {}, pollMs: 1,
  screenLocked: async () => false, // hermetic: never read the real machine's lock state
  ...over,
});
const MUTATING = ["ax.press", "ax.set", "ax.converge", "ax.click", "ax.perform", "ax.menu", "app.activate"];
const mutated = () => fake.calls.some((c) => MUTATING.includes(c.op));

beforeEach(() => {
  fake = new FakeHelper(); // fixture headers: volume 173 (unity), pan 64 (centre)
});

describe("gb_mix get", () => {
  it("reads each track's fader (raw 0–233, 173 = unity) and pan (−64…+63, 0 = centre) — read-only", async () => {
    const r = await createGbMix(deps())({ command: "get" });
    expect(r).toMatchObject({
      status: "verified", op: "gb_mix.get",
      data: { tracks: [
        { number: 1, patch: "Soft Saw Lead", volume: { raw: 173, db: 0 }, pan: 0, muted: false, soloed: false },
        { number: 2, patch: "Taureg Moon Bass", volume: { raw: 173, db: 0 }, pan: 0, muted: false, soloed: false },
      ] },
    });
    expect(mutated()).toBe(false);
  });
});

describe("gb_mix set_pan / set_volume", () => {
  it("set_pan converges track 2's pan knob to −20 (raw 44) and leaves track 1 alone", async () => {
    const mix = createGbMix(deps());
    expect(await mix({ command: "set_pan", track: 2, pan: -20 })).toMatchObject({ status: "verified", op: "gb_mix.set_pan", data: { track: 2, pan: -20, from: 0, changed: true } });
    expect(await mix({ command: "get" })).toMatchObject({ data: { tracks: [{ number: 1, pan: 0 }, { number: 2, pan: -20 }] } });
  });

  it("set_volume by raw fader value converges only that track's fader", async () => {
    const mix = createGbMix(deps());
    expect(await mix({ command: "set_volume", track: "Soft Saw Lead", raw: 150 }))
      .toMatchObject({ status: "verified", op: "gb_mix.set_volume", data: { track: 1, volume: { raw: 150 }, from: { raw: 173 }, changed: true } });
    expect(await mix({ command: "get" })).toMatchObject({ data: { tracks: [{ volume: { raw: 150 } }, { volume: { raw: 173 } }] } });
  });

  it("set_volume needs exactly one of raw / db", async () => {
    const mix = createGbMix(deps());
    expect(await mix({ command: "set_volume", track: 1 })).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
    expect(await mix({ command: "set_volume", track: 1, raw: 100, db: -3 })).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
    expect(mutated()).toBe(false);
  });

  it("dry_run plans and touches nothing; a value already in place is a verified no-op", async () => {
    const mix = createGbMix(deps());
    expect(await mix({ command: "set_volume", track: 1, raw: 100, dry_run: true })).toMatchObject({ status: "verified", data: { dry_run: true, to: { raw: 100 } } });
    expect(await mix({ command: "set_pan", track: 2, pan: 0 })).toMatchObject({ status: "verified", data: { changed: false } });
    expect(mutated()).toBe(false);
  });

  it("set_volume by db uses the measured taper (−3 dB → raw 143) and reports both", async () => {
    expect(await createGbMix(deps())({ command: "set_volume", track: 2, db: -3 }))
      .toMatchObject({ status: "verified", data: { track: 2, volume: { raw: 143, db: -3 }, from: { raw: 173, db: 0 }, changed: true } });
  });

  it("a gain outside the measured range (−18.2…+6 dB) is refused by the schema, never extrapolated", async () => {
    for (const db of [-30, 6.5]) {
      const r = await createGbMix(deps())({ command: "set_volume", track: 1, db });
      expect(r).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
      expect(r.status === "failed" && r.message).toMatch(/db/);
    }
    expect(mutated()).toBe(false);
  });
});

describe("gb_mix get fields mask", () => {
  it("returns only the requested fields per track (number always kept)", async () => {
    const r = await createGbMix(deps())({ command: "get", fields: ["pan"] });
    expect((r as { data: { tracks: unknown[] } }).data.tracks).toEqual([{ number: 1, pan: 0 }, { number: 2, pan: 0 }]);
  });
});
