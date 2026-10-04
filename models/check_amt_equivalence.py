# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Proof that the patched AMT sampler changes speed only: with greedy decoding, the shipped add_token and ours must
produce the same tokens for the first TOKENS steps of the benchmark infill. Prints one JSON line.
    models/.venv/bin/python models/check_amt_equivalence.py [device]"""
import json
import sys
import time

import torch
from anticipation import ops, sample
from anticipation.convert import midi_to_events

from gbmodels import amt
from gbmodels.amt_fast import PrefixCache, make_add_token

TOKENS = 200
CALLS = (TOKENS + 2) // 3  # add_token yields 3 tokens per call


class Enough(Exception):
    pass


def first_tokens(model, inputs, add_token):
    produced, shipped = [], sample.add_token

    def recording(*a, **k):
        out = add_token(*a, **k)
        produced.extend(out)
        if len(produced) >= TOKENS:
            raise Enough
        return out

    sample.add_token = recording
    t = time.perf_counter()
    try:
        sample.generate(model, inputs["start_s"], inputs["end_s"], inputs=inputs["events"], top_p=0.98)
    except Enough:
        pass
    finally:
        sample.add_token = shipped
    return produced[:TOKENS], time.perf_counter() - t


def main():
    device = sys.argv[1] if len(sys.argv) > 1 else "mps"
    dtype = sys.argv[2] if len(sys.argv) > 2 else "float32"  # the patched sampler's dtype; the shipped one is float32
    cfg = json.load(open("bench/inputs.json"))["amt"]
    events = midi_to_events(cfg["midi"])
    s, e = cfg["start_s"], cfg["end_s"]
    inputs = {"start_s": s, "end_s": e, "events": ops.sort(ops.clip(events, 0, s, clip_duration=False) + ops.clip(events, e, ops.max_time(events), clip_duration=False))}
    model = amt.load(device)["model"]

    real_multinomial = torch.multinomial
    torch.multinomial = lambda probs, n: torch.argmax(probs, dim=-1, keepdim=True)  # shipped sampler, made greedy
    try:
        shipped, t_shipped = first_tokens(model, inputs, sample.add_token)
    finally:
        torch.multinomial = real_multinomial
    if dtype != "float32":
        model = amt.load(device, dtype)["model"]
    cache = PrefixCache()
    ours, t_ours = first_tokens(model, inputs, make_add_token(cache, greedy=True))

    first_diff = next((i for i, (a, b) in enumerate(zip(shipped, ours)) if a != b), None)
    agree = sum(a == b for a, b in zip(shipped, ours)) / TOKENS
    print(json.dumps({"device": device, "dtype": dtype, "tokens": TOKENS, "agreement": round(agree, 4), "identical": shipped == ours, "first_difference_at": first_diff,
                      "shipped_s": round(t_shipped, 2), "patched_s": round(t_ours, 2), "speedup": round(t_shipped / t_ours, 2),
                      "cache_hits": cache.hits, "cache_misses": cache.misses}))


if __name__ == "__main__":
    main()
