// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWavInfo } from "./wav.js";
import { writeWav, sineStereo } from "../testing/wav.js";

const dir = mkdtempSync(join(tmpdir(), "gbmcp-wav-"));

describe("readWavInfo", () => {
  it("reads format and duration from a finalized WAV", () => {
    const p = join(dir, "ok.wav");
    writeWav(p, sineStereo(2, 44100, -6), 44100);
    expect(readWavInfo(p)).toEqual({ ok: true, value: { sampleRate: 44100, channels: 2, bitsPerSample: 16, seconds: 2, dataBytes: 2 * 44100 * 4 } });
  });

  it("rejects an unfinalized header (data size 0) — a bug this test once caught", () => {
    const p = join(dir, "unfinalized.wav");
    writeWav(p, sineStereo(1, 44100, -6), 44100);
    const b = Buffer.from(readFileSync(p));
    b.writeUInt32LE(0, 40); // data chunk size never written
    writeFileSync(p, b);
    const r = readWavInfo(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/data/);
  });

  it("rejects files that are not WAVE", () => {
    const p = join(dir, "x.wav");
    writeFileSync(p, "not audio");
    expect(readWavInfo(p).ok).toBe(false);
  });
});
