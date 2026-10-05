# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""The real MuLaCover checkpoint (8.8 GB, bf16) loads into the MLX model strictly: every tensor has a parameter with
the same name and shape, and every parameter is filled. Skipped where the weights are not downloaded."""
import os
import unittest

import mlx.core as mx
from mlx.utils import tree_flatten

from mulacover_mlx.model import MuLaCoverDims, MuLaCoverMLX, load_checkpoint

CKPT = os.environ.get("GB_MCP_MULACOVER_CKPT", os.path.expanduser("~/Library/Caches/gb-mcp/mulacover-ckpt/MuLaCover"))


@unittest.skipUnless(os.path.exists(os.path.join(CKPT, "model.safetensors.index.json")), "MuLaCover weights not downloaded")
class CheckpointLoads(unittest.TestCase):
    def test_all_659_tensors_load_strictly_in_bfloat16(self):
        model = MuLaCoverMLX(MuLaCoverDims.from_config(os.path.join(CKPT, "config.json")))
        count = load_checkpoint(model, CKPT)
        self.assertEqual(count, 659)
        params = dict(tree_flatten(model.parameters()))
        self.assertEqual(len(params), 659)
        self.assertEqual(params["audio_head"].shape, (7, 3072, 8197))
        self.assertEqual(params["backbone.layers.27.attn.k_proj.weight"].dtype, mx.bfloat16)


if __name__ == "__main__":
    unittest.main()
