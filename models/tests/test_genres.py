# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""The genre labels CLAP ranks against (M14): the frozen 20 first and unchanged, then the 27 added in M14."""
import unittest

from gbmodels.genres import GENRES, M8_GENRES

M14_NEW = [
    "Latin trap", "dembow", "bachata", "salsa", "cumbia", "bossa nova", "corridos tumbados", "Latin pop",
    "Brazilian funk", "merengue",
    "Arabic pop", "Khaleeji", "mahraganat", "raï", "gnawa", "Moroccan chaabi", "dabke",
    "country", "Americana", "Bollywood (filmi)", "gospel", "soul", "blues", "Celtic folk", "lullaby", "K-pop", "amapiano",
]


class Genres(unittest.TestCase):
    def test_the_frozen_20_come_first_and_unchanged(self):
        self.assertEqual(len(M8_GENRES), 20)
        self.assertEqual(GENRES[:20], M8_GENRES)
        self.assertEqual((M8_GENRES[0], M8_GENRES[-1]), ("lo-fi hip-hop", "epic orchestral (Hans Zimmer style)"))

    def test_m14_adds_27_genres(self):
        self.assertEqual(GENRES[20:], M14_NEW)
        self.assertEqual(len(GENRES), 47)

    def test_labels_are_unique_ignoring_case(self):
        self.assertEqual(len({g.lower() for g in GENRES}), len(GENRES))

    def test_calibrated_prompts_are_only_for_m14_genres(self):
        from gbmodels.genres import CLAP_PROMPTS, clap_prompt
        self.assertLessEqual(set(CLAP_PROMPTS), set(M14_NEW))
        self.assertEqual(len(CLAP_PROMPTS), 19)
        self.assertEqual(clap_prompt("dabke"), "Lebanese dabke folk dance music")  # rank 29 → 1 on the held-out clip
        self.assertEqual(clap_prompt("salsa"), "salsa music")  # the plain prompt ranked best

    def test_the_ranking_note_counts_the_labels(self):
        from gbmodels.listen import ranking_note
        self.assertEqual(ranking_note(), "a ranking among gb-mcp's 47 genres, not a grade")


if __name__ == "__main__":
    unittest.main()
