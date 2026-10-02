// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { renderBassBar } from "./bass-patterns.js";
import { parseChord, type Chord } from "./chord.js";

const chord = (symbol: string): Chord => {
  const result = parseChord(symbol);
  if (!result.ok) throw new Error(`bad fixture ${symbol}`);
  return result.value;
};

describe("renderBassBar", () => {
  it("sustain: holds the bass note for the whole bar (Fm, octave 2 → F2 = 41)", () => {
    expect(renderBassBar("sustain", chord("Fm"), 2)).toEqual([
      { pitch: 41, startBeat: 0, durationBeats: 4, velocity: 96 },
    ]);
  });

  describe("rolling", () => {
    const notes = renderBassBar("rolling", chord("Gm"), 2);
    it("fills the three 16ths after each beat, never the downbeat", () => {
      expect(notes.map((n) => n.startBeat)).toEqual([0.25, 0.5, 0.75, 1.25, 1.5, 1.75, 2.25, 2.5, 2.75, 3.25, 3.5, 3.75]);
    });
    it("plays the chord's bass note, each note shorter than a 16th", () => {
      for (const n of notes) {
        expect(n.pitch % 12).toBe(7); // G
        expect(n.durationBeats).toBeLessThanOrEqual(0.25);
      }
    });
  });

  it("renders over a partial bar when a chord lasts 2 beats", () => {
    expect(renderBassBar("offbeat", chord("Fm"), 2, 2).map((n) => n.startBeat)).toEqual([0.5, 1.5]);
  });

  describe("octave", () => {
    const notes = renderBassBar("octave", chord("Em"), 2);
    it("alternates root and the octave above on every 8th, offbeats up", () => {
      expect(notes.map((n) => [n.startBeat, n.pitch])).toEqual([
        [0, 40], [0.5, 52], [1, 40], [1.5, 52], [2, 40], [2.5, 52], [3, 40], [3.5, 52],
      ]);
    });
  });

  describe("offbeat", () => {
    const notes = renderBassBar("offbeat", chord("Fm"), 2);

    it("plays exactly on the 'and' of every beat, never on a downbeat", () => {
      expect(notes.map((n) => n.startBeat)).toEqual([0.5, 1.5, 2.5, 3.5]);
    });

    it("ends every note before the next kick (downbeat)", () => {
      for (const n of notes) expect(n.startBeat + n.durationBeats).toBeLessThanOrEqual(Math.ceil(n.startBeat));
    });

    it("uses the chord's bass pitch class (octave jumps allowed) and valid velocities", () => {
      for (const n of notes) {
        expect(n.pitch % 12).toBe(5); // F
        expect(n.velocity).toBeGreaterThanOrEqual(1);
        expect(n.velocity).toBeLessThanOrEqual(127);
      }
    });

    it("follows slash-chord bass notes (Db/F plays F, not Db)", () => {
      for (const n of renderBassBar("offbeat", chord("Db/F"), 2)) expect(n.pitch % 12).toBe(5);
    });
  });
});
