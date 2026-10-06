# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""gb_analyze master (M13.2): a mastered copy — loudness target and true-peak ceiling, measured on the written file."""
import os
import tempfile
import unittest

import numpy as np
import soundfile as sf

from gbanalyze.loudness import integrated_lufs, true_peak
from gbanalyze.master import master
from tests.signals import kick, pad, SR


def _song(seconds=12.0):
    """A quiet mix with sharp transients: kicks over a pad, about -30 LUFS."""
    return (kick(120, seconds) * 0.2 + pad(seconds) * 0.3).astype(np.float64)


class MasterTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.src = os.path.join(self.dir.name, "mix.wav")
        sf.write(self.src, _song(), SR, subtype="PCM_24")

    def tearDown(self):
        self.dir.cleanup()

    def test_reaches_the_loudness_target_under_the_true_peak_ceiling(self):
        out = os.path.join(self.dir.name, "mix-master.wav")
        r = master(self.src, out, lufs=-14.0, peak_db=-1.0)
        y, rate = sf.read(out, always_2d=True, dtype="float64")
        self.assertEqual(rate, SR)
        self.assertAlmostEqual(integrated_lufs(y, rate), -14.0, delta=0.5)
        self.assertLessEqual(20 * np.log10(true_peak(y)), -1.0 + 0.05)
        self.assertAlmostEqual(r["after"]["lufs"], integrated_lufs(y, rate), delta=0.05)  # measured on the written file

    def test_never_overwrites(self):
        out = os.path.join(self.dir.name, "taken.wav")
        open(out, "wb").close()
        with self.assertRaises(FileExistsError):
            master(self.src, out)
        self.assertEqual(os.path.getsize(out), 0)

    def test_a_silent_input_is_refused(self):
        quiet = os.path.join(self.dir.name, "silent.wav")
        sf.write(quiet, np.zeros((SR * 2, 2)), SR, subtype="PCM_16")
        with self.assertRaises(ValueError):
            master(quiet, os.path.join(self.dir.name, "silent-master.wav"))

    def test_a_loud_input_is_turned_down_without_limiting(self):
        loud = os.path.join(self.dir.name, "loud.wav")
        sf.write(loud, pad(12.0) * 2.0, SR, subtype="PCM_24")  # a soft-edged pad, about -8 LUFS, no transients
        r = master(loud, os.path.join(self.dir.name, "loud-master.wav"), lufs=-16.0)
        self.assertEqual(r["limiter_max_reduction_db"], 0.0)
        self.assertAlmostEqual(r["after"]["lufs"], -16.0, delta=0.2)


if __name__ == "__main__":
    unittest.main()
