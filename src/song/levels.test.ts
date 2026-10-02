// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { scaleVelocity, applyTrackLevels } from "./levels.js";

describe("scaleVelocity (GM curve: dB = 40·log10(v'/v))", () => {
  it.each([
    [100, 0, 100],
    [100, -6, 71],
    [100, -12, 50],
    [64, 6, 90],
    [127, 6, 127], // clamped to MIDI max
    [10, -24, 3],
    [1, -24, 1], // never 0 (that would be a note-off)
  ])("velocity %i at %i dB → %i", (v, db, expected) => {
    expect(scaleVelocity(v, db)).toBe(expected);
  });
});

describe("applyTrackLevels", () => {
  it("scales every note of a track by its level and leaves level-less tracks alone", () => {
    const tracks = [
      { name: "Drums", channel: 10, notes: [{ pitch: 36, startTick: 0, durationTicks: 120, velocity: 100 }] },
      { name: "Pad", channel: 1, notes: [{ pitch: 60, startTick: 0, durationTicks: 480, velocity: 80 }] },
    ];
    const out = applyTrackLevels(tracks, { Drums: -6 });
    expect(out[0]!.notes[0]!.velocity).toBe(71);
    expect(out[1]!.notes[0]!.velocity).toBe(80);
    expect(tracks[0]!.notes[0]!.velocity).toBe(100); // pure: input untouched
  });
});
