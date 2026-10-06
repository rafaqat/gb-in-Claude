# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""M13.12 the RoFormer vocal separator (gbmodels/roformer.py): its model folder works offline, the weights are the
pinned bytes, and audio-separator's output files are found by their stem. No test loads the model."""
import json
import os
import tempfile
import unittest

from gbmodels import roformer


class ModelFolder(unittest.TestCase):
    def test_the_folder_holds_the_checkpoint_link_the_config_and_an_offline_model_list(self):
        d = tempfile.mkdtemp()
        ckpt = os.path.join(d, "MelBandRoformer.ckpt")
        open(ckpt, "wb").write(b"weights")
        work = os.path.join(d, "work")
        roformer.prepare_model_dir(work, ckpt)
        roformer.prepare_model_dir(work, ckpt)  # again: nothing breaks
        self.assertEqual(open(os.path.join(work, roformer.MODEL_FILE), "rb").read(), b"weights")
        self.assertEqual(open(os.path.join(work, roformer.CONFIG_FILE)).read(), roformer.CONFIG)
        lists = json.load(open(os.path.join(work, "download_checks.json")))
        self.assertEqual(lists["roformer_download_list"], {})  # the model is in audio-separator's own list

    def test_weights_with_other_bytes_are_refused(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "w.ckpt")
        open(p, "wb").write(b"abc")
        roformer.verify(p, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")  # sha256("abc")
        with self.assertRaisesRegex(ValueError, "not the pinned weights"):
            roformer.verify(p, "0" * 64)


class Outputs(unittest.TestCase):
    def test_the_vocal_and_the_rest_are_found_by_their_stem_names(self):
        files = ["/w/song_(Other)_vocals_mel_band_roformer.wav", "/w/song_(Vocals)_vocals_mel_band_roformer.wav"]
        self.assertEqual(roformer.pick(files), {"vocals": files[1], "other": files[0]})
        with self.assertRaisesRegex(ValueError, "vocals"):
            roformer.pick(files[:1])
        live = ["/w/mix_(other)_vocals_mel_band_roformer.wav", "/w/mix_(vocals)_vocals_mel_band_roformer.wav"]  # 0.47.0, live
        self.assertEqual(roformer.pick(live), {"vocals": live[1], "other": live[0]})
