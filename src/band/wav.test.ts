// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { wavInfo, withOverview, channelOf } from "./wav.js";
import { bareWav } from "./testing.js";

describe("wavInfo", () => {
  it("reads channels, rate, bit depth and frame count of a PCM WAV, and whether it has GarageBand's overview chunk", () => {
    expect(wavInfo(bareWav(176400))).toEqual({ ok: true, value: { channels: 2, rate: 44100, bits: 16, frames: 176400, hasOverview: false } });
  });

  // security review 2026-10-06 (C3): chunks() listed every chunk, so a file of empty 8-byte chunks cost ~16 bytes of
  // heap per byte (a 256 MB build input ~4 GB) and crashed the process instead of returning WAV errors
  it("refuses a WAV with more chunks than any real WAV has (thousands of empty ones)", () => {
    const base = bareWav(10);
    const empty = Uint8Array.from([0x6a, 0x75, 0x6e, 0x6b, 0, 0, 0, 0]); // "junk", size 0
    const n = 5000;
    const b = new Uint8Array(base.length + n * 8);
    b.set(base.subarray(0, 36));
    for (let i = 0; i < n; i++) b.set(empty, 36 + i * 8);
    b.set(base.subarray(36), 36 + n * 8);
    const r = wavInfo(b);
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_WAV" } });
  });

  it("refuses bytes that are not a RIFF/WAVE file", () => {
    const r = wavInfo(new TextEncoder().encode("this is not a wav file at all, honestly"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("NOT_WAV");
  });

  it("refuses a RIFF/WAVE file that has no data chunk", () => {
    const b = bareWav(10);
    b.set(new TextEncoder().encode("junk"), 36);
    const r = wavInfo(b);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("NOT_WAV");
  });

  it("refuses WAVs that are not 16- or 24-bit integer PCM (float, compressed)", () => {
    const b = bareWav(10);
    new DataView(b.buffer).setUint16(20, 3, true); // WAVE_FORMAT_IEEE_FLOAT
    const r = wavInfo(b);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("WAV_UNSUPPORTED");
  });
});

describe("withOverview", () => {
  it("adds the LGWV overview GarageBand adds on import: 176400 frames grow the file by exactly 1396 bytes", () => {
    const bare = bareWav(176400);
    const r = withOverview(bare);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBe(bare.length + 1396);
    const v = new DataView(r.value.buffer, r.value.byteOffset);
    expect(v.getUint32(4, true)).toBe(r.value.length - 8);                       // RIFF size follows the new length
    expect(String.fromCharCode(...r.value.subarray(bare.length, bare.length + 4))).toBe("LGWV");
    expect(v.getUint32(bare.length + 8, true)).toBe(176400);                    // the overview starts with the frame count
    expect(wavInfo(r.value)).toEqual({ ok: true, value: { channels: 2, rate: 44100, bits: 16, frames: 176400, hasOverview: true } });
  });

  it("leaves a WAV that already has an overview exactly as it is", () => {
    const once = withOverview(bareWav(1000));
    if (!once.ok) throw new Error(once.error.message);
    const twice = withOverview(once.value);
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(Buffer.from(twice.value).equals(Buffer.from(once.value))).toBe(true);
  });

  it("scales 24-bit samples to 16-bit overview peaks (half of full scale -> 16384)", () => {
    const b = bareWav(300, 1, 48000, 24);
    const half = 0x400000;
    b[44] = half & 0xff; b[45] = (half >> 8) & 0xff; b[46] = (half >> 16) & 0xff;   // first sample of the data chunk
    const r = withOverview(b);
    if (!r.ok) throw new Error(r.error.message);
    const v = new DataView(r.value.buffer, r.value.byteOffset);
    expect(v.getUint32(b.length + 8, true)).toBe(300);
    expect(v.getUint16(b.length + 16, true)).toBe(16384);                         // bin 0 peak
    expect(r.value.length).toBe(b.length + 8 + 8 + 2 * Math.ceil(300 / 256));
  });
});

describe("a WAV header that cannot describe audio is refused", () => {
  it.each([
    { what: "a sample rate of 0", wav: () => bareWav(1000, 2, 0) },
    { what: "0 channels", wav: () => bareWav(1000, 0) },
    { what: "no audio frames", wav: () => bareWav(0) },
  ])("refuses $what (WAV_UNSUPPORTED)", ({ wav }) => {
    expect(wavInfo(wav())).toMatchObject({ ok: false, error: { code: "WAV_UNSUPPORTED" } });
  });
});


describe("damaged WAV headers return NOT_WAV and never throw", () => {
  const shortFmt = () => { const b = bareWav(10).slice(0, 30); new DataView(b.buffer).setUint32(16, 2, true); b.set(new TextEncoder().encode("data"), 22); return b; };
  const lyingData = (size: number) => { const b = bareWav(10); new DataView(b.buffer).setUint32(40, size, true); return b; };
  it.each([
    ["a fmt chunk shorter than 16 bytes", shortFmt()],
    ["a data size larger than the file", lyingData(1_000_000)],
    ["a streaming data size (0xFFFFFFFF)", lyingData(0xffffffff)],
  ])("%s", (_why, b) => {
    for (const r of [wavInfo(b), withOverview(b)]) expect(r).toMatchObject({ ok: false, error: { code: "NOT_WAV" } });
  });
});

describe("withOverview after an odd-sized last chunk", () => {
  it("pads to an even offset, so the LGWV chunk is found where RIFF readers look", () => {
    const bare = bareWav(1000);
    const odd = new Uint8Array(bare.length + 11); // + "junk" chunk of 3 bytes, without its pad byte
    odd.set(bare);
    odd.set(new TextEncoder().encode("junk"), bare.length);
    new DataView(odd.buffer).setUint32(bare.length + 4, 3, true);
    new DataView(odd.buffer).setUint32(4, odd.length - 8, true);
    const r = withOverview(odd);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(wavInfo(r.value)).toMatchObject({ ok: true, value: { hasOverview: true } });
    expect(new DataView(r.value.buffer).getUint32(4, true)).toBe(r.value.length - 8);
  });
});

describe("channelOf (M13.18): one channel of a stereo WAV as a mono WAV", () => {
  /** A 16-bit stereo WAV whose left samples are 1, 2, 3… and right samples -1, -2, -3… */
  const stereo = (frames: number) => {
    const b = bareWav(frames, 2, 44100, 16);
    const v = new DataView(b.buffer, b.byteOffset);
    const data = b.length - frames * 4;
    for (let i = 0; i < frames; i++) { v.setInt16(data + 4 * i, i + 1, true); v.setInt16(data + 4 * i + 2, -(i + 1), true); }
    return b;
  };

  it("takes the left or the right samples, keeping rate and bits", () => {
    for (const [ch, sign] of [[0, 1], [1, -1]] as const) {
      const r = channelOf(stereo(5), ch);
      if (!r.ok) throw new Error(r.error.message);
      expect(wavInfo(r.value)).toMatchObject({ ok: true, value: { channels: 1, rate: 44100, bits: 16, frames: 5 } });
      const v = new DataView(r.value.buffer, r.value.byteOffset);
      expect([0, 1, 2, 3, 4].map((i) => v.getInt16(r.value.length - 10 + 2 * i, true))).toEqual([1, 2, 3, 4, 5].map((x) => sign * x));
    }
  });

  it("refuses a mono WAV", () => {
    expect(channelOf(bareWav(5, 1, 44100, 16), 0)).toMatchObject({ ok: false, error: { code: "WAV_UNSUPPORTED" } });
  });
});
