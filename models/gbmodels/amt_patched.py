# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""AMT with the patched sampler (gbmodels.amt_fast): same model, same inputs and sampling rules as gbmodels.amt."""
from gbmodels.amt import load  # noqa: F401 — the same loader


def run(handle, inputs: dict) -> dict:
    import torch
    from anticipation import ops
    from anticipation.convert import midi_to_events
    from gbmodels.amt_fast import generate_fast

    torch.manual_seed(inputs.get("seed", 1))
    events = midi_to_events(inputs["midi"])
    start, end = inputs["start_s"], inputs["end_s"]
    before = ops.clip(events, 0, start, clip_duration=False)
    after = ops.clip(events, end, ops.max_time(events), clip_duration=False)
    infill, cache = generate_fast(handle["model"], start, end, inputs=ops.sort(before + after), top_p=0.98,
                                  instruments=sorted(ops.get_instruments(events)) if inputs.get("song_instruments_only", True) else None,
                                  window_chunk=inputs.get("window_chunk", 0))
    notes = ops.clip(infill, start, end, clip_duration=False)
    return {"notes_generated": len(notes) // 3, "instruments": sorted(ops.get_instruments(notes).keys()),
            "cache_hits": cache.hits, "cache_misses": cache.misses}
