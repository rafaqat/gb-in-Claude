// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import type { SmfTrack } from "../midi/smf.js";

/** Level in dB → velocity factor on the GM curve (amplitude ∝ velocity², so dB = 40·log10(v'/v)). */
export const velocityFactor = (db: number) => 10 ** (db / 40);

/** Scale a MIDI velocity by a level in dB; stays within 1..127 (0 would be a note-off). */
export function scaleVelocity(velocity: number, db: number): number {
  return Math.max(1, Math.min(127, Math.round(velocity * velocityFactor(db))));
}

/** Fader on the performance: scale each named track's notes by its level (pure; tracks without a level pass through). */
export function applyTrackLevels<T extends Pick<SmfTrack, "name" | "notes">>(tracks: T[], levels: Record<string, number>): T[] {
  return tracks.map((t) => {
    const db = levels[t.name];
    if (db === undefined || db === 0) return t;
    return { ...t, notes: t.notes.map((n) => ({ ...n, velocity: scaleVelocity(n.velocity, db) })) };
  });
}
