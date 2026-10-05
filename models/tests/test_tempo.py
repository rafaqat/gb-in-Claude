# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""The tempo of a beat list (beat_this times, on 20 ms frames): exact enough to re-time audio by."""
import unittest

import numpy as np

from gbmodels import beatthis

FRAME = 0.02  # beat_this reports beats on 50 fps frames


def framed(bpm: float, n: int, start: float = 0.0) -> np.ndarray:
    """n beats at `bpm` from `start`, rounded to the tracker's frames."""
    return np.round((start + np.arange(n) * 60.0 / bpm) / FRAME) * FRAME


class TempoTest(unittest.TestCase):
    def test_not_quantised_by_the_tracker_frames(self):
        # 84.85 BPM gives intervals of 0.70 s and 0.72 s; their median (0.70 s) reads 85.71 BPM — 1 % fast
        self.assertAlmostEqual(beatthis.tempo(framed(84.85, 300)), 84.85, delta=0.03)

    def test_a_free_intro_and_a_break_do_not_move_it(self):
        intro = np.array([0.14, 1.30, 1.80, 3.90, 4.62])            # rubato: no grid
        verse = framed(79.0, 120, start=8.74)                         # after a 4.12 s gap
        rest = framed(79.0, 100, start=verse[-1] + 3.58 + 60 / 79.0)  # after a 3.58 s break
        self.assertAlmostEqual(beatthis.tempo(np.concatenate([intro, verse, rest])), 79.0, delta=0.05)

    def test_a_beat_caught_on_a_swung_off_beat_does_not_move_it(self):
        b = framed(86.0, 200)
        b[100:] += round(60 / 86.0 / 3 / FRAME) * FRAME               # from beat 100 the tracker follows the swung 8th
        self.assertAlmostEqual(beatthis.tempo(b), 86.0, delta=0.05)


if __name__ == "__main__":
    unittest.main()
