# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""M12a benchmark, part 1: run ACE-Step 1.5 jobs on this Mac and record time, memory and thermal state per job.

    ~/Library/Caches/gb-mcp/ace-step/.venv/bin/python eval/m12a/generate.py eval/m12a/plan.json [job-id …]

Runs in ACE-Step's own venv (its locked torch / MLX), not in models/.venv. The authors' code is imported, so it must
be the reviewed commit with a clean tree; the weights are the reviewed Hugging Face revision, and the run is offline
(HF_HUB_OFFLINE=1): nothing is fetched. Outputs go to <workspace>/gen/m12a/<job id>.wav and one JSON line per job in
results.jsonl; a job whose WAV exists is skipped (a run can resume), and nothing is overwritten. Part 2
(eval/m12a/measure.py, in models/.venv) measures the outputs.
"""
import json, os, resource, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # eval/: _paths
from _paths import ROOT, workspace  # noqa: E402
WORKSPACE = workspace()
ACE = os.environ.get("GB_MCP_ACESTEP", os.path.expanduser("~/Library/Caches/gb-mcp/ace-step"))
PINNED_COMMIT = "ca1e85fe9430179831e6bc6be790c332190a3866"  # github.com/ace-step/ACE-Step-1.5, MIT, reviewed 2026-10-05
WEIGHTS = ("ACE-Step/Ace-Step1.5", "19671f406d603126926c1b7e2adc169acbcade22")  # MIT; turbo DiT, 1.7B LM, VAE, text encoder
DIT = "acestep-v15-turbo"
LM = "acestep-5Hz-lm-1.7B"
# speed switches (M12a speed test): a separate output folder, DiT mx.compile; ACESTEP_MLX_VAE_FP16=1 is ACE-Step's own
TAG = os.environ.get("GB_M12A_TAG", "")
COMPILE = os.environ.get("GB_M12A_COMPILE") == "1"
OUT = os.path.join(WORKSPACE, "gen", "m12a", *([TAG] if TAG else []))


def verify_code() -> None:
    head = subprocess.run(["git", "-C", ACE, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    if head != PINNED_COMMIT:
        sys.exit(f"ACE-Step checkout is {head[:12] or 'missing'}, not the reviewed commit {PINNED_COMMIT[:12]}")
    dirty = subprocess.run(["git", "-C", ACE, "status", "--porcelain"], capture_output=True, text=True).stdout.strip()
    if dirty:
        sys.exit(f"ACE-Step checkout has local changes; refusing to import it:\n{dirty[:500]}")


def thermal() -> str:
    """macOS thermal warning level as pmset reports it (no warning = the Air is not throttling yet)."""
    out = subprocess.run(["pmset", "-g", "therm"], capture_output=True, text=True).stdout
    lines = [l.strip() for l in out.splitlines() if l.strip() and not l.startswith("Note:")]
    return "; ".join(lines)[:200]


def main(plan_path: str, only: list[str]) -> int:
    verify_code()
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    sys.path.insert(0, ACE)
    import mlx.core as mx
    import torch
    from acestep.handler import AceStepHandler
    from acestep.llm_inference import LLMHandler
    from acestep.inference import GenerationConfig, GenerationParams, generate_music

    with open(plan_path) as f:
        jobs = [j for j in json.load(f)[os.environ.get("GB_M12A_PLAN_KEY", "jobs")] if not only or j["id"] in only]
    os.makedirs(OUT, exist_ok=True)
    todo = [j for j in jobs if not os.path.lexists(os.path.join(OUT, f"{j['id']}.wav"))]
    print(f"{len(todo)} of {len(jobs)} jobs to run; {thermal()}", flush=True)
    if not todo:
        return 0

    t0 = time.time()
    dit = AceStepHandler()
    status, ok = dit.initialize_service(project_root=ACE, config_path=DIT, device="mps", compile_model=COMPILE)
    if not ok:
        sys.exit(f"DiT did not load: {status}")
    llm = None
    if any(j.get("thinking") for j in todo):
        llm = LLMHandler()
        status, ok = llm.initialize(checkpoint_dir=os.path.join(ACE, "checkpoints"), lm_model_path=LM, backend="mlx", device="mps")
        if not ok:
            sys.exit(f"LM did not load: {status}")
    load_s = time.time() - t0
    print(f"models loaded in {load_s:.1f} s (LM: {'yes' if llm else 'no'})", flush=True)

    for job in todo:
        params = GenerationParams(
            task_type=job["task"], caption=job["caption"], lyrics=job.get("lyrics", "[Instrumental]"),
            instrumental=job.get("lyrics", "[Instrumental]") == "[Instrumental]",
            bpm=job.get("bpm"), keyscale=job.get("keyscale", ""), timesignature=job.get("timesignature", "4"),
            vocal_language=job.get("vocal_language", "unknown"), duration=job.get("duration", -1.0),
            inference_steps=8, shift=3.0, infer_method="ode", seed=job["seed"], thinking=bool(job.get("thinking")),
            src_audio=os.path.join(WORKSPACE, job["src"]) if job.get("src") else None,
            audio_cover_strength=job.get("strength", 1.0),
        )
        config = GenerationConfig(batch_size=1, use_random_seed=False, seeds=[job["seed"]], audio_format="wav")
        raw = os.path.join(OUT, "_raw", job["id"])
        os.makedirs(raw, exist_ok=True)
        mx.reset_peak_memory()
        before = thermal()
        start = time.time()
        result = generate_music(dit, llm, params, config, save_dir=raw)
        seconds = time.time() - start
        row = {"id": job["id"], "task": job["task"], "ok": bool(result.success), "seconds": round(seconds, 1),
               "mlx_peak_gb": round(mx.get_peak_memory() / 1e9, 2),
               "mps_allocated_gb": round(torch.mps.driver_allocated_memory() / 1e9, 2),
               "rss_peak_gb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e9, 2),
               "thermal_before": before, "thermal_after": thermal(), "job": job,
               "dit": DIT, "lm": LM if llm else None, "code": PINNED_COMMIT, "weights": WEIGHTS[1],
               "switches": {"dit_compile": COMPILE, "vae_fp16": os.environ.get("ACESTEP_MLX_VAE_FP16", "0") == "1"}}
        if result.success:
            audio = result.audios[0]
            final = os.path.join(OUT, f"{job['id']}.wav")
            os.link(audio["path"], final)  # fails rather than overwrite
            meta = (result.extra_outputs or {}).get("lm_metadata") or {}
            row.update({"path": os.path.relpath(final, WORKSPACE), "sample_rate": audio.get("sample_rate"),
                        "audio_seconds": round(audio["tensor"].shape[-1] / audio["sample_rate"], 2),
                        "time_costs": (result.extra_outputs or {}).get("time_costs"),
                        "lm_metadata": {k: v for k, v in meta.items() if isinstance(v, (str, int, float, bool))} if isinstance(meta, dict) else None})
        else:
            row["error"] = str(result.error)[:500]
        with open(os.path.join(OUT, "results.jsonl"), "a") as f:
            f.write(json.dumps(row, default=str) + "\n")
        print(f"{job['id']}: {'ok' if result.success else 'FAILED'} {seconds:.1f} s for {row.get('audio_seconds', '?')} s audio; "
              f"MLX peak {row['mlx_peak_gb']} GB, MPS {row['mps_allocated_gb']} GB, RSS peak {row['rss_peak_gb']} GB", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2:]))
