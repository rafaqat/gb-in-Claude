# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Neighborhood attention in plain PyTorch (M13.13), so models built on NATTEN run on Apple GPUs (MPS) or the CPU
without NATTEN's compiled kernels (which need CUDA, or a CPU build that only old torch versions compile).

The four unfused ops all-in-one calls, with NATTEN's semantics (non-causal, odd kernel K, dilation d): positions split
into d groups (i mod d); in a group of length n the window of query i starts at clamp(i − K//2, 0, n − K) — at the
edges it shifts inward, it is never padded — and the relative-position bias of a neighbour is rpb[neighbour − i + K − 1]
(always 0 … 2K−2 because of the shift; NATTEN's get_pb_start). 2D applies the rule on each axis, neighbours row-major.
Layout as NATTEN's: query/key/value [B, H, L, D] (2D: [B, H, X, Y, D]); attention [B, H, L, K] ([B, H, X, Y, K*K]).
Tested against NATTEN 0.17.5 (models/tests/test_natten_mps.py, reference outputs in tests/fixtures).
"""
from functools import lru_cache

import torch


@lru_cache(maxsize=64)
def _axis(length: int, kernel: int, dilation: int) -> tuple[tuple[int, ...], tuple[int, ...]]:
    """Per position: its K neighbours (flattened [L*K]) and their bias indices (same shape)."""
    if kernel % 2 != 1:
        raise ValueError(f"kernel_size must be odd (got {kernel})")
    half = kernel // 2
    neighbours, bias = [], []
    for i in range(length):
        group, idx = i % dilation, i // dilation
        n = len(range(group, length, dilation))
        if n < kernel:
            raise ValueError(f"a dilation group has {n} positions, fewer than kernel_size {kernel} (length {length}, dilation {dilation})")
        start = min(max(idx - half, 0), n - kernel)
        for k in range(kernel):
            neighbours.append(group + (start + k) * dilation)
            bias.append(start + k - idx + kernel - 1)
    return tuple(neighbours), tuple(bias)


def _tables(length: int, kernel: int, dilation: int, device) -> tuple[torch.Tensor, torch.Tensor]:
    nb, rel = _axis(length, kernel, dilation)
    shape = (length, kernel)
    return (torch.tensor(nb, device=device).view(shape), torch.tensor(rel, device=device).view(shape))


def na1d_qk(query: torch.Tensor, key: torch.Tensor, kernel_size: int, dilation: int = 1, rpb: torch.Tensor | None = None) -> torch.Tensor:
    L = query.shape[-2]
    nb, rel = _tables(L, kernel_size, dilation, query.device)
    keys = key[:, :, nb]  # [B, H, L, K, D]
    attn = torch.einsum("bhld,bhlkd->bhlk", query, keys)
    if rpb is not None:
        attn = attn + rpb[:, rel].unsqueeze(0)  # rpb [H, 2K-1] → [1, H, L, K]
    return attn


def na1d_av(attn: torch.Tensor, value: torch.Tensor, kernel_size: int, dilation: int = 1) -> torch.Tensor:
    nb, _ = _tables(value.shape[-2], kernel_size, dilation, value.device)
    return torch.einsum("bhlk,bhlkd->bhld", attn, value[:, :, nb])


def _pair(v) -> tuple[int, int]:
    return (v, v) if isinstance(v, int) else (int(v[0]), int(v[1]))


def _tables2d(X: int, Y: int, kernel_size, dilation, device):
    (kx, ky), (dx, dy) = _pair(kernel_size), _pair(dilation)
    nbx, relx = _tables(X, kx, dx, device)
    nby, rely = _tables(Y, ky, dy, device)
    return (kx, ky), nbx, relx, nby, rely


def na2d_qk(query: torch.Tensor, key: torch.Tensor, kernel_size, dilation=1, rpb: torch.Tensor | None = None) -> torch.Tensor:
    B, H, X, Y, D = query.shape
    (kx, ky), nbx, relx, nby, rely = _tables2d(X, Y, kernel_size, dilation, query.device)
    # keys[b, h, x, y, i, j] = key[b, h, nbx[x, i], nby[y, j]]
    keys = key[:, :, nbx][:, :, :, :, nby]  # [B, H, X, kx, Y, ky, D]
    keys = keys.permute(0, 1, 2, 4, 3, 5, 6)  # [B, H, X, Y, kx, ky, D]
    attn = torch.einsum("bhxyd,bhxyijd->bhxyij", query, keys)
    if rpb is not None:  # rpb [H, 2kx-1, 2ky-1]
        bias = rpb[:, relx[:, None, :, None], rely[None, :, None, :]]  # [H, X, Y, kx, ky]
        attn = attn + bias.unsqueeze(0)
    return attn.reshape(B, H, X, Y, kx * ky)


def na2d_av(attn: torch.Tensor, value: torch.Tensor, kernel_size, dilation=1) -> torch.Tensor:
    B, H, X, Y, D = value.shape
    (kx, ky), nbx, _, nby, _ = _tables2d(X, Y, kernel_size, dilation, value.device)
    vals = value[:, :, nbx][:, :, :, :, nby].permute(0, 1, 2, 4, 3, 5, 6)  # [B, H, X, Y, kx, ky, D]
    return torch.einsum("bhxyij,bhxyijd->bhxyd", attn.reshape(B, H, X, Y, kx, ky), vals)


# NATTEN's pre-0.15 names, as all-in-one calls them: (query, key, rpb, kernel_size, dilation)
def natten1dqkrpb(query, key, rpb, kernel_size, dilation):
    return na1d_qk(query, key, kernel_size, dilation, rpb=rpb)


def natten1dav(attn, value, kernel_size, dilation):
    return na1d_av(attn, value, kernel_size, dilation)


def natten2dqkrpb(query, key, rpb, kernel_size, dilation):
    return na2d_qk(query, key, kernel_size, dilation, rpb=rpb)


def natten2dav(attn, value, kernel_size, dilation):
    return na2d_av(attn, value, kernel_size, dilation)
