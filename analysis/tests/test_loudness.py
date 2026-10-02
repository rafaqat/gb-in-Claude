# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
import os
import unittest
import numpy as np
from gbanalyze.loudness import k_weighting_coefficients


class KWeightingTest(unittest.TestCase):
    def test_matches_itu_bs1770_coefficients_at_48k(self):
        # ITU-R BS.1770-4, Tables 1 and 2 (48 kHz)
        (b1, a1), (b2, a2) = k_weighting_coefficients(48000)
        np.testing.assert_allclose(b1, [1.53512485958697, -2.69169618940638, 1.19839281085285], atol=1e-8)
        np.testing.assert_allclose(a1, [1.0, -1.69065929318241, 0.73248077421585], atol=1e-8)
        np.testing.assert_allclose(b2, [1.0, -2.0, 1.0], atol=1e-8)
        np.testing.assert_allclose(a2, [1.0, -1.99004745483398, 0.99007225036621], atol=1e-8)


if __name__ == "__main__":
    unittest.main()


from gbanalyze.loudness import integrated_lufs  # noqa: E402
from tests.signals import sine, silence, SR  # noqa: E402


class IntegratedLoudnessTest(unittest.TestCase):
    def test_stereo_997hz_sine_at_minus_20_dbfs_is_minus_20_lufs(self):
        self.assertAlmostEqual(integrated_lufs(sine(997, 10), SR), -20.0, delta=0.1)

    def test_mono_sine_is_3_db_quieter_than_stereo(self):
        self.assertAlmostEqual(integrated_lufs(sine(997, 10, channels=1), SR), -23.01, delta=0.1)

    def test_absolute_gate_ignores_silence(self):
        x = np.vstack([sine(997, 10), silence(10)])
        self.assertAlmostEqual(integrated_lufs(x, SR), -20.0, delta=0.1)

    def test_silence_has_no_loudness(self):
        self.assertIsNone(integrated_lufs(silence(5), SR))

    def test_shorter_than_one_block_has_no_loudness(self):
        self.assertIsNone(integrated_lufs(sine(997, 0.3), SR))


import tempfile  # noqa: E402
from pathlib import Path  # noqa: E402
import soundfile as sf  # noqa: E402
from tests.reference import FFMPEG, ffmpeg_ebur128  # noqa: E402
from tests.signals import noise  # noqa: E402

# Optional golden check against real GarageBand exports: GB_MCP_REAL_EXPORTS (a folder of WAVs), else the default
# workspace's exports folder. Skipped when neither has a WAV.
REAL_EXPORTS = sorted(Path(os.environ.get("GB_MCP_REAL_EXPORTS", Path.home() / "Music" / "gb-mcp" / "exports")).glob("*.wav"))


@unittest.skipUnless(FFMPEG, "ffmpeg not installed")
class GoldenAgainstFfmpegTest(unittest.TestCase):
    def _compare(self, path, x=None, rate=None):
        if x is None:
            x, rate = sf.read(str(path), always_2d=True)
        ref_i, _ = ffmpeg_ebur128(path)
        self.assertAlmostEqual(integrated_lufs(x, rate), ref_i, delta=0.2)

    def test_dynamic_pink_noise_matches_ffmpeg_ebur128(self):
        x = np.vstack([noise(5, -30, color="pink"), silence(2), noise(5, -15, color="pink", seed=2), noise(3, -45, seed=3)])
        with tempfile.TemporaryDirectory() as d:
            path = Path(d, "dyn.wav")
            sf.write(str(path), x, SR, subtype="FLOAT")
            self._compare(path, x, SR)

    @unittest.skipUnless(REAL_EXPORTS, "no real GarageBand export (set GB_MCP_REAL_EXPORTS)")
    def test_real_garageband_export_matches_ffmpeg_ebur128(self):
        self._compare(REAL_EXPORTS[0])


from gbanalyze.loudness import levels  # noqa: E402


class LevelsTest(unittest.TestCase):
    def test_true_peak_finds_the_inter_sample_peak_that_sample_peak_misses(self):
        # fs/4 sine at 45° phase: every sample lands at 0.707 of the real waveform peak
        t = np.arange(SR * 2) / SR
        x = np.tile((0.9 * np.sin(2 * np.pi * (SR / 4) * t + np.pi / 4))[:, None], (1, 2))
        lv = levels(x, SR)
        self.assertAlmostEqual(lv["sample_peak_dbfs"], 20 * np.log10(0.9 * np.sin(np.pi / 4)), delta=0.05)
        self.assertAlmostEqual(lv["true_peak_dbtp"], 20 * np.log10(0.9), delta=0.3)

    def test_crest_factor_of_a_sine_is_3_db(self):
        self.assertAlmostEqual(levels(sine(1000, 2, dbfs=-6), SR)["crest_db"], 3.01, delta=0.05)

    def test_detects_hard_clipping_but_not_a_clean_loud_sine(self):
        clipped = np.clip(sine(220, 2, dbfs=3.5), -1.0, 1.0)  # +3.5 dB sine hard-clipped at full scale
        self.assertGreater(levels(clipped, SR)["clip_runs"], 0)
        self.assertEqual(levels(sine(220, 2, dbfs=-1), SR)["clip_runs"], 0)

    def test_silence_reports_no_levels(self):
        lv = levels(silence(1), SR)
        self.assertIsNone(lv["sample_peak_dbfs"])
        self.assertIsNone(lv["crest_db"])


@unittest.skipUnless(FFMPEG and REAL_EXPORTS, "needs ffmpeg and a real export")
class TruePeakGoldenTest(unittest.TestCase):
    def test_true_peak_matches_ffmpeg_on_real_export(self):
        x, rate = sf.read(str(REAL_EXPORTS[0]), always_2d=True)
        _, ref_peak = ffmpeg_ebur128(REAL_EXPORTS[0])
        self.assertAlmostEqual(levels(x, rate)["true_peak_dbtp"], ref_peak, delta=0.3)
