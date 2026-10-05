# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""MLX Llama vs torchtune's llama3_2 (the backbone / depth decoder / symbolic adaptor builder), copied weights, fp32."""
import unittest

import mlx.core as mx
import numpy as np
import torch
from torch import nn
from torchtune.models import llama3_2

from mulacover_mlx.llama import Llama, LlamaDims, load_torch

DIMS = LlamaDims(num_layers=2, num_heads=4, num_kv_heads=2, embed_dim=64, intermediate_dim=128, rope_base=500_000, scale_factor=32)


def torch_llama(d: LlamaDims, max_seq_len: int = 64):
    torch.manual_seed(0)
    m = llama3_2.llama3_2(vocab_size=32, num_layers=d.num_layers, num_heads=d.num_heads, num_kv_heads=d.num_kv_heads,
                          embed_dim=d.embed_dim, max_seq_len=max_seq_len, intermediate_dim=d.intermediate_dim, attn_dropout=0.0,
                          norm_eps=1e-5, rope_base=d.rope_base, scale_factor=d.scale_factor)
    m.tok_embeddings, m.output = nn.Identity(), nn.Identity()  # as MuLaCover's _prepare_transformer
    for p in m.parameters():  # non-trivial norm scales too
        nn.init.normal_(p, std=0.1)
    return m.eval()


class LlamaMatchesTorchtune(unittest.TestCase):
    def test_prefill_then_two_decode_steps_through_the_kv_cache(self):
        ref = torch_llama(DIMS)
        ref.setup_caches(2, torch.float32, decoder_max_seq_len=64)
        causal = torch.tril(torch.ones(64, 64, dtype=torch.bool))
        mine = Llama(DIMS)
        load_torch(mine, ref.state_dict())
        caches = mine.make_cache()

        x = torch.randn(2, 6, DIMS.embed_dim)
        pos = torch.arange(6).repeat(2, 1)
        with torch.no_grad():
            want = ref(x, mask=causal[pos], input_pos=pos).numpy()
        got = np.array(mine(mx.array(x.numpy()), caches))
        np.testing.assert_allclose(got, want, atol=1e-4, rtol=1e-4)

        for step in (6, 7):
            x1 = torch.randn(2, 1, DIMS.embed_dim)
            pos1 = torch.full((2, 1), step)
            with torch.no_grad():
                want = ref(x1, mask=causal[pos1], input_pos=pos1).numpy()
            got = np.array(mine(mx.array(x1.numpy()), caches))
            np.testing.assert_allclose(got, want, atol=1e-4, rtol=1e-4, err_msg=f"decode step at position {step}")


if __name__ == "__main__":
    unittest.main()


class SharpAttentionMatches(unittest.TestCase):
    """Small random weights give near-uniform attention, where a wrong rotation barely shows; the real model attends
    sharply. Scaled-up q/k weights make position decide the result (this caught a fused-RoPE fault for batch 2, length 1)."""

    def test_prefill_then_decode_with_sharp_attention(self):
        ref = torch_llama(DIMS)
        with torch.no_grad():
            for layer in ref.layers:
                layer.attn.q_proj.weight.mul_(12.0)
                layer.attn.k_proj.weight.mul_(12.0)
        ref.setup_caches(2, torch.float32, decoder_max_seq_len=64)
        causal = torch.tril(torch.ones(64, 64, dtype=torch.bool))
        mine = Llama(DIMS)
        load_torch(mine, ref.state_dict())
        caches = mine.make_cache()
        torch.manual_seed(4)
        steps = [(torch.randn(2, 6, DIMS.embed_dim), 0)] + [(torch.randn(2, 1, DIMS.embed_dim), p) for p in (6, 7, 8)]
        for x, start in steps:
            pos = torch.arange(start, start + x.shape[1]).repeat(2, 1)
            with torch.no_grad():
                want = ref(x, mask=causal[pos], input_pos=pos).numpy()
            got = np.array(mine(mx.array(x.numpy()), caches))
            np.testing.assert_allclose(got, want, atol=1e-3, rtol=1e-3, err_msg=f"positions from {start}")
