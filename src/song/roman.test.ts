// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { romanToChords, chordTones } from "./roman.js";

describe("Roman numerals → chord symbols in a key (M9)", () => {
  it.each([
    ["i | VI | III | VII", "F minor", "Fm | Db | Ab | Eb"],
    ["I | V | vi | IV", "C major", "C | G | Am | F"],
    ["ii7 V7 | Imaj7", "F major", "Gm7 C7 | Fmaj7"],
    ["i9 | iv9 | VImaj7 | V7", "C minor", "Cm9 | Fm9 | Abmaj7 | G7"],
    ["iiø V7 | i", "D minor", "Em7b5 A7 | Dm"],
    ["I | bVII | IV", "D major", "D | C | G"],
  ])("%s in %s → %s", (roman, key, chords) => {
    expect(romanToChords(roman, key)).toBe(chords);
  });

  it("gives the chord tones of a symbol (root, third, fifth, seventh) as note names", () => {
    expect(chordTones("Fm7")).toEqual(["f", "ab", "c", "eb"]);
    expect(chordTones("G7")).toEqual(["g", "b", "d", "f"]);
  });
});
