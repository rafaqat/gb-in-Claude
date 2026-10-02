// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { parseAnalyzerOutput } from "./analyzer.js";

const minimalResult = {
  file: { seconds: 8, sample_rate: 48000, channels: 2 },
  loudness: { integrated_lufs: -14.2, levels: { sample_peak_dbfs: -1.2, true_peak_dbtp: -0.9, rms_dbfs: -15, crest_db: 13.8, clipped_samples: 0, clip_runs: 0 } },
  tonal_balance: {
    bands: { sub: { share: 0.3, db: -5.2 }, low: { share: 0.4, db: -4 }, mid: { share: 0.2, db: -7 }, presence: { share: 0.07, db: -11.5 }, air: { share: 0.03, db: -15.2 } },
    tilt_db_per_octave: -4.1, centroid_hz: 640,
  },
  stereo_width: { mono_source: false, overall: 0.2, bands: { low: 0.01, mid: 0.2, high: 0.4 } },
  rhythm: {
    tempo: { bpm: 132.1, bpm_folded: 132.1, relation_to_intended: "same", matches_intended: true, confidence: 0.6 },
    onset_density: 4.2,
    pump: { detected: false, depth_db: 1.2, trough_phase: 0.5, peak_phase: 0.1, strength: 0.1 },
  },
  drums: { percussive_ratio_db: -11.2, kick_band_share: 0.31 },
  key: { estimated: "F minor", confidence: 0.12, declared: "F minor", relation: "match" },
  sections: [{ name: "drop", start_s: 0, end_s: 8, truncated: false, lufs: -14, onset_density: 4, centroid_hz: 600, tilt_db_per_octave: -4, low_share: 0.7, pump: { detected: false, depth_db: 1 }, percussive_ratio_db: -12, kick_hit_share: 0.04, kick_band_share: 0.3 }],
  missing_sections: [],
  section_contrast: { loudest: "drop", quietest: "drop", range_lu: 0, drop_minus_breakdown_lu: null },
  thresholds: { thin_low_end_share: 0.2 },
  flags: [],
  suggestions: [],
  spectrogram: null,
};

describe("parseAnalyzerOutput", () => {
  it("parses a successful document into a typed result", () => {
    const out = parseAnalyzerOutput(JSON.stringify({ ok: true, result: minimalResult }) + "\n", 0);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.loudness.integrated_lufs).toBe(-14.2);
  });

  it("maps the sidecar's typed errors", () => {
    const out = parseAnalyzerOutput(JSON.stringify({ ok: false, error: { code: "AUDIO_INVALID", message: "not audio" } }), 2);
    expect(out).toEqual({ ok: false, error: { code: "AUDIO_INVALID", message: "not audio" } });
  });

  it.each([
    ["garbage", "Traceback (most recent call last)…", 1],
    ["extra output before the document", "warning: x\n" + JSON.stringify({ ok: true, result: minimalResult }), 0],
    ["a result that does not match the schema", JSON.stringify({ ok: true, result: { file: {} } }), 0],
    ["an unknown error code", JSON.stringify({ ok: false, error: { code: "WAT", message: "?" } }), 2],
    ["empty output", "", 1],
  ])("treats %s as ANALYSIS_FAILED", (_label, stdout, code) => {
    const out = parseAnalyzerOutput(stdout, code);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("ANALYSIS_FAILED");
  });
});
