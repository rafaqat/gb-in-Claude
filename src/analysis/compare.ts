// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import type { AnalysisResult } from "./analyzer.js";

export type Comparison = {
  deltas: {
    integrated_lufs: number | null;
    true_peak_dbtp: number | null;
    low_share: number | null;
    tilt_db_per_octave: number | null;
    centroid_hz: number | null;
    stereo_width: number | null;
    onset_density: number | null;
    percussive_ratio_db: number | null;
  };
  resolved: string[];
  introduced: string[];
  verdict: "improved" | "regressed" | "mixed" | "unchanged";
  sections: {
    name: string; lufs_before: number | null; lufs_after: number | null; delta_lu: number | null;
    percussive_ratio_db_delta: number | null; kick_hit_share_delta: number | null;
  }[];
};

const delta = (before: number | null, after: number | null) => (before === null || after === null ? null : after - before);

const lowShare = (r: AnalysisResult) => {
  const { sub, low } = r.tonal_balance.bands;
  return sub.share === null || low.share === null ? null : sub.share + low.share;
};

/** after − before for the headline metrics, flags resolved/introduced, and per-section loudness. */
export function compareAnalyses(before: AnalysisResult, after: AnalysisResult): Comparison {
  const was = new Set(before.flags);
  const now = new Set(after.flags);
  const resolved = [...was].filter((f) => !now.has(f)).sort();
  const introduced = [...now].filter((f) => !was.has(f)).sort();
  const verdict = resolved.length && introduced.length ? "mixed" : resolved.length ? "improved" : introduced.length ? "regressed" : "unchanged";
  const afterSections = new Map(after.sections.map((s) => [s.name, s]));
  return {
    deltas: {
      integrated_lufs: delta(before.loudness.integrated_lufs, after.loudness.integrated_lufs),
      true_peak_dbtp: delta(before.loudness.levels.true_peak_dbtp, after.loudness.levels.true_peak_dbtp),
      low_share: delta(lowShare(before), lowShare(after)),
      tilt_db_per_octave: delta(before.tonal_balance.tilt_db_per_octave, after.tonal_balance.tilt_db_per_octave),
      centroid_hz: delta(before.tonal_balance.centroid_hz, after.tonal_balance.centroid_hz),
      stereo_width: delta(before.stereo_width.overall, after.stereo_width.overall),
      onset_density: delta(before.rhythm.onset_density, after.rhythm.onset_density),
      percussive_ratio_db: delta(before.drums.percussive_ratio_db, after.drums.percussive_ratio_db),
    },
    resolved,
    introduced,
    verdict,
    sections: before.sections
      .filter((s) => afterSections.has(s.name))
      .map((s) => {
        const a = afterSections.get(s.name)!;
        return {
          name: s.name, lufs_before: s.lufs, lufs_after: a.lufs, delta_lu: delta(s.lufs, a.lufs),
          percussive_ratio_db_delta: delta(s.percussive_ratio_db, a.percussive_ratio_db),
          kick_hit_share_delta: delta(s.kick_hit_share, a.kick_hit_share),
        };
      }),
  };
}
