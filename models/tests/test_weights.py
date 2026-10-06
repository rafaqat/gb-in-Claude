# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Pinned, hash-checked, pickle-free weight loading: CLAP and beat_this weights
came from the network at run time without a revision or a hash and were unpickled (torch.load weights_only=False)."""
import hashlib
import os
import tempfile
import unittest
from unittest import mock

from gbmodels import weights


class Verify(unittest.TestCase):
    def test_a_matching_hash_passes_and_a_different_file_is_refused(self):
        d = tempfile.mkdtemp(); p = os.path.join(d, "w.bin")
        with open(p, "wb") as f:
            f.write(b"weights")
        weights.verify(p, hashlib.sha256(b"weights").hexdigest())
        with self.assertRaises(ValueError):
            weights.verify(p, hashlib.sha256(b"other").hexdigest())


class SafeLoad(unittest.TestCase):
    def test_a_pickle_that_would_run_code_is_refused_without_running_it(self):
        import torch
        d = tempfile.mkdtemp(); marker = os.path.join(d, "pwned"); p = os.path.join(d, "evil.pt")

        class Evil:
            def __reduce__(self):
                return (open, (marker, "w"))
        torch.save({"state_dict": {}, "x": Evil()}, p)
        with self.assertRaises(Exception):
            weights.safe_torch_load(p)
        self.assertFalse(os.path.exists(marker))

    def test_tensors_and_the_allowed_numpy_scalars_load(self):
        import numpy as np
        import torch
        d = tempfile.mkdtemp(); p = os.path.join(d, "ok.pt")
        torch.save({"state_dict": {"w": torch.ones(2)}, "epoch": np.float64(15.0)}, p)
        ck = weights.safe_torch_load(p, numpy_scalars=True)
        self.assertEqual(float(ck["epoch"]), 15.0)


class Clap(unittest.TestCase):
    def test_the_download_is_pinned_to_a_revision_and_hash_checked_before_loading(self):
        from gbmodels import clap
        d = tempfile.mkdtemp(); p = os.path.join(d, "planted.pt")
        with open(p, "wb") as f:
            f.write(b"not the pinned weights")
        with mock.patch.object(clap, "hf_hub_download", return_value=p) as dl:
            with self.assertRaises(ValueError):
                clap.checkpoint()
        dl.assert_called_once_with(*clap.CKPT, revision=clap.REVISION)


class BeatThis(unittest.TestCase):
    def test_a_planted_cached_checkpoint_is_refused(self):
        from gbmodels import beatthis
        d = tempfile.mkdtemp(); os.makedirs(os.path.join(d, "checkpoints"))
        with open(os.path.join(d, "checkpoints", beatthis.FILE), "wb") as f:
            f.write(b"planted")
        with mock.patch("torch.hub.get_dir", return_value=d), mock.patch("torch.hub.download_url_to_file") as dl:
            with self.assertRaises(ValueError):
                beatthis.checkpoint()
            dl.assert_not_called()

    def test_a_missing_checkpoint_is_downloaded_to_a_temp_file_and_checked_before_use(self):
        from gbmodels import beatthis
        d = tempfile.mkdtemp()
        def fake_download(url, dst, **_):
            with open(dst, "wb") as f:
                f.write(b"tampered on the way")
        with mock.patch("torch.hub.get_dir", return_value=d), mock.patch("torch.hub.download_url_to_file", side_effect=fake_download):
            with self.assertRaises(ValueError):
                beatthis.checkpoint()
        self.assertFalse(os.path.exists(os.path.join(d, "checkpoints", beatthis.FILE)))  # never kept


if __name__ == "__main__":
    unittest.main()


class EveryDownloadPinned(unittest.TestCase):
    """D3: every model the sidecar fetches names a revision, so a changed upstream repo can never swap a model."""

    def test_no_download_call_without_a_revision(self):
        import re
        root = os.path.join(os.path.dirname(__file__), "..")
        unpinned = []
        for d in ("gbmodels", "mulacover_mlx"):
            for f in sorted(os.listdir(os.path.join(root, d))):
                if not f.endswith(".py"):
                    continue
                text = open(os.path.join(root, d, f)).read()
                for m in re.finditer(r"\b(snapshot_download|hf_hub_download|from_pretrained)\(", text):
                    call = text[m.start(): text.find(")", m.end()) + 1]
                    line = text[: m.start()].count("\n") + 1
                    src = text.splitlines()[line - 1]
                    if "revision" not in call and "f\"from huggingface_hub" not in src and "a local folder, pinned" not in src:
                        unpinned.append(f"{d}/{f}:{line}")
        self.assertEqual(unpinned, [])
