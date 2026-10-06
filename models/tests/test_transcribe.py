# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Transcription (M13.14): stems -> notes and drum hits on the song map's GarageBand bar lines. Synthetic pitch tracks,
onsets and envelopes, so the expected notes are exact."""
import unittest

import numpy as np

from gbmodels import transcribe

HOP = 0.01  # 10 ms frames
LINES = [0.0, 2.0, 4.0]  # two GarageBand bars at 120 BPM: a 16th step is 0.125 s


def track(notes, end=4.0):
    """A frame-wise MIDI pitch track (NaN = unvoiced) from [(pitch, start_s, end_s)]."""
    times = np.arange(0, end, HOP)
    midi = np.full(len(times), np.nan)
    for p, a, b in notes:
        midi[(times >= a) & (times < b)] = p
    return times, midi


class GridNotesTest(unittest.TestCase):
    def test_held_notes_and_rests_land_on_16th_steps(self):
        times, midi = track([(36, 0.0, 0.5), (40, 1.0, 2.0), (43, 2.0, 2.25)])
        notes = transcribe.grid_notes(midi, times, onsets=[0.0, 1.0, 2.0], lines=LINES)
        self.assertEqual(notes, [{"bar": 1, "step": 0, "len": 4, "pitch": 36},
                                 {"bar": 1, "step": 8, "len": 8, "pitch": 40},
                                 {"bar": 2, "step": 0, "len": 2, "pitch": 43}])

    def test_an_onset_strikes_the_same_pitch_again_and_an_octave_jump_without_one_is_a_tracker_error(self):
        times, midi = track([(38, 0.0, 0.5), (38, 0.5, 1.0), (50, 1.0, 1.25), (38, 1.25, 1.5)])
        notes = transcribe.grid_notes(midi, times, onsets=[0.0, 0.5], lines=LINES)
        self.assertEqual(notes, [{"bar": 1, "step": 0, "len": 4, "pitch": 38}, {"bar": 1, "step": 4, "len": 8, "pitch": 38}])

    def test_a_100_ms_glide_into_the_next_note_leaves_no_passing_note(self):
        # measured on a GM render: a sung 69 -> 67 moves over ~100 ms from just after the step line
        times, midi = track([(69, 0.0, 0.505), (67, 0.605, 1.0), (69, 1.0, 1.5)])
        glide = (times >= 0.505) & (times < 0.605)
        midi[glide] = np.interp(times[glide], [0.505, 0.605], [69, 67])
        notes = transcribe.grid_notes(midi, times, onsets=[0.0], lines=LINES)
        self.assertEqual([(n["step"], n["len"], n["pitch"]) for n in notes], [(0, 4, 69), (4, 4, 67), (8, 4, 69)])

    def test_a_singer_s_wide_vibrato_is_one_note(self):
        times, midi = track([(64, 0.0, 1.5), (67, 1.5, 2.0)])
        held = times < 1.5
        midi[held] += 0.7 * np.sin(2 * np.pi * 5.5 * times[held])  # +-70 cents at 5.5 Hz, as real singers do
        notes = transcribe.grid_notes(midi, times, onsets=[], lines=LINES)
        self.assertEqual([(n["step"], n["len"], n["pitch"]) for n in notes], [(0, 12, 64), (12, 4, 67)])


def envelope(peaks, end=4.0):
    """An onset envelope with a 30 ms decaying spike of height h at each (t, h), over a faint noise floor."""
    times = np.arange(0, end, HOP)
    env = np.random.default_rng(0).uniform(0, 0.02, len(times))
    for t, h in peaks:
        i = int(round(t / HOP))
        env[i:i + 3] += h * np.array([1.0, 0.5, 0.2])
    return times, env


class DrumHitsTest(unittest.TestCase):
    def test_peaks_snap_to_the_nearest_step_and_faint_ones_are_not_hits(self):
        times, kick = envelope([(0.0, 1.0), (0.27, 0.9), (1.0, 1.0), (1.5, 0.05), (2.48, 0.6)])
        hits = transcribe.drum_hits({"kick": kick}, times, LINES)
        self.assertEqual([(h["bar"], h["step"]) for h in hits["kick"]], [(1, 0), (1, 2), (1, 8), (2, 4)])
        self.assertTrue(all(0 < h["strength"] <= 1 for h in hits["kick"]))

    def test_a_stroke_outside_the_bar_lines_is_not_put_on_the_first_or_last_step(self):
        times, env = envelope([(0.5, 1.0), (1.0, 1.0), (4.3, 1.0)], end=4.6)  # 4.3 s: a tail after the last bar line
        hits = transcribe.drum_hits({"kick": env}, times, LINES)
        self.assertEqual([(h["bar"], h["step"]) for h in hits["kick"]], [(1, 4), (1, 8)])

    def test_ghost_strokes_count_for_kick_and_hats_but_the_snare_floor_is_higher(self):
        # measured (eval/m13-transcribe): a kick's spill lands on the snare, so the snare needs a firmer hit
        times, env = envelope([(0.25 * k, 0.2 if k == 2 else 1.0) for k in range(16)])  # a ghost on bar 1, step 4
        hits = transcribe.drum_hits({"kick": env, "snare": env, "hat": env}, times, LINES)
        ghost = lambda v: (1, 4) in [(h["bar"], h["step"]) for h in hits[v]]  # noqa: E731
        self.assertEqual((ghost("kick"), ghost("hat"), ghost("snare")), (True, True, False))
        self.assertEqual(len(hits["snare"]), 15)


SR = 22050


def tones(notes, end=4.0):
    """A plucked tone per (midi, start_s, end_s): a sine with its 2nd harmonic and a short decay at the end."""
    t = np.arange(int(end * SR)) / SR
    y = np.zeros(len(t))
    for p, a, b in notes:
        hz = 440.0 * 2 ** ((p - 69) / 12)
        sel = (t >= a) & (t < b)
        env = np.minimum(1.0, (t[sel] - a) / 0.005) * np.minimum(1.0, (b - t[sel]) / 0.01)
        y[sel] += env * (0.4 * np.sin(2 * np.pi * hz * t[sel]) + 0.15 * np.sin(4 * np.pi * hz * t[sel]))
    return y


def hits(times, kind, end=4.0):
    """Drum strokes: kick = a 55 Hz thump, snare = mid noise + body, hat = high noise (short)."""
    rng = np.random.default_rng(3)
    y = np.zeros(int(end * SR))
    for t0 in times:
        a = int(t0 * SR)
        n = int(0.12 * SR)
        k = np.arange(n) / SR
        if kind == "kick":
            s = np.sin(2 * np.pi * 55 * k) * np.exp(-k * 25)
        elif kind == "snare":
            noise = np.convolve(rng.standard_normal(n), np.ones(4) / 4, mode="same")
            s = (0.6 * noise + 0.5 * np.sin(2 * np.pi * 190 * k)) * np.exp(-k * 30)
        else:
            s = np.diff(rng.standard_normal(n + 1)) * np.exp(-k * 80) * 0.3
        y[a:a + n] += 0.8 * s[:len(y) - a]
    return y


class RunTest(unittest.TestCase):
    def test_bass_lead_and_drums_from_four_stems(self):
        import os
        import tempfile
        import soundfile as sf
        beat = 0.5
        bass = tones([(36, 0.0, 0.95), (36, 1.0, 1.95), (43, 2.0, 3.95)])
        lead = tones([(72, 0.0, 0.45), (74, 0.5, 0.95), (76, 1.0, 1.95), (79, 2.0, 2.95)])
        drums = hits([0.0, 1.0, 2.0, 3.0], "kick") + hits([0.5, 1.5, 2.5, 3.5], "snare") + hits(np.arange(8) * beat + 0.25, "hat")
        with tempfile.TemporaryDirectory() as d:
            stems = {}
            for name, y in (("bass", bass), ("vocals", lead), ("drums", drums), ("other", np.zeros_like(bass))):
                stems[name] = os.path.join(d, f"take-{name}.wav")
                sf.write(stems[name], np.stack([y, y], axis=1), SR)
            out = transcribe.run(transcribe.load("cpu"), {"stems": stems, "lines": LINES})
        self.assertEqual([(n["bar"], n["step"], n["len"], n["pitch"]) for n in out["bass"]], [(1, 0, 8, 36), (1, 8, 8, 36), (2, 0, 16, 43)])
        self.assertEqual([n["pitch"] for n in out["lead"]], [72, 74, 76, 79])
        self.assertEqual(out["lead_source"], "vocals")
        self.assertEqual([(h["bar"], h["step"]) for h in out["drums"]["kick"]], [(1, 0), (1, 8), (2, 0), (2, 8)])
        self.assertEqual([(h["bar"], h["step"]) for h in out["drums"]["snare"]], [(1, 4), (1, 12), (2, 4), (2, 12)])
        self.assertEqual([(h["bar"], h["step"]) for h in out["drums"]["hat"]], [(b, s) for b in (1, 2) for s in (2, 6, 10, 14)])
        self.assertEqual(out["bass_source"], "bass")

    def test_a_silent_stem_is_named_not_transcribed(self):
        """Demucs can leave a stem empty (it put a synth bass in "other"): the draft must say so, not guess."""
        import os
        import tempfile
        import soundfile as sf
        quiet = 1e-5 * np.random.default_rng(0).standard_normal(int(4.0 * SR))  # -100 dBFS: separation residue
        with tempfile.TemporaryDirectory() as d:
            stems = {}
            for name, y in (("bass", quiet), ("vocals", tones([(72, 0.0, 1.95)])), ("drums", hits([0.0, 1.0], "kick")), ("other", quiet)):
                stems[name] = os.path.join(d, f"take-{name}.wav")
                sf.write(stems[name], np.stack([y, y], axis=1), SR)
            out = transcribe.run(transcribe.load("cpu"), {"stems": stems, "lines": LINES})
        self.assertEqual((out["bass"], out["bass_source"]), ([], None))
        self.assertEqual(out["lead_source"], "vocals")


class RegistryTest(unittest.TestCase):
    def test_the_sidecar_serves_it_from_the_models_venv(self):
        from gbmodels.registry import MODELS
        meta = MODELS["transcribe"]
        self.assertEqual((meta["module"], meta["venv"]), ("gbmodels.transcribe", ".venv"))
        self.assertIn("ISC", meta["license"])  # librosa (pYIN); recorded, never a filter


if __name__ == "__main__":
    unittest.main()
