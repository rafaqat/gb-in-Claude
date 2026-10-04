# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""MLX port check: greedy first 200 tokens of the MLX engine vs the shipped PyTorch sampler (float32, MPS).
    models/.venv/bin/python models/check_amt_mlx.py [float16|float32]"""
import json, sys, time
import torch
from anticipation import ops, sample
from anticipation.convert import midi_to_events
from gbmodels import amt, amt_mlx
from gbmodels.amt_fast import make_add_token
from check_amt_equivalence import TOKENS, first_tokens

dtype = sys.argv[1] if len(sys.argv) > 1 else "float16"
cfg = json.load(open("bench/inputs.json"))["amt"]
ev = midi_to_events(cfg["midi"]); s, e = cfg["start_s"], cfg["end_s"]
inputs = {"start_s": s, "end_s": e, "events": ops.sort(ops.clip(ev, 0, s, clip_duration=False) + ops.clip(ev, e, ops.max_time(ev), clip_duration=False))}
real = torch.multinomial
torch.multinomial = lambda probs, n: torch.argmax(probs, dim=-1, keepdim=True)
try:
    shipped, t_shipped = first_tokens(amt.load("mps")["model"], inputs, sample.add_token)
finally:
    torch.multinomial = real
h = amt_mlx.load("mlx", dtype)
cache = amt_mlx.MLXPrefixCache(h["model"])
ours, t_ours = first_tokens(amt_mlx._DeviceShim(), inputs, make_add_token(cache, greedy=True))
diff = next((i for i, (a, b) in enumerate(zip(shipped, ours)) if a != b), None)
print(json.dumps({"engine": "mlx", "dtype": dtype, "tokens": TOKENS, "agreement": round(sum(a == b for a, b in zip(shipped, ours)) / TOKENS, 4),
                  "identical": shipped == ours, "first_difference_at": diff, "shipped_s": round(t_shipped, 2), "mlx_s": round(t_ours, 2),
                  "speedup": round(t_shipped / t_ours, 2), "cache_hits": cache.hits, "cache_misses": cache.misses}))
