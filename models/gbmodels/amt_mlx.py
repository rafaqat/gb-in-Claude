# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""The Anticipatory Music Transformer on MLX (Apple's array framework, Metal underneath).

music-medium-800k is GPT-2 with two details a stock port misses: scale_attn_by_inverse_layer_idx (scores in layer i
are also divided by i + 1) and gelu_new (the tanh GELU). Weights come from the same Hugging Face checkpoint.
Sampling uses the patched sampler's rules (gbmodels.amt_fast) through MLXPrefixCache, so only the engine changes.
"""
import math

import mlx.core as mx
import mlx.nn as nn
import numpy as np
import torch
from huggingface_hub import snapshot_download

from gbmodels.amt import REPO, REVISION


class Block(nn.Module):
    def __init__(self, d: int, heads: int, layer: int):
        super().__init__()
        self.heads, self.ln_1, self.ln_2 = heads, nn.LayerNorm(d, eps=1e-5), nn.LayerNorm(d, eps=1e-5)
        self.c_attn, self.c_proj = nn.Linear(d, 3 * d), nn.Linear(d, d)
        self.c_fc, self.mlp_proj = nn.Linear(d, 4 * d), nn.Linear(4 * d, d)
        self.scale = 1.0 / (math.sqrt(d // heads) * (layer + 1))  # inverse-layer-index scaling

    def __call__(self, x, mask, cache):
        b, l, d = x.shape
        q, k, v = mx.split(self.c_attn(self.ln_1(x)), 3, axis=-1)
        q, k, v = (t.reshape(b, l, self.heads, -1).transpose(0, 2, 1, 3) for t in (q, k, v))
        if cache is not None:
            k, v = mx.concatenate([cache[0], k], axis=2), mx.concatenate([cache[1], v], axis=2)
        a = mx.fast.scaled_dot_product_attention(q, k, v, scale=self.scale, mask=mask)
        x = x + self.c_proj(a.transpose(0, 2, 1, 3).reshape(b, l, d))
        x = x + self.mlp_proj(nn.gelu_approx(self.c_fc(self.ln_2(x))))
        return x, (k, v)


class GPT2(nn.Module):
    def __init__(self, vocab=55028, positions=1024, d=1024, layers=24, heads=16):
        super().__init__()
        self.wte, self.wpe = nn.Embedding(vocab, d), nn.Embedding(positions, d)
        self.h = [Block(d, heads, i) for i in range(layers)]
        self.ln_f = nn.LayerNorm(d, eps=1e-5)

    def __call__(self, ids, cache=None):
        offset = cache[0][0].shape[2] if cache else 0
        l = ids.shape[1]
        x = self.wte(ids) + self.wpe(mx.arange(offset, offset + l))
        mask = None
        if l > 1:  # new tokens see every cached token and the new ones up to themselves
            mask = mx.where(mx.arange(offset + l)[None, :] > (mx.arange(l)[:, None] + offset), -mx.inf, 0.0).astype(x.dtype)
        new_cache = []
        for i, block in enumerate(self.h):
            x, kv = block(x, mask, cache[i] if cache else None)
            new_cache.append(kv)
        return self.wte.as_linear(self.ln_f(x[:, -1:, :])), new_cache  # tied embeddings; last position only


def load(device: str = "mlx", dtype: str = "float16"):
    """device is always MLX's default (the GPU); dtype float16 or float32."""
    sd = torch.load(f"{snapshot_download(REPO, revision=REVISION)}/pytorch_model.bin", map_location="cpu", weights_only=True)
    # the checkpoint also stores non-tensor entries (old GPT-2 attention buffers); only weights are converted
    sd = {k.removeprefix("transformer."): v.float().numpy() for k, v in sd.items() if isinstance(v, torch.Tensor)}
    t = lambda a: mx.array(a.T)  # GPT-2's Conv1D stores weights as (in, out); mlx Linear wants (out, in)
    weights = [("wte.weight", mx.array(sd["wte.weight"])), ("wpe.weight", mx.array(sd["wpe.weight"])),
               ("ln_f.weight", mx.array(sd["ln_f.weight"])), ("ln_f.bias", mx.array(sd["ln_f.bias"]))]
    for i in range(24):
        p = f"h.{i}."
        weights += [(p + "ln_1.weight", mx.array(sd[p + "ln_1.weight"])), (p + "ln_1.bias", mx.array(sd[p + "ln_1.bias"])),
                    (p + "ln_2.weight", mx.array(sd[p + "ln_2.weight"])), (p + "ln_2.bias", mx.array(sd[p + "ln_2.bias"])),
                    (p + "c_attn.weight", t(sd[p + "attn.c_attn.weight"])), (p + "c_attn.bias", mx.array(sd[p + "attn.c_attn.bias"])),
                    (p + "c_proj.weight", t(sd[p + "attn.c_proj.weight"])), (p + "c_proj.bias", mx.array(sd[p + "attn.c_proj.bias"])),
                    (p + "c_fc.weight", t(sd[p + "mlp.c_fc.weight"])), (p + "c_fc.bias", mx.array(sd[p + "mlp.c_fc.bias"])),
                    (p + "mlp_proj.weight", t(sd[p + "mlp.c_proj.weight"])), (p + "mlp_proj.bias", mx.array(sd[p + "mlp.c_proj.bias"]))]
    mx.set_cache_limit(1 << 30)  # MLX keeps freed buffers for reuse; uncapped it grew to 11 GB next to GarageBand
    model = GPT2()
    model.load_weights(weights)
    model.set_dtype(getattr(mx, dtype))
    mx.eval(model.parameters())
    return {"model": model, "device": "mlx", "dtype": dtype}


