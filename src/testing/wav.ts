// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { writeFileSync } from "node:fs";

/** Write a 16-bit PCM WAV from interleaved channel arrays in [-1, 1]. */
export function writeWav(path: string, channels: Float64Array[], sampleRate: number): void {
  const frames = channels[0]!.length;
  const nch = channels.length;
  const data = Buffer.alloc(frames * nch * 2);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c]![i]!));
      data.writeInt16LE(Math.round(v * 32767), (i * nch + c) * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(nch, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * nch * 2, 28); header.writeUInt16LE(nch * 2, 32);
  header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

/** Stereo 997 Hz sine at the given dBFS peak. */
export function sineStereo(seconds: number, sampleRate: number, dbfs: number): Float64Array[] {
  const n = Math.round(seconds * sampleRate);
  const a = 10 ** (dbfs / 20);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = a * Math.sin((2 * Math.PI * 997 * i) / sampleRate);
  return [x, Float64Array.from(x)];
}
