// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * Pitch-bend range per GarageBand patch, measured live on GarageBand 10.4 (eval/m11/MESSAGES.md,
 * probe 2): full-scale bend after RPN 0 = 12. `rpn`: the patch honours RPN 0, so gb-mcp sends it and gets the range.
 * Unmeasured patches are assumed to bend ±2 semitones (the GM default) — validation warns about them.
 */
export type BendRange = { semitones: number; rpn: boolean };

export const BEND_RANGES: Readonly<Record<string, BendRange>> = {
  "Flute Solo": { semitones: 12, rpn: true },
  "Soft Saw Lead": { semitones: 2, rpn: false },
  "String Ensemble": { semitones: 2, rpn: false },
  "Taureg Moon Bass": { semitones: 2, rpn: false },
  Harp: { semitones: 0, rpn: false }, // no pitch bend at all
  // M11 gate (bends written into a .band, exported, pitch-tracked): +207¢ / +198¢ at full scale — the default ±2; RPN untested
  "Steinway Grand Piano": { semitones: 2, rpn: false },
  "Fingerstyle Bass": { semitones: 2, rpn: false },
};

export function bendRangeFor(patch: string | undefined): BendRange & { measured: boolean } {
  const measured = patch === undefined ? undefined : BEND_RANGES[patch];
  return measured ? { ...measured, measured: true } : { semitones: 2, rpn: false, measured: false };
}
