# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""M14: eval/run.py --set m8 | m14 — which briefs, and which genre prompts CLAP ranks against.
    models/.venv/bin/python -m unittest discover -s eval/tests"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import run  # noqa: E402
from gbmodels.genres import GENRES, M8_GENRES, clap_prompt  # noqa: E402


class Sets(unittest.TestCase):
    def test_m8_is_the_frozen_20_ranked_among_themselves_with_the_plain_prompts(self):
        briefs = run.load_briefs("m8")
        self.assertEqual(len(briefs), 20)
        labels, prompts = run.rank_space("m8", briefs)
        self.assertEqual(labels, [b["genre"] for b in briefs])
        self.assertEqual(prompts, [f"{g} music" for g in labels])  # unchanged since M8: scores stay comparable

    def test_m14_is_27_briefs_ranked_among_all_47_genres(self):
        briefs = run.load_briefs("m14")
        self.assertEqual([b["id"][:2] for b in briefs], [str(i) for i in range(21, 48)])
        labels, prompts = run.rank_space("m14", briefs)
        self.assertEqual(labels, GENRES)
        self.assertEqual(prompts, [clap_prompt(g) for g in GENRES])


class Prompts(unittest.TestCase):
    def test_the_m8_genres_keep_the_plain_prompt(self):
        for g in M8_GENRES:
            self.assertEqual(clap_prompt(g), f"{g} music")


if __name__ == "__main__":
    unittest.main()
