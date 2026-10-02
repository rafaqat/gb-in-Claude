// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import type { NoteEvent } from "./bass-patterns.js";

export type ArpStyle = "up" | "down" | "updown" | "broken" | "gated";

const STEP = 0.25; // 16th notes
const NOTE_LENGTH = 0.2; // shorter than a step: notes re-articulate, never overlap
const ACCENT_VELOCITY = 100; // first 16th of each beat
const STEP_VELOCITY = 82;

/** Classic trance gate (one bar of 16ths): x = chord on, . = silent. */
export const GATE_MASK = "x.xx.xx.x.xx.xx.";

/** The arp pitch pool: the voicing plus the same voicing an octave up. */
const pool = (voicing: number[]) => [...voicing, ...voicing.map((p) => p + 12)].sort((a, b) => a - b);

function sequence(style: Exclude<ArpStyle, "gated">, voicing: number[]): number[] {
  const up = pool(voicing);
  if (style === "up") return up;
  if (style === "down") return [...up].reverse();
  if (style === "broken") return up.slice(0, -2).flatMap((p, i) => [p, up[i + 2]!]); // 1-3-2-4-3-5-4-6
  return [...up, ...up.slice(1, -1).reverse()]; // updown: no repeated turnaround notes
}

const velocityAt = (step: number) => (step % 4 === 0 ? ACCENT_VELOCITY : STEP_VELOCITY);

export function renderArpSpan(style: ArpStyle, voicing: number[], spanBeats: number): NoteEvent[] {
  const steps = Math.floor(spanBeats / STEP);
  if (style === "gated") {
    return Array.from({ length: steps }, (_, step) =>
      GATE_MASK[step % GATE_MASK.length] === "x"
        ? voicing.map((pitch) => ({ pitch, startBeat: step * STEP, durationBeats: NOTE_LENGTH, velocity: velocityAt(step) }))
        : [],
    ).flat();
  }
  const seq = sequence(style, voicing);
  return Array.from({ length: steps }, (_, step) => ({
    pitch: seq[step % seq.length]!,
    startBeat: step * STEP,
    durationBeats: NOTE_LENGTH,
    velocity: velocityAt(step),
  }));
}
