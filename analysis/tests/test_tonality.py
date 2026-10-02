# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
import unittest
from gbanalyze.tonality import estimate_key, parse_key, key_relation
from tests.signals import progression, SR

C_MAJOR_CADENCE = [[48, 60, 64, 67], [53, 60, 65, 69], [55, 59, 62, 67], [48, 60, 64, 67]]  # C F G C
A_MINOR_CADENCE = [[45, 57, 60, 64], [50, 57, 62, 65], [52, 56, 59, 64], [45, 57, 60, 64]]  # Am Dm E Am


class KeyEstimateTest(unittest.TestCase):
    def test_major_cadence(self):
        self.assertEqual(estimate_key(progression(C_MAJOR_CADENCE, 2.0), SR)["key"], "C major")

    def test_minor_cadence_with_leading_tone(self):
        self.assertEqual(estimate_key(progression(A_MINOR_CADENCE, 2.0), SR)["key"], "A minor")

    def test_reports_confidence_margin(self):
        out = estimate_key(progression(C_MAJOR_CADENCE, 2.0), SR)
        self.assertGreater(out["confidence"], 0.0)


class KeyNamesTest(unittest.TestCase):
    def test_parses_flats_and_sharps(self):
        self.assertEqual(parse_key("F minor"), (5, "minor"))
        self.assertEqual(parse_key("Ab major"), (8, "major"))
        self.assertEqual(parse_key("C# minor"), (1, "minor"))
        self.assertIsNone(parse_key("H dorian"))

    def test_relations(self):
        self.assertEqual(key_relation("F minor", "F minor"), "match")
        self.assertEqual(key_relation("F minor", "Ab major"), "relative")
        self.assertEqual(key_relation("F minor", "F major"), "parallel")
        self.assertEqual(key_relation("F minor", "D major"), "mismatch")


if __name__ == "__main__":
    unittest.main()
