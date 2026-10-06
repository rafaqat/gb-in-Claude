# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Memory limits of the audio loader: the 20-minute limit was checked in seconds
only, so a FLAC at 655350 Hz passed it and took gigabytes (60 s: 3.6 GB measured)."""
import os
import tempfile
import unittest
from unittest import mock

import numpy as np
import soundfile as sf

from gbanalyze import cli


class LoadLimits(unittest.TestCase):
    def write(self, rate, seconds=0.5, channels=2, fmt="WAV"):
        p = os.path.join(tempfile.mkdtemp(), f"x.{fmt.lower()}")
        sf.write(p, np.zeros((int(rate * seconds), channels)), rate, format=fmt)
        return p

    def test_a_sample_rate_above_192_khz_is_refused_before_reading(self):
        with self.assertRaises(cli.CliError) as e:
            cli._load(self.write(384_000))
        self.assertEqual(e.exception.code, "NOT_SUPPORTED")

    def test_more_samples_than_20_minutes_of_48_khz_stereo_are_refused(self):
        p = self.write(48_000, seconds=1.0)
        with mock.patch.object(cli, "MAX_SAMPLES", 48_000):  # 1 s stereo = 96 000 samples
            with self.assertRaises(cli.CliError) as e:
                cli._load(p)
        self.assertEqual(e.exception.code, "NOT_SUPPORTED")

    def test_ordinary_audio_still_loads(self):
        x, rate = cli._load(self.write(44_100))
        self.assertEqual((rate, x.shape[1]), (44_100, 2))

    def test_the_sample_cap_is_20_minutes_of_48_khz_stereo(self):
        self.assertEqual(cli.MAX_SAMPLES, 20 * 60 * 48_000 * 2)


if __name__ == "__main__":
    unittest.main()
