# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""MuLaCover's symbolic conditioning in MLX: the SymbolicAdaptor (melody / drum / chord roll → context) and the gated
cross-attention from the backbone to that context. The roll does not change during a song, so the context's keys and
values are computed once (prepare) instead of once per frame as in the original; the per-frame call is query-side only.
key_mask: (B, L) bool, True = padding (the original's context_mask)."""
import math

import mlx.core as mx
import mlx.nn as nn

from .llama import Llama, LlamaDims, RMSNorm, llama3_theta, rope_heads

ROPE_BASE, ROPE_SCALE = 500_000, 32


def _attend(key_mask: mx.array) -> mx.array:
    """(B, L) padding → (B, 1, 1, L) True where a key may be attended."""
    return mx.logical_not(key_mask)[:, None, None, :]


class CrossAttentionRoPE(nn.Module):
    def __init__(self, embed_dim: int, num_heads: int, num_kv_heads: int):
        super().__init__()
        self.num_heads, self.num_kv_heads = num_heads, num_kv_heads
        self.head_dim = embed_dim // num_heads
        self.q_proj = nn.Linear(embed_dim, num_heads * self.head_dim, bias=False)
        self.k_proj = nn.Linear(embed_dim, num_kv_heads * self.head_dim, bias=False)
        self.v_proj = nn.Linear(embed_dim, num_kv_heads * self.head_dim, bias=False)
        self.output_proj = nn.Linear(num_heads * self.head_dim, embed_dim, bias=False)
        self._theta = llama3_theta(self.head_dim, ROPE_BASE, ROPE_SCALE)

    def prepare(self, context: mx.array):
        b, n, _ = context.shape
        k = rope_heads(self.k_proj(context).reshape(b, n, self.num_kv_heads, self.head_dim).transpose(0, 2, 1, 3), 0, self._theta)
        v = self.v_proj(context).reshape(b, n, self.num_kv_heads, self.head_dim).transpose(0, 2, 1, 3)
        return k, v

    def __call__(self, x: mx.array, kv, key_mask: mx.array, offset: int) -> mx.array:
        """offset: the backbone position of x's first row (the queries are at offset … offset + S − 1)."""
        b, s, _ = x.shape
        q = rope_heads(self.q_proj(x).reshape(b, s, self.num_heads, self.head_dim).transpose(0, 2, 1, 3), offset, self._theta)
        out = mx.fast.scaled_dot_product_attention(q, kv[0], kv[1], scale=1.0 / math.sqrt(self.head_dim), mask=_attend(key_mask))
        return self.output_proj(out.transpose(0, 2, 1, 3).reshape(b, s, -1))


class CrossAttentionBlock(nn.Module):
    def __init__(self, embed_dim: int, num_heads: int, gate_dim: int = 12, gate_num_heads: int = 1):
        super().__init__()
        self.norm = RMSNorm(embed_dim, 1e-5)
        self.attn = CrossAttentionRoPE(embed_dim, num_heads, num_heads)
        self.x_gate_proj = nn.Linear(embed_dim, gate_dim)
        self.context_gate_proj = nn.Linear(embed_dim, gate_dim)
        self.gate = CrossAttentionRoPE(gate_dim, gate_num_heads, gate_num_heads)
        self.gate_proj = nn.Linear(gate_dim, 1)

    def prepare(self, context: mx.array) -> dict:
        return {"attn": self.attn.prepare(context), "gate": self.gate.prepare(self.context_gate_proj(context))}

    def __call__(self, hidden: mx.array, prepared: dict, key_mask: mx.array, offset: int) -> mx.array:
        normed = self.norm(hidden)
        attended = self.attn(normed, prepared["attn"], key_mask, offset)
        gate = self.gate(self.x_gate_proj(normed), prepared["gate"], key_mask, offset)
        return hidden + mx.tanh(self.gate_proj(gate)) * attended


class SymbolicAdaptor(nn.Module):
    def __init__(self, embed_dim: int, bottleneck_dim: int = 24, hidden_dim: int = 512, num_layers: int = 2, num_heads: int = 8):
        super().__init__()
        self.pianoroll_proj = nn.Linear(256, bottleneck_dim)
        self.drum_pianoroll_proj = nn.Linear(128, bottleneck_dim)
        self.chord_proj = nn.Linear(12, bottleneck_dim)
        self.fusion_proj = nn.Linear(bottleneck_dim * 3, hidden_dim)
        self.decoder = Llama(LlamaDims(num_layers=num_layers, num_heads=num_heads, num_kv_heads=num_heads, embed_dim=hidden_dim,
                                       intermediate_dim=hidden_dim * 4, rope_base=ROPE_BASE, scale_factor=ROPE_SCALE))
        self.out_proj = nn.Linear(hidden_dim, embed_dim)

    def __call__(self, pianoroll: mx.array, drum_pianoroll: mx.array, chord: mx.array, key_mask: mx.array) -> mx.array:
        h = self.fusion_proj(mx.concatenate([self.pianoroll_proj(pianoroll), self.drum_pianoroll_proj(drum_pianoroll),
                                             self.chord_proj(chord)], axis=-1))
        return self.out_proj(self.decoder(h, None, mask=_attend(key_mask)))  # bidirectional, padding masked
