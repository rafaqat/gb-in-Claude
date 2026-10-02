# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
import unittest
import numpy as np
from scipy.signal import butter, sosfilt
from gbanalyze.spectral import tonal_balance, BANDS
from tests.signals import noise, SR

OCTAVES = {name: np.log2(hi / lo) for name, (lo, hi) in BANDS.items()}
TOTAL_OCTAVES = sum(OCTAVES.values())


def filtered(kind, cutoff, seconds=8):
    sos = butter(8, cutoff, btype=kind, fs=SR, output="sos")
    return sosfilt(sos, noise(seconds, -20, color="white"), axis=0)


class TonalBalanceTest(unittest.TestCase):
    def test_pink_noise_band_shares_follow_octave_widths(self):
        bands = tonal_balance(noise(10, -20, color="pink"), SR)["bands"]
        for name in BANDS:
            self.assertAlmostEqual(bands[name]["share"], OCTAVES[name] / TOTAL_OCTAVES, delta=0.03, msg=name)

    def test_low_passed_noise_lives_in_sub_and_low_bands(self):
        bands = tonal_balance(filtered("lowpass", 180), SR)["bands"]
        self.assertGreater(bands["sub"]["share"] + bands["low"]["share"], 0.9)

    def test_high_passed_noise_lives_in_presence_and_air(self):
        bands = tonal_balance(filtered("highpass", 3000), SR)["bands"]
        self.assertGreater(bands["presence"]["share"] + bands["air"]["share"], 0.9)

    def test_spectral_tilt_is_flat_for_pink_and_plus_3db_per_octave_for_white(self):
        self.assertAlmostEqual(tonal_balance(noise(10, -20, color="pink"), SR)["tilt_db_per_octave"], 0.0, delta=0.5)
        self.assertAlmostEqual(tonal_balance(noise(10, -20, color="white"), SR)["tilt_db_per_octave"], 3.0, delta=0.5)

    def test_centroid_of_pink_noise_and_ordering(self):
        self.assertAlmostEqual(tonal_balance(noise(10, -20, color="pink"), SR)["centroid_hz"], 2892, delta=300)
        self.assertLess(tonal_balance(filtered("lowpass", 400), SR)["centroid_hz"],
                        tonal_balance(filtered("highpass", 2000), SR)["centroid_hz"])

    def test_silence_has_no_balance(self):
        out = tonal_balance(np.zeros((SR, 2)), SR)
        self.assertIsNone(out["tilt_db_per_octave"])
        self.assertIsNone(out["centroid_hz"])


if __name__ == "__main__":
    unittest.main()


from gbanalyze.spectral import stereo_width, WIDTH_BANDS  # noqa: E402


class StereoWidthTest(unittest.TestCase):
    def test_identical_channels_have_zero_width(self):
        mono = noise(5, -20, channels=1)
        w = stereo_width(np.hstack([mono, mono]), SR)
        self.assertAlmostEqual(w["overall"], 0.0, delta=0.01)
        self.assertFalse(w["mono_source"])

    def test_independent_channels_have_half_width_and_inverted_full(self):
        self.assertAlmostEqual(stereo_width(noise(5, -20, channels=2), SR)["overall"], 0.5, delta=0.05)
        mono = noise(5, -20, channels=1)
        self.assertAlmostEqual(stereo_width(np.hstack([mono, -mono]), SR)["overall"], 1.0, delta=0.01)

    def test_width_is_reported_per_band(self):
        low = filtered("lowpass", 120)[:, :1]  # mono low end
        high = sosfilt(butter(8, 5000, btype="highpass", fs=SR, output="sos"), noise(8, -20, channels=2, seed=5), axis=0)  # wide top
        w = stereo_width(np.hstack([low, low]) + high, SR)
        self.assertEqual(set(w["bands"]), set(WIDTH_BANDS))
        self.assertLess(w["bands"]["low"], 0.05)
        self.assertGreater(w["bands"]["high"], 0.4)

    def test_mono_file_is_flagged_as_mono_source(self):
        w = stereo_width(noise(2, -20, channels=1), SR)
        self.assertTrue(w["mono_source"])
        self.assertEqual(w["overall"], 0.0)
