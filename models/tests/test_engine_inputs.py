# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""The M12b engines check their inputs before loading anything (and importing them loads no engine library)."""
import os
import sys
import tempfile
import unittest

from gbmodels import ace_step, mulacover


def wav(dir_):
    p = os.path.join(dir_, "song.wav")
    open(p, "wb").write(b"RIFF")
    return p


class EnginesImportLight(unittest.TestCase):
    def test_no_engine_library_is_imported_by_the_modules(self):
        for heavy in ("acestep", "mulacover", "mlx.core"):
            self.assertNotIn(heavy, sys.modules)


class AceStepInputs(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.out = os.path.join(self.d, "cover.wav")

    def test_a_cover_gets_defaults(self):
        v = ace_step.validate({"task": "cover", "src": wav(self.d), "caption": "film song, female vocals", "out": self.out})
        self.assertEqual((v["strength"], v["lyrics"], v["seed"], v["thinking"]), (0.7, "[Instrumental]", 42, False))

    def test_text_needs_a_duration_and_thinks(self):
        with self.assertRaisesRegex(ValueError, "duration"):
            ace_step.validate({"task": "text", "caption": "lo-fi", "out": self.out})
        v = ace_step.validate({"task": "text", "caption": "lo-fi", "duration": 30, "bpm": 80, "key": "A minor", "out": self.out})
        self.assertEqual((v["thinking"], v["bpm"], v["keyscale"]), (True, 80, "A minor"))

    def test_bad_values_are_named(self):
        cases = [({"task": "remix"}, "task"), ({"task": "cover", "caption": "x", "out": self.out}, "src"),
                 ({"task": "cover", "src": wav(self.d), "caption": "x", "strength": 1.5, "out": self.out}, "strength"),
                 ({"task": "text", "caption": "x", "duration": 5, "out": self.out}, "duration"),
                 ({"task": "text", "caption": "x" * 513, "duration": 30, "out": self.out}, "caption"),
                 ({"task": "text", "caption": "x", "duration": 30, "bpm": 400, "out": self.out}, "bpm"),
                 ({"task": "text", "caption": "x", "duration": 30, "out": "relative.wav"}, "out")]
        for inputs, word in cases:
            with self.assertRaisesRegex(ValueError, word, msg=str(inputs)[:80]):
                ace_step.validate(inputs)

    def test_an_existing_output_is_never_overwritten(self):
        open(self.out, "wb").close()
        with self.assertRaises(FileExistsError):
            ace_step.validate({"task": "text", "caption": "x", "duration": 30, "out": self.out})


class MuLaCoverInputs(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.mid = os.path.join(self.d, "song.mid")
        open(self.mid, "wb").write(b"MThd")
        self.base = {"midi": self.mid, "melody": ["Bansuri"], "chords": ["Pad"], "lyrics": "[Verse]\nla la", "tags": "genre:[film]",
                     "out": os.path.join(self.d, "vocals.wav")}

    def test_defaults(self):
        v = mulacover.validate(self.base)
        self.assertEqual((v["start_bar"], v["bars"], v["drums"], v["seed"]), (1, None, None, 42))

    def test_bad_values_are_named(self):
        cases = [({"melody": []}, "melody"), ({"chords": "Pad"}, "chords"), ({"start_bar": 0}, "start_bar"),
                 ({"bars": 0}, "bars"), ({"lyrics": "  "}, "lyrics"), ({"tags": ""}, "tags"), ({"midi": "song.mid"}, "midi")]
        for change, word in cases:
            with self.assertRaisesRegex(ValueError, word, msg=str(change)):
                mulacover.validate({**self.base, **change})


if __name__ == "__main__":
    unittest.main()


class EngineFolders(unittest.TestCase):
    """The engines find their folders where scripts/install-engines.sh puts them: GB_MCP_ENGINE_HOME moves all of them."""

    def test_engine_home_moves_every_engine_folder(self):
        import subprocess
        env = {k: v for k, v in os.environ.items() if k not in ("GB_MCP_ACESTEP", "GB_MCP_MULACOVER", "GB_MCP_MULACOVER_CKPT")}
        env["GB_MCP_ENGINE_HOME"] = "/engines"
        out = subprocess.run([sys.executable, "-c", "from gbmodels import ace_step, mulacover; print(ace_step.CODE, mulacover.CODE, mulacover.CKPT)"],
                             capture_output=True, text=True, env=env, cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        self.assertEqual(out.stdout.split(), ["/engines/ace-step", "/engines/mulacover", "/engines/mulacover-ckpt"])
