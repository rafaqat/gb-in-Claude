# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
import unittest
import numpy as np
from gbanalyze.percussive import drum_balance
from tests.signals import pad, clicks, SR

# Evidence: soft-mask HPSS leaked a steady pad into "percussive" at -11 dB and compressed a
# +6 dB drum change to +3 dB; Driedger's margin (beta = 2) gives a -29 dB floor and exact +6 dB steps.
# Low kicks are narrowband and HPSS cannot see them: "thump" is measured by rhythm.kick_thump instead.


def drums(level):
    return clicks(120, 10, freq=3000, decay=0.003, level=level)


class DrumBalanceTest(unittest.TestCase):
    def test_a_steady_pad_is_harmonic(self):
        self.assertLess(drum_balance(pad(10), SR)["percussive_ratio_db"], -20)

    def test_clicks_alone_are_percussive(self):
        self.assertGreater(drum_balance(drums(0.5), SR)["percussive_ratio_db"], 5)

    def test_raising_the_drums_6_db_raises_the_ratio_6_db(self):
        soft = drum_balance(pad(10) + drums(0.2), SR)["percussive_ratio_db"]
        loud = drum_balance(pad(10) + drums(0.4), SR)["percussive_ratio_db"]
        self.assertAlmostEqual(loud - soft, 6.0, delta=1.0)

    def test_silence_has_no_balance(self):
        self.assertIsNone(drum_balance(np.zeros((SR * 2, 2)), SR)["percussive_ratio_db"])


if __name__ == "__main__":
    unittest.main()