class MLXPrefixCache:
    """The exact prefix cache of gbmodels.amt_fast, on MLX. Returns float32 torch logits (CPU) for the sampler."""
    def __init__(self, model):
        self.mlx_model, self.window_start = model, 0
        self.ids, self.past, self.hits, self.misses = [], None, 0, 0
        self.events, self.capped = 0, False

    def logits(self, _torch_model, ids):
        n = len(self.ids)
        if self.past is not None and 0 < n < len(ids) and ids[:n] == self.ids:
            out, self.past = self.mlx_model(mx.array([ids[n:]]), self.past)
            self.hits += 1
        else:
            out, self.past = self.mlx_model(mx.array([ids]))
            self.misses += 1
        self.ids = list(ids)
        return torch.from_numpy(np.array(out[0, -1].astype(mx.float32)))


def generate_mlx(handle, start_time, end_time, inputs=None, top_p=1.0, greedy=False, window_chunk=0, instruments=None, budget=None):
    from anticipation import sample
    from gbmodels.amt_fast import make_add_token
    cache = MLXPrefixCache(handle["model"])
    shipped = sample.add_token
    sample.add_token = make_add_token(cache, greedy, window_chunk, instruments, budget)
    try:
        events = sample.generate(_DeviceShim(), start_time, end_time, inputs=inputs, top_p=top_p)
    finally:
        sample.add_token = shipped
    return events, cache


class _DeviceShim:
    """anticipation's generate() passes the model through to add_token only; ours ignores it."""
    device = "cpu"


def run(handle, inputs: dict) -> dict:
    from anticipation import ops
    from anticipation.convert import midi_to_events
    torch.manual_seed(inputs.get("seed", 1))
    events = midi_to_events(inputs["midi"])
    start, end = inputs["start_s"], inputs["end_s"]
    before = ops.clip(events, 0, start, clip_duration=False)
    after = ops.clip(events, end, ops.max_time(events), clip_duration=False)
    infill, cache = generate_mlx(handle, start, end, inputs=ops.sort(before + after), top_p=0.98,
                                  instruments=sorted(ops.get_instruments(events)) if inputs.get("song_instruments_only", True) else None,
                                 window_chunk=inputs.get("window_chunk", 0))
    notes = ops.clip(infill, start, end, clip_duration=False)
    return {"notes_generated": len(notes) // 3, "instruments": sorted(ops.get_instruments(notes).keys()),
            "cache_hits": cache.hits, "cache_misses": cache.misses}
