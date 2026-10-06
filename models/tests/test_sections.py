# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""M13.13 sections (gbmodels/sections.py): all-in-one reads copies of gb-mcp's own stems (no second separation); its result
becomes a plain list. No test loads the model."""
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace

from gbmodels import sections


class Stems(unittest.TestCase):
    def test_our_stems_are_copied_as_16_bit_pcm_where_all_in_one_looks_for_its_own(self):
        # madmom reads WAV through a memory map, which cannot read 24-bit samples: 16-bit copies
        import numpy as np
        import soundfile as sf
        d = tempfile.mkdtemp()
        stems = {}
        for i, s in enumerate(("vocals", "drums", "bass", "other")):
            stems[s] = os.path.join(d, f"song-{s}.wav")
            sf.write(stems[s], np.full((441, 2), 0.1 * (i + 1)), 44100, subtype="PCM_24")
        work = os.path.join(d, "work")
        sections.stage_stems(work, "song", stems)
        for i, s in enumerate(("vocals", "drums", "bass", "other")):
            p = os.path.join(work, "htdemucs", "song", f"{s}.wav")
            self.assertFalse(os.path.islink(p))
            self.assertEqual((sf.info(p).subtype, sf.info(p).frames), ("PCM_16", 441))
            self.assertAlmostEqual(float(sf.read(p)[0][0, 0]), 0.1 * (i + 1), places=3)


class Result(unittest.TestCase):
    def test_segments_without_its_start_and_end_markers(self):
        r = SimpleNamespace(segments=[SimpleNamespace(start=0.0, end=0.12, label="start"), SimpleNamespace(start=0.12, end=24.78, label="intro"),
                                      SimpleNamespace(start=24.78, end=37.6812, label="verse"), SimpleNamespace(start=264.0, end=270.0, label="end")])
        self.assertEqual(sections.segments(r), [{"start_s": 0.12, "end_s": 24.78, "label": "intro"}, {"start_s": 24.78, "end_s": 37.681, "label": "verse"}])


class Natten(unittest.TestCase):
    def test_all_in_one_finds_our_neighborhood_attention_under_nattens_name(self):
        sections.install_natten()
        from natten.functional import natten1dav, natten2dqkrpb  # the names allin1's model imports
        from gbmodels import natten_mps
        self.assertIs(natten1dav, natten_mps.natten1dav)
        self.assertIs(natten2dqkrpb, natten_mps.natten2dqkrpb)
