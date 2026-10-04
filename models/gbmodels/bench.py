# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Benchmark worker: one model, one device, in its own process (so peak memory is this model's alone).
    python -m gbmodels.bench <model> <device> <inputs.json> <runs>
Prints one JSON line: load time, per-run wall times, peak RSS, peak Metal allocation, the last run's output."""
import importlib
import json
import sys
import time
import traceback

from gbmodels.common import mps_allocated_bytes, mps_fallback_on, rss_peak_bytes, sync
from gbmodels.registry import MODELS


def main() -> None:
    key, device, inputs_path, runs = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
    meta = MODELS[key]
    inputs = {**json.load(open(inputs_path))[meta.get("inputs", key)], **meta.get("run_options", {})}
    module = importlib.import_module(meta["module"])
    result = {"model": key, "device": device, "mps_cpu_fallback": mps_fallback_on()}
    try:
        t0 = time.perf_counter()
        handle = module.load(device, **meta.get("load_options", {}))
        sync(device)
        result["load_s"] = round(time.perf_counter() - t0, 3)
        if "providers" in handle:
            result["providers"] = handle["providers"]
        times, mps_peak = [], mps_allocated_bytes()
        for _ in range(runs):  # back to back, no pause: run 5 vs run 1 shows throttling
            t = time.perf_counter()
            out = module.run(handle, inputs)
            sync(device)
            times.append(round(time.perf_counter() - t, 3))
            mps_peak = max(mps_peak, mps_allocated_bytes())
        result.update(ok=True, run_s=times, output=out)
    except Exception as e:  # recorded, never raised: the orchestrator decides the next device
        result.update(ok=False, error=f"{type(e).__name__}: {e}"[:600], trace=traceback.format_exc()[-1500:])
    result["rss_peak_bytes"] = rss_peak_bytes()
    result["mps_peak_bytes"] = mps_allocated_bytes() if not result.get("ok") else mps_peak
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
