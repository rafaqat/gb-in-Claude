# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Foundation-1: loops from tagged prompts ("<instrument>, <timbre>, …, <key>, <bars> Bars, <bpm> BPM").
Runs in .venv-sat (stable-audio-tools). Tags exist only for 100/110/120/128/130/140/150 BPM and 4 or 8 bars."""
import json
import os

from huggingface_hub import snapshot_download

REPO = "RoyalCities/Foundation-1"
REVISION = "7b10fbbbc1be2f54cbc5540aab89ee383bc94e4a"  # pinned
STEPS = 100  # the usual Stable Audio Open setting; stable-audio-tools defaults to 250


def _apg_project_f32(self, v0, v1, padding_mask=None):
    """stable-audio-tools' DiffusionTransformer.apg_project in float32: Metal has no float64. Same arithmetic."""
    import torch
    dtype = v0.dtype
    v0, v1 = v0.float(), v1.float()
    if padding_mask is not None:
        mask = padding_mask.unsqueeze(1).float()
        v1_masked = v1 * mask
        v1_normalized = v1_masked / v1_masked.norm(dim=[-1, -2], keepdim=True).clamp(min=1e-8)
        v0_parallel = ((v0 * mask) * v1_normalized).sum(dim=[-1, -2], keepdim=True) * v1_normalized
        v0_orthogonal = (v0 - (v0 * v1_normalized).sum(dim=[-1, -2], keepdim=True) * v1_normalized) * mask
    else:
        v1 = torch.nn.functional.normalize(v1, dim=[-1, -2])
        v0_parallel = (v0 * v1).sum(dim=[-1, -2], keepdim=True) * v1
        v0_orthogonal = v0 - v0_parallel
    return v0_parallel.to(dtype), v0_orthogonal.to(dtype)


def load(device: str, dtype: str = "float32"):
    import torch
    from stable_audio_tools.models.factory import create_model_from_config
    from stable_audio_tools.models.utils import load_ckpt_state_dict

    root = snapshot_download(REPO, revision=REVISION, allow_patterns=["Foundation_1.safetensors", "model_config.json"])
    config = json.load(open(os.path.join(root, "model_config.json")))
    model = create_model_from_config(config)
    model.load_state_dict(load_ckpt_state_dict(os.path.join(root, "Foundation_1.safetensors")))
    if device == "mps":
        from stable_audio_tools.models.dit import DiffusionTransformer
        DiffusionTransformer.apg_project = _apg_project_f32
    model = model.to(device).eval().requires_grad_(False).to(getattr(torch, dtype))
    return {"model": model, "device": device, "dtype": dtype,
            "sample_rate": config["sample_rate"], "sample_size": config["sample_size"]}


def run(handle, inputs: dict) -> dict:
    """inputs: prompt, bpm, bars, seed, out (optional .wav path to keep the loop)."""
    import torch
    from stable_audio_tools.inference.generation import generate_diffusion_cond

    seconds = inputs["bars"] * 4 * 60.0 / inputs["bpm"]
    steps = inputs.get("steps", STEPS)
    with torch.inference_mode():
        audio = generate_diffusion_cond(
            handle["model"], steps=steps, cfg_scale=7,
            conditioning=[{"prompt": inputs["prompt"], "seconds_start": 0, "seconds_total": seconds}],
            sample_size=handle["sample_size"], sample_rate=handle["sample_rate"], seed=inputs.get("seed", 1),
            device=handle["device"],
        )
    sr = handle["sample_rate"]
    loop = audio[0, :, : int(seconds * sr)].float().cpu()
    if inputs.get("out"):
        import soundfile as sf
        out = inputs["out"].replace(".wav", f"-{handle['dtype']}-{steps}steps.wav")
        sf.write(out, loop.T.numpy(), sr)
    return {"seconds": round(seconds, 3), "channels": int(loop.shape[0]), "sample_rate": sr, "steps": steps,
            "nan": bool(torch.isnan(loop).any()),
            "peak": round(float(loop.abs().max()), 4)}
