# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""The generation loop (the authors' MuLaCoverGenPipeline._forward) over the MLX frame generator. Input: the pipeline's
preprocess() output (torch tensors or arrays); output: the frames (codebooks, frames) as numpy, the shape the authors'
postprocess() / codec expects under {"frames": …}. Stops at EOS; a padding token is an error, as in the original."""
import mlx.core as mx
import numpy as np

ROLLS = ("pianoroll", "drum_pianoroll", "chord")


def _mx(value) -> mx.array:
    return mx.array(value.detach().cpu().numpy()) if hasattr(value, "detach") else mx.array(value)


def generate(model, inputs: dict, max_frames: int, temperature: float, topk: int, cfg_scale: float, eos_id: int, empty_id: int,
             dtype=mx.float32, progress=None) -> np.ndarray:
    x = {k: _mx(v) for k, v in inputs.items() if v is not None}
    for key in ROLLS:
        x[key] = x[key].astype(dtype)
    state = model.start(x["pianoroll"], x["drum_pianoroll"], x["chord"], x["context_mask"], x["qwen_embedding"], cfg_scale=cfg_scale)
    tokens, mask = x["tokens"], x["tokens_mask"]
    batch, codebooks = tokens.shape[0], tokens.shape[2] - 1
    first = (x["muq_embedding"], x["qwen_indices"], x["muq_indices"])
    next_mask = mx.concatenate([mx.ones((batch, 1, codebooks), dtype=mx.bool_), mx.zeros((batch, 1, 1), dtype=mx.bool_)], axis=2)
    frames = []
    for step in range(max_frames):
        sample = model.frame(state, tokens, mask, temperature, topk, first if step == 0 else None)
        row = np.array(sample[0])
        if (row >= eos_id).any():
            break
        if (row < 0).any() or (row >= eos_id - 1).any():
            raise RuntimeError("MuLaCover generated an audio padding token")
        frames.append(row)
        tokens = mx.concatenate([sample[:, None, :], mx.full((batch, 1, 1), empty_id, dtype=sample.dtype)], axis=2)
        mask = next_mask
        if progress is not None:
            progress(step + 1)
    if not frames:
        raise RuntimeError("MuLaCover emitted EOS before generating any audio")
    return np.stack(frames, axis=-1)
