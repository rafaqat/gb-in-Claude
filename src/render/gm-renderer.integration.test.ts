// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createGmRenderer } from "./gm-renderer.js";

const binary = resolve(import.meta.dirname, "../../native/bin/gm-render");
const required = process.env.GBMCP_REQUIRE_NATIVE === "1";

describe.skipIf(!existsSync(binary) && !required)("gm-render (macOS DLS synth, offline)", () => {
  const renderer = createGmRenderer({ binary, timeoutMs: 60_000 });
  const events = {
    duration_s: 2,
    events: [
      { t: 0, bytes: [0xc0, 81] }, // saw lead
      { t: 0, bytes: [0x90, 60, 100] }, { t: 0.5, bytes: [0x80, 60, 0] },
      { t: 0.5, bytes: [0x90, 64, 100] }, { t: 1.0, bytes: [0x80, 64, 0] },
      { t: 0, bytes: [0x99, 36, 110] }, { t: 0.1, bytes: [0x89, 36, 0] }, // GM kick on channel 10
    ],
  };

  it("renders an event list to a stereo WAV with the song's duration plus a release tail", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "gbmcp-gm-")), "draft.wav");
    const r = await renderer.render(events, out);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(readFileSync(out).subarray(0, 4).toString()).toBe("RIFF");
    expect(r.value.seconds).toBeGreaterThanOrEqual(2);
    expect(r.value.seconds).toBeLessThan(5);
    expect(r.value.peak).toBeGreaterThan(0.01); // not silent
  }, 60_000);

  it("finalizes the WAV header: the data chunk length matches the rendered duration", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "gbmcp-gm-")), "header.wav");
    const r = await renderer.render(events, out);
    if (!r.ok) throw new Error(r.error.message);
    const wav = readFileSync(out);
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8); // RIFF size covers the whole file
    const dataAt = wav.indexOf("data", 12);
    expect(dataAt).toBeGreaterThan(0);
    const dataBytes = wav.readUInt32LE(dataAt + 4);
    expect(dataBytes / (44100 * 2 * 2)).toBeCloseTo(r.value.seconds, 1); // 16-bit stereo frames
  }, 60_000);

  it("never overwrites an existing file", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "gbmcp-gm-")), "taken.wav");
    writeFileSync(out, "keep");
    const r = await renderer.render(events, out);
    expect(r).toMatchObject({ ok: false, error: { code: "FILE_EXISTS" } });
    expect(readFileSync(out, "utf8")).toBe("keep");
  });
});
