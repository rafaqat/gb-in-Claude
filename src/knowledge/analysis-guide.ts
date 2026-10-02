// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/** Agent-facing guide to gb_analyze, served as gb://knowledge/analysis. */
export const ANALYSIS_GUIDE = `# Listening with gb_analyze

You cannot hear audio. gb_analyze measures it, and the spectrogram PNG lets you look at it (open the
returned path with your file-reading tool). Compare versions instead of trusting absolute numbers.

## The loop (no clicks)
1. gb_song render_midi { song, filename: "x-v2.mid" }
2. gb_project open_midi { path: "x-v2.mid" }   (unsaved projects are backed up to sessions/ first)
3. gb_export song { filename: "x-v2.wav" }     (lands in the export inbox, exports/)
4. gb_analyze against_song { path: "exports/x-v2.wav", song } → flags + suggestions with Song JSON paths
5. Change the Song JSON where the suggestion (or the user's ears) points; repeat with a new filename
6. gb_analyze compare { before, after, song } → verdict + per-section deltas (drums too)
For a quick structure check without GarageBand: gb_song render_draft (macOS GM synth; not for tone).
Waiting for the user: if a GarageBand call returns SCREEN_LOCKED, ask them to unlock the Mac.

## Metrics
loudness.integrated_lufs — BS.1770 (matches ffmpeg ebur128). Club masters ≈ -9…-7, streaming ≈ -14, drafts lower.
loudness.levels.true_peak_dbtp — keep ≤ -1. clip_runs > 0 = audible clipping.
tonal_balance.bands — energy shares: sub 20–60, low 60–250, mid 250–2k, presence 2–6k, air 6–20k Hz.
tonal_balance.tilt_db_per_octave — pink noise = 0; full mixes ≈ -3…-6; above -2 sounds bright/tinny.
tonal_balance.centroid_hz — "brightness"; tinny mixes sit far higher than full ones.
stereo_width — 0 mono … 0.5 uncorrelated … 1 out of phase; keep the low band near 0.
rhythm.tempo — estimate, folded onto the song tempo (half/double are reported, not errors).
rhythm.pump — sidechain "breathing": a dip right after each kick that recovers within the beat.
drums.percussive_ratio_db — percussive vs harmonic energy (+6 dB louder drums reads +6 dB). Per section too.
sections[].kick_hit_share — kick energy at the hit above the low band's average, share of the mix ("thump").
sections[].kick_band_share — 40–120 Hz (kick + bass) share of the mix.
key — Krumhansl estimate vs declared key: match / relative / parallel / mismatch.
sections — per-section loudness, density, brightness, pump on the Song JSON bar map.
section_contrast.drop_minus_breakdown_lu — a drop should be ≥ 3 LU louder than the breakdown.

## Flags → what to change
thin_low_end → bass part in the section, octave 1–2, fuller bass program (39), kick in the drums
bright_tilt → lower lead/arp velocity or octave, warmer patches
weak_drop → add drums/bass/lead to the drop or strip the breakdown
no_pump_in_drop → duck pads on the kick (GarageBand: Tremolo 1/4 on the pad track)
thumpy_kick (per section) → lower the drums track "level", soften kick steps (o instead of x), tighter kit
drums_forward (per section) → lower the drums level/velocities; skip if the section is a deliberate drum feature
low_end_heavy (per section) → kick + bass own 40–120 Hz: lower one of them or lift the bass an octave
(drum thresholds are calibrated on a single labelled example — treat them as starting points, not verdicts)
true_peak_over / clipping → lower track volumes or velocities
tempo_mismatch → GarageBand project tempo ≠ Song JSON tempo
key_mismatch → chords/notes vs declared key

Thresholds are heuristics (ask for fields: ["thresholds"] to see them).
`;
