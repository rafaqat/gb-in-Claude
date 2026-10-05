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


def tempo(beats) -> float | None:
    """BPM of a beat list. Not 60 / the median interval: beat_this puts beats on 20 ms frames, so that median is
    quantised (84.85 BPM reads 85.71). The mean of the regular intervals — within 15 % of the median, which leaves out
    gaps (a free intro, a break) and a beat caught on a swung off-beat — averages the frames out."""
    import numpy as np
    ibi = np.diff(np.asarray(beats, dtype=float))
    if len(ibi) == 0:
        return None
    regular = ibi[np.abs(ibi / np.median(ibi) - 1) <= 0.15]
    return 60.0 / float(np.mean(regular))
