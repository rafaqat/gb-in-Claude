# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""M12d spike: MuLaCover (HeartMuLa) on Apple Silicon — PyTorch MPS, no code changes. (MuLaCover's own venv)

    ~/Library/Caches/gb-mcp/mulacover/.venv/bin/python eval/m12d/spike.py <inputs folder> <seconds> <out.wav> [seed]

Inputs (relative to the workspace): melody.mid, chord.mid, [drums.mid], lyrics.txt, tags.txt (eval/m12d/inputs.py).
Code: github.com/HeartMuLa/MuLaCover f01810c (Apache-2.0), checked before import. Weights (CC BY-NC 4.0 — weights AND
outputs non-commercial): MuLaCover@bbbaef2, HeartCodec-oss@f889dab, Qwen3-Embedding-0.6B@97b0c61, offline.
"""
import json, os, resource, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WORKSPACE = os.environ.get("GB_MCP_WORKSPACE") or os.path.join(os.path.dirname(ROOT), "out")
CODE = os.environ.get("GB_MCP_MULACOVER", os.path.expanduser("~/Library/Caches/gb-mcp/mulacover"))
CKPT = os.path.expanduser("~/Library/Caches/gb-mcp/mulacover-ckpt")
PINNED_COMMIT = "f01810c715a58ddc3d5a795c562fe5d8fbd56b24"


def verify_code() -> None:
    head = subprocess.run(["git", "-C", CODE, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    if head != PINNED_COMMIT:
        sys.exit(f"MuLaCover checkout is {head[:12] or 'missing'}, not the reviewed commit {PINNED_COMMIT[:12]}")
    if subprocess.run(["git", "-C", CODE, "status", "--porcelain"], capture_output=True, text=True).stdout.strip():
        sys.exit("MuLaCover checkout has local changes; refusing to import it")


def main(folder: str, seconds: float, out: str, seed: int) -> int:
    verify_code()
    os.environ["HF_HUB_OFFLINE"] = "1"
    import torch
    from mulacover import MuLaCoverGenPipeline
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import mps_shims
    shims = mps_shims.apply()
    src = os.path.join(WORKSPACE, folder)
    save = os.path.join(WORKSPACE, out)
    if os.path.lexists(save):
        sys.exit(f"{save} exists; nothing written")
    inputs = {k: os.path.join(src, f) for k, f in (("melody_midi", "melody.mid"), ("chord_midi", "chord.mid"), ("drum_midi", "drums.mid"),
                                                    ("lyrics", "lyrics.txt"), ("tags", "tags.txt")) if os.path.exists(os.path.join(src, f))}
    t0 = time.time()
    pipe = MuLaCoverGenPipeline.from_pretrained(CKPT, device=torch.device("mps"), lazy_load=True,
                                                dtype={"mulacover": torch.bfloat16, "codec": torch.float32, "qwen": torch.float32, "transcriptor": torch.float32})
    load_s = time.time() - t0
    pre, fwd, post = pipe._sanitize_parameters(save_path=save, max_audio_length_ms=int(seconds * 1000), cfg_scale=1.5, temperature=1.0, topk=250)
    tokens_path = save + ".tokens.pt"  # kept so a codec failure does not cost a new generation
    t0 = time.time()
    if os.path.exists(tokens_path):
        outputs, tokens_s = torch.load(tokens_path, weights_only=False), None
    else:
        torch.manual_seed(seed)
        outputs = pipe._forward(pipe.preprocess(inputs, **pre), **fwd)
        tokens_s = time.time() - t0
        torch.save(outputs, tokens_path)
    t1 = time.time()
    pipe.postprocess(outputs, **post)
    codec_s = time.time() - t1
    gen_s = time.time() - t0
    import soundfile as sf
    info = sf.info(save)
    row = {"inputs": folder, "out": out, "seed": seed, "requested_s": seconds, "audio_s": round(info.frames / info.samplerate, 2),
           "rate": info.samplerate, "load_s": round(load_s, 1), "gen_s": round(gen_s, 1), "tokens_s": tokens_s and round(tokens_s, 1),
           "codec_s": round(codec_s, 1), "shims": shims,
           "rtf": round(gen_s / (info.frames / info.samplerate), 2),
           "mps_allocated_gb": round(torch.mps.driver_allocated_memory() / 1e9, 2),
           "rss_peak_gb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e9, 2), "code": PINNED_COMMIT}
    print(json.dumps(row), flush=True)
    with open(os.path.join(os.path.dirname(save), "results.jsonl"), "a") as f:
        f.write(json.dumps(row) + "\n")
    return 0


if __name__ == "__main__":
    a = sys.argv[1:]
    sys.exit(main(a[0], float(a[1]), a[2], int(a[3]) if len(a) > 3 else 42))
