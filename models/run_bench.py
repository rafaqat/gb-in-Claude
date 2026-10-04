# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Benchmark day (M8): every model on the M4 Air — MPS first, then MPS with CPU fallback, then CPU.
Writes bench/results.json and bench/results.md. Thresholds are flagged, never decided.
    models/.venv/bin/python models/run_bench.py [model ...]"""
import json
import os
import platform
import statistics
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from gbmodels.registry import MODELS, THRESHOLDS  # noqa: E402

RUNS = 5
OUT = os.path.join(HERE, "bench")
INPUTS = os.path.join(OUT, "inputs.json")
AUDIO_MIN = 1.0  # the analysis input is 60 s


def attempts(kind: str):
    if kind == "onnx":
        return [("coreml", {}), ("cpu", {})]
    if kind == "mlx":
        return [("mlx", {})]
    return [("mps", {}), ("mps", {"PYTORCH_ENABLE_MPS_FALLBACK": "1"}), ("cpu", {})]


def run_one(key: str) -> dict:
    meta, tries = MODELS[key], []
    for device, env in attempts(meta["kind"]):
        py = os.path.join(HERE, meta["venv"], "bin", "python")
        proc = subprocess.run([py, "-m", "gbmodels.bench", key, device, INPUTS, str(RUNS)], cwd=HERE,
                              env={**os.environ, **env, "TOKENIZERS_PARALLELISM": "false"},
                              capture_output=True, text=True, timeout=3600)
        line = next((l for l in reversed(proc.stdout.splitlines()) if l.startswith("{")), None)
        res = json.loads(line) if line else {"ok": False, "device": device, "error": (proc.stderr or "no output")[-600:]}
        res["device_label"] = device + ("+cpu-fallback" if env else "")
        tries.append(res)
        print(f"  {key} on {res['device_label']}: {'ok' if res.get('ok') else 'FAILED — ' + res.get('error', '')[:160]}", flush=True)
        if res.get("ok"):
            break
    best = tries[-1]
    best["attempts"] = [{"device": t["device_label"], "ok": t.get("ok", False), "error": t.get("error")} for t in tries]
    return best


def flags(key: str, r: dict) -> list:
    if not r.get("ok"):
        return ["did not run"]
    out, th = [], THRESHOLDS[key]
    if "NaN" in json.dumps(r.get("output")) or "Infinity" in json.dumps(r.get("output")):
        out.append("output has NaN/Inf")
    # run 1 includes warm-up (MPS kernels, Core ML compile): judge the warm runs, report the cold one separately
    warm = statistics.median(r["run_s"][1:]) if len(r["run_s"]) > 1 else r["run_s"][0]
    limit = th.get("max_run_s") or th["max_run_s_per_audio_min"] * AUDIO_MIN
    if warm > limit:
        out.append(f"warm run {warm:.1f}s > {limit:.0f}s")
    if r["run_s"][0] > limit:
        r["cold_start_warning"] = f"cold first run {r['run_s'][0]:.1f}s > {limit:.0f}s (warm-up; load once and keep it)"
    peak_gb = (r["rss_peak_bytes"] + r["mps_peak_bytes"]) / 1e9
    if peak_gb > THRESHOLDS["_all"]["max_peak_gb"]:
        out.append(f"peak {peak_gb:.1f} GB > {THRESHOLDS['_all']['max_peak_gb']:.0f} GB")
    return out


def main() -> None:
    keys = sys.argv[1:] or list(MODELS)
    results = {}
    if os.path.exists(os.path.join(OUT, "results.json")):
        results = json.load(open(os.path.join(OUT, "results.json")))["models"]
    for key in keys:
        print(f"benchmarking {key} …", flush=True)
        r = run_one(key)
        r["flags"] = flags(key, r)
        r["go"] = r.get("ok", False) and not r["flags"]
        results[key] = {**MODELS[key], **r}
    doc = {"machine": {"chip": subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip(),
                       "memory_gb": int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout) // 2**30,
                       "macos": platform.mac_ver()[0]},
           "runs_per_model": RUNS, "when": time.strftime("%Y-%m-%d %H:%M"), "thresholds": THRESHOLDS, "models": results}
    json.dump(doc, open(os.path.join(OUT, "results.json"), "w"), indent=2)
    open(os.path.join(OUT, "results.md"), "w").write(table(doc))
    print(table(doc))


def table(doc: dict) -> str:
    rows = ["| Model | Device | Load s | Cold run 1 s | Median run s (2–5) | Worst run s (2–5) | Peak memory GB (RSS + Metal) | Run 5 / run 1 | Run 5 / run 2 (throttle) | Go? |",
            "|---|---|---|---|---|---|---|---|---|---|"]
    for key, r in doc["models"].items():
        if not r.get("ok"):
            rows.append(f"| {r['name']} | {r.get('device_label', '-')} | – | – | – | – | – | – | – | no-go: {r.get('error', '')[:80]} |")
            continue
        runs = r["run_s"]
        peak = f"{r['rss_peak_bytes'] / 1e9:.1f} + {r['mps_peak_bytes'] / 1e9:.1f}"
        go = "go" if r["go"] else "no-go: " + "; ".join(r["flags"])
        warm = runs[1:] or runs
        rows.append(f"| {r['name']} | {r['device_label']} | {r['load_s']:.1f} | {runs[0]:.2f} | {statistics.median(warm):.2f} | {max(warm):.2f} | "
                    f"{peak} | {runs[-1] / runs[0]:.2f} | {runs[-1] / runs[1]:.2f} | {go} |")
    m = doc["machine"]
    return f"# Model benchmark — {m['chip']}, {m['memory_gb']} GB, macOS {m['macos']} ({doc['when']}, {doc['runs_per_model']} back-to-back runs)\n\n" + "\n".join(rows) + "\n"


if __name__ == "__main__":
    main()
