# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Stem tools (M11b): alignment of outside audio to a gb-mcp song — synthetic signals, so expected values are exact."""
import os
import shutil
import tempfile
import unittest

import numpy as np
import soundfile as sf

from gbmodels import stems

SR = 44100


def clicks(bpm: float, beats: int, sr: int = SR) -> tuple[np.ndarray, np.ndarray]:
    """A stereo click train: a 30 ms decaying noise burst on every beat; returns (audio, click times in seconds)."""
    rng = np.random.default_rng(1)
    times = np.arange(beats) * 60.0 / bpm
    x = np.zeros((int((times[-1] + 1.0) * sr), 2))
    burst = rng.standard_normal(int(0.03 * sr)) * np.exp(-np.linspace(0, 8, int(0.03 * sr)))
    burst = burst / np.abs(burst).max()  # peaks at 0.5 below: −6 dBFS, never clipped
    for t in times:
        a = int(t * sr)
        x[a:a + len(burst)] += burst[:, None] * 0.5
    return x, times


def tone(hz: float, seconds: float, sr: int = SR) -> np.ndarray:
    t = np.arange(int(seconds * sr)) / sr
    return np.stack([0.3 * np.sin(2 * np.pi * hz * t)] * 2, axis=1)


def onsets(x: np.ndarray, sr: int = SR) -> np.ndarray:
    """Click starts: where the envelope first crosses half its peak after silence."""
    env = np.abs(x.mean(1))
    hot = env > 0.25 * env.max()
    starts, last = [], -1e9
    for i in np.flatnonzero(hot):
        if i - last > 0.1 * sr:
            starts.append(i / sr)
        last = i
    return np.array(starts)


class SliceStretchTest(unittest.TestCase):
    def test_every_stroke_moves_to_its_scaled_time_and_the_length_scales(self):
        x, times = clicks(100, 8)
        y = stems.slice_stretch(x, SR, 100 / 120)
        found = onsets(y)
        self.assertEqual(len(found), 8)
        np.testing.assert_allclose(found, times * 100 / 120, atol=0.005)
        self.assertAlmostEqual(len(y) / SR, len(x) / SR * 100 / 120, delta=0.01)


class ModeTest(unittest.TestCase):
    def test_clicks_are_percussive_and_a_sustained_tone_is_tonal(self):
        self.assertEqual(stems.detect_mode(clicks(100, 8)[0], SR), "percussive")
        self.assertEqual(stems.detect_mode(tone(440, 3), SR), "tonal")


class FormatTest(unittest.TestCase):
    def test_prepare_writes_24_bit_pcm_at_the_project_rate(self):
        with tempfile.TemporaryDirectory() as d:
            src, out = os.path.join(d, "in.wav"), os.path.join(d, "out.wav")
            sf.write(src, clicks(100, 4, 48000)[0], 48000, subtype="FLOAT")
            r = stems.prepare({"wav": src, "out": out, "to_bpm": 100, "from_bpm": 100, "rate": 44100})
            info = sf.info(out)
            self.assertEqual((info.samplerate, info.subtype, info.channels), (44100, "PCM_24", 2))
            self.assertEqual(r["mode"], "percussive")
            self.assertEqual(r["stretched"], False)  # same tempo: no stretch, format only


def peak_hz(x: np.ndarray, sr: int = SR) -> float:
    m = x.mean(1)[int(0.25 * len(x)):int(0.75 * len(x))]  # the steady middle
    spec = np.abs(np.fft.rfft(m * np.hanning(len(m))))
    return float(np.fft.rfftfreq(len(m), 1 / sr)[np.argmax(spec)])


@unittest.skipUnless(shutil.which("rubberband"), "Rubber Band is not installed (brew install rubberband)")
class TonalTest(unittest.TestCase):
    def test_a_tone_stretched_by_1_25_lasts_1_25_times_longer_at_the_same_pitch(self):
        y = stems.rubberband(tone(440, 2), SR, 1.25, 0)
        self.assertAlmostEqual(len(y) / SR, 2.5, delta=0.02)
        self.assertAlmostEqual(peak_hz(y), 440, delta=440 * 0.005)

    def test_two_semitones_up_keeps_the_length(self):
        y = stems.rubberband(tone(440, 2), SR, 1.0, 2)
        self.assertAlmostEqual(peak_hz(y), 440 * 2 ** (2 / 12), delta=440 * 0.005)
        self.assertAlmostEqual(len(y) / SR, 2.0, delta=0.02)


