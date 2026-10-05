# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""M12a speed switches: the same 116 s cover (same seed), twice per process, under each switch set.

    models/.venv/bin/python eval/m12a/speed_compare.py [out.json]

Per variant (gen/m12a/speed-<variant>/): wall time cold (first job in the process) and warm (second), the stage
times ACE-Step reports, and the audio's SNR against the baseline's first run (base speed-1). The baseline's own second
run gives the floor: the same settings and seed twice.
"""
import json, os, sys
import numpy as np, soundfile as sf

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WORKSPACE = os.environ.get("GB_MCP_WORKSPACE") or os.path.join(os.path.dirname(ROOT), "out")
GEN = os.path.join(WORKSPACE, "gen", "m12a")
VARIANTS = ("base", "vae16", "compile", "both")


def snr_db(ref: np.ndarray, x: np.ndarray) -> float | None:
    n = min(len(ref), len(x))
    err = np.sum((ref[:n] - x[:n]) ** 2)
    return None if err == 0 else round(float(10 * np.log10(np.sum(ref[:n] ** 2) / err)), 1)


def main(out_path: str | None) -> int:
    ref, _ = sf.read(os.path.join(GEN, "speed-base", "speed-1.wav"), always_2d=True)
    rows = []
    for v in VARIANTS:
        path = os.path.join(GEN, f"speed-{v}", "results.jsonl")
        if not os.path.exists(path):
            continue
        for r in (json.loads(l) for l in open(path)):
            tc = r.get("time_costs") or {}
            x, _ = sf.read(os.path.join(GEN, f"speed-{v}", f"{r['id']}.wav"), always_2d=True)
            snr = snr_db(ref, x)
            rows.append({"variant": v, "run": r["id"], "seconds": r["seconds"], "switches": r.get("switches"),
                         "dit_s": round(tc.get("dit_diffusion_time_cost", 0), 1), "vae_decode_s": round(tc.get("dit_vae_decode_time_cost", 0), 1),
                         "pipeline_s": round(tc.get("pipeline_total_time", 0), 1), "mlx_peak_gb": r.get("mlx_peak_gb"),
                         "snr_vs_base_db": "identical" if snr is None else snr})
    for row in rows:
        print(json.dumps(row))
    if out_path:
        with open(out_path, "w") as f:
            json.dump({"speed": rows}, f, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else None))
