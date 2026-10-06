# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""eval/m14/calibration/clap_greedy.py helpers (code review 2026-10-06, findings 2–5).
    models/.venv/bin/python -m unittest discover -s eval/tests"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "m14", "calibration"))
import clap_greedy as cg  # noqa: E402


def write(path, data):  # closed at once, so the size on disk is the new one
    with open(path, "wb") as f:
        f.write(data)


class Cache(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.d, "gen"))  # clips live in <workspace>/gen/, as gb_generate writes them
        for s in ("a", "b"):
            write(os.path.join(self.d, "gen", f"m14-cal-{s}.wav"), b"x" * 10)

    def path(self, labels, prefix="m14-cal"):
        return cg.cache_path(self.d, os.path.join(self.d, "cache"), prefix, labels)

    def test_the_cache_lives_in_the_given_folder_not_beside_the_script(self):
        p = self.path({"a": "A", "b": "B"})
        self.assertTrue(p.startswith(os.path.join(self.d, "cache")))
        self.assertTrue(p.endswith(".npz"))

    def test_a_changed_clip_or_label_set_gives_another_cache(self):
        p1 = self.path({"a": "A", "b": "B"})
        self.assertEqual(p1, self.path({"a": "A", "b": "B"}))
        self.assertNotEqual(p1, self.path({"a": "A"}))
        write(os.path.join(self.d, "gen", "m14-cal-b.wav"), b"y" * 11)
        self.assertNotEqual(p1, self.path({"a": "A", "b": "B"}))

    def test_another_workspace_gives_another_cache(self):
        other = tempfile.mkdtemp()
        os.makedirs(os.path.join(other, "gen"))
        for s in ("a", "b"):
            write(os.path.join(other, "gen", f"m14-cal-{s}.wav"), b"x" * 10)
        self.assertNotEqual(self.path({"a": "A", "b": "B"}),
                            cg.cache_path(other, os.path.join(self.d, "cache"), "m14-cal", {"a": "A", "b": "B"}))


class Report(unittest.TestCase):
    def test_the_second_set_is_held_out_only_when_it_was_not_used_to_choose(self):
        self.assertEqual(cg.second_label(False), "seed 2 (held out)")
        self.assertEqual(cg.second_label(True), "seed 2 (also chosen on — not a held-out check)")

    def test_the_top_5_count_is_out_of_the_label_count(self):
        line = cg.summary_line("seed 1", {"x": 1, "y": 9}, {"x": 1, "y": 2})
        self.assertIn("top-5 1 → 2/2", line)


if __name__ == "__main__":
    unittest.main()
