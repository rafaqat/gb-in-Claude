// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { voiceChord, renderPadSpan } from "./pad-patterns.js";
import { parseChord, type Chord } from "./chord.js";

const chord = (s: string): Chord => {
  const r = parseChord(s);
  if (!r.ok) throw new Error(s);
  return r.value;
};

describe("voiceChord", () => {
  it("without a previous chord: close root position from the octave (Fm, oct 3 → F3 Ab3 C4)", () => {
    expect(voiceChord(chord("Fm"), 3)).toEqual([53, 56, 60]);
  });

  it("with a previous chord: picks the inversion with the least total movement (Fm → Db = F3 Ab3 Db4)", () => {
    expect(voiceChord(chord("Db"), 3, [53, 56, 60])).toEqual([53, 56, 61]);
  });

  it("keeps the whole progression Fm–Db–Ab–Eb within a narrow band (no octave jumps)", () => {
    let prev: number[] | undefined;
    const all: number[] = [];
    for (const s of ["Fm", "Db", "Ab", "Eb"]) {
      prev = voiceChord(chord(s), 3, prev);
      all.push(...prev);
    }
    expect(Math.max(...all) - Math.min(...all)).toBeLessThanOrEqual(12);
  });
});

describe("renderPadSpan", () => {
  it("sustain holds the voicing for the whole span", () => {
    expect(renderPadSpan("sustain", [53, 56, 60], 4)).toEqual([
      { pitch: 53, startBeat: 0, durationBeats: 4, velocity: 76 },
      { pitch: 56, startBeat: 0, durationBeats: 4, velocity: 76 },
      { pitch: 60, startBeat: 0, durationBeats: 4, velocity: 76 },
    ]);
  });

  it("stabs hit the voicing on every offbeat, short", () => {
    const notes = renderPadSpan("stabs", [53, 56, 60], 4);
    expect([...new Set(notes.map((n) => n.startBeat))]).toEqual([0.5, 1.5, 2.5, 3.5]);
    expect(notes).toHaveLength(12);
    for (const n of notes) expect(n.durationBeats).toBeLessThanOrEqual(0.25);
  });
});
