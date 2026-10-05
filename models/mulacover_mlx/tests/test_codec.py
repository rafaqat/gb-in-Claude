# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""The codec's flow-matching estimator (HeartCodec LlamaTransformer, mulacover/_codec/models/transformer.py) in MLX vs
the authors' module: tiny dims, random weights (Conv1d weights re-laid out for MLX), fp32, AdaLN timestep modulation."""
import unittest

import mlx.core as mx
import numpy as np
import torch
from torch import nn
from mulacover._codec.models.transformer import LlamaTransformer

from mulacover_mlx.codec import Estimator, EstimatorDims, load_torch_estimator

DIMS = EstimatorDims(num_attention_heads=2, attention_head_dim=8, in_channels=12, out_channels=6, num_layers=2, num_layers_2=1)


def reference():
    torch.manual_seed(0)
    m = LlamaTransformer(num_attention_heads=2, attention_head_dim=8, in_channels=12, out_channels=6, num_layers=2, num_layers_2=1,
                         norm_type="ada_norm_single")
    for p in m.parameters():
        nn.init.normal_(p, std=0.2)
    return m.eval()


class EstimatorMatches(unittest.TestCase):
    def test_two_stages_with_timestep_modulation(self):
        r = reference()
        m = Estimator(DIMS)
        load_torch_estimator(m, r.state_dict())
        torch.manual_seed(1)
        x, t = torch.randn(2, 10, 12), torch.tensor([0.3, 0.3])
        with torch.no_grad():
            want = r(x, timestep=t).numpy()
        got = np.array(m(mx.array(x.numpy()), mx.array(t.numpy())))
        np.testing.assert_allclose(got, want, atol=2e-4, rtol=2e-4)


if __name__ == "__main__":
    unittest.main()


class BridgeMatches(unittest.TestCase):
    def test_the_bridge_stands_in_for_the_torch_estimator(self):
        from mulacover_mlx.codec import EstimatorBridge
        r = reference()
        m = Estimator(DIMS)
        load_torch_estimator(m, r.state_dict())
        bridge = EstimatorBridge(m)
        torch.manual_seed(2)
        x, t = torch.randn(2, 10, 12), torch.tensor([0.7, 0.7])
        with torch.no_grad():
            want = r(x, timestep=t)
            got = bridge(x, timestep=t)
        self.assertIsInstance(got, torch.Tensor)
        self.assertEqual((got.dtype, got.device, tuple(got.shape)), (want.dtype, want.device, tuple(want.shape)))
        np.testing.assert_allclose(got.numpy(), want.numpy(), atol=2e-4, rtol=2e-4)
