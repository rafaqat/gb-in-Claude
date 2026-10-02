// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { parseNotes } from "./mini-notation.js";

describe("parseNotes: weights, bars, chords", () => {
  it("@n gives a token n shares of the bar", () => {
    const out = parseNotes("eb6@2 c6 ~", 4);
    expect(out.ok && out.value.events).toEqual([
      { startBeat: 0, durationBeats: 2, pitches: [87] },
      { startBeat: 2, durationBeats: 1, pitches: [84] },
    ]);
  });

  it("| separates bars; positions continue across bars", () => {
    const out = parseNotes("c5 | d5 e5", 4);
    expect(out.ok && out.value).toEqual({
      bars: 2,
      events: [
        { startBeat: 0, durationBeats: 4, pitches: [72] },
        { startBeat: 4, durationBeats: 2, pitches: [74] },
        { startBeat: 6, durationBeats: 2, pitches: [76] },
      ],
    });
  });

  it("[a,b,c] is a chord sharing one slot; it can carry @n", () => {
    const out = parseNotes("[f4,ab4,c5]@3 ~", 4);
    expect(out.ok && out.value.events).toEqual([{ startBeat: 0, durationBeats: 3, pitches: [65, 68, 72] }]);
  });

  it.each([
    ["bad pitch", "f5 h5"],
    ["zero weight", "c5@0"],
    ["unclosed chord", "[c4,e4 g4]"],
    ["empty chord", "[]"],
    ["empty bar", "c5 | "],
    ["embedded code", "c5 ${process.exit()}"],
  ])("rejects %s", (_label, input) => {
    const out = parseNotes(input, 4);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("INVALID_NOTES");
  });
});

describe("parseNotes", () => {
  it("splits a bar equally between its tokens; ~ is a rest", () => {
    expect(parseNotes("f5 ab5 c6 ~", 4)).toEqual({
      ok: true,
      value: {
        bars: 1,
        events: [
          { startBeat: 0, durationBeats: 1, pitches: [77] },
          { startBeat: 1, durationBeats: 1, pitches: [80] },
          { startBeat: 2, durationBeats: 1, pitches: [84] },
        ],
      },
    });
  });
});
