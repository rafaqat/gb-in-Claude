# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Shared pieces of the gb-mcp model sidecar (M8): device choice, timing, memory.

Every model module exposes the same two functions so M8's tools and the benchmark use one loader:
    load(device: str) -> handle            device is "mps" or "cpu" (ONNX models: "coreml" or "cpu")
    run(handle, inputs: dict) -> dict      one inference on the fixed inputs; returns a small JSON-able summary
"""
import os
import resource
import time

# Unified memory: Metal buffers are not all counted in RSS, so the benchmark records both.
def rss_peak_bytes() -> int:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss  # bytes on macOS


def mps_allocated_bytes() -> int:
    """The process's Metal memory. PyTorch's driver figure covers every Metal allocation of the process, MLX's
    included, so it is used whenever PyTorch is loaded; MLX's active + cached bytes otherwise. Never the sum."""
    import sys
    driver = _torch_mps_bytes() if "torch" in sys.modules else 0
    if driver:
        return driver
    try:
        if "mlx.core" in sys.modules:
            import mlx.core as mx
            return int(mx.get_active_memory() + mx.get_cache_memory())
    except Exception:
        pass
    return 0


def _torch_mps_bytes() -> int:
    try:
        import torch
        return int(torch.mps.driver_allocated_memory()) if torch.backends.mps.is_available() else 0
    except Exception:
        return 0


def sync(device: str) -> None:
    """Wait for queued GPU work, so wall time measures the work and not only its scheduling."""
    if device == "mps":
        import torch
        torch.mps.synchronize()


def mps_fallback_on() -> bool:
    return os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK") == "1"


def timed(fn, device: str):
    start = time.perf_counter()
    out = fn()
    sync(device)
    return out, time.perf_counter() - start
