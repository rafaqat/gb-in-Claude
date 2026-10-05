# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""ACE-Step 1.5 turbo as a gb_generate engine (M12b). Runs in ACE-Step's own venv (a sidecar with
GBMODELS_ENV=ace-step): the authors' code at a reviewed commit (checked before import), the weights at a reviewed
revision, offline. Measured on this Mac (eval/m12a): a 116 s cover in about 90 s warm; 30 s text-to-music 50–100 s
with the 1.7B LM. float16 VAE (same-latent SNR 55 dB, −3.7 GB); the LM loads only for `text`.
Tasks: cover (a source WAV re-sung / re-played to a caption and lyrics; strength = how closely it keeps the source)
and text (music from a caption, bpm, key, length). Output: 16-bit 48 kHz WAV at `out`, never overwritten."""
import os
import shutil
import sys
import tempfile

ENGINE_HOME = os.environ.get("GB_MCP_ENGINE_HOME") or os.path.expanduser("~/Library/Caches/gb-mcp")  # scripts/install-engines.sh
CODE = os.environ.get("GB_MCP_ACESTEP") or os.path.join(ENGINE_HOME, "ace-step")
PINNED_COMMIT = "ca1e85fe9430179831e6bc6be790c332190a3866"  # github.com/ace-step/ACE-Step-1.5, MIT
WEIGHTS_REVISION = "19671f406d603126926c1b7e2adc169acbcade22"  # ACE-Step/Ace-Step1.5, MIT
DIT, LM = "acestep-v15-turbo", "acestep-5Hz-lm-1.7B"
TASKS = ("cover", "text")
INSTRUMENTAL = "[Instrumental]"


def _number(inputs: dict, key: str, lo: float, hi: float, default=None, integer: bool = False):
    value = inputs.get(key, default)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not lo <= value <= hi or (integer and int(value) != value):
        raise ValueError(f"{key} must be {'an integer' if integer else 'a number'} from {lo} to {hi}")
    return int(value) if integer else float(value)


def _out(inputs: dict) -> str:
    out = inputs.get("out")
    if not isinstance(out, str) or not os.path.isabs(out) or not out.endswith(".wav"):
        raise ValueError("out must be an absolute .wav path")
    if os.path.lexists(out):
        raise FileExistsError(f"{os.path.basename(out)} already exists; nothing written")
    return out


def validate(inputs: dict) -> dict:
    task = inputs.get("task")
    if task not in TASKS:
        raise ValueError(f"task must be one of {', '.join(TASKS)}")
    caption = inputs.get("caption")
    if not isinstance(caption, str) or not caption.strip() or len(caption) > 512:
        raise ValueError("caption must be 1–512 characters")
    lyrics = inputs.get("lyrics", INSTRUMENTAL)
    if not isinstance(lyrics, str) or not lyrics.strip() or len(lyrics) > 4096:
        raise ValueError("lyrics must be 1–4096 characters ([Instrumental] for none)")
    v = {"task": task, "caption": caption.strip(), "lyrics": lyrics, "seed": _number(inputs, "seed", 0, 2**31 - 1, 42, True),
         "bpm": _number(inputs, "bpm", 30, 300, integer=True), "keyscale": str(inputs.get("key") or ""),
         "duration": _number(inputs, "duration", 10, 600), "vocal_language": inputs.get("vocal_language") or ("unknown" if lyrics == INSTRUMENTAL else "en")}
    if task == "cover":
        src = inputs.get("src")
        if not isinstance(src, str) or not os.path.isabs(src) or not os.path.isfile(src):
            raise ValueError("src must be an existing absolute audio path (the song to cover)")
        v.update(src=src, strength=_number(inputs, "strength", 0.0, 1.0, 0.7), thinking=False)  # cover does not use the LM
    else:
        if v["duration"] is None:
            raise ValueError("duration (10–600 s) is required for text")
        v.update(src=None, strength=1.0, thinking=bool(inputs.get("thinking", True)))
    v["out"] = _out(inputs)
    return v


def load(device: str, **_) -> dict:
    from .pinned import verify_checkout
    verify_checkout(CODE, PINNED_COMMIT, "ACE-Step 1.5", install_hint="see gb://knowledge/generate")
    os.environ["HF_HUB_OFFLINE"] = "1"  # the reviewed weights only; nothing is fetched
    os.environ["ACESTEP_MLX_VAE_FP16"] = "1"
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    sys.path.insert(0, CODE)
    from acestep.handler import AceStepHandler
    dit = AceStepHandler()
    status, ok = dit.initialize_service(project_root=CODE, config_path=DIT, device="mps")
    if not ok:
        raise RuntimeError(f"ACE-Step DiT did not load: {status}")
    return {"dit": dit, "llm": None}


def _llm(handle: dict):
    if handle["llm"] is None:
        from acestep.llm_inference import LLMHandler
        llm = LLMHandler()
        status, ok = llm.initialize(checkpoint_dir=os.path.join(CODE, "checkpoints"), lm_model_path=LM, backend="mlx", device="mps")
        if not ok:
            raise RuntimeError(f"ACE-Step LM did not load: {status}")
        handle["llm"] = llm
    return handle["llm"]


def run(handle: dict, inputs: dict) -> dict:
    v = validate(inputs)
    from acestep.inference import GenerationConfig, GenerationParams, generate_music
    llm = _llm(handle) if v["thinking"] else None
    params = GenerationParams(task_type=v["task"] if v["task"] == "cover" else "text2music", caption=v["caption"], lyrics=v["lyrics"],
                              instrumental=v["lyrics"] == INSTRUMENTAL, bpm=v["bpm"], keyscale=v["keyscale"], timesignature="4",
                              vocal_language=v["vocal_language"], duration=v["duration"] if v["duration"] is not None else -1.0,
                              inference_steps=8, shift=3.0, infer_method="ode", seed=v["seed"], thinking=v["thinking"],
                              src_audio=v["src"], audio_cover_strength=v["strength"])
    config = GenerationConfig(batch_size=1, use_random_seed=False, seeds=[v["seed"]], audio_format="wav")
    raw = tempfile.mkdtemp(prefix=".ace-step-", dir=os.path.dirname(v["out"]))
    try:
        result = generate_music(handle["dit"], llm, params, config, save_dir=raw)
        if not result.success:
            raise RuntimeError(f"ACE-Step failed: {str(result.error)[:300]}")
        audio = result.audios[0]
        os.link(audio["path"], v["out"])  # fails rather than overwrite
    finally:
        shutil.rmtree(raw, ignore_errors=True)
    costs = (result.extra_outputs or {}).get("time_costs") or {}
    return {"engine": "ace_step", "task": v["task"], "path": v["out"], "rate": audio["sample_rate"],
            "seconds": round(audio["tensor"].shape[-1] / audio["sample_rate"], 3), "seed": v["seed"],
            "strength": v["strength"] if v["task"] == "cover" else None, "lm": LM if llm else None,
            "time_costs": {k: round(c, 2) for k, c in costs.items() if isinstance(c, (int, float))},
            "code": PINNED_COMMIT, "weights": WEIGHTS_REVISION}
