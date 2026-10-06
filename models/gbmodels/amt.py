# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Anticipatory Music Transformer: infill a span of bars, keeping everything before and after it.
generate() treats the input events after `start` as anticipated controls, so the infill hears what comes next."""
from huggingface_hub import snapshot_download

REPO = "stanford-crfm/music-medium-800k"
REVISION = "93b6eb7e09bad33be6cb2ebd50ce5279cbfde7f6"  # pinned


def load(device: str, dtype: str = "float32"):
    import torch
    from transformers import AutoModelForCausalLM
    model = AutoModelForCausalLM.from_pretrained(snapshot_download(REPO, revision=REVISION), dtype=getattr(torch, dtype)).to(device).eval()
    return {"model": model, "device": device, "dtype": dtype}


def run(handle, inputs: dict) -> dict:
    """inputs: midi (path), start_s, end_s (the span to infill), seed."""
    import torch
    from anticipation import ops
    from anticipation.convert import midi_to_events
    from anticipation.sample import generate

    torch.manual_seed(inputs.get("seed", 1))
    events = midi_to_events(inputs["midi"])
    start, end = inputs["start_s"], inputs["end_s"]
    before = ops.clip(events, 0, start, clip_duration=False)
    after = ops.clip(events, end, ops.max_time(events), clip_duration=False)
    with torch.inference_mode():
        infill = generate(handle["model"], start, end, inputs=ops.sort(before + after), top_p=0.98)
    notes = ops.clip(infill, start, end, clip_duration=False)
    return {"notes_generated": len(notes) // 3, "instruments": sorted(ops.get_instruments(notes).keys())}
