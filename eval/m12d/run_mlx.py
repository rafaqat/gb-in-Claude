# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""M12d: MuLaCover with the MLX token generator (models/mulacover_mlx) and the authors' PyTorch preprocessing + codec
on MPS. (MuLaCover's own venv, with mlx installed.)

    PY=~/Library/Caches/gb-mcp/mulacover/.venv/bin/python
    $PY eval/m12d/run_mlx.py generate <inputs folder> <seconds> <out.wav> [seed]
    $PY eval/m12d/run_mlx.py compare <inputs folder> <frames>     # greedy: the authors' PyTorch model vs MLX, real weights

Same pinned code / weights / offline rule as spike.py. Outputs are CC BY-NC 4.0 (non-commercial).
"""
import json, os, resource, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "models"))
from spike import CKPT, PINNED_COMMIT, WORKSPACE, verify_code  # noqa: E402

MODEL = os.path.join(CKPT, "MuLaCover")
CFG, TEMPERATURE, TOPK = 1.5, 1.0, 250


def pipeline_and_inputs(folder: str, seconds: float, save: str):
    import torch
    import mps_shims
    from mulacover import MuLaCoverGenPipeline
    shims = mps_shims.apply()
    pipe = MuLaCoverGenPipeline.from_pretrained(CKPT, device=torch.device("mps"), lazy_load=True,
                                                dtype={"mulacover": torch.bfloat16, "codec": torch.float32, "qwen": torch.float32, "transcriptor": torch.float32})
    src = os.path.join(WORKSPACE, folder)
    inputs = {k: os.path.join(src, f) for k, f in (("melody_midi", "melody.mid"), ("chord_midi", "chord.mid"), ("drum_midi", "drums.mid"),
                                                    ("lyrics", "lyrics.txt"), ("tags", "tags.txt")) if os.path.exists(os.path.join(src, f))}
    pre, _, post = pipe._sanitize_parameters(save_path=save, max_audio_length_ms=int(seconds * 1000), cfg_scale=CFG, temperature=TEMPERATURE, topk=TOPK)
    t = time.time()
    model_inputs = pipe.preprocess(inputs, **pre)
    return pipe, model_inputs, post, shims, time.time() - t


def mlx_frames(pipe, model_inputs, frames: int, topk: int, seed: int):
    import mlx.core as mx
    from mulacover_mlx.generate import generate
    from mulacover_mlx.model import MuLaCoverDims, MuLaCoverMLX, load_checkpoint
    mx.random.seed(seed)
    t = time.time()
    model = MuLaCoverMLX(MuLaCoverDims.from_config(os.path.join(MODEL, "config.json")))
    load_checkpoint(model, MODEL)
    load_s = time.time() - t
    mx.reset_peak_memory()
    t = time.time()
    out = generate(model, model_inputs, max_frames=frames, temperature=TEMPERATURE, topk=topk, cfg_scale=CFG,
                   eos_id=pipe.config.audio_eos_id, empty_id=pipe.config.empty_id, dtype=mx.bfloat16)
    tokens_s = time.time() - t
    peak = mx.get_peak_memory() / 1e9
    del model
    mx.clear_cache()
    return out, load_s, tokens_s, peak


def generate_song(folder: str, seconds: float, out: str, seed: int) -> int:
    import numpy as np, torch, soundfile as sf
    save = os.path.join(WORKSPACE, out)
    if os.path.lexists(save):
        sys.exit(f"{save} exists; nothing written")
    pipe, model_inputs, post, shims, prep_s = pipeline_and_inputs(folder, seconds, save)
    frames, load_s, tokens_s, peak = mlx_frames(pipe, model_inputs, int(seconds * 1000) // 80, TOPK, seed)
    np.save(save + ".tokens.npy", frames)
    t = time.time()
    pipe.postprocess({"frames": torch.from_numpy(frames.astype(np.int64))}, **post)
    codec_s = time.time() - t
    info = sf.info(save)
    audio_s = info.frames / info.samplerate
    import mlx.core as mx
    row = {"engine": "mlx", "mlx": mx.__version__, "inputs": folder,  # a seed reproduces a song only on the same MLX version "out": out, "seed": seed, "requested_s": seconds, "audio_s": round(audio_s, 2),
           "frames": int(frames.shape[1]), "preprocess_s": round(prep_s, 1), "mlx_load_s": round(load_s, 1), "tokens_s": round(tokens_s, 1),
           "s_per_frame": round(tokens_s / frames.shape[1], 3), "codec_s": round(codec_s, 1), "mlx_peak_gb": round(peak, 2),
           "rss_peak_gb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e9, 2), "shims": shims, "code": PINNED_COMMIT}
    print(json.dumps(row), flush=True)
    with open(os.path.join(os.path.dirname(save), "results.jsonl"), "a") as f:
        f.write(json.dumps(row) + "\n")
    return 0


def compare(folder: str, frames: int) -> int:
    """Greedy (topk=1, deterministic in both) from the same preprocessed inputs: the authors' model (MPS, bf16 autocast)
    vs MLX (bf16). Reports where the token streams first differ; bf16 arithmetic differs, so a late split is expected."""
    import numpy as np
    save = os.path.join(WORKSPACE, "gen", "m12d", "_compare.wav")
    pipe, model_inputs, _, _, _ = pipeline_and_inputs(folder, frames * 0.08, save)
    t = time.time()
    want = pipe._forward(dict(model_inputs), max_audio_length_ms=frames * 80, temperature=TEMPERATURE, topk=1, cfg_scale=CFG,
                         disable_progress=True)["frames"].numpy()
    torch_s = time.time() - t
    got, _, mlx_s, _ = mlx_frames(pipe, model_inputs, frames, 1, 0)
    n = min(want.shape[1], got.shape[1])
    same = (want[:, :n] == got[:, :n])
    split = next((i for i in range(n) if not same[:, i].all()), None)
    print(json.dumps({"frames": n, "torch_s": round(torch_s, 1), "mlx_s": round(mlx_s, 1), "first_differing_frame": split,
                      "codebook0_equal_until_split": None if split is None else bool(same[0, :split].all()),
                      "equal_share": round(float(same.mean()), 3), "frame0_torch": want[:, 0].tolist(), "frame0_mlx": got[:, 0].tolist()}))
    return 0


if __name__ == "__main__":
    verify_code()
    os.environ["HF_HUB_OFFLINE"] = "1"
    cmd, a = sys.argv[1], sys.argv[2:]
    if cmd == "generate":
        sys.exit(generate_song(a[0], float(a[1]), a[2], int(a[3]) if len(a) > 3 else 42))
    sys.exit(compare(a[0], int(a[1])))