class DependencyTest(unittest.TestCase):
    def test_a_missing_rubberband_is_named_with_the_fix(self):
        old = os.environ.get("PATH", "")
        os.environ["PATH"] = "/nonexistent"
        try:
            with self.assertRaisesRegex(RuntimeError, "brew install rubberband"):
                stems.rubberband(tone(440, 1), SR, 1.25, 0)
        finally:
            os.environ["PATH"] = old


class MeasureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.handle = stems.load("mps")
        cls.dir = tempfile.TemporaryDirectory()
        cls.src = os.path.join(cls.dir.name, "clicks120.wav")
        cls.x, cls.times = clicks(120, 24)
        sf.write(cls.src, cls.x, SR, subtype="PCM_16")

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    def test_prepare_measures_the_tempo_when_from_bpm_is_missing(self):
        out = os.path.join(self.dir.name, "to100.wav")
        r = stems.run(self.handle, {"op": "prepare", "wav": self.src, "out": out, "to_bpm": 100})
        self.assertAlmostEqual(r["from_bpm"], 120, delta=1.0)
        y, _ = sf.read(out, always_2d=True)
        np.testing.assert_allclose(onsets(y)[:12], self.times[:12] * 120 / 100, atol=0.012)

    def test_a_measured_tempo_folds_toward_the_target_when_it_is_half_or_double(self):
        self.assertEqual(stems.fold(60.0, 118), 120.0)
        self.assertEqual(stems.fold(240.0, 125), 120.0)
        self.assertEqual(stems.fold(120.0, 100), 120.0)

    def test_inspect_reports_format_length_tempo_mode_and_peak(self):
        r = stems.run(self.handle, {"op": "inspect", "wav": self.src})
        self.assertEqual((r["rate"], r["subtype"], r["channels"]), (SR, "PCM_16", 2))
        self.assertAlmostEqual(r["seconds"], len(self.x) / SR, delta=0.01)
        self.assertAlmostEqual(r["bpm"], 120, delta=1.0)
        self.assertEqual(r["mode"], "percussive")
        self.assertIn("key", r)
        self.assertLess(r["peak_dbfs"], 0)


class SeparateTest(unittest.TestCase):
    """Integration: Demucs (htdemucs) — its weights download on the first run."""

    def test_four_stems_the_clicks_land_in_drums_and_the_stems_add_up_to_the_mix(self):
        with tempfile.TemporaryDirectory() as d:
            x, times = clicks(100, 12)
            mix = x + tone(110, len(x) / SR) * 0.5  # drums + a bass-register tone
            src = os.path.join(d, "mix.wav")
            sf.write(src, mix, SR, subtype="PCM_16")
            r = stems.run(stems.load("mps"), {"op": "separate", "wav": src, "out_dir": os.path.join(d, "stems")})
            self.assertEqual(sorted(r["stems"]), ["bass", "drums", "other", "vocals"])
            parts = {}
            for name, path in r["stems"].items():
                info = sf.info(path)
                self.assertEqual((info.subtype, info.samplerate), ("PCM_24", SR))
                self.assertAlmostEqual(info.frames, len(mix), delta=SR * 0.01)
                parts[name], _ = sf.read(path, always_2d=True)
            n = min(len(p) for p in parts.values())
            at_clicks = np.concatenate([np.arange(int(t * SR), int(t * SR) + int(0.03 * SR)) for t in times])
            energy = lambda y: float(np.mean(y[at_clicks[at_clicks < n]] ** 2))
            self.assertGreater(energy(parts["drums"]), 4 * max(energy(parts["other"]), energy(parts["vocals"])))
            residual = mix[:n] - sum(p[:n] for p in parts.values())
            self.assertLess(10 * np.log10(np.mean(residual ** 2) / np.mean(mix[:n] ** 2)), -20)


class NoEscapeTest(unittest.TestCase):
    """Security review of 8591c80: a dangling link at an output name must not let a write leave the folder."""

    def test_prepare_refuses_a_link_at_the_output_and_writes_nothing_through_it(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as outside:
            src, out = os.path.join(d, "in.wav"), os.path.join(d, "out.wav")
            sf.write(src, clicks(100, 4)[0], SR, subtype="PCM_16")
            escaped = os.path.join(outside, "escaped.wav")
            os.symlink(escaped, out)  # dangling: the target does not exist yet
            with self.assertRaises(FileExistsError):
                stems.prepare({"wav": src, "out": out, "to_bpm": 100, "from_bpm": 100})
            self.assertFalse(os.path.exists(escaped))

    def test_write_pcm_never_overwrites(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "x.wav")
            stems.write_pcm(path, tone(440, 0.1), SR)
            with self.assertRaises(FileExistsError):
                stems.write_pcm(path, tone(440, 0.1), SR)


if __name__ == "__main__":
    unittest.main()
