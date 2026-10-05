# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""The whole MLX frame generator vs the authors' MuLaCover.generate_frame: a tiny random config (4 backbone layers, the
last 2 with cross-attention and style modulation, 8 codebooks), classifier-free guidance (batch 2), greedy sampling
(topk=1 is deterministic in both), 4 frames — every codebook token must be equal."""
import unittest

import mlx.core as mx
import numpy as np
import torch
from torch import nn
from torchtune.models import llama3_2
from mulacover import modeling as ref
from mulacover.configuration import MuLaCoverConfig

from mulacover_mlx.llama import LlamaDims, load_torch
from mulacover_mlx.model import MuLaCoverMLX, MuLaCoverDims

BACKBONE = LlamaDims(num_layers=4, num_heads=8, num_kv_heads=4, embed_dim=64, intermediate_dim=128)
DECODER = LlamaDims(num_layers=2, num_heads=4, num_kv_heads=2, embed_dim=32, intermediate_dim=64)
DIMS = MuLaCoverDims(backbone=BACKBONE, decoder=DECODER, text_vocab_size=40, audio_vocab_size=21, audio_num_codebooks=8,
                     muq_dim=16, qwen_dim=24, peft_layer_num=2)


def tiny(d: LlamaDims):
    return lambda: llama3_2.llama3_2(vocab_size=32, num_layers=d.num_layers, num_heads=d.num_heads, num_kv_heads=d.num_kv_heads,
                                     embed_dim=d.embed_dim, max_seq_len=64, intermediate_dim=d.intermediate_dim, attn_dropout=0.0,
                                     norm_eps=1e-5, rope_base=d.rope_base, scale_factor=d.scale_factor)


def torch_model():
    ref.FLAVORS["tiny-backbone"], ref.FLAVORS["tiny-decoder"] = tiny(BACKBONE), tiny(DECODER)
    cfg = MuLaCoverConfig(backbone_flavor="tiny-backbone", decoder_flavor="tiny-decoder", text_vocab_size=40, audio_vocab_size=21,
                          audio_num_codebooks=8, muq_dim=16, qwen_dim=24, peft_layer_num=2, train_tag=True)
    m = ref.MuLaCover(cfg)
    torch.manual_seed(0)
    for p in m.parameters():  # also the gates and style MLPs the authors zero-initialise
        nn.init.normal_(p, std=0.2)
    return m.eval()


class FrameGeneratorMatches(unittest.TestCase):
    def test_four_frames_greedy_with_cfg(self):
        r = torch_model()
        r.setup_caches(2)
        m = MuLaCoverMLX(DIMS)
        load_torch(m, r.state_dict())

        g = torch.Generator().manual_seed(5)
        S, L, ncb = 5, 12, 8
        tokens = torch.cat([torch.randint(0, 21, (1, S, ncb), generator=g), torch.randint(0, 40, (1, S, 1), generator=g)], -1).repeat(2, 1, 1)
        tokens_mask = (torch.rand(1, S, ncb + 1, generator=g) > 0.3).repeat(2, 1, 1)
        roll = [torch.randn(1, L, n, generator=g).repeat(2, 1, 1) for n in (256, 128, 12)]
        context_mask = torch.zeros(2, L, dtype=torch.bool)
        context_mask[:, -3:] = True
        qwen = torch.randn(1, 24, generator=g).repeat(2, 1)
        muq = torch.zeros(2, 16)
        idx_q, idx_m = torch.full((2,), 1), torch.full((2,), 2)

        state = m.start(*(mx.array(t.numpy()) for t in (*roll, context_mask, qwen)), cfg_scale=1.5)
        pos = torch.arange(S).repeat(2, 1)
        x, x_mask = tokens, tokens_mask
        for frame in range(4):
            first = frame == 0
            with torch.no_grad():
                want = r.generate_frame(tokens=x, tokens_mask=x_mask, input_pos=pos, temperature=1.0, topk=1,
                                        pianoroll=roll[0], drum_pianoroll=roll[1], chord=roll[2], context_mask=context_mask,
                                        qwen_embedding=qwen, qwen_indices=idx_q if first else None,
                                        muq_embedding=muq if first else None, muq_indices=idx_m if first else None,
                                        first_step=first, cfg_scale=1.5).numpy()
            got = np.array(m.frame(state, mx.array(x.numpy()), mx.array(x_mask.numpy()), temperature=1.0, topk=1,
                                   first=(mx.array(muq.numpy()), mx.array(idx_q.numpy()), mx.array(idx_m.numpy())) if first else None))
            np.testing.assert_array_equal(got, want, err_msg=f"frame {frame}")
            x = torch.zeros(2, 1, ncb + 1, dtype=torch.long)
            x[:, 0, :-1] = torch.from_numpy(want)
            x_mask = torch.ones_like(x, dtype=torch.bool)
            x_mask[..., -1] = False
            pos = pos[:, -1:] + 1


if __name__ == "__main__":
    unittest.main()


class StaysInModelPrecision(unittest.TestCase):
    """The authors run under bf16 autocast: every linear works in bf16. The style embedding becomes float32 after the
    guidance mask; its scale / shift must still come out in bf16, or the hidden state turns float32 from the first
    styled layer on (slow, and different from the original)."""

    def test_bf16_weights_keep_the_frame_in_bf16(self):
        r = torch_model()
        m = MuLaCoverMLX(DIMS)
        load_torch(m, r.state_dict(), dtype=mx.bfloat16)
        L = 12
        roll = [mx.random.normal((2, L, n)).astype(mx.bfloat16) for n in (256, 128, 12)]
        state = m.start(*roll, mx.zeros((2, L), dtype=mx.bool_), mx.random.normal((2, 24)), cfg_scale=1.5)
        for scale, shift in state.style.values():
            self.assertEqual((scale.dtype, shift.dtype), (mx.bfloat16, mx.bfloat16))
        from mulacover_mlx import llama
        seen, original = [], llama.Llama.__call__

        def spy(self, x, *a, **k):  # special methods are looked up on the class, so patch the class
            if self is m.decoder:
                seen.append(x.dtype)
            return original(self, x, *a, **k)

        llama.Llama.__call__ = spy
        try:
            tokens = mx.zeros((2, 3, 9), dtype=mx.int32)
            m.frame(state, tokens, mx.ones((2, 3, 9), dtype=mx.bool_), temperature=1.0, topk=1,
                    first=(mx.zeros((2, 16)), mx.array([0, 0]), mx.array([1, 1])))
        finally:
            llama.Llama.__call__ = original
        self.assertEqual(len(seen), 7)  # codebooks 1–7
        self.assertEqual(set(seen), {mx.bfloat16})
