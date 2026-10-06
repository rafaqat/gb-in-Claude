// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { ok, err, type Result } from "../result.js";

export type SmfSummary = { tempoBpm: number | null; trackNames: string[]; programs: (number | null)[] };

class SmfError extends Error {}

/** A variable-length number: at most 4 bytes (the SMF limit), never past `end`. */
function readVlq(b: Uint8Array, at: number, end: number = b.length): [number, number] {
  let v = 0;
  for (let i = 0; i < 4; i++) {
    if (at >= end) throw new SmfError("a number runs past the end of its track");
    const byte = b[at++]!;
    v = (v << 7) | (byte & 0x7f);
    if (byte < 0x80) return [v, at];
  }
  throw new SmfError("a variable-length number longer than 4 bytes");
}

/**
 * Just enough of a Standard MIDI File to verify what GarageBand should show after opening it: the tempo and,
 * in order, the names (and first GM program) of the tracks that contain notes — GarageBand makes one track each.
 */
export function readSmfSummary(bytes: Uint8Array): Result<SmfSummary, string> {
  try {
    return readSummary(bytes);
  } catch (e) {
    if (e instanceof SmfError || e instanceof RangeError) return err(`damaged MIDI file: ${e.message}`);
    throw e;
  }
}

function readSummary(bytes: Uint8Array): Result<SmfSummary, string> {
  const b = bytes;
  const text = (s: number, e: number) => String.fromCharCode(...b.subarray(s, e));
  if (b.length < 14 || text(0, 4) !== "MThd") return err("not a Standard MIDI File");
  const tracks = (b[10]! << 8) | b[11]!;
  let at = 8 + ((b[4]! << 24) | (b[5]! << 16) | (b[6]! << 8) | b[7]!);
  let tempoBpm: number | null = null;
  const trackNames: string[] = [];
  const programs: (number | null)[] = [];
  for (let t = 0; t < tracks; t++) {
    if (text(at, at + 4) !== "MTrk") return err(`track ${t} chunk missing`);
    const len = ((b[at + 4]! << 24) | (b[at + 5]! << 16) | (b[at + 6]! << 8) | b[at + 7]!) >>> 0;
    const end = at + 8 + len;
    if (end > b.length) return err(`track ${t} runs past the end of the file`);
    let p = at + 8;
    let status = 0;
    let name: string | null = null;
    let program: number | null = null;
    let hasNotes = false;
    while (p < end) {
      [, p] = readVlq(b, p, end);
      let s = b[p]!;
      if (s === 0xff) {
        const type = b[p + 1]!;
        const [l, q] = readVlq(b, p + 2, end);
        if (q + l > end) throw new SmfError("a meta event runs past the end of its track");
        if (type === 0x03 && name === null) name = text(q, q + l);
        if (type === 0x51 && tempoBpm === null) tempoBpm = Math.round((60_000_000 / ((b[q]! << 16) | (b[q + 1]! << 8) | b[q + 2]!)) * 100) / 100;
        p = q + l;
        continue;
      }
      if (s === 0xf0 || s === 0xf7) {
        const [l, q] = readVlq(b, p + 1, end);
        if (q + l > end) throw new SmfError("a system-exclusive event runs past the end of its track");
        p = q + l;
        continue;
      }
      if (s & 0x80) {
        status = s;
        p++;
      } else {
        s = status;
      }
      const kind = status & 0xf0;
      if (kind === 0xc0 && program === null) program = b[p]!;
      if (kind === 0x90 && b[p + 1]! > 0) hasNotes = true;
      p += kind === 0xc0 || kind === 0xd0 ? 1 : 2;
    }
    if (hasNotes) {
      trackNames.push(name ?? `Track ${t}`);
      programs.push(program);
    }
    at = end;
  }
  return ok({ tempoBpm, trackNames, programs });
}
