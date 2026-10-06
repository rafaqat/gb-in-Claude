# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""The M12b engines check their inputs before loading anything (and importing them loads no engine library)."""
import os
import sys
import tempfile
import unittest

import numpy as np

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
                 ({"task": "text", "caption": "x" * 1001, "duration": 30, "out": self.out}, "caption"),
                 ({"task": "text", "caption": "x", "duration": 30, "bpm": 400, "out": self.out}, "bpm"),
                 ({"task": "text", "caption": "x", "duration": 30, "out": "relative.wav"}, "out")]
        for inputs, word in cases:
            with self.assertRaisesRegex(ValueError, word, msg=str(inputs)[:80]):
                ace_step.validate(inputs)

    def test_a_caption_as_long_as_acesteps_own_examples_is_accepted(self):
        # ACE-Step's 200 examples have captions up to 724 characters; its text encoder keeps about 256 tokens
        v = ace_step.validate({"task": "text", "caption": "x" * 700, "duration": 30, "out": self.out})
        self.assertEqual(len(v["caption"]), 700)
        with self.assertRaisesRegex(ValueError, "caption"):
            ace_step.validate({"task": "text", "caption": "x" * 1001, "duration": 30, "out": self.out})

    def test_an_existing_output_is_never_overwritten(self):
        open(self.out, "wb").close()
        with self.assertRaises(FileExistsError):
            ace_step.validate({"task": "text", "caption": "x", "duration": 30, "out": self.out})

    def test_repaint_needs_a_source_and_a_range_and_never_thinks(self):
        v = ace_step.validate({"task": "repaint", "src": wav(self.d), "caption": "quiet bridge", "start": 10, "end": 20, "out": self.out})
        self.assertEqual((v["task"], v["start"], v["end"], v["mode"], v["strength"], v["thinking"]), ("repaint", 10.0, 20.0, "balanced", 0.5, False))
        self.assertEqual(ace_step.validate({"task": "repaint", "src": wav(self.d), "caption": "x", "start": 5, "out": self.out})["end"], -1.0)
        for inputs, word in [({"task": "repaint", "caption": "x", "start": 1, "end": 2, "out": self.out}, "src"),
                             ({"task": "repaint", "src": wav(self.d), "caption": "x", "start": 20, "end": 10, "out": self.out}, "end"),
                             ({"task": "repaint", "src": wav(self.d), "caption": "x", "out": self.out}, "start"),
                             ({"task": "repaint", "src": wav(self.d), "caption": "x", "start": 1, "mode": "wild", "out": self.out}, "mode")]:
            with self.assertRaisesRegex(ValueError, word, msg=str(inputs)[:80]):
                ace_step.validate(inputs)


class LegoAndComplete(unittest.TestCase):
    """M13.10: the ACE-Step base model adds a track to a song (lego) or completes a lone track (complete)."""

    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.out = os.path.join(self.d, "out.wav")

    def test_lego_adds_one_named_track_over_a_range(self):
        v = ace_step.validate({"task": "lego", "src": wav(self.d), "caption": "uilleann pipes, Irish ornaments", "track": "woodwinds", "out": self.out})
        self.assertEqual((v["task"], v["track"], v["start"], v["end"], v["thinking"]), ("lego", "woodwinds", 0.0, -1.0, False))
        for inputs, word in [({"task": "lego", "src": wav(self.d), "caption": "x", "track": "bagpipes", "out": self.out}, "track"),
                             ({"task": "lego", "caption": "x", "track": "brass", "out": self.out}, "src")]:
            with self.assertRaisesRegex(ValueError, word):
                ace_step.validate(inputs)

    def test_complete_takes_a_list_of_track_names(self):
        v = ace_step.validate({"task": "complete", "src": wav(self.d), "caption": "warm soul band", "tracks": ["drums", "bass", "keyboard"], "out": self.out})
        self.assertEqual((v["task"], v["tracks"]), ("complete", ["drums", "bass", "keyboard"]))
        for tracks in ([], ["drums", "cowbell"], "drums"):
            with self.assertRaisesRegex(ValueError, "tracks"):
                ace_step.validate({"task": "complete", "src": wav(self.d), "caption": "x", "tracks": tracks, "out": self.out})


class LegoCrop(unittest.TestCase):
    """M13.10 live: lego on a whole 270 s song passed ACE-Step's 600 s limit (32 steps x 2 for CFG). It now works on
    the range plus context, and the result goes back to its place in a song-length file."""

    def test_the_window_is_the_range_plus_context_inside_the_song(self):
        self.assertEqual(ace_step.crop_window(30.0, 90.0, 270.0, 10.0), (20.0, 100.0, 10.0, 70.0))
        self.assertEqual(ace_step.crop_window(5.0, -1.0, 270.0, 10.0), (0.0, 270.0, 5.0, -1.0))
        self.assertEqual(ace_step.crop_window(250.0, 268.0, 270.0, 10.0), (240.0, 270.0, 10.0, 28.0))

    def test_only_the_new_track_is_kept_the_context_was_the_song_itself(self):
        # live: lego returns the context (10 s each side) as a copy of the song; layered on the song it would play twice
        piece = np.ones((100, 1))
        y = ace_step.keep_range(piece, rate=10, start_s=2.0, end_s=8.0, fade_s=0.2)
        self.assertEqual(y[:20, 0].tolist(), [0.0] * 20)
        self.assertEqual(y[82:, 0].tolist(), [0.0] * 18)
        self.assertEqual(y[30:70, 0].tolist(), [1.0] * 40)
        self.assertTrue(0 < y[20, 0] <= y[21, 0] < 1)                 # a fade in, not a click

    def test_the_piece_goes_back_to_its_place(self):
        piece = np.ones((3, 2))
        y = ace_step.pad_to(piece, rate=10, offset_s=0.5, frames=12)
        self.assertEqual(y.shape, (12, 2))
        self.assertEqual(y[:, 0].tolist(), [0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0])


class RepaintLevel(unittest.TestCase):
    """ACE-Step normalises its output: a repaint comes back at another level. It is brought back to the source's
    level, measured where the source was kept, so the result splices into a project."""

    def test_the_kept_part_comes_back_at_the_source_level(self):
        sr = 1000
        rng = np.random.default_rng(0)
        src = rng.standard_normal((10 * sr, 2)) * 0.2
        out = src * 0.89
        out[4 * sr:6 * sr] = rng.standard_normal((2 * sr, 2)) * 0.1  # the repainted range
        y, info = ace_step.match_level(src, out, sr, start=4.0, end=6.0)
        self.assertAlmostEqual(info["gain_db"], 1.01, delta=0.02)
        self.assertTrue(info["level_matched"])
        np.testing.assert_allclose(y[:4 * sr], src[:4 * sr], atol=1e-9)

    def test_it_never_clips_a_peak_and_says_so(self):
        sr = 1000
        src = np.full((4 * sr, 1), 0.95)
        out = src * 0.5
        out[sr:2 * sr] = 0.9  # a loud repaint: matching the level would take it to 1.71
        y, info = ace_step.match_level(src, out, sr, start=1.0, end=2.0)
        self.assertLessEqual(np.abs(y).max(), 10 ** (-0.1 / 20) + 1e-9)
        self.assertFalse(info["level_matched"])


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
