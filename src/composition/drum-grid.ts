// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { ok, err, type Result } from "../result.js";

export type DrumHit = { startBeat: number; velocity: number };
export type DrumGrid = { bars: number; hits: DrumHit[] };
export type GridError = { code: "INVALID_GRID"; input: string; message: string };

/** Step characters → velocity (`.` = rest). */
const STEP_VELOCITY: Record<string, number | null> = { x: 100, X: 120, o: 55, ".": null };

/**
 * Parse a drum step grid. Bars are separated by `|`; whitespace is ignored.
 * Every bar must have the same number of steps, a whole number of steps per beat
 * (4 = quarters, 8 = 8ths, 12 = 8th triplets, 16 = 16ths, 32 = 32nds in 4/4).
 */
export function parseGrid(pattern: string, beatsPerBar: number): Result<DrumGrid, GridError> {
  const fail = (message: string) => err({ code: "INVALID_GRID" as const, input: pattern, message });
  const bars = pattern.split("|").map((bar) => bar.replace(/\s+/g, ""));
  const stepsPerBar = bars[0]!.length;
  if (bars.some((b) => b.length === 0)) return fail("empty bar");
  if (bars.some((b) => b.length !== stepsPerBar)) return fail(`bars must all have ${stepsPerBar} steps`);
  if (stepsPerBar % beatsPerBar !== 0) {
    return fail(`${stepsPerBar} steps don't divide ${beatsPerBar} beats evenly`);
  }
  const stepBeats = beatsPerBar / stepsPerBar;
  const hits: DrumHit[] = [];
  for (const [barIndex, bar] of bars.entries()) {
    for (const [stepIndex, c] of [...bar].entries()) {
      if (!(c in STEP_VELOCITY)) return fail(`unknown step "${c}"; use x X o .`);
      const velocity = STEP_VELOCITY[c];
      if (velocity != null) hits.push({ startBeat: barIndex * beatsPerBar + stepIndex * stepBeats, velocity });
    }
  }
  return ok({ bars: bars.length, hits });
}
