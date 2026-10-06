# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Lyric check (M13.11): the sung words against the written lyrics, line by line — alignment on synthetic transcripts."""
import unittest

from gbmodels import lyrics

LYRICS = """[Verse 1]
Rain is falling on the station
Every window in the town is bright

[Chorus]
Take me home to the river
Where the evening trains run slow"""


def words(text, start=10.0, step=0.4):
    return [{"word": w, "start": round(start + i * step, 2), "end": round(start + i * step + 0.3, 2)} for i, w in enumerate(text.split())]


class AlignTest(unittest.TestCase):
    def test_every_line_sung_is_found_with_its_times(self):
        heard = words("Rain is falling on the station, every window in the town is bright. Take me home to the river, where the evening trains run slow.")
        r = lyrics.align(LYRICS, heard)
        self.assertEqual([l["status"] for l in r["lines"]], ["sung"] * 4)
        self.assertEqual(r["lines"][2]["section"], "Chorus")
        self.assertAlmostEqual(r["lines"][0]["start_s"], 10.0)
        self.assertEqual(r["wer"], 0.0)

    def test_a_skipped_line_is_missing_and_a_changed_word_is_partial(self):
        heard = words("Rain is falling on the station. Take me home to the city where the evening trains run slow")
        r = lyrics.align(LYRICS, heard)
        self.assertEqual([l["status"] for l in r["lines"]], ["sung", "missing", "partial", "sung"])
        self.assertIn("city", r["lines"][2]["heard"])
        self.assertGreater(r["wer"], 0.3)


if __name__ == "__main__":
    unittest.main()
