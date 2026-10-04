// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * Genre grooves mined from the Groove MIDI Dataset (Magenta, CC BY 4.0) by models/mine_grooves.py (M9): per style
 * and drum voice, the hit probability, mean velocity and mean timing offset of each 16th step, and a readable grid.
 * humanize() uses a groove's timing and accents for the drums in place of the generic pocket.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DRUM_VOICES, type DrumVoice } from "../composition/drums.js";

export type VoiceGroove = { p: number[]; velocity: number[]; offset: number[]; grid: string };
export type Groove = { recordings: number; bars: number; voices: Partial<Record<DrumVoice, VoiceGroove>> };

const DATA = JSON.parse(readFileSync(fileURLToPath(new URL("./grooves.json", import.meta.url)), "utf8")) as { styles: Record<string, Groove> };
export const GROOVES: Readonly<Record<string, Groove>> = DATA.styles;
export const GROOVE_NAMES = Object.keys(GROOVES).sort() as [string, ...string[]];

/** What humanize needs, keyed by GM drum pitch: per 16th step, a timing offset (fraction of a 16th) and an accent
 * (velocity relative to the voice's mean, 1 = average). Steps the drummers never played keep offset 0, accent 1. */
export type GrooveFeel = ReadonlyMap<number, { offset: number[]; accent: number[] }>;

/** A step's measured offset counts fully once drummers play it in this share of bars; rarer steps shrink toward 0
 * (an average of a few hits is noise: e.g. pop's kick on a rare step read +0.44 of a 16th). */
const TRUSTED_SHARE = 0.3;

export function grooveFeel(name: string): GrooveFeel {
  const feel = new Map<number, { offset: number[]; accent: number[] }>();
  for (const [voice, g] of Object.entries(GROOVES[name]?.voices ?? {}) as [DrumVoice, VoiceGroove][]) {
    const played = g.velocity.filter((v) => v > 0);
    const mean = played.reduce((s, v) => s + v, 0) / Math.max(played.length, 1);
    const offset = g.offset.map((o, i) => o * Math.min(1, g.p[i]! / TRUSTED_SHARE));
    feel.set(DRUM_VOICES[voice], { offset, accent: g.velocity.map((v) => (v > 0 && mean > 0 ? v / mean : 1)) });
  }
  return feel;
}
