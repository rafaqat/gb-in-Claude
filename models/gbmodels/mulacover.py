# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""MuLaCover as a gb_generate engine (M12b): vocals that follow a song's own melody and chords. Runs in MuLaCover's
venv (a sidecar with GBMODELS_ENV=mulacover): the authors' code at a reviewed commit (checked before import) for the
prompt (lyrics, style tags → Qwen embedding, MIDI → rolls) and the codec (PyTorch on MPS, one in-memory shim); the
token generator is our MLX port (models/mulacover_mlx, 3× the authors' speed here). Offline. Measured (eval/m12d):
30 s of audio ≈ 55 s tokens + 65–85 s codec. MuLaCover takes no tempo from MIDI and chooses its own (its symbolic
condition is in sixteenth notes, symbolic.py: "Tempo is metadata"): gb_generate measures the result and re-times it to
input_bpm (M13.15); range_seconds is the bar range's length at that tempo. Weights AND outputs: CC BY-NC 4.0
(non-commercial)."""
import os
import tempfile

ENGINE_HOME = os.environ.get("GB_MCP_ENGINE_HOME") or os.path.expanduser("~/Library/Caches/gb-mcp")  # scripts/install-engines.sh
CODE = os.environ.get("GB_MCP_MULACOVER") or os.path.join(ENGINE_HOME, "mulacover")
CKPT = os.environ.get("GB_MCP_MULACOVER_CKPT") or os.path.join(ENGINE_HOME, "mulacover-ckpt")
PINNED_COMMIT = "f01810c715a58ddc3d5a795c562fe5d8fbd56b24"  # github.com/HeartMuLa/MuLaCover, Apache-2.0
# the reviewed weight revisions, one folder each under CKPT (scripts/install-engines.sh downloads them)
WEIGHTS = {
    "MuLaCover": ("HeartMuLa/MuLaCover", "bbbaef2b31835c2ef5172ff528dbe325230d46fb"),  # CC BY-NC 4.0
    "HeartCodec-oss": ("HeartMuLa/HeartCodec-oss-20260123", "f889dab0532cfa4bf459f2a3367eb6d346b8eeda"),  # Apache-2.0
    "Qwen3-Embedding-0.6B": ("Qwen/Qwen3-Embedding-0.6B", "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"),  # Apache-2.0
}
MAX_SECONDS = 300  # the pipeline's own limit (prompt + frames within an 8192-token context)
CFG, TEMPERATURE, TOPK = 1.5, 1.0, 250
FRAME_S = 0.08


def _names(inputs: dict, key: str, required: bool):
    value = inputs.get(key)
    if value is None and not required:
        return None
    if not isinstance(value, list) or not value or not all(isinstance(n, str) and n.strip() for n in value):
        raise ValueError(f"{key} must be a non-empty list of track names")
    return value


def _text(inputs: dict, key: str, limit: int) -> str:
    value = inputs.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f"{key} must be 1–{limit} characters")
    return value


def validate(inputs: dict) -> dict:
    midi = inputs.get("midi")
    if not isinstance(midi, str) or not os.path.isabs(midi) or not midi.endswith(".mid") or not os.path.isfile(midi):
        raise ValueError("midi must be an existing absolute .mid path (the song)")
    start_bar, bars, seed = inputs.get("start_bar", 1), inputs.get("bars"), inputs.get("seed", 42)
    if isinstance(start_bar, bool) or not isinstance(start_bar, int) or start_bar < 1:
        raise ValueError("start_bar must be an integer ≥ 1")
    if bars is not None and (isinstance(bars, bool) or not isinstance(bars, int) or bars < 1):
        raise ValueError("bars must be an integer ≥ 1 (or left out for the rest of the song)")
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2**31:
        raise ValueError("seed must be an integer from 0 to 2^31 − 1")
    out = inputs.get("out")
    if not isinstance(out, str) or not os.path.isabs(out) or not out.endswith(".wav"):
        raise ValueError("out must be an absolute .wav path")
    if os.path.lexists(out):
        raise FileExistsError(f"{os.path.basename(out)} already exists; nothing written")
    return {"midi": midi, "melody": _names(inputs, "melody", True), "chords": _names(inputs, "chords", True),
            "drums": _names(inputs, "drums", False), "start_bar": start_bar, "bars": bars, "seed": seed,
            "lyrics": _text(inputs, "lyrics", 4096), "tags": _text(inputs, "tags", 512), "out": out}


def load(device: str, **_) -> dict:
    from .pinned import verify_checkout
    verify_checkout(CODE, PINNED_COMMIT, "MuLaCover", install_hint="see gb://knowledge/generate")
    os.environ["HF_HUB_OFFLINE"] = "1"
    import torch
    from mulacover import MuLaCoverGenPipeline
    from . import mulacover_shims
    shims = mulacover_shims.apply()
    pipe = MuLaCoverGenPipeline.from_pretrained(CKPT, device=torch.device("mps"), lazy_load=True,  # CKPT: a local folder, pinned at install
                                                dtype={"mulacover": torch.bfloat16, "codec": torch.float32, "qwen": torch.float32, "transcriptor": torch.float32})
    from mulacover_mlx.model import MuLaCoverDims, MuLaCoverMLX, load_checkpoint
    model = MuLaCoverMLX(MuLaCoverDims.from_config(os.path.join(CKPT, "MuLaCover", "config.json")))
    load_checkpoint(model, os.path.join(CKPT, "MuLaCover"))
    return {"pipe": pipe, "model": model, "shims": shims}


def run(handle: dict, inputs: dict) -> dict:
    v = validate(inputs)
    import mlx.core as mx
    import numpy as np
    import soundfile as sf
    import torch
    from mulacover_mlx.generate import generate
    from .mulacover_inputs import build
    work = v["out"][: -len(".wav")] + "-inputs"
    built = build(v["midi"], work, melody=v["melody"], chords=v["chords"], drums=v["drums"], start_bar=v["start_bar"], bars=v["bars"])
    if built["seconds"] > MAX_SECONDS:
        raise ValueError(f"{built['bars']} bars last {built['seconds']:.0f} s at the song's first tempo; MuLaCover makes at most "
                         f"{MAX_SECONDS} s — choose a shorter range (start_bar, bars)")
    pipe, model = handle["pipe"], handle["model"]
    tmp = tempfile.mkstemp(suffix=".wav", prefix=".mulacover-", dir=os.path.dirname(v["out"]))[1]
    os.unlink(tmp)  # the codec writes it; then it is linked to `out`
    max_ms = int((built["seconds"] + 2.0) * 1000)
    pre, _, post = pipe._sanitize_parameters(save_path=tmp, max_audio_length_ms=max_ms, cfg_scale=CFG, temperature=TEMPERATURE, topk=TOPK)
    files = {"melody_midi": built["melody"], "chord_midi": built["chord"], "lyrics": v["lyrics"], "tags": v["tags"]}
    if built["drums"]:
        files["drum_midi"] = built["drums"]
    try:
        model_inputs = pipe.preprocess(files, **pre)
        mx.random.seed(v["seed"])
        frames = generate(model, model_inputs, max_frames=max_ms // 80, temperature=TEMPERATURE, topk=TOPK, cfg_scale=CFG,
                          eos_id=pipe.config.audio_eos_id, empty_id=pipe.config.empty_id, dtype=mx.bfloat16)
        mx.clear_cache()
        pipe.postprocess({"frames": torch.from_numpy(frames.astype(np.int64))}, **post)
        os.link(tmp, v["out"])  # fails rather than overwrite
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    info = sf.info(v["out"])
    return {"engine": "mulacover", "task": "cover", "path": v["out"], "rate": info.samplerate, "seconds": round(info.frames / info.samplerate, 3),
            "frames": int(frames.shape[1]), "bars": built["bars"], "input_bpm": built["bpm"], "range_seconds": built["seconds"],
            "seed": v["seed"], "inputs": work,
            "mlx": mx.__version__, "shims": handle["shims"], "code": PINNED_COMMIT,
            "license": "CC BY-NC 4.0: weights and outputs are non-commercial"}
