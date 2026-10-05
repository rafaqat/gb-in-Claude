# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""MuLaCover's frame generator in MLX (the authors' MuLaCover.generate_frame, modeling.py). One frame = the backbone over
the new tokens (with style modulation and cross-attention to the symbolic context in its last layers), codebook 0 from
the backbone, codebooks 1–7 from the small depth decoder. Classifier-free guidance uses batch 2 (row 0 conditioned,
row 1 unconditioned). Everything that is the same for every frame — the masked rolls, the eight adaptors' cumulative
contexts and their keys / values, the style modulation — is computed once in start()."""
import json
from dataclasses import dataclass, field

import mlx.core as mx
import mlx.nn as nn

from .cross import CrossAttentionBlock, SymbolicAdaptor
from .llama import KVCache, Llama, LlamaDims

BACKBONE_3B = LlamaDims(num_layers=28, num_heads=24, num_kv_heads=8, embed_dim=3072, intermediate_dim=8192)
DECODER_300M = LlamaDims(num_layers=3, num_heads=8, num_kv_heads=4, embed_dim=3072, intermediate_dim=8192)
FLAVORS = {"llama-3B": BACKBONE_3B, "llama-300M": DECODER_300M}


@dataclass(frozen=True)
class MuLaCoverDims:
    backbone: LlamaDims
    decoder: LlamaDims
    text_vocab_size: int
    audio_vocab_size: int
    audio_num_codebooks: int
    muq_dim: int
    qwen_dim: int
    peft_layer_num: int
    train_tag: bool = True

    @classmethod
    def from_config(cls, path: str) -> "MuLaCoverDims":
        with open(path) as f:
            c = json.load(f)
        return cls(backbone=FLAVORS[c["backbone_flavor"]], decoder=FLAVORS[c["decoder_flavor"]], text_vocab_size=c["text_vocab_size"],
                   audio_vocab_size=c["audio_vocab_size"], audio_num_codebooks=c["audio_num_codebooks"], muq_dim=c["muq_dim"],
                   qwen_dim=c["qwen_dim"], peft_layer_num=c["peft_layer_num"], train_tag=c.get("train_tag", True))


class CrossAttentionLayer(nn.Module):
    def __init__(self, embed_dim: int, num_heads: int = 8):
        super().__init__()
        self.cross_attn = CrossAttentionBlock(embed_dim, num_heads)
        self.adaptor = SymbolicAdaptor(embed_dim)


class StyleMLP(nn.Module):
    def __init__(self, embed_dim: int, hidden_dim: int):
        super().__init__()
        self.mlp = nn.Linear(embed_dim, hidden_dim * 2)

    def __call__(self, style: mx.array):
        # as under the original's bf16 autocast: SiLU in the input's precision, the linear in the weights' precision
        return mx.split(self.mlp(nn.silu(style).astype(self.mlp.weight.dtype)), 2, axis=-1)


def sample_topk(logits: mx.array, topk: int, temperature: float) -> mx.array:
    """The authors' sample_topk: keep the top-k logits, sample from their softmax. (B, V) → (B, 1) int32."""
    logits = logits / temperature
    kth = mx.min(mx.topk(logits, topk, axis=-1), axis=-1, keepdims=True)
    masked = mx.where(logits < kth, -mx.inf, logits)
    return mx.random.categorical(masked, axis=-1)[:, None].astype(mx.int32)


@dataclass
class SongState:
    """Per-song state from start(): backbone KV caches and the precomputed conditioning."""
    caches: list
    prepared: dict  # peft layer index → prepared cross-attention keys / values
    style: dict  # tag layer index → (scale, shift)
    key_mask: mx.array
    uncond: mx.array | None
    cfg_scale: float
    extra: dict = field(default_factory=dict)


