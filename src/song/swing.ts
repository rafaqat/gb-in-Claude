// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * Swing (m9b): delay every second 16th (or 8th) by a percentage, as drum machines do — 50 % is straight, 58 % light,
 * 66 % a triplet feel, 75 % hard. Applied on the quantized grid before humanize, so it is part of the composition
 * (it also applies with humanize "off"); a swung note moves less than half a step, so groove steps still line up.
 */
import type { RoleTrack } from "./humanize.js";

export type SwingOptions = { percent: number; unit: "16th" | "8th"; ppq: number };

export function applySwing(tracks: RoleTrack[], opts: SwingOptions): RoleTrack[] {
  if (opts.percent <= 50) return tracks;
  const unit = opts.unit === "8th" ? opts.ppq / 2 : opts.ppq / 4;
  const delay = Math.round(((opts.percent - 50) / 50) * unit);
  return tracks.map((t) => ({
    ...t,
    notes: t.notes.map((n) => (n.startTick % (2 * unit) === unit ? { ...n, startTick: n.startTick + delay } : n)),
  }));
}
