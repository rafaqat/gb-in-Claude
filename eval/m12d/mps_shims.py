# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""MPS shims for MuLaCover f01810c: run-time replacements for the few lines that only work on CUDA.
Applied in memory after the pinned-checkout check; the authors' files are never edited. Each shim checks that the
original method is the reviewed one (source hash), so an upstream change makes it refuse instead of mis-patching."""
import hashlib, inspect, math

import torch


def _sha(fn) -> str:
    return hashlib.sha256(inspect.getsource(fn).encode()).hexdigest()


def apply() -> list[str]:
    from mulacover._codec.models import transformer
    cls = transformer.PixArtAlphaCombinedFlowEmbeddings
    original = cls.timestep_embedding
    expected = REVIEWED["PixArtAlphaCombinedFlowEmbeddings.timestep_embedding"]
    if _sha(original) != expected:
        raise RuntimeError("PixArtAlphaCombinedFlowEmbeddings.timestep_embedding differs from the reviewed version; not patching")

    def timestep_embedding(self, timesteps, max_period=10000, scale=1000):
        # the original casts with .type(timesteps.type()); 'torch.mps.FloatTensor' is not a valid .type() target
        half = self.flow_t_size // 2
        freqs = torch.exp(-math.log(max_period) * torch.arange(start=0, end=half, device=timesteps.device) / half).to(timesteps.dtype)
        args = timesteps[:, None] * freqs[None] * scale
        embedding = torch.cat([torch.cos(args), torch.sin(args)], dim=-1)
        if self.flow_t_size % 2:
            embedding = torch.cat([embedding, torch.zeros_like(embedding[:, :1])], dim=-1)
        return embedding

    cls.timestep_embedding = timestep_embedding
    return ["PixArtAlphaCombinedFlowEmbeddings.timestep_embedding: .type(t.type()) → .to(t.dtype)"]


REVIEWED = {"PixArtAlphaCombinedFlowEmbeddings.timestep_embedding": "fd3aa2ca24c28fb490b86b888e74d568cbd32041dc06e465270c2d574502624d"}
