# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Model weights the sidecar trusts: every file pinned to a revision and a
SHA-256, checked before it is loaded, and loaded without pickle code (torch.load weights_only=True). A file that does
not match is refused with a message that says how to get the pinned one again; it is never loaded."""
import hashlib


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 22), b""):
            h.update(block)
    return h.hexdigest()


def verify(path: str, sha256: str) -> str:
    got = sha256_file(path)
    if got != sha256:
        raise ValueError(f"{path.rsplit('/', 1)[-1]} is not the pinned weights (sha256 {got[:12]}…, expected "
                         f"{sha256[:12]}…): delete it and let gb-mcp download the pinned file again")
    return path


def safe_torch_load(path: str, numpy_scalars: bool = False):
    """torch.load with weights_only=True: tensors, containers and plain values only, never pickle code. numpy_scalars
    also allows numpy's scalar and dtype types (data only — the LAION CLAP checkpoint stores its epoch as one)."""
    import torch
    if not numpy_scalars:
        return torch.load(path, map_location="cpu", weights_only=True)
    import numpy as np
    allowed = [np.core.multiarray.scalar, np.dtype, np.dtypes.Float64DType, np.dtypes.Float32DType, np.dtypes.Int64DType]
    with torch.serialization.safe_globals(allowed):
        return torch.load(path, map_location="cpu", weights_only=True)
