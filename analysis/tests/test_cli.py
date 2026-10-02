# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
import soundfile as sf
from tests.signals import full_mix, SR

ROOT = Path(__file__).resolve().parents[1]


def run(*args):
    env = {**os.environ, "MPLCONFIGDIR": tempfile.gettempdir() + "/gbmcp-mpl"}
    p = subprocess.run([sys.executable, "-m", "gbanalyze.cli", *args], cwd=ROOT, capture_output=True, text=True, timeout=300, env=env)
    lines = p.stdout.strip().splitlines()
    return p.returncode, lines, (json.loads(lines[-1]) if lines else None)


class CliTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.wav = Path(self.dir.name, "mix.wav")
        sf.write(str(self.wav), full_mix(120, 8), SR)

    def tearDown(self):
        self.dir.cleanup()

    def test_analyze_prints_exactly_one_json_document_and_writes_the_spectrogram(self):
        png = Path(self.dir.name, "mix.png")
        context = json.dumps({"tempo": 120, "beats_per_bar": 4, "sections": [{"name": "a", "bars": 2}, {"name": "b", "bars": 2}]})
        code, lines, doc = run("analyze", "--input", str(self.wav), "--context", context, "--spectrogram", str(png))
        self.assertEqual(code, 0)
        self.assertEqual(len(lines), 1)
        self.assertTrue(doc["ok"])
        self.assertEqual([s["name"] for s in doc["result"]["sections"]], ["a", "b"])
        self.assertEqual(doc["result"]["spectrogram"], str(png))
        self.assertTrue(png.exists())
        self.assertNotIn("NaN", lines[0])

    def test_errors_are_typed_json(self):
        cases = [
            (["analyze", "--input", str(Path(self.dir.name, "missing.wav"))], "FILE_NOT_FOUND"),
            (["analyze", "--input", str(self.wav), "--context", "{not json"], "INPUT_INVALID"),
            (["analyze", "--input", str(Path(__file__))], "AUDIO_INVALID"),
            (["frobnicate"], "INPUT_INVALID"),
        ]
        for args, expected in cases:
            code, lines, doc = run(*args)
            self.assertEqual(code, 2, args)
            self.assertEqual(len(lines), 1, args)
            self.assertEqual(doc, {"ok": False, "error": {"code": expected, "message": doc["error"]["message"]}}, args)

    def test_refuses_to_overwrite_an_existing_spectrogram(self):
        png = Path(self.dir.name, "taken.png")
        png.write_bytes(b"keep")
        code, _, doc = run("analyze", "--input", str(self.wav), "--spectrogram", str(png))
        self.assertEqual((code, doc["error"]["code"]), (2, "FILE_EXISTS"))
        self.assertEqual(png.read_bytes(), b"keep")


if __name__ == "__main__":
    unittest.main()
