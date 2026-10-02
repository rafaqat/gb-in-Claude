// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { readFileSync } from "node:fs";
import { ok, err, type Result } from "../result.js";

export type WavInfo = { sampleRate: number; channels: number; bitsPerSample: number; seconds: number; dataBytes: number };

/** Parse a RIFF/WAVE header (skipping JUNK/LIST chunks) and prove the data chunk was finalized. */
export function readWavInfo(path: string): Result<WavInfo, string> {
  let b: Buffer;
  try {
    b = readFileSync(path);
  } catch {
    return err("cannot read file");
  }
  if (b.length < 12 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") return err("not a RIFF/WAVE file");
  let at = 12;
  let fmt: { channels: number; sampleRate: number; bitsPerSample: number } | undefined;
  while (at + 8 <= b.length) {
    const id = b.toString("ascii", at, at + 4);
    const size = b.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt " && size >= 16) {
      fmt = { channels: b.readUInt16LE(body + 2), sampleRate: b.readUInt32LE(body + 4), bitsPerSample: b.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt) return err("data chunk before fmt chunk");
      if (size === 0) return err("data chunk size is 0 (header not finalized)");
      if (body + size > b.length) return err("data chunk is larger than the file (truncated)");
      const frameBytes = fmt.channels * (fmt.bitsPerSample / 8);
      return ok({ ...fmt, seconds: Math.round((size / frameBytes / fmt.sampleRate) * 1000) / 1000, dataBytes: size });
    }
    at = body + size + (size % 2); // chunks are word-aligned
  }
  return err("no data chunk");
}
