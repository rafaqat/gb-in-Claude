// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { ok, err, type Result } from "../result.js";
import { pitchClass } from "./pitch.js";

export type Chord = { root: number; intervals: number[]; bass: number };
export type ChordError = { code: "INVALID_CHORD"; input: string };

/** Exact suffix → intervals. Never substring-matched: "maj7" must not read as "m". */
const QUALITIES: Record<string, number[]> = {
  "": [0, 4, 7],
  m: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  "7": [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  m7b5: [0, 3, 6, 10],
  add9: [0, 4, 7, 14],
  m9: [0, 3, 7, 10, 14],
};

/** Root letter + accidental, quality suffix (no "/"), optional "/Bass" note. */
const CHORD_PATTERN = /^([A-G])(#|b)?([^/]*)(?:\/([A-G])(#|b)?)?$/;

export function parseChord(input: string): Result<Chord, ChordError> {
  const match = CHORD_PATTERN.exec(input);
  if (!match) return err({ code: "INVALID_CHORD", input });
  const [, letter, accidental = "", suffix = "", bassLetter, bassAccidental = ""] = match;
  const intervals = QUALITIES[suffix];
  if (!intervals) return err({ code: "INVALID_CHORD", input });
  const root = pitchClass(letter!, accidental);
  const bass = bassLetter ? pitchClass(bassLetter, bassAccidental) : root;
  return ok({ root, intervals, bass });
}
