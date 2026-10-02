// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { parseProgression } from "./progression.js";

describe("parseProgression", () => {
  it("one chord per bar, separated by |", () => {
    const out = parseProgression("Fm | Db", 4);
    expect(out.ok && out.value).toEqual({
      bars: 2,
      chords: [
        { startBeat: 0, durationBeats: 4, chord: { root: 5, intervals: [0, 3, 7], bass: 5 } },
        { startBeat: 4, durationBeats: 4, chord: { root: 1, intervals: [0, 4, 7], bass: 1 } },
      ],
    });
  });

  it("several chords in a bar share it equally", () => {
    const out = parseProgression("Am F", 4);
    expect(out.ok && out.value.chords.map((c) => [c.startBeat, c.durationBeats])).toEqual([[0, 2], [2, 2]]);
  });

  it.each([["bad chord", "Fm | Hx"], ["empty bar", "Fm | "]])("rejects %s", (_l, input) => {
    const out = parseProgression(input, 4);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("INVALID_PROGRESSION");
  });
});
