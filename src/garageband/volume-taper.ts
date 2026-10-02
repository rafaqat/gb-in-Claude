// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * GarageBand's track fader taper: AX value (0–233, 173 = unity) ↔ gain in dB. GarageBand exposes no dB attribute
 * , so the mapping is MEASURED: two tracks
 * separated in channel (hard L / hard R) AND frequency band, one fader swept, 15 exports; the shared reverb return's
 * leak is incoherent with the measured track and power-subtracted. Result: 0.1 dB/step above raw 113, 0.2 dB/step
 * from 53 to 113, +6.0 dB at the top (the Logic-family maximum). Below raw 53 the measurement reached its floor:
 * those positions have no trusted dB value, and no gain outside the measured range is ever extrapolated.
 */
export const VOLUME_TAPER: ReadonlyArray<readonly [raw: number, db: number]> = [
  [53, -18.2], [73, -14.1], [93, -10.1], [113, -6.0], [133, -4.0], [153, -2.0], [173, 0], [193, 2.0], [213, 4.1], [233, 6.0],
];

function interpolate(raw: number, taper: ReadonlyArray<readonly [number, number]>): number | null {
  for (let i = 1; i < taper.length; i++) {
    const [r0, d0] = taper[i - 1]!;
    const [r1, d1] = taper[i]!;
    if (raw >= r0 && raw <= r1) return d0 + ((raw - r0) / (r1 - r0)) * (d1 - d0);
  }
  return null;
}

/** Gain in dB (0.1 dB resolution) for a raw fader value; null outside the measured range. */
export function rawToDb(raw: number, taper = VOLUME_TAPER): number | null {
  if (taper.length < 2) return null;
  const db = interpolate(raw, taper);
  return db === null ? null : Math.round(db * 10) / 10;
}

/** The raw fader value whose gain is closest to `db` (ties → the quieter position); null outside the measured range. */
export function dbToRaw(db: number, taper = VOLUME_TAPER): number | null {
  if (taper.length < 2) return null;
  const lo = taper[0]!, hi = taper[taper.length - 1]!;
  if (db < lo[1] || db > hi[1]) return null;
  let best = lo[0];
  let bestErr = Number.POSITIVE_INFINITY;
  for (let raw = lo[0]; raw <= hi[0]; raw++) {
    const err = Math.abs(interpolate(raw, taper)! - db);
    if (err < bestErr - 1e-9) { best = raw; bestErr = err; }
  }
  return best;
}
