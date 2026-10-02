// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { compareAnalyses } from "./compare.js";
import type { AnalysisResult } from "./analyzer.js";

function result(over: {
  lufs?: number; tp?: number; low?: number; tilt?: number; centroid?: number; flags?: string[];
  sections?: { name: string; lufs: number }[];
}): AnalysisResult {
  const low = over.low ?? 0.5;
  return {
    file: { seconds: 10, sample_rate: 44100, channels: 2 },
    loudness: { integrated_lufs: over.lufs ?? -14, levels: { sample_peak_dbfs: -1, true_peak_dbtp: over.tp ?? -1, rms_dbfs: -15, crest_db: 14, clipped_samples: 0, clip_runs: 0 } },
    tonal_balance: {
      bands: { sub: { share: low / 2, db: null }, low: { share: low / 2, db: null }, mid: { share: (1 - low) / 2, db: null }, presence: { share: (1 - low) / 4, db: null }, air: { share: (1 - low) / 4, db: null } },
      tilt_db_per_octave: over.tilt ?? -4, centroid_hz: over.centroid ?? 800,
    },
    stereo_width: { mono_source: false, overall: 0.2, bands: { low: 0, mid: 0.2, high: 0.3 } },
    rhythm: { tempo: { bpm: 132, bpm_folded: 132, relation_to_intended: "same", matches_intended: true, confidence: 0.5 }, onset_density: 4, pump: { detected: false, depth_db: 1, trough_phase: 0.5, peak_phase: 0.2, strength: 0.1 } },
    drums: { percussive_ratio_db: -10, kick_band_share: 0.3 },
    key: { estimated: "F minor", confidence: 0.1, declared: "F minor", relation: "match" },
    sections: (over.sections ?? []).map((s, i) => ({ name: s.name, start_s: i * 5, end_s: i * 5 + 5, truncated: false, lufs: s.lufs, onset_density: 4, centroid_hz: 800, tilt_db_per_octave: -4, low_share: low, pump: { detected: false, depth_db: 1 }, percussive_ratio_db: null, kick_hit_share: null, kick_band_share: null })),
    missing_sections: [],
    section_contrast: { loudest: null, quietest: null, range_lu: null, drop_minus_breakdown_lu: null },
    thresholds: {}, flags: over.flags ?? [], suggestions: [], spectrogram: null,
  };
}

describe("compareAnalyses", () => {
  it("reports metric deltas (after - before)", () => {
    const d = compareAnalyses(result({ lufs: -18, low: 0.1, tilt: 1, centroid: 3000 }), result({ lufs: -14, low: 0.45, tilt: -4.5, centroid: 700 }));
    expect(d.deltas.integrated_lufs).toBeCloseTo(4);
    expect(d.deltas.low_share).toBeCloseTo(0.35);
    expect(d.deltas.tilt_db_per_octave).toBeCloseTo(-5.5);
    expect(d.deltas.centroid_hz).toBeCloseTo(-2300);
  });

  it("lists flags resolved and introduced, and a verdict", () => {
    const d = compareAnalyses(result({ flags: ["thin_low_end", "bright_tilt"] }), result({ flags: ["true_peak_over"] }));
    expect(d.resolved).toEqual(["bright_tilt", "thin_low_end"]);
    expect(d.introduced).toEqual(["true_peak_over"]);
    expect(d.verdict).toBe("mixed");
  });

  it("verdict improved / regressed / unchanged", () => {
    expect(compareAnalyses(result({ flags: ["thin_low_end"] }), result({ flags: [] })).verdict).toBe("improved");
    expect(compareAnalyses(result({ flags: [] }), result({ flags: ["clipping"] })).verdict).toBe("regressed");
    expect(compareAnalyses(result({ flags: ["weak_drop"] }), result({ flags: ["weak_drop"] })).verdict).toBe("unchanged");
  });

  it("compares sections present in both runs by name", () => {
    const d = compareAnalyses(
      result({ sections: [{ name: "breakdown", lufs: -20 }, { name: "drop", lufs: -16 }] }),
      result({ sections: [{ name: "drop", lufs: -12 }, { name: "outro", lufs: -18 }] }),
    );
    expect(d.sections).toEqual([{ name: "drop", lufs_before: -16, lufs_after: -12, delta_lu: 4, percussive_ratio_db_delta: null, kick_hit_share_delta: null }]);
  });

  it("reports drum deltas per shared section (forwardness and kick hits)", () => {
    const before = result({ sections: [{ name: "intro", lufs: -20 }] });
    const after = result({ sections: [{ name: "intro", lufs: -21 }] });
    before.sections[0]!.percussive_ratio_db = 5.5; after.sections[0]!.percussive_ratio_db = -2.5;
    before.sections[0]!.kick_hit_share = 0.23; after.sections[0]!.kick_hit_share = 0.08;
    before.drums.percussive_ratio_db = -9; after.drums.percussive_ratio_db = -10;
    const d = compareAnalyses(before, after);
    expect(d.sections[0]).toMatchObject({ name: "intro", percussive_ratio_db_delta: -8, kick_hit_share_delta: expect.closeTo(-0.15, 6) });
    expect(d.deltas.percussive_ratio_db).toBeCloseTo(-1, 6);
  });

  it("treats null metrics as unknown deltas, never as zero", () => {
    const before = result({});
    before.loudness.integrated_lufs = null;
    expect(compareAnalyses(before, result({})).deltas.integrated_lufs).toBeNull();
  });
});
