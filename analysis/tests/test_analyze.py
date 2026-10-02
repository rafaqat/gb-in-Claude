# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
import unittest
import numpy as np
from gbanalyze.analyze import analyze
from tests.signals import full_mix, tinny_mix, SR

BPM = 120  # 2 s per bar


def codes(result):
    return {s["code"] for s in result["suggestions"]}


class TinnyVersusFullTest(unittest.TestCase):
    def test_tinny_mix_is_flagged_thin_and_bright_and_full_mix_is_not(self):
        full, tinny = analyze(full_mix(BPM, 16), SR), analyze(tinny_mix(BPM, 16), SR)
        self.assertIn("thin_low_end", tinny["flags"])
        self.assertNotIn("thin_low_end", full["flags"])
        self.assertGreater(tinny["tonal_balance"]["centroid_hz"], 2 * full["tonal_balance"]["centroid_hz"])
        self.assertGreater(tinny["tonal_balance"]["tilt_db_per_octave"], full["tonal_balance"]["tilt_db_per_octave"] + 3)


class SectionAwareTest(unittest.TestCase):
    CONTEXT = {
        "tempo": BPM, "beats_per_bar": 4, "key": "F minor",
        "sections": [{"name": "breakdown", "bars": 4}, {"name": "drop", "bars": 4}],
        "tracks": [{"name": "Bass", "role": "bass"}, {"name": "Pad", "role": "pad"}],
    }

    def test_sections_are_measured_on_the_song_bar_map(self):
        x = np.vstack([full_mix(BPM, 8) * 0.25, full_mix(BPM, 8)])  # breakdown 12 dB quieter
        out = analyze(x, SR, self.CONTEXT)
        names = [s["name"] for s in out["sections"]]
        self.assertEqual(names, ["breakdown", "drop"])
        self.assertAlmostEqual(out["sections"][1]["start_s"], 8.0, delta=1e-6)
        self.assertAlmostEqual(out["section_contrast"]["drop_minus_breakdown_lu"], 12.0, delta=1.0)
        self.assertNotIn("weak_drop", out["flags"])

    def test_a_drop_no_louder_than_the_breakdown_suggests_a_bigger_drop(self):
        out = analyze(full_mix(BPM, 16), SR, self.CONTEXT)
        self.assertIn("weak_drop", out["flags"])
        weak = next(s for s in out["suggestions"] if s["code"] == "WEAK_DROP")
        self.assertEqual(weak["path"], "sections.drop")
        self.assertIn("value", weak["metric"])

    def test_thin_low_end_suggestion_points_at_the_bass_track(self):
        out = analyze(tinny_mix(BPM, 16), SR, self.CONTEXT)
        thin = next(s for s in out["suggestions"] if s["code"] == "THIN_LOW_END")
        self.assertEqual(thin["path"], "tracks.Bass")

    def test_reports_tempo_and_key_against_intent(self):
        out = analyze(full_mix(BPM, 16), SR, self.CONTEXT)
        self.assertTrue(out["rhythm"]["tempo"]["matches_intended"])
        self.assertEqual(out["key"]["declared"], "F minor")
        self.assertIn(out["key"]["relation"], {"match", "relative", "parallel", "mismatch"})


class ShapeTest(unittest.TestCase):
    def test_without_context_there_are_no_sections_and_no_intent_checks(self):
        out = analyze(full_mix(BPM, 8), SR)
        self.assertEqual(out["sections"], [])
        self.assertIsNone(out["key"]["declared"])
        self.assertIn("integrated_lufs", out["loudness"])
        self.assertEqual(out["file"]["sample_rate"], SR)


if __name__ == "__main__":
    unittest.main()


from tests.signals import pad, kick, clicks, bass_line  # noqa: E402


class DrumFlagsTest(unittest.TestCase):
    """Calibrated on one labelled example: the a mix judged "drums too forward and thumpy"
    (intro kick hit share 0.23 / kick band 0.67; build kick band 0.69)."""

    CONTEXT = {
        "tempo": BPM, "beats_per_bar": 4,
        "sections": [{"name": "intro", "bars": 8}, {"name": "drop", "bars": 8}],
        "tracks": [{"name": "Drums", "role": "drums", "sections": ["intro", "drop"]},
                   {"name": "Pad", "role": "pad", "sections": ["intro", "drop"]}],
    }

    def test_a_kick_dominated_section_is_flagged_thumpy_with_the_drums_path(self):
        intro = pad(16) + kick(BPM, 16, level=0.9)  # the kick owns the low end
        drop = pad(16) + bass_line(BPM, 16) + kick(BPM, 16, level=0.15)
        out = analyze(np.vstack([intro, drop]), SR, self.CONTEXT)
        thumpy = [s for s in out["suggestions"] if s["code"] == "THUMPY_KICK"]
        self.assertEqual([s["section"] for s in thumpy], ["intro"])
        self.assertEqual(thumpy[0]["path"], "tracks.Drums")
        self.assertIn("thumpy_kick", out["flags"])

    def test_loud_transient_drums_are_flagged_forward(self):
        intro = pad(16, level=0.05) + clicks(BPM, 16, freq=3000, decay=0.003, level=0.9, every=0.25)
        drop = pad(16) + clicks(BPM, 16, freq=3000, decay=0.003, level=0.05)
        out = analyze(np.vstack([intro, drop]), SR, {**self.CONTEXT, "sections": [{"name": "intro", "bars": 8}, {"name": "drop", "bars": 8}]})
        forward = [s for s in out["suggestions"] if s["code"] == "DRUMS_FORWARD"]
        self.assertEqual([s["section"] for s in forward], ["intro"])

    def test_sections_without_drums_are_never_drum_flagged(self):
        ctx = {**self.CONTEXT, "tracks": [{"name": "Pad", "role": "pad", "sections": ["intro", "drop"]}]}
        out = analyze(np.vstack([pad(16) + kick(BPM, 16, level=0.9), pad(16)]), SR, ctx)
        self.assertFalse({"THUMPY_KICK", "DRUMS_FORWARD"} & {s["code"] for s in out["suggestions"]})

    def test_sections_report_drum_metrics(self):
        out = analyze(np.vstack([pad(16) + kick(BPM, 16), pad(16)]), SR, self.CONTEXT)
        for key in ("percussive_ratio_db", "kick_hit_share", "kick_band_share"):
            self.assertIn(key, out["sections"][0])
        self.assertIn("percussive_ratio_db", out["drums"])
