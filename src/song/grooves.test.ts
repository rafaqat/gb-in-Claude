// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { GROOVES, GROOVE_NAMES, grooveFeel } from "./grooves.js";
import { humanize, type RoleTrack } from "./humanize.js";
import { parseSong } from "./schema.js";

const PPQ = 480;
const SIXTEENTH = PPQ / 4;
const drums = (hits: { step: number; pitch: number }[], bars = 8): RoleTrack => ({
  name: "Drums", channel: 9, program: 0, role: "drums",
  notes: Array.from({ length: bars }, (_, b) => hits.map((h) => ({ pitch: h.pitch, startTick: b * 16 * SIXTEENTH + h.step * SIXTEENTH, durationTicks: 60, velocity: 100 }))).flat(),
});

describe("grooves mined from the Groove MIDI Dataset (M9)", () => {
  it("carries the 4/4 styles, each with per-step probability, velocity and timing for its voices", () => {
    expect(GROOVE_NAMES).toEqual(expect.arrayContaining(["funk", "hiphop", "jazz", "rock", "soul", "afrobeat", "latin", "reggae", "pop", "dance"]));
    const funk = GROOVES.funk!.voices.snare!;
    expect(funk.p).toHaveLength(16);
    expect(funk.velocity).toHaveLength(16);
    expect(funk.offset).toHaveLength(16);
  });

  it("moves each hit by its style's measured offset (a laid-back hip-hop snare lands late on the backbeat)", () => {
    const feel = grooveFeel("hiphop");
    const offset = GROOVES.hiphop!.voices.snare!.offset[4]!; // fraction of a 16th
    const tempo = 90;
    const [t] = humanize([drums([{ step: 4, pitch: 38 }])], { feel: "natural", seed: 1, tempoBpm: tempo, ppq: PPQ, groove: feel });
    const mean = t!.notes.reduce((s, n) => s + ((n.startTick % (16 * SIXTEENTH)) - 4 * SIXTEENTH), 0) / t!.notes.length;
    const expectedTicks = offset * SIXTEENTH;
    expect(Math.sign(mean)).toBe(Math.sign(expectedTicks));
    expect(Math.abs(mean - expectedTicks)).toBeLessThan(SIXTEENTH * 0.08);
  });

  it("accents the steps the style accents: funk's backbeat snare is louder than its ghost notes", () => {
    const g = GROOVES.funk!.voices.snare!;
    const [t] = humanize([drums([{ step: 4, pitch: 38 }, { step: 1, pitch: 38 }])], { feel: "natural", seed: 1, tempoBpm: 100, ppq: PPQ, groove: grooveFeel("funk") });
    const vel = (step: number) => t!.notes.filter((n) => Math.round((n.startTick % (16 * SIXTEENTH)) / SIXTEENTH) === step).reduce((s, n, _, a) => s + n.velocity / a.length, 0);
    expect(g.velocity[4]!).toBeGreaterThan(g.velocity[1]!);
    expect(vel(4)).toBeGreaterThan(vel(1) + 10);
  });

  it("Song JSON takes `groove` (a mined style) and refuses an unknown one", () => {
    const base = { title: "T", tempo: 90, sections: [{ name: "a", bars: 2 }], tracks: [{ name: "Drums", role: "drums", parts: { a: { grid: { kick: "x..." } } } }] };
    expect(parseSong({ ...base, groove: "hiphop" })).toMatchObject({ ok: true, value: { groove: "hiphop" } });
    expect(parseSong({ ...base, groove: "polka" })).toMatchObject({ ok: false, error: { path: "groove" } });
  });
});

describe("groove timing is trusted as far as drummers actually play the step (m9b)", () => {
  it("shrinks the offset of a rarely played step, keeps the offset of a step that is played most bars", () => {
    const pop = GROOVES.pop!.voices.kick!;
    const rare = pop.p.findIndex((p, i) => p > 0 && p < 0.1 && Math.abs(pop.offset[i]!) > 0.1);
    const common = pop.p.findIndex((p) => p >= 0.5);
    expect(rare).toBeGreaterThanOrEqual(0);
    const feel = grooveFeel("pop").get(36)!;
    expect(Math.abs(feel.offset[rare]!)).toBeLessThan(Math.abs(pop.offset[rare]!) * 0.35);
    expect(feel.offset[common]).toBeCloseTo(pop.offset[common]!, 6);
  });
});