class MuLaCoverMLX(nn.Module):
    def __init__(self, d: MuLaCoverDims):
        super().__init__()
        self.dims = d
        e, ed = d.backbone.embed_dim, d.decoder.embed_dim
        self.backbone = Llama(d.backbone)
        self.decoder = Llama(d.decoder)
        self.text_embeddings = nn.Embedding(d.text_vocab_size, e)
        self.audio_embeddings = nn.Embedding(d.audio_vocab_size * d.audio_num_codebooks, e)
        self.unconditional_text_embedding = nn.Embedding(1, e)
        self.projection = nn.Linear(e, ed, bias=False)
        self.codebook0_head = nn.Linear(e, d.audio_vocab_size, bias=False)
        self.audio_head = mx.zeros((d.audio_num_codebooks - 1, ed, d.audio_vocab_size))
        self.muq_linear = nn.Linear(d.muq_dim, e)
        self.qwen_linear = nn.Linear(d.qwen_dim, e)
        first = d.backbone.num_layers - d.peft_layer_num
        self.peft_layers = [CrossAttentionLayer(e) if i >= first else nn.Module() for i in range(d.backbone.num_layers)]
        self.tag_mlp_layers = [StyleMLP(d.qwen_dim, e) if i >= first else nn.Module() for i in range(d.backbone.num_layers)]
        self._first_peft = first

    # ---- once per song ----
    def start(self, pianoroll: mx.array, drum_pianoroll: mx.array, chord: mx.array, key_mask: mx.array, qwen_embedding: mx.array,
              cfg_scale: float) -> SongState:
        batch = pianoroll.shape[0]
        uncond = None
        style = qwen_embedding[:, None, :]
        if cfg_scale > 1.0 and batch > 1:
            uncond = mx.arange(batch) >= batch // 2
            u3 = uncond[:, None, None]
            pianoroll, drum_pianoroll, chord = (mx.where(u3, -1.0, t).astype(t.dtype) for t in (pianoroll, drum_pianoroll, chord))
            style = mx.where(u3, -1.0, style.astype(mx.float32))  # the original promotes to float32 here
        prepared, mods, context = {}, {}, None
        for i in range(self._first_peft, self.dims.backbone.num_layers):
            layer = self.peft_layers[i]
            current = layer.adaptor(pianoroll, drum_pianoroll, chord, key_mask)
            context = current if context is None else context + current
            prepared[i] = layer.cross_attn.prepare(context)
            if self.dims.train_tag:
                mods[i] = self.tag_mlp_layers[i](style)
        state = SongState(caches=self.backbone.make_cache(), prepared=prepared, style=mods, key_mask=key_mask, uncond=uncond,
                          cfg_scale=cfg_scale, extra={"qwen": qwen_embedding})
        mx.eval(prepared, mods)
        return state

    # ---- once per frame ----
    def _embed(self, tokens: mx.array, uncond: mx.array | None) -> mx.array:
        d = self.dims
        text = self.text_embeddings(tokens[:, :, -1])
        if uncond is not None:
            text = mx.where(uncond[:, None, None], self.unconditional_text_embedding.weight[0], text)
        audio = self.audio_embeddings(tokens[:, :, :-1] + d.audio_vocab_size * mx.arange(d.audio_num_codebooks))
        return mx.concatenate([audio, text[:, :, None, :]], axis=2)

    def _guided_sample(self, logits: mx.array, state: SongState, topk: int, temperature: float) -> mx.array:
        if state.uncond is not None:
            guided = logits[1:] + (logits[0:1] - logits[1:]) * state.cfg_scale
            return mx.repeat(sample_topk(guided, topk, temperature), 2, axis=0)
        return sample_topk(logits, topk, temperature)

    def frame(self, state: SongState, tokens: mx.array, tokens_mask: mx.array, temperature: float, topk: int,
              first: tuple | None = None) -> mx.array:
        """tokens: (B, S, codebooks + 1); first = (muq_embedding, qwen_indices, muq_indices) on the first frame only.
        Returns the frame's codebook tokens (B, codebooks)."""
        d = self.dims
        batch, seq = tokens.shape[:2]
        hidden = (self._embed(tokens, state.uncond) * tokens_mask[..., None]).sum(axis=2)
        if first is not None:
            muq, idx_q, idx_m = first
            uncond_emb = self.unconditional_text_embedding.weight[0]
            q = self.qwen_linear(state.extra["qwen"].astype(self.qwen_linear.weight.dtype))
            m = self.muq_linear(muq.astype(self.muq_linear.weight.dtype))
            if state.uncond is not None:
                q = mx.where(state.uncond[:, None], uncond_emb, q)
                m = mx.where(state.uncond[:, None], uncond_emb, m)
            at = mx.arange(seq)[None, :]
            hidden = mx.where((at == idx_q[:, None])[..., None], q[:, None, :].astype(hidden.dtype), hidden)
            hidden = mx.where((at == idx_m[:, None])[..., None], m[:, None, :].astype(hidden.dtype), hidden)

        offset = state.caches[0].offset
        for i, layer in enumerate(self.backbone.layers):
            if i in state.style:
                scale, shift = state.style[i]
                hidden = hidden * (1 + scale) + shift
            hidden = layer(hidden, state.caches[i])
            if i in state.prepared:
                hidden = self.peft_layers[i].cross_attn(hidden, state.prepared[i], state.key_mask, offset)
        last = self.backbone.norm(hidden)[:, -1, :]

        sample = self._guided_sample(self.codebook0_head(last), state, topk, temperature)
        samples = [sample]
        caches = self.decoder.make_cache()
        x = mx.concatenate([last[:, None, :], self.audio_embeddings(sample)], axis=1)  # codebook 0: offset 0
        for codebook in range(1, d.audio_num_codebooks):
            h = self.decoder(self.projection(x), caches)
            sample = self._guided_sample(h[:, -1, :] @ self.audio_head[codebook - 1], state, topk, temperature)
            samples.append(sample)
            x = self.audio_embeddings(sample + codebook * d.audio_vocab_size)
        return mx.concatenate(samples, axis=1)


def load_checkpoint(model: MuLaCoverMLX, folder: str) -> int:
    """Load the authors' sharded safetensors (names = the MLX parameter names) strictly; returns the tensor count."""
    import os
    with open(os.path.join(folder, "model.safetensors.index.json")) as f:
        index = json.load(f)["weight_map"]
    weights = []
    for shard in sorted(set(index.values())):
        weights += list(mx.load(os.path.join(folder, shard)).items())
    model.load_weights(weights, strict=True)
    mx.eval(model.parameters())
    return len(weights)
