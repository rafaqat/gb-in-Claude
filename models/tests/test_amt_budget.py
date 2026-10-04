# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""The infill sampler's budget (M10): a runaway take (seed 3 wrote 4,235 notes in 8 bars, 229 s) is stopped."""
import unittest

from anticipation.vocab import TIME_OFFSET

from gbmodels.amt_fast import PrefixCache, make_add_token


class Budget(unittest.TestCase):
    def test_a_spent_note_budget_ends_the_section_without_asking_the_model(self):
        cache = PrefixCache()
        add = make_add_token(cache, budget={"max_events": 0, "deadline": None, "end_tick": 4520})
        token = add(None, [0], [], 0.98, 1000)  # the model (None) must not be called
        self.assertGreaterEqual(token[0] - TIME_OFFSET, 4520)
        self.assertTrue(cache.capped)

    def test_a_passed_deadline_ends_it_too(self):
        cache = PrefixCache()
        add = make_add_token(cache, budget={"max_events": 10_000, "deadline": 0.0, "end_tick": 4520})
        token = add(None, [0], [], 0.98, 1000)
        self.assertGreaterEqual(token[0] - TIME_OFFSET, 4520)
        self.assertTrue(cache.capped)


if __name__ == "__main__":
    unittest.main()
