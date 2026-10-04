// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { notesToPart } from "./infill.js";
import { parseNotes } from "../composition/mini-notation.js";

// 120 BPM, 4/4: a 16th is 0.125 s, a bar 2 s
const at = (startS: number) => ({ startS, bpm: 120, beatsPerBar: 4, bars: 2 });

describe("AMT notes → Song JSON notes (M10)", () => {
  it("writes each bar as 16 shares: notes with their length in 16ths, rests, chords", () => {
    const part = notesToPart([
      { pitch: 60, start_s: 10.0, dur_s: 0.5 },   // bar 1, beat 1, a quarter
      { pitch: 64, start_s: 10.0, dur_s: 0.5 },   // with it: a chord
      { pitch: 67, start_s: 11.0, dur_s: 0.25 },  // bar 1, beat 3, an 8th
      { pitch: 72, start_s: 12.5, dur_s: 1.0 },   // bar 2, beat 2, a half
    ], at(10));
    expect(part).toBe("[c4,e4]@4 ~ ~ ~ ~ g4@2 ~ ~ ~ ~ ~ ~ | ~ ~ ~ ~ c5@8 ~ ~ ~ ~");
  });

  it("the result parses as Song JSON notes and spans exactly the section's bars", () => {
    const part = notesToPart([{ pitch: 62, start_s: 10.05, dur_s: 0.3 }, { pitch: 65, start_s: 13.9, dur_s: 0.4 }], at(10));
    const parsed = parseNotes(part, 4);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.bars).toBe(2);
  });

  it("cuts a note that runs past the next note or the section end", () => {
    const part = notesToPart([{ pitch: 60, start_s: 10.0, dur_s: 3.0 }, { pitch: 62, start_s: 10.5, dur_s: 9 }], at(10));
    expect(part).toBe("c4@4 d4@12 | d4@16");
  });

  it("an empty section is all rests", () => {
    expect(notesToPart([], at(10))).toBe("~@16 | ~@16");
  });
});
