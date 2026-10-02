// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import type { Chord } from "./chord.js";
import type { NoteEvent } from "./bass-patterns.js";

export type PadStyle = "sustain" | "stabs";

const rootPosition = (chord: Chord, octave: number): number[] =>
  chord.intervals.map((i) => (octave + 1) * 12 + chord.root + i);

/** All inversions of a voicing (lowest k notes raised an octave), each also tried an octave down/up. */
function candidates(voicing: number[]): number[][] {
  const out: number[][] = [];
  for (let k = 0; k < voicing.length; k++) {
    const inv = [...voicing.slice(k), ...voicing.slice(0, k).map((p) => p + 12)].sort((a, b) => a - b);
    for (const shift of [-12, 0, 12]) out.push(inv.map((p) => p + shift));
  }
  return out;
}

/** Total movement: each new note to its nearest previous note (works when chord sizes differ). */
const movement = (next: number[], prev: number[]): number =>
  next.reduce((sum, p) => sum + Math.min(...prev.map((q) => Math.abs(p - q))), 0);

/**
 * Voice a chord as a close voicing. With a previous voicing, choose the inversion that moves
 * the voices least (voice leading) — pads glide between chords instead of jumping.
 */
export function voiceChord(chord: Chord, octave: number, previous?: number[]): number[] {
  const base = rootPosition(chord, octave);
  if (!previous || previous.length === 0) return base;
  let best = base;
  let bestCost = movement(base, previous);
  for (const c of candidates(base)) {
    const cost = movement(c, previous);
    if (cost < bestCost) {
      best = c;
      bestCost = cost;
    }
  }
  return best;
}

const SUSTAIN_VELOCITY = 76;
const STAB_VELOCITY = 92;
const STAB_DURATION = 0.2;

export function renderPadSpan(style: PadStyle, voicing: number[], spanBeats: number): NoteEvent[] {
  switch (style) {
    case "sustain":
      return voicing.map((pitch) => ({ pitch, startBeat: 0, durationBeats: spanBeats, velocity: SUSTAIN_VELOCITY }));
    case "stabs":
      return Array.from({ length: Math.floor(spanBeats) }, (_, beat) =>
        voicing.map((pitch) => ({ pitch, startBeat: beat + 0.5, durationBeats: STAB_DURATION, velocity: STAB_VELOCITY })),
      ).flat();
  }
}
