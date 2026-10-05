# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""The Llama 3.2 transformer as torchtune builds it (llama3_2(): MuLaCover's backbone, depth decoder and symbolic
adaptor), in MLX. Parameter names are torchtune's, so a torchtune state dict loads with no renaming. Numerics follow
torchtune: RMSNorm in float32; Llama-3 scaled RoPE on interleaved pairs (x0,x1),(x2,x3)… computed in float32;
grouped-query attention where query head h reads KV head h // (heads / kv_heads); SwiGLU MLP."""
import math
from dataclasses import dataclass

import mlx.core as mx
import mlx.nn as nn
import numpy as np


@dataclass(frozen=True)
class LlamaDims:
    num_layers: int
    num_heads: int
    num_kv_heads: int
    embed_dim: int
    intermediate_dim: int
    rope_base: int = 500_000
    scale_factor: int = 32
    norm_eps: float = 1e-5

    @property
    def head_dim(self) -> int:
        return self.embed_dim // self.num_heads


def llama3_theta(head_dim: int, base: float, scale_factor: float, low_freq_factor: float = 1, high_freq_factor: float = 4,
                 old_context_len: int = 8192) -> mx.array:
    """torchtune Llama3ScaledRoPE.theta (float32)."""
    f32 = np.float32
    freqs = (1.0 / (f32(base) ** (np.arange(0, head_dim, 2)[: head_dim // 2].astype(f32) / f32(head_dim)))).astype(f32)
    low_wavelen, high_wavelen = old_context_len / low_freq_factor, old_context_len / high_freq_factor
    out = []
    for freq in freqs:
        wavelen = f32(2 * math.pi) / freq
        if wavelen < high_wavelen:
            out.append(freq)
        elif wavelen > low_wavelen:
            out.append(freq / f32(scale_factor))
        else:
            smooth = (f32(old_context_len) / wavelen - f32(low_freq_factor)) / f32(high_freq_factor - low_freq_factor)
            out.append((f32(1) - smooth) * freq / f32(scale_factor) + smooth * freq)
    return mx.array(np.array(out, dtype=f32))


def rope(x: mx.array, positions: mx.array, theta: mx.array) -> mx.array:
    """x: (B, S, H, D); positions: (S,) — the same positions for every batch row."""
    angles = positions.astype(mx.float32)[:, None] * theta[None, :]  # (S, D/2)
    cos, sin = mx.cos(angles)[None, :, None, :], mx.sin(angles)[None, :, None, :]
    xf = x.astype(mx.float32)
    x0, x1 = xf[..., 0::2], xf[..., 1::2]
    out = mx.stack([x0 * cos - x1 * sin, x1 * cos + x0 * sin], axis=-1)
    return out.reshape(x.shape).astype(x.dtype)


def rope_heads(x: mx.array, offset: int, theta: mx.array) -> mx.array:
    """The same rotation on (B, H, S, D) with positions offset … offset + S − 1, as one fused kernel. MLX's freqs are
    periods (1 / theta). The batch is folded into the head axis first: MLX 0.30.6's mx.fast.rope rotates batch rows
    after the first wrongly when S == 1 and offset > 0 (exactly the batch-2 CFG decode step); with batch 1 it is right."""
    b, h, s, d = x.shape
    out = mx.fast.rope(x.reshape(1, b * h, s, d), d, traditional=True, base=None, scale=1.0, offset=offset, freqs=1.0 / theta)
    return out.reshape(b, h, s, d)


class RMSNorm(nn.Module):
    def __init__(self, dim: int, eps: float):
        super().__init__()
        self.scale = mx.ones((dim,))
        self.eps = eps

    def __call__(self, x: mx.array) -> mx.array:
        return mx.fast.rms_norm(x, self.scale, self.eps)  # accumulates in float32, as torchtune does


class KVCache:
    """Keys / values seen so far, (B, kv_heads, length, head_dim); grows by concatenation."""

    def __init__(self):
        self.k = self.v = None

    @property
    def offset(self) -> int:
        return 0 if self.k is None else self.k.shape[2]

    def update(self, k: mx.array, v: mx.array):
        self.k = k if self.k is None else mx.concatenate([self.k, k], axis=2)
        self.v = v if self.v is None else mx.concatenate([self.v, v], axis=2)
        return self.k, self.v


class Attention(nn.Module):
    def __init__(self, d: LlamaDims):
        super().__init__()
        self.d = d
        self.q_proj = nn.Linear(d.embed_dim, d.num_heads * d.head_dim, bias=False)
        self.k_proj = nn.Linear(d.embed_dim, d.num_kv_heads * d.head_dim, bias=False)
        self.v_proj = nn.Linear(d.embed_dim, d.num_kv_heads * d.head_dim, bias=False)
        self.output_proj = nn.Linear(d.num_heads * d.head_dim, d.embed_dim, bias=False)
        self._theta = llama3_theta(d.head_dim, d.rope_base, d.scale_factor)

    def __call__(self, x: mx.array, cache: KVCache | None = None, mask: mx.array | None = None) -> mx.array:
        d = self.d
        b, s, _ = x.shape
        offset = cache.offset if cache is not None else 0
        q = rope_heads(self.q_proj(x).reshape(b, s, d.num_heads, d.head_dim).transpose(0, 2, 1, 3), offset, self._theta)
        k = rope_heads(self.k_proj(x).reshape(b, s, d.num_kv_heads, d.head_dim).transpose(0, 2, 1, 3), offset, self._theta)
        v = self.v_proj(x).reshape(b, s, d.num_kv_heads, d.head_dim).transpose(0, 2, 1, 3)
        if cache is not None:
            k, v = cache.update(k, v)
            if mask is None and s > 1:  # causal over the cache: query i sees keys up to offset + i
                mask = mx.arange(offset + s)[None, :] <= (offset + mx.arange(s))[:, None]
        out = mx.fast.scaled_dot_product_attention(q, k, v, scale=1.0 / math.sqrt(d.head_dim), mask=mask)
        return self.output_proj(out.transpose(0, 2, 1, 3).reshape(b, s, -1))


class FeedForward(nn.Module):
    def __init__(self, d: LlamaDims):
        super().__init__()
        self.w1 = nn.Linear(d.embed_dim, d.intermediate_dim, bias=False)
        self.w2 = nn.Linear(d.intermediate_dim, d.embed_dim, bias=False)
        self.w3 = nn.Linear(d.embed_dim, d.intermediate_dim, bias=False)

    def __call__(self, x: mx.array) -> mx.array:
        return self.w2(nn.silu(self.w1(x)) * self.w3(x))


class Layer(nn.Module):
    def __init__(self, d: LlamaDims):
        super().__init__()
        self.sa_norm = RMSNorm(d.embed_dim, d.norm_eps)
        self.attn = Attention(d)
        self.mlp_norm = RMSNorm(d.embed_dim, d.norm_eps)
        self.mlp = FeedForward(d)

    def __call__(self, x: mx.array, cache: KVCache | None = None, mask: mx.array | None = None) -> mx.array:
        h = x + self.attn(self.sa_norm(x), cache, mask)
        return h + self.mlp(self.mlp_norm(h))


class Llama(nn.Module):
    """torchtune TransformerDecoder with tok_embeddings and output removed (as MuLaCover's _prepare_transformer)."""

    def __init__(self, d: LlamaDims):
        super().__init__()
        self.dims = d
        self.layers = [Layer(d) for _ in range(d.num_layers)]
        self.norm = RMSNorm(d.embed_dim, d.norm_eps)

    def make_cache(self) -> list[KVCache]:
        return [KVCache() for _ in self.layers]

    def __call__(self, x: mx.array, caches: list[KVCache] | None = None, mask: mx.array | None = None) -> mx.array:
        for i, layer in enumerate(self.layers):
            x = layer(x, caches[i] if caches is not None else None, mask)
        return self.norm(x)


def load_torch(module: nn.Module, state_dict: dict, prefix: str = "", dtype=mx.float32) -> None:
    """Load torchtune / MuLaCover tensors whose names start with `prefix` (prefix removed); every parameter of
    `module` must be present (strict). Cache buffers are skipped."""
    weights = [(k[len(prefix):], mx.array(v.detach().float().cpu().numpy()).astype(dtype))
               for k, v in state_dict.items() if k.startswith(prefix) and "kv_cache" not in k]
    module.load_weights(weights, strict=True)
