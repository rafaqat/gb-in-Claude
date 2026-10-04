# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""M10: AMT infill for gb_song infill. The MLX engine (exact window by default; "fast" = the chunked window), limited to
the instruments of the tracks being rewritten. Returns the generated notes inside the span, in seconds."""
from gbmodels import amt_mlx


def load(device: str = "mlx", dtype: str = "float16"):
    return amt_mlx.load("mlx", dtype)


def run(handle, inputs: dict) -> dict:
    """inputs: midi (path), start_s, end_s, instruments (GM programs to generate; 128 = drums), mode exact|fast, seed."""
    import torch
    from anticipation import ops
    from anticipation.convert import midi_to_events
    from anticipation.vocab import DUR_OFFSET, NOTE_OFFSET, TIME_OFFSET, TIME_RESOLUTION

    torch.manual_seed(int(inputs.get("seed", 1)))
    events = midi_to_events(inputs["midi"])
    start, end = float(inputs["start_s"]), float(inputs["end_s"])
    wanted = set(int(i) for i in inputs["instruments"])
    # context = the song before and after the span. Keeping the other instruments' notes inside the span as
    # anticipated controls made the model write one note and jump past the span (M10), so the span is
    # left empty: the model hears the song around the section, not the other tracks within it.
    before = ops.clip(events, 0, start, clip_duration=False)
    after = ops.clip(events, end, ops.max_time(events), clip_duration=False)
    chunk = 128 if inputs.get("mode") == "fast" else 0
    infill, cache = amt_mlx.generate_mlx(handle, start, end, inputs=ops.sort(before + after), top_p=0.98,
                                         window_chunk=chunk, instruments=sorted(wanted))
    notes = []
    span = ops.clip(infill, start, end, clip_duration=False)
    for i in range(0, len(span), 3):
        t, d, n = span[i] - TIME_OFFSET, span[i + 1] - DUR_OFFSET, span[i + 2] - NOTE_OFFSET
        instr, pitch = n // 128, n % 128
        if instr in wanted:
            notes.append({"instrument": instr, "pitch": pitch, "start_s": round(t / TIME_RESOLUTION, 3),
                          "dur_s": round(d / TIME_RESOLUTION, 3)})
    return {"notes": notes, "mode": inputs.get("mode", "exact"), "cache_misses": cache.misses}
