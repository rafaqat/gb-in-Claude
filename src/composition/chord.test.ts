// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { parseChord } from "./chord.js";

describe("parseChord", () => {
  it("parses a major triad as root pitch class + intervals", () => {
    expect(parseChord("C")).toEqual({ ok: true, value: { root: 0, intervals: [0, 4, 7], bass: 0 } });
  });

  it.each([
    ["Fm", 5, [0, 3, 7]],
    ["Bbm", 10, [0, 3, 7]],
    ["Gb", 6, [0, 4, 7]],
    ["F#m", 6, [0, 3, 7]],
    ["Ebm", 3, [0, 3, 7]],
  ])("parses %s (accidental roots, minor triads)", (symbol, root, intervals) => {
    expect(parseChord(symbol)).toEqual({ ok: true, value: { root, intervals, bass: root } });
  });

  it.each([
    ["Cmaj7", [0, 4, 7, 11]], // regression: substring parsers read this as minor
    ["Cm7", [0, 3, 7, 10]],
    ["C7", [0, 4, 7, 10]],
    ["Cm7b5", [0, 3, 6, 10]],
    ["Cdim", [0, 3, 6]],
    ["Caug", [0, 4, 8]],
    ["Csus2", [0, 2, 7]],
    ["Csus4", [0, 5, 7]],
    ["Cadd9", [0, 4, 7, 14]],
    ["Cm9", [0, 3, 7, 10, 14]],
  ])("parses quality %s", (symbol, intervals) => {
    expect(parseChord(symbol)).toEqual({ ok: true, value: { root: 0, intervals, bass: 0 } });
  });

  it.each([
    ["C/E", 0, [0, 4, 7], 4],
    ["Am/G", 9, [0, 3, 7], 7],
    ["Db/F", 1, [0, 4, 7], 5],
    ["Fm7/Eb", 5, [0, 3, 7, 10], 3],
  ])("parses slash chord %s with its bass pitch class", (symbol, root, intervals, bass) => {
    expect(parseChord(symbol)).toEqual({ ok: true, value: { root, intervals, bass } });
  });

  it.each(["", "c", "H", "C/", "C/H", "C/E/G", "Cmaj", "Cmin7x", "C##", "Cm7 ", "Am F"])("rejects %j", (input) => {
    expect(parseChord(input)).toEqual({ ok: false, error: { code: "INVALID_CHORD", input } });
  });
});
