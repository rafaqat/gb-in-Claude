# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Scoring helpers of eval/run.py.    models/.venv/bin/python -m unittest discover -s eval/tests"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import run  # noqa: E402


class GridScore(unittest.TestCase):
    def beats(self, bpm, n=40, start=0.3):
        return list(start + np.arange(n) * 60 / bpm + np.random.default_rng(1).normal(0, 0.01, n))

    def test_on_tempo(self):
        g = run.grid_score(self.beats(120), 120)
        self.assertEqual(g["pass_rate"], 1.0)
        self.assertEqual(g["grid_multiple"], 1)

    def test_double_time_reading_is_recorded_not_failed(self):
        g = run.grid_score(self.beats(160), 80)  # beat_this counted eighths of an 80 BPM ballad
        self.assertEqual(g["pass_rate"], 1.0)
        self.assertEqual(g["grid_multiple"], 2)

    def test_half_time_reading_is_recorded_not_failed(self):
        g = run.grid_score(self.beats(70), 140)  # trap felt in half time
        self.assertEqual(g["pass_rate"], 1.0)
        self.assertEqual(g["grid_multiple"], 0.5)

    def test_off_grid_beats_fail(self):
        g = run.grid_score(self.beats(97), 120)  # a different tempo altogether
        self.assertLess(g["pass_rate"], 0.5)


class KeyMatch(unittest.TestCase):
    def test_cases(self):
        self.assertEqual(run.key_match("G# Major", "F minor"), "relative")
        self.assertEqual(run.key_match("D# Major", "Eb major"), "exact")
        self.assertEqual(run.key_match("C minor", "F minor"), "other")


if __name__ == "__main__":
    unittest.main()


class SwingAwareGrid(unittest.TestCase):
    def swung(self, bpm, percent, n=40, start=0.3):
        """beats a tracker reports at double time (8ths) of a song swung on 8ths."""
        eighth = 60 / bpm / 2
        delay = (percent - 50) / 50 * eighth
        jitter = np.random.default_rng(7).normal(0, 0.02, n)  # humanize "loose" timing, as in the real renders
        return [start + i * eighth + (delay if i % 2 else 0) + jitter[i] for i in range(n)]

    def test_swung_eighths_at_double_time_fail_a_straight_grid(self):
        self.assertLess(run.grid_score(self.swung(80, 64), 80)["pass_rate"], 0.85)

    def test_the_song_swing_makes_them_pass(self):
        g = run.grid_score(self.swung(80, 64), 80, swing=64, swing_unit="8th")
        self.assertGreaterEqual(g["pass_rate"], 0.95)
        self.assertEqual(g["grid_multiple"], 2)

    def test_swing_does_not_change_a_straight_on_beat_reading(self):
        beats = [0.3 + i * 0.75 for i in range(30)]  # quarter notes at 80 BPM: swing only moves off-beats
        self.assertEqual(run.grid_score(beats, 80, swing=64, swing_unit="8th")["pass_rate"], 1.0)
