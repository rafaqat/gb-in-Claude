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
    gaps (a free intro, a break) and a beat caught on a swung off-beat — averages the frames out. Hard swing counted on
    every 8th has no regular intervals; there the neighbouring pairs (short + long) give the step."""
    import numpy as np
    ibi = np.diff(np.asarray(beats, dtype=float))
    if len(ibi) == 0:
        return None
    near = lambda v: np.abs(v / np.median(v) - 1) <= 0.15  # noqa: E731
    regular = ibi[near(ibi)]
    if len(regular) < 0.75 * len(ibi) and len(ibi) >= 4:
        # swing counted on every 8th: the intervals alternate short/long, but each neighbouring pair is one beat apart.
        # (A tracker that switches to half time also leaves few regular intervals, but its pairs do not add up.)
        pairs = ibi[:-1] + ibi[1:]
        steady = pairs[near(pairs)]
        if len(steady) >= 0.75 * len(pairs):
            return 120.0 / float(np.mean(steady))
    return 60.0 / float(np.mean(regular))
