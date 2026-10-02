# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
import unittest
import numpy as np
from gbanalyze.rhythm import tempo, onset_density
from tests.signals import clicks, kick, SR


class TempoTest(unittest.TestCase):
    def test_click_track_tempo(self):
        out = tempo(clicks(132, 40), SR)
        self.assertAlmostEqual(out["bpm"], 132.0, delta=0.7)

    def test_four_on_the_floor_with_offbeat_hats(self):
        x = kick(128, 40) + clicks(128, 40, freq=8000, level=0.2, offset_beats=0.5)
        self.assertAlmostEqual(tempo(x, SR)["bpm"], 128.0, delta=0.7)

    def test_folds_onto_the_intended_tempo_octave(self):
        out = tempo(clicks(132, 40), SR, intended_bpm=66)
        self.assertAlmostEqual(out["bpm_folded"], 66.0, delta=0.5)
        self.assertEqual(out["relation_to_intended"], "half")
        self.assertTrue(out["matches_intended"])

    def test_reports_a_mismatch_against_a_wrong_intended_tempo(self):
        out = tempo(clicks(132, 40), SR, intended_bpm=120)
        self.assertFalse(out["matches_intended"])

    def test_silence_has_no_tempo(self):
        self.assertIsNone(tempo(np.zeros((SR * 5, 2)), SR)["bpm"])


class OnsetDensityTest(unittest.TestCase):
    def test_onsets_per_second_of_a_click_track(self):
        # 132 BPM quarter clicks = 2.2 onsets / s
        self.assertAlmostEqual(onset_density(clicks(132, 20), SR), 2.2, delta=0.2)

    def test_busier_parts_have_higher_density(self):
        self.assertGreater(onset_density(clicks(132, 20, every=0.25), SR), 3 * onset_density(clicks(132, 20), SR))


if __name__ == "__main__":
    unittest.main()


from gbanalyze.rhythm import pump  # noqa: E402
from tests.signals import pad, ducking  # noqa: E402


class PumpTest(unittest.TestCase):
    def test_detects_a_pad_ducking_after_each_kick(self):
        x = kick(128, 20) + pad(20) * ducking(128, 20)
        p = pump(x, SR, bpm=128)
        self.assertTrue(p["detected"])
        self.assertGreaterEqual(p["depth_db"], 3.0)
        self.assertLess(p["trough_phase"], 0.3)

    def test_a_steady_pad_over_the_same_kicks_is_not_pumping(self):
        self.assertFalse(pump(kick(128, 20) + pad(20), SR, bpm=128)["detected"])

    def test_claps_on_the_beat_are_peaks_not_pump(self):
        x = kick(128, 20) + pad(20) + clicks(128, 20, freq=1500, decay=0.03, level=0.4)
        self.assertFalse(pump(x, SR, bpm=128)["detected"])

    def test_without_tempo_or_signal_reports_nothing(self):
        self.assertIsNone(pump(np.zeros((SR * 4, 2)), SR, bpm=128)["detected"])
        self.assertIsNone(pump(pad(4), SR, bpm=None)["detected"])


from gbanalyze.rhythm import kick_thump  # noqa: E402
from tests.signals import sustained_bass, bass_line  # noqa: E402


class KickThumpTest(unittest.TestCase):
    def test_kicks_over_a_pad_punch_hard_in_the_low_band(self):
        self.assertGreater(kick_thump(pad(12) + kick(120, 12), SR, bpm=120)["punch_db"], 12)

    def test_a_held_bass_alone_does_not_punch(self):
        self.assertLess(kick_thump(pad(12) + sustained_bass(12), SR, bpm=120)["punch_db"], 3)

    def test_a_louder_kick_over_the_same_bass_punches_harder(self):
        soft = kick_thump(sustained_bass(12) + kick(120, 12, level=0.3), SR, bpm=120)["punch_db"]
        loud = kick_thump(sustained_bass(12) + kick(120, 12, level=0.9), SR, bpm=120)["punch_db"]
        self.assertGreater(loud, soft + 3)

    def test_kick_band_share_rises_with_the_kick(self):
        soft = kick_thump(pad(12) + kick(120, 12, level=0.2), SR, bpm=120)["kick_band_share"]
        loud = kick_thump(pad(12) + kick(120, 12, level=0.8), SR, bpm=120)["kick_band_share"]
        self.assertGreater(loud, soft)

    def test_without_tempo_reports_nothing(self):
        self.assertIsNone(kick_thump(kick(120, 4), SR, bpm=None)["punch_db"])


class KickHitShareTest(unittest.TestCase):
    """Kick energy at the hit (first 20 % of the beat) above the low band's average, as a share of the mix."""

    def test_a_held_bass_has_no_kick_hits(self):
        self.assertLess(kick_thump(pad(12) + sustained_bass(12), SR, bpm=120)["hit_share"], 0.02)

    def test_hit_share_grows_with_the_kick_over_the_same_bass(self):
        soft = kick_thump(bass_line(120, 12) + pad(12) + kick(120, 12, level=0.4), SR, bpm=120)["hit_share"]
        loud = kick_thump(bass_line(120, 12) + pad(12) + kick(120, 12, level=0.8), SR, bpm=120)["hit_share"]
        self.assertGreater(loud, 1.5 * soft)

    def test_a_kick_over_a_pad_dominates(self):
        self.assertGreater(kick_thump(pad(12) + kick(120, 12, level=0.8), SR, bpm=120)["hit_share"], 0.3)


class BeatLockedKickTest(unittest.TestCase):
    """With the beat grid known (sections start on bar lines), the hit window sits on the beat — a loud offbeat bass
    must not be mistaken for the kick (quieter kick made the old metric report the bass)."""

    def test_offbeat_bass_louder_than_a_soft_kick_reports_the_soft_kick(self):
        x = pad(12) + bass_line(120, 12, level=0.5) + kick(120, 12, level=0.1)
        locked = kick_thump(x, SR, bpm=120, beat_phase=0.0)["hit_share"]
        loud_kick = kick_thump(pad(12) + bass_line(120, 12, level=0.5) + kick(120, 12, level=0.8), SR, bpm=120, beat_phase=0.0)["hit_share"]
        self.assertLess(locked, 0.05)
        self.assertGreater(loud_kick, 4 * locked)
