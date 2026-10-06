# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""grid_score (M9/m9c, tests added in M13.5): beats against the brief's grid, with swing."""
import unittest

import numpy as np

from gbmodels.scoring import grid_score

FRAME = 0.02


def framed(times):
    return np.round(np.asarray(times) / FRAME) * FRAME


class GridScoreTest(unittest.TestCase):
    def test_a_straight_song_on_its_grid_passes(self):
        beats = framed(0.3 + np.arange(64) * 0.5)  # 120 BPM, GarageBand trimmed 0.3 s
        self.assertGreaterEqual(grid_score(beats, 120)["pass_rate"], 0.95)

    def test_hard_swung_eighths_pass_only_with_the_swing_model(self):
        # 80 BPM, 8th notes, swing 75: every second 8th is 188 ms late — more than twice the 70 ms tolerance
        unit = 60 / 80 / 2
        delay = (75 - 50) / 50 * unit
        beats = framed([k * unit + (delay if k % 2 else 0.0) for k in range(96)])
        self.assertGreaterEqual(grid_score(beats, 80, swing=75, swing_unit="8th")["pass_rate"], 0.95)
        self.assertLess(grid_score(beats, 80)["pass_rate"], 0.8)

    def test_the_detected_tempo_is_not_quantised_by_the_tracker_frames(self):
        beats = framed(np.arange(200) * 60 / 84.85)  # median interval 0.70 s reads 85.71
        self.assertAlmostEqual(grid_score(beats, 85)["detected_bpm"], 84.85, delta=0.05)


if __name__ == "__main__":
    unittest.main()
