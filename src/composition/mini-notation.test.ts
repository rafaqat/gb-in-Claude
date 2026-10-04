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

describe("parseNotes: expression (M11)", () => {
  it("a slide token is one note that bends into the next pitch: d5@7>e5@2 (meend)", () => {
    const r = parseNotes("d5@7>e5@2", 4);
    expect(r.ok && r.value.events).toEqual([
      { startBeat: 0, durationBeats: 4, pitches: [74], slide: [{ at: 7 / 9, semitones: 2 }] },
    ]);
  });
  it("a chain bends through several pitches in one breath: a4@2>c5@2>b4@4", () => {
    const r = parseNotes("a4@2>c5@2>b4@4 | ~", 4);
    expect(r.ok && r.value.events).toEqual([
      { startBeat: 0, durationBeats: 4, pitches: [69], slide: [{ at: 0.25, semitones: 3 }, { at: 0.5, semitones: 2 }] },
    ]);
  });
  it("a cent offset tunes one note off the tempered grid (shruti): e5-20c, and a slide may land off-grid too", () => {
    const r = parseNotes("e5-20c a4>bb4+30c", 4);
    expect(r.ok && r.value.events).toEqual([
      { startBeat: 0, durationBeats: 4 / 3, pitches: [76], cents: -20 }, // a chain weighs the sum of its points: 1 + 2 shares
      { startBeat: 4 / 3, durationBeats: 8 / 3, pitches: [69], slide: [{ at: 0.5, semitones: 1.3 }] },
    ]);
  });
  it("! accents a note, ? softens it; plain tokens keep their old shape", () => {
    const r = parseNotes("a4! c5? e5 [a3,e4]@1!", 4);
    expect(r.ok && r.value.events.map((e) => e.accent)).toEqual(["accent", "soft", undefined, "accent"]);
    expect(r.ok && Object.keys(r.value.events[2]!)).toEqual(["startBeat", "durationBeats", "pitches"]);
  });
  it.each([
    ["[a4,c5]>d5", "a slide joins single pitches"],
    ["~>a4", "a slide joins single pitches"],
    ["~-20c", "a rest has no pitch"],
    ["~!", "a rest cannot be accented"],
    ["a4>", "bad token"],
  ])("refuses %s", (input, message) => {
    const r = parseNotes(input, 4);
    expect(!r.ok && r.error.message).toContain(message);
  });
});

