// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { ok, err, type Result } from "../result.js";

export type PitchError = { code: "INVALID_PITCH"; input: string };

export const LETTER_SEMITONES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
export const ACCIDENTAL_SHIFT: Record<string, number> = { "": 0, "#": 1, b: -1 };

/** Pitch class 0..11 from a letter + optional accidental (e.g. "B","b" → 10). */
export const pitchClass = (letter: string, accidental: string): number =>
  (LETTER_SEMITONES[letter.toLowerCase()]! + ACCIDENTAL_SHIFT[accidental]! + 12) % 12;

const MIDI_MIN = 0;
const MIDI_MAX = 127;

/** Strict grammar: letter, optional single accidental, octave -1..9. */
const PITCH_PATTERN = /^([a-g])(#|b)?(-1|[0-9])$/;

export function parsePitch(input: string): Result<number, PitchError> {
  const match = PITCH_PATTERN.exec(input.toLowerCase());
  if (!match) return err({ code: "INVALID_PITCH", input });
  const [, letter, accidental = "", octave] = match;
  const midi = (Number(octave) + 1) * 12 + LETTER_SEMITONES[letter!]! + ACCIDENTAL_SHIFT[accidental]!;
  if (midi < MIDI_MIN || midi > MIDI_MAX) return err({ code: "INVALID_PITCH", input });
  return ok(midi);
}
