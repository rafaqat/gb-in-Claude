# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""MLX symbolic adaptor and gated cross-attention vs the authors' modules (mulacover.modeling), copied weights, fp32.
The MLX cross-attention splits into prepare(context) — once per song — and a per-frame query-side call."""
import unittest

import mlx.core as mx
import numpy as np
import torch
from torch import nn
from mulacover import modeling as ref

from mulacover_mlx.llama import load_torch
from mulacover_mlx.cross import CrossAttentionBlock, SymbolicAdaptor

E, L = 64, 20


def randomize(m: nn.Module) -> nn.Module:
    torch.manual_seed(1)
    for p in m.parameters():
        nn.init.normal_(p, std=0.1)
    return m.eval()


def inputs():
    torch.manual_seed(2)
    mask = torch.zeros(2, L, dtype=torch.bool)
    mask[1, -5:] = True  # row 1: the last 5 steps are padding
    return torch.randn(2, L, 256), torch.randn(2, L, 128), torch.randn(2, L, 12), mask


class AdaptorMatches(unittest.TestCase):
    def test_bidirectional_with_padding(self):
        r = randomize(ref.SymbolicAdaptor(E))
        m = SymbolicAdaptor(E)
        load_torch(m, r.state_dict())
        p, d, c, mask = inputs()
        with torch.no_grad():
            want = r(p, d, c, mask).numpy()
        got = np.array(m(*(mx.array(t.numpy()) for t in (p, d, c, mask))))
        np.testing.assert_allclose(got, want, atol=1e-4, rtol=1e-4)


class CrossAttentionMatches(unittest.TestCase):
    def test_prepared_context_prefill_then_one_frame(self):
        r = randomize(ref.CrossAttentionBlock(E, 8))
        m = CrossAttentionBlock(E, 8)
        load_torch(m, r.state_dict())
        torch.manual_seed(3)
        context = torch.randn(2, L, E)
        _, _, _, mask = inputs()
        prepared = m.prepare(mx.array(context.numpy()))
        for start, length in ((0, 6), (6, 1)):
            h = torch.randn(2, length, E)
            pos = torch.arange(start, start + length).repeat(2, 1)
            with torch.no_grad():
                want = r(h, context, mask, pos).numpy()
            got = np.array(m(mx.array(h.numpy()), prepared, mx.array(mask.numpy()), start))
            np.testing.assert_allclose(got, want, atol=1e-4, rtol=1e-4, err_msg=f"positions {start}..{start + length - 1}")


if __name__ == "__main__":
    unittest.main()
