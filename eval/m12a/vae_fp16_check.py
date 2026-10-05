# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""M12a: does ACE-Step's MLX VAE in float16 decode the SAME latents like float32? (ACE-Step venv)

    ~/Library/Caches/gb-mcp/ace-step/.venv/bin/python eval/m12a/vae_fp16_check.py <music.wav, 48 kHz stereo>

The speed test cannot answer this: float16 also changes the encoded source, and the diffusion then makes another
(valid) cover. Here one chunk of latents (512 frames, 20.48 s — ACE-Step's MLX decode chunk) is encoded once in
float32 and decoded by the float32 and the float16 MLX VAE; SNR of float16 against float32, and the time of each.
Same pinned code and weights as generate.py (checked before import).
"""
import json, os, sys, time
import numpy as np, soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate import ACE, verify_code  # noqa: E402

FRAMES, HOP = 512, 1920


def main(music: str) -> int:
    verify_code()
    os.environ["HF_HUB_OFFLINE"] = "1"
    sys.path.insert(0, ACE)
    import mlx.core as mx
    from mlx.utils import tree_map
    from diffusers import AutoencoderOobleck
    from acestep.models.mlx.vae_model import MLXAutoEncoderOobleck
    from acestep.models.mlx.vae_convert import convert_and_load

    torch_vae = AutoencoderOobleck.from_pretrained(os.path.join(ACE, "checkpoints", "vae")).eval()
    vae32 = MLXAutoEncoderOobleck.from_pytorch_config(torch_vae)
    convert_and_load(torch_vae, vae32)
    vae16 = MLXAutoEncoderOobleck.from_pytorch_config(torch_vae)
    convert_and_load(torch_vae, vae16)
    vae16.update(tree_map(lambda v: v.astype(mx.float16) if isinstance(v, mx.array) and mx.issubdtype(v.dtype, mx.floating) else v, vae16.parameters()))

    y, sr = sf.read(music, always_2d=True, dtype="float32")
    assert sr == 48000 and y.shape[1] == 2
    audio = mx.array(y[None, :FRAMES * HOP])  # (1, samples, 2): NLC
    z = vae32.encode_mean(audio)
    mx.eval(z)

    def timed(vae, dtype):
        out = vae.decode(z.astype(dtype)); mx.eval(out)  # warm
        t = time.time(); out = vae.decode(z.astype(dtype)); mx.eval(out)
        return np.array(out.astype(mx.float32)), time.time() - t

    a32, t32 = timed(vae32, mx.float32)
    a16, t16 = timed(vae16, mx.float16)
    snr = 10 * np.log10(np.sum(a32 ** 2) / np.sum((a32 - a16) ** 2))
    row = {"latent_frames": int(z.shape[1]), "fp32_chunk_s": round(t32, 3), "fp16_chunk_s": round(t16, 3),
           "fp16_vs_fp32_snr_db": round(float(snr), 1), "fp16_peak_abs": round(float(np.abs(a16).max()), 3)}
    print(json.dumps(row))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
