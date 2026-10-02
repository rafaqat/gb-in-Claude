// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { ok, err, type Result } from "../result.js";
import { parseChord, type Chord } from "./chord.js";

export type TimedChord = { startBeat: number; durationBeats: number; chord: Chord };
export type Progression = { bars: number; chords: TimedChord[] };
export type ProgressionError = { code: "INVALID_PROGRESSION"; input: string; message: string };

/** "Fm | Db | Ab | Eb" — bars separated by `|`; chords within a bar share it equally. */
export function parseProgression(pattern: string, beatsPerBar: number): Result<Progression, ProgressionError> {
  const fail = (message: string) => err({ code: "INVALID_PROGRESSION" as const, input: pattern, message });
  const bars = pattern.split("|").map((b) => b.trim());
  const chords: TimedChord[] = [];
  for (const [barIndex, bar] of bars.entries()) {
    if (bar === "") return fail(`bar ${barIndex + 1} is empty`);
    const symbols = bar.split(/\s+/);
    const durationBeats = beatsPerBar / symbols.length;
    for (const [i, symbol] of symbols.entries()) {
      const chord = parseChord(symbol);
      if (!chord.ok) return fail(`bad chord "${symbol}" in bar ${barIndex + 1}`);
      chords.push({ startBeat: barIndex * beatsPerBar + i * durationBeats, durationBeats, chord: chord.value });
    }
  }
  return ok({ bars: bars.length, chords });
}
