// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createPythonAnalyzer } from "./analyzer.js";
import { writeWav, sineStereo } from "../testing/wav.js";

const analysisDir = resolve(import.meta.dirname, "../../analysis");
const pythonReady = (() => {
  try {
    execFileSync("python3", ["-c", "import numpy, scipy, soundfile, matplotlib"], { stdio: "ignore", timeout: 30000 });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!pythonReady)("python analyzer sidecar (real process)", () => {
  let wav: string;
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "gbmcp-an-"));
    wav = join(dir, "sine.wav");
    writeWav(wav, sineStereo(6, 48000, -20), 48000);
  });

  it("analyzes a WAV: stereo 997 Hz at -20 dBFS measures -20 LUFS", async () => {
    const analyzer = createPythonAnalyzer({ python: "python3", analysisDir, timeoutMs: 120_000 });
    const out = await analyzer.analyze({ path: wav });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.file).toEqual({ seconds: 6, sample_rate: 48000, channels: 2 });
    expect(out.value.loudness.integrated_lufs).toBeCloseTo(-20, 0);
  }, 120_000);

  it("returns DEADLINE_EXCEEDED when the deadline passes", async () => {
    const out = await createPythonAnalyzer({ python: "python3", analysisDir, timeoutMs: 5 }).analyze({ path: wav });
    expect(out).toMatchObject({ ok: false, error: { code: "DEADLINE_EXCEEDED" } });
  });

  it("returns DEPENDENCY_MISSING when python is not there", async () => {
    const out = await createPythonAnalyzer({ python: "/nonexistent/python3", analysisDir, timeoutMs: 10_000 }).analyze({ path: wav });
    expect(out).toMatchObject({ ok: false, error: { code: "DEPENDENCY_MISSING" } });
  });
});
