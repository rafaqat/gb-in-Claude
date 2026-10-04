// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { applySwing } from "./swing.js";
import { parseSong } from "./schema.js";
import type { RoleTrack } from "./humanize.js";

const PPQ = 480;
const track = (ticks: number[]): RoleTrack => ({ name: "Hats", channel: 9, program: 0, role: "drums",
  notes: ticks.map((t) => ({ pitch: 42, startTick: t, durationTicks: 60, velocity: 90 })) });

describe("swing (m9b): off-beat notes are delayed by a percentage, like a drum machine", () => {
  it("16th swing at 66 % delays every second 16th by 0.32 of a 16th and leaves the on-beat 16ths alone", () => {
    const [t] = applySwing([track([0, 120, 240, 360])], { percent: 66, unit: "16th", ppq: PPQ });
    expect(t!.notes.map((n) => n.startTick)).toEqual([0, 158, 240, 398]);
  });

  it("8th swing (jazz) delays every second 8th; 16ths in between are left alone", () => {
    const [t] = applySwing([track([0, 120, 240, 480])], { percent: 62, unit: "8th", ppq: PPQ });
    expect(t!.notes.map((n) => n.startTick)).toEqual([0, 120, 298, 480]);
  });

  it("50 % is straight: nothing moves", () => {
    const [t] = applySwing([track([0, 120, 240])], { percent: 50, unit: "16th", ppq: PPQ });
    expect(t!.notes.map((n) => n.startTick)).toEqual([0, 120, 240]);
  });

  it("Song JSON takes swing 50–75 and swingUnit; refuses 80", () => {
    const base = { title: "T", tempo: 132, sections: [{ name: "a", bars: 1 }], tracks: [{ name: "D", role: "drums", parts: { a: { grid: { hat: "x.x." } } } }] };
    expect(parseSong({ ...base, swing: 62, swingUnit: "16th" })).toMatchObject({ ok: true, value: { swing: 62 } });
    expect(parseSong({ ...base, swing: 80 })).toMatchObject({ ok: false, error: { path: "swing" } });
  });
});

describe("glide (m9b): a track whose notes run legato into the next, so a mono 808 slides", () => {
  it("a bass track with glide overlaps each note into the next different note; without glide it does not", async () => {
    const { humanize } = await import("./humanize.js");
    const bass = (glide?: boolean): RoleTrack => ({ name: "808", channel: 1, program: 38, role: "bass", ...(glide ? { glide } : {}),
      notes: [{ pitch: 31, startTick: 0, durationTicks: 400, velocity: 100 }, { pitch: 43, startTick: 480, durationTicks: 400, velocity: 100 }] });
    const opts = { feel: "off" as const, seed: 1, tempoBpm: 140, ppq: PPQ };
    const glided = humanize([bass(true)], { ...opts, feel: "tight" })[0]!.notes.sort((a, b) => a.startTick - b.startTick);
    expect(glided[0]!.startTick + glided[0]!.durationTicks).toBeGreaterThan(glided[1]!.startTick);
    const plain = humanize([bass(false)], { ...opts, feel: "tight" })[0]!.notes.sort((a, b) => a.startTick - b.startTick);
    expect(plain[0]!.startTick + plain[0]!.durationTicks).toBeLessThanOrEqual(plain[1]!.startTick);
  });

  it("Song JSON takes glide on a track", () => {
    const song = { title: "T", tempo: 140, sections: [{ name: "a", bars: 1 }], tracks: [{ name: "808", role: "bass", glide: true, parts: { a: { notes: "g1@3 g2" } } }] };
    expect(parseSong(song)).toMatchObject({ ok: true, value: { tracks: [{ glide: true }] } });
  });
});
