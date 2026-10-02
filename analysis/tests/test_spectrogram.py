# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
import tempfile
import unittest
from pathlib import Path
from gbanalyze.spectrogram import write_spectrogram
from tests.signals import full_mix, SR


class SpectrogramTest(unittest.TestCase):
    def test_writes_a_png_with_section_markers(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d, "spec.png")
            write_spectrogram(full_mix(120, 8), SR, path, sections=[("intro", 0.0, 4.0), ("drop", 4.0, 8.0)], title="Ascent")
            data = path.read_bytes()
            self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
            self.assertGreater(len(data), 10_000)

    def test_never_overwrites(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d, "spec.png")
            path.write_bytes(b"keep")
            with self.assertRaises(FileExistsError):
                write_spectrogram(full_mix(120, 2), SR, path)
            self.assertEqual(path.read_bytes(), b"keep")


if __name__ == "__main__":
    unittest.main()
