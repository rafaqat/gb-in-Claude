# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""The long-lived sidecar: protocol, errors, and that the second call is warm (no load, fast).
    cd gb-mcp/models && .venv/bin/python -m unittest tests.test_server"""
import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WAV = os.path.join(HERE, "bench", "inputs", "ascent-orbit-60s.wav")


class SidecarTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.proc = subprocess.Popen([sys.executable, "-m", "gbmodels.server"], cwd=HERE, stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        cls.ready = json.loads(cls.proc.stdout.readline())

    @classmethod
    def tearDownClass(cls):
        cls.proc.stdin.close()
        cls.proc.wait(timeout=30)

    def ask(self, req):
        self.proc.stdin.write(json.dumps(req) + "\n")
        return json.loads(self.proc.stdout.readline())

    def test_announces_itself_and_its_models(self):
        self.assertTrue(self.ready["ready"])
        self.assertIn("skey", self.ready["models"])
        self.assertNotIn("foundation1", self.ready["models"])  # another environment

    def test_rejects_bad_requests_without_dying(self):
        self.assertEqual(self.ask({"id": 1, "op": "fly"})["error"]["code"], "BAD_REQUEST")
        self.assertEqual(self.ask({"id": 2, "op": "run", "model": "nope"})["error"]["code"], "UNKNOWN_MODEL")
        self.assertEqual(self.ask({"id": 3, "op": "run", "model": "foundation1"})["error"]["code"], "WRONG_ENVIRONMENT")
        self.proc.stdin.write("not json\n")
        self.assertEqual(json.loads(self.proc.stdout.readline())["error"]["code"], "BAD_REQUEST")
        self.assertTrue(self.ask({"id": 4, "op": "ping"})["ok"])

    @unittest.skipUnless(os.path.exists(WAV), "needs a 60 s export at bench/inputs/ascent-orbit-60s.wav (not shipped)")
    def test_second_call_is_warm(self):
        first = self.ask({"id": 10, "op": "run", "model": "skey", "inputs": {"wav": WAV}})
        second = self.ask({"id": 11, "op": "run", "model": "skey", "inputs": {"wav": WAV}})
        self.assertTrue(first["ok"], first)
        self.assertIn("load_s", first)
        self.assertNotIn("load_s", second)  # loaded once, kept warm
        self.assertEqual(first["result"]["key"], second["result"]["key"])
        self.assertLess(second["run_s"], 2.0)

    @unittest.skipUnless(os.path.exists(WAV), "needs a 60 s export at bench/inputs/ascent-orbit-60s.wav (not shipped)")
    def test_listen_bundles_beats_key_and_genre(self):
        r = self.ask({"id": 20, "op": "run", "model": "listen", "inputs": {"wav": WAV, "bpm": 126, "key": "F minor"}})
        self.assertTrue(r["ok"], r)
        res = r["result"]
        self.assertGreater(res["beats"]["grid"]["pass_rate"], 0.5)  # Ascent at 126 BPM
        self.assertIn(res["key"]["vs_song"], ("exact", "relative"))
        self.assertEqual(len(res["genre"]["ranking"]), 3)
        self.assertEqual(res["genre"]["ranking"][0]["genre"], "ambient trance (William Orbit style)")

    def test_infill_fills_a_section_that_has_other_instruments_playing(self):
        bar = 240 / 85  # the variation section (bars 13–20) of the unhumanized lo-fi render: the lead plays there too
        r = self.ask({"id": 31, "op": "run", "model": "infill", "inputs": {
            "midi": os.path.join(HERE, "tests", "fixtures", "lofi-unhumanized.mid"), "start_s": 12 * bar, "end_s": 20 * bar,
            "instruments": [4], "mode": "fast", "seed": 1}})
        self.assertTrue(r["ok"], r)
        self.assertGreater(len(r["result"]["notes"]), 40)  # the original has 136 Rhodes notes there

    def test_infill_rewrites_only_the_asked_instrument_inside_the_span(self):
        span = (22.588, 45.176)  # bars 9–16 of the lo-fi brief at 85 BPM
        r = self.ask({"id": 30, "op": "run", "model": "infill", "inputs": {
            "midi": os.path.join(HERE, "bench", "inputs", "lofi-4track.mid"), "start_s": span[0], "end_s": span[1],
            "instruments": [4], "mode": "fast", "seed": 1}})
        self.assertTrue(r["ok"], r)
        notes = r["result"]["notes"]
        self.assertGreater(len(notes), 10)
        self.assertTrue(all(n["instrument"] == 4 for n in notes))
        self.assertTrue(all(span[0] - 0.01 <= n["start_s"] < span[1] for n in notes))

    def test_clamp3_judge_ranks_a_fitting_description_above_a_wrong_one(self):
        lofi = os.path.join(HERE, "tests", "fixtures", "lofi-unhumanized.mid")
        fits = self.ask({"id": 40, "op": "run", "model": "clamp3", "inputs": {"midis": [lofi], "prompt": "lo-fi hip-hop with jazzy electric piano chords"}})
        wrong = self.ask({"id": 41, "op": "run", "model": "clamp3", "inputs": {"midis": [lofi], "prompt": "death metal with fast distorted guitars and blast beats"}})
        self.assertTrue(fits["ok"] and wrong["ok"], (fits, wrong))
        self.assertGreater(fits["result"]["scores"][0], wrong["result"]["scores"][0])


if __name__ == "__main__":
    unittest.main()
