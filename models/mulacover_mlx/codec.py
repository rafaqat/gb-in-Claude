# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""HeartCodec's flow-matching estimator (the authors' LlamaTransformer, _codec/models/transformer.py) in MLX. It is 84 %
of the codec's time on MPS (20 calls for 30 s of audio); the codebook lookup, the Euler loop and the conv decoder stay
in the authors' PyTorch, and EstimatorBridge stands in for their estimator module. Parameter names are the authors';
Conv1d weights are re-laid out (torch: out, in, k → MLX: out, k, in). Bidirectional attention, RoPE on interleaved
pairs (base 10000), RMSNorm eps 1e-6 in the input precision, AdaLN-single timestep modulation."""
import math
from dataclasses import dataclass

import mlx.core as mx
import mlx.nn as nn
import numpy as np

FLOW_T_SIZE = 512


@dataclass(frozen=True)
class EstimatorDims:
    num_attention_heads: int = 24
    attention_head_dim: int = 64
    in_channels: int = 1024
    out_channels: int = 256
    num_layers: int = 24
    num_layers_2: int = 6

    @property
    def inner_dim(self) -> int:
        return self.num_attention_heads * self.attention_head_dim


class RMSNorm(nn.Module):
    def __init__(self, dim: int, eps: float = 1e-6):
        super().__init__()
        self.weight = mx.ones((dim,))
        self.eps = eps

    def __call__(self, x):
        return self.weight * (x * mx.rsqrt(mx.mean(x * x, axis=-1, keepdims=True) + self.eps))


class Attention(nn.Module):
    def __init__(self, dim: int, n_heads: int, head_dim: int):
        super().__init__()
        self.n_heads, self.head_dim = n_heads, head_dim
        inner = n_heads * head_dim
        self.q_proj = nn.Linear(dim, inner, bias=False)
        self.k_proj = nn.Linear(dim, inner, bias=False)
        self.v_proj = nn.Linear(dim, inner, bias=False)
        self.o_proj = nn.Linear(inner, dim, bias=False)

    def __call__(self, x):
        b, t, _ = x.shape
        shape = lambda y: y.reshape(b, t, self.n_heads, self.head_dim).transpose(0, 2, 1, 3)
        q, k, v = shape(self.q_proj(x)), shape(self.k_proj(x)), shape(self.v_proj(x))
        q = mx.fast.rope(q, self.head_dim, traditional=True, base=10000.0, scale=1.0, offset=0)
        k = mx.fast.rope(k, self.head_dim, traditional=True, base=10000.0, scale=1.0, offset=0)
        out = mx.fast.scaled_dot_product_attention(q, k, v, scale=1.0 / math.sqrt(self.head_dim))
        return self.o_proj(out.transpose(0, 2, 1, 3).reshape(b, t, -1))


class MLP(nn.Module):
    def __init__(self, dim: int, multiple_of: int = 256):
        super().__init__()
        hidden = int(2 * (4 * dim) / 3)
        hidden = multiple_of * ((hidden + multiple_of - 1) // multiple_of)
        self.gate = nn.Linear(dim, hidden, bias=False)
        self.up = nn.Linear(dim, hidden, bias=False)
        self.down = nn.Linear(hidden, dim, bias=False)

    def __call__(self, x):
        return self.down(nn.silu(self.gate(x)) * self.up(x))


class Block(nn.Module):
    def __init__(self, dim: int, n_heads: int, head_dim: int):
        super().__init__()
        self.attn_norm = RMSNorm(dim)
        self.attn = Attention(dim, n_heads, head_dim)
        self.mlp_norm = RMSNorm(dim)
        self.mlp = MLP(dim)
        self.scale_shift_table = mx.zeros((6, dim))

    def __call__(self, x, timestep_mod):
        b = x.shape[0]
        mods = self.scale_shift_table[None] + timestep_mod.reshape(b, 6, -1)
        shift_msa, scale_msa, gate_msa, shift_mlp, scale_mlp, gate_mlp = (mods[:, i:i + 1] for i in range(6))
        x = x + gate_msa * self.attn(self.attn_norm(x) * (1 + scale_msa) + shift_msa)
        return x + gate_mlp * self.mlp(self.mlp_norm(x) * (1 + scale_mlp) + shift_mlp)


class ProjectLayer(nn.Module):
    def __init__(self, hidden_size: int, filter_size: int, kernel_size: int = 3):
        super().__init__()
        self.kernel_size = kernel_size
        self.ffn_1 = nn.Conv1d(hidden_size, filter_size, kernel_size, padding=kernel_size // 2)
        self.ffn_2 = nn.Linear(filter_size, filter_size)

    def __call__(self, x):  # (B, T, C): MLX convolutions are channels-last
        return self.ffn_2(self.ffn_1(x) * self.kernel_size ** -0.5)


class TimestepEmbedder(nn.Module):
    def __init__(self, in_channels: int, dim: int):
        super().__init__()
        self.linear_1 = nn.Linear(in_channels, dim)
        self.linear_2 = nn.Linear(dim, dim)

    def __call__(self, x):
        return self.linear_2(nn.silu(self.linear_1(x)))


class FlowEmbeddings(nn.Module):
    def __init__(self, dim: int):
        super().__init__()
        self.timestep_embedder = TimestepEmbedder(FLOW_T_SIZE, dim)

    def __call__(self, t, dtype):
        half = FLOW_T_SIZE // 2
        freqs = mx.exp(-math.log(10000) * mx.arange(half, dtype=mx.float32) / half).astype(t.dtype)
        args = t[:, None] * freqs[None] * 1000
        return self.timestep_embedder(mx.concatenate([mx.cos(args), mx.sin(args)], axis=-1).astype(dtype))


class AdaLayerNormSingle(nn.Module):
    def __init__(self, dim: int):
        super().__init__()
        self.emb = FlowEmbeddings(dim)
        self.linear = nn.Linear(dim, 6 * dim)

    def __call__(self, t, dtype):
        embedded = self.emb(t, dtype)
        return self.linear(nn.silu(embedded)), embedded


class Estimator(nn.Module):
    def __init__(self, d: EstimatorDims):
        super().__init__()
        inner, inner2 = d.inner_dim, d.inner_dim * 2
        self.proj_in = ProjectLayer(d.in_channels, inner)
        self.transformer_blocks = [Block(inner, d.num_attention_heads, d.attention_head_dim) for _ in range(d.num_layers)]
        self.transformer_blocks_2 = [Block(inner2, d.num_attention_heads, d.attention_head_dim * 2) for _ in range(d.num_layers_2)]
        self.connection_proj = ProjectLayer(d.in_channels + inner, inner2)
        self.scale_shift_table = mx.zeros((2, inner))
        self.scale_shift_table_2 = mx.zeros((2, inner2))
        self.proj_out = ProjectLayer(inner2, d.out_channels)
        self.adaln_single = AdaLayerNormSingle(inner)
        self.adaln_single_2 = AdaLayerNormSingle(inner2)

    @staticmethod
    def _out(x, table, embedded):
        mods = table[None] + embedded[:, None]
        return mx.fast.layer_norm(x, None, None, 1e-6) * (1 + mods[:, 1:2]) + mods[:, 0:1]

    def __call__(self, hidden, timestep):
        s = self.proj_in(hidden)
        mod, embedded = self.adaln_single(timestep, s.dtype)
        for blk in self.transformer_blocks:
            s = blk(s, mod)
        s = self._out(s, self.scale_shift_table, embedded)
        x = self.connection_proj(mx.concatenate([hidden, s], axis=-1))
        mod2, embedded2 = self.adaln_single_2(timestep, x.dtype)
        for blk in self.transformer_blocks_2:
            x = blk(x, mod2)
        return self.proj_out(self._out(x, self.scale_shift_table_2, embedded2))


def _to_mx(name: str, value: np.ndarray, dtype) -> mx.array:
    a = mx.array(value).astype(dtype)
    return a.transpose(0, 2, 1) if name.endswith("ffn_1.weight") else a  # Conv1d: (out, in, k) → (out, k, in)


def load_torch_estimator(module: Estimator, state_dict: dict, prefix: str = "", dtype=mx.float32) -> None:
    weights = [(k[len(prefix):], _to_mx(k, v.detach().float().cpu().numpy(), dtype)) for k, v in state_dict.items() if k.startswith(prefix)]
    module.load_weights(weights, strict=True)


def load_checkpoint_estimator(module: Estimator, folder: str, dtype=mx.float32) -> int:
    """The estimator's tensors from HeartCodec's sharded safetensors (prefix flow_matching.estimator.)."""
    import json, os
    prefix = "flow_matching.estimator."
    with open(os.path.join(folder, "model.safetensors.index.json")) as f:
        index = json.load(f)["weight_map"]
    weights = []
    for shard in sorted({s for k, s in index.items() if k.startswith(prefix)}):
        for k, v in mx.load(os.path.join(folder, shard)).items():
            if k.startswith(prefix):
                name = k[len(prefix):]
                v = v.astype(dtype)
                weights.append((name, v.transpose(0, 2, 1) if name.endswith("ffn_1.weight") else v))
    module.load_weights(weights, strict=True)
    mx.eval(module.parameters())
    return len(weights)


def _torch_module_base():
    import torch
    return torch.nn.Module


class EstimatorBridge(_torch_module_base()):
    """A torch module with the authors' estimator interface, computing in MLX: forward(hidden_states, timestep)."""

    def __init__(self, estimator: Estimator, dtype=mx.float32):
        super().__init__()
        self.mlx = estimator
        self.mlx_dtype = dtype

    def forward(self, hidden_states, timestep=None):
        import torch
        x = mx.array(hidden_states.detach().float().cpu().numpy()).astype(self.mlx_dtype)
        t = mx.array(timestep.detach().float().cpu().numpy())
        out = self.mlx(x, t).astype(mx.float32)
        return torch.from_numpy(np.array(out)).to(device=hidden_states.device, dtype=hidden_states.dtype)
