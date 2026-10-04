# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""beat_this: beat and downbeat times of a recording (in seconds), without a DBN post-processor."""


def load(device: str, float16: bool = False):
    from beat_this.inference import File2Beats
    return {"model": File2Beats(checkpoint_path="final0", device=device, dbn=False, float16=float16), "device": device}


def run(handle, inputs: dict) -> dict:
    """inputs: wav (path)."""
    import numpy as np
    import torch
    with torch.inference_mode():
        beats, downbeats = handle["model"](inputs["wav"])
    ibi = np.diff(beats)
    return {"beats": len(beats), "downbeats": len(downbeats),
            "bpm_median": round(60.0 / float(np.median(ibi)), 2) if len(ibi) else None}
