// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/** Test helpers for the band module. */

/** A bare PCM WAV (fmt + data only) of `frames` frames, the way ffmpeg writes one with -map_metadata -1. */
export const bareWav = (frames: number, channels = 2, rate = 44100, bits = 16) => {
  const align = channels * (bits / 8);
  const b = Buffer.alloc(44 + frames * align);
  b.write("RIFF", 0); b.writeUInt32LE(36 + frames * align, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * align, 28); b.writeUInt16LE(align, 32); b.writeUInt16LE(bits, 34);
  b.write("data", 36); b.writeUInt32LE(frames * align, 40);
  for (let i = 0; i < frames * channels; i++) if (bits === 16) b.writeInt16LE(Math.round(8000 * Math.sin(i / 20)), 44 + 2 * i);
  return new Uint8Array(b);
};
