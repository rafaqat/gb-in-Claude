// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * WAV files for GarageBand projects. GarageBand (like Logic) appends an "LGWV" waveform-overview chunk to any WAV
 * that lacks one, rewriting the file on import — which would no longer match the size the project records.
 * Adding the chunk ourselves keeps the file exactly as GarageBand would keep it.
 */
import { err, ok, type Result } from "../result.js";

export type WavInfo = { channels: number; rate: number; bits: number; frames: number; hasOverview: boolean };
export type WavError = { code: "NOT_WAV" | "WAV_UNSUPPORTED"; message: string };

type Chunk = { id: string; at: number; size: number };

function chunks(b: Uint8Array): Chunk[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Chunk[] = [];
  for (let at = 12; at + 8 <= b.length; ) {
    const size = v.getUint32(at + 4, true);
    out.push({ id: String.fromCharCode(...b.subarray(at, at + 4)), at: at + 8, size });
    at += 8 + size + (size & 1);
  }
  return out;
}

const ascii = (b: Uint8Array, at: number) => String.fromCharCode(...b.subarray(at, at + 4));

export function wavInfo(b: Uint8Array): Result<WavInfo, WavError> {
  if (b.length < 12 || ascii(b, 0) !== "RIFF" || ascii(b, 8) !== "WAVE") return err({ code: "NOT_WAV", message: "not a RIFF/WAVE file" });
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const list = chunks(b);
  const fmt = list.find((c) => c.id === "fmt ");
  const data = list.find((c) => c.id === "data");
  if (!fmt || !data) return err({ code: "NOT_WAV", message: "the WAV has no fmt or data chunk" });
  // every size here comes from the file: a chunk that promises more bytes than the file holds is damage, never "the rest"
  if (fmt.size < 16 || fmt.at + 16 > b.length) return err({ code: "NOT_WAV", message: "the WAV's fmt chunk is shorter than 16 bytes" });
  if (data.at + data.size > b.length) return err({ code: "NOT_WAV", message: "the WAV's data chunk is longer than the file (cut or still recording)" });
  const format = v.getUint16(fmt.at, true);
  const channels = v.getUint16(fmt.at + 2, true);
  const bits = v.getUint16(fmt.at + 14, true);
  if (format !== 1 || (bits !== 16 && bits !== 24)) {
    return err({ code: "WAV_UNSUPPORTED", message: `only 16- or 24-bit integer PCM WAVs are supported (format ${format}, ${bits}-bit)` });
  }
  const rate = v.getUint32(fmt.at + 4, true);
  const frames = channels > 0 ? Math.floor(data.size / (channels * (bits / 8))) : 0;
  if (rate === 0 || channels === 0 || frames === 0) {
    return err({ code: "WAV_UNSUPPORTED", message: "the WAV header describes no audio (sample rate, channels or length is 0)" });
  }
  return ok({ channels, rate, bits, frames, hasOverview: list.some((c) => c.id === "LGWV") });
}

const BIN_FRAMES = 256;

/** `b` with an LGWV overview appended: [u32 frames][u32 checksum 0][u16 peak per 256 frames, all channels]. */
export function withOverview(b: Uint8Array): Result<Uint8Array, WavError> {
  const info = wavInfo(b);
  if (!info.ok) return info;
  if (info.value.hasOverview) return ok(b);
  const { channels, bits, frames } = info.value;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const data = chunks(b).find((c) => c.id === "data")!;
  const bytes = bits / 8;
  const sample = (i: number) =>
    bytes === 2 ? v.getInt16(data.at + 2 * i, true) : (v.getInt8(data.at + 3 * i + 2) * 65536 + v.getUint16(data.at + 3 * i, true)) >> 8;
  const bins = Math.ceil(frames / BIN_FRAMES);
  const payload = new DataView(new ArrayBuffer(8 + 2 * bins));
  payload.setUint32(0, frames, true);
  for (let bin = 0; bin < bins; bin++) {
    let peak = 0;
    const end = Math.min(frames, (bin + 1) * BIN_FRAMES) * channels;
    for (let i = bin * BIN_FRAMES * channels; i < end; i++) peak = Math.max(peak, Math.abs(sample(i)));
    payload.setUint16(8 + 2 * bin, Math.min(peak, 32767), true);
  }
  // a chunk starts at an even offset: after an odd-sized last chunk, its missing pad byte comes first
  const at = b.length + (b.length & 1);
  const out = new Uint8Array(at + 8 + payload.byteLength);
  out.set(b);
  out.set(new TextEncoder().encode("LGWV"), at);
  const ov = new DataView(out.buffer);
  ov.setUint32(at + 4, payload.byteLength, true);
  out.set(new Uint8Array(payload.buffer), at + 8);
  ov.setUint32(4, out.length - 8, true);
  return ok(out);
}
