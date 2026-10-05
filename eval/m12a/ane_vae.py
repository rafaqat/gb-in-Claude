# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""M12a Neural Engine spike: ACE-Step's VAE decoder as Core ML — does the ANE beat MLX here, and is the audio the same?

    ~/Library/Caches/gb-mcp/ace-ane/bin/python eval/m12a/ane_vae.py <music.wav, 48 kHz, ≥ 21 s>

The venv: torch 2.10.0, diffusers 0.37.1, coremltools 9.0 (the pair the TTS conversion used). The decoder is the
diffusers AutoencoderOobleck from the pinned ACE-Step weights, weight norm folded, converted for ONE fixed chunk —
512 latent frames (20.48 s), the chunk ACE-Step's MLX decoder uses (64-frame overlaps, stride 384). Steps:
1. latents: encode the first 512 frames' worth of the given music with the PyTorch encoder (the latent mean);
2. reference: PyTorch float32 decode on the CPU;
3. Core ML (float16 and float32) under each compute-unit setting: warm time per chunk, SNR against the reference,
   and the share of ops Core ML plans for the Neural Engine (MLComputePlan).
Prints a JSON summary; the time for a 116 s song = 8 chunks × the per-chunk time (compare MLX float32: 28.8 s).
"""
import json, os, sys, time
import numpy as np, soundfile as sf, torch

ACE = os.environ.get("GB_MCP_ACESTEP", os.path.expanduser("~/Library/Caches/gb-mcp/ace-step"))
CACHE = os.path.expanduser("~/Library/Caches/gb-mcp/ace-ane")
FRAMES = 512
HOP = 1920  # samples per latent frame: 2 × 4 × 4 × 6 × 10
SR = 48000


def fold_weight_norm(model: torch.nn.Module) -> None:
    from torch.nn.utils import parametrize
    for m in model.modules():
        if parametrize.is_parametrized(m, "weight"):
            parametrize.remove_parametrizations(m, "weight", leave_parametrized=True)
        elif hasattr(m, "weight_g"):
            torch.nn.utils.remove_weight_norm(m)


class Decoder(torch.nn.Module):
    def __init__(self, vae):
        super().__init__()
        self.decoder = vae.decoder

    def forward(self, z):
        return self.decoder(z)


def snr_db(ref: np.ndarray, x: np.ndarray) -> float:
    return round(float(10 * np.log10(np.sum(ref ** 2) / (np.sum((ref - x) ** 2) + 1e-20))), 2)


def ane_share(path: str, units) -> float | None:
    """Share of ops (by count) whose preferred device is the Neural Engine, from Core ML's compute plan."""
    try:
        import coremltools as ct
        from coremltools.models.compute_plan import MLComputePlan
        from coremltools.models.compute_device import MLNeuralEngineComputeDevice
        compiled = ct.utils.compile_model(path)
        plan = MLComputePlan.load_from_path(compiled, compute_units=units)
        fn = plan.model_structure.program.functions["main"]
        ops = [op for op in fn.block.operations if op.operator_name not in ("const",)]
        ane = sum(1 for op in ops if isinstance(getattr(plan.get_compute_device_usage_for_mlprogram_operation(op), "preferred_compute_device", None), MLNeuralEngineComputeDevice))
        return round(ane / max(1, len(ops)), 3)
    except Exception as e:  # the plan API is best effort; timing and SNR are the real measures
        print(f"compute plan unavailable: {e}", file=sys.stderr)
        return None


def main(music: str) -> int:
    import coremltools as ct
    from diffusers import AutoencoderOobleck
    torch.manual_seed(0)
    vae = AutoencoderOobleck.from_pretrained(os.path.join(ACE, "checkpoints", "vae")).eval()
    fold_weight_norm(vae)

    y, sr = sf.read(music, always_2d=True, dtype="float32")
    assert sr == SR and y.shape[1] == 2, (sr, y.shape)
    need = FRAMES * HOP
    assert len(y) >= need, f"need {need / SR:.2f} s of audio"
    x = torch.from_numpy(y[:need].T.copy())[None]
    with torch.no_grad():
        z = vae.encode(x).latent_dist.mean  # (1, 64, 512)
        t = time.time(); ref = vae.decoder(z).numpy(); torch_cpu_s = time.time() - t
    print(f"latents {tuple(z.shape)}; PyTorch CPU float32 decode {torch_cpu_s:.2f} s", flush=True)

    traced = torch.jit.trace(Decoder(vae).eval(), z)
    results = {"frames": FRAMES, "audio_seconds": FRAMES * HOP / SR, "torch_cpu_fp32_s": round(torch_cpu_s, 2), "runs": []}
    for precision in ("fp16", "fp32"):
        path = os.path.join(CACHE, f"vae_decoder_{FRAMES}_{precision}.mlpackage")
        if not os.path.exists(path):
            t = time.time()
            ml = ct.convert(traced, inputs=[ct.TensorType(name="z", shape=tuple(z.shape))], outputs=[ct.TensorType(name="audio")],
                            convert_to="mlprogram", minimum_deployment_target=ct.target.macOS15,
                            compute_precision=ct.precision.FLOAT16 if precision == "fp16" else ct.precision.FLOAT32)
            ml.save(path)
            print(f"converted {precision} in {time.time() - t:.0f} s → {path}", flush=True)
        for units in (ct.ComputeUnit.CPU_AND_NE, ct.ComputeUnit.CPU_AND_GPU, ct.ComputeUnit.ALL, ct.ComputeUnit.CPU_ONLY):
            if precision == "fp32" and units == ct.ComputeUnit.CPU_AND_NE:
                continue  # the ANE computes in float16 only
            t = time.time()
            model = ct.models.MLModel(path, compute_units=units)
            load_s = time.time() - t
            feed = {"z": z.numpy().astype(np.float32)}
            out = model.predict(feed)["audio"]  # first call: may compile for the device
            times = []
            for _ in range(3):
                t = time.time(); out = model.predict(feed)["audio"]; times.append(time.time() - t)
            row = {"precision": precision, "units": units.name, "load_s": round(load_s, 1), "chunk_s": round(min(times), 3),
                   "song_116s_est_s": round(8 * min(times), 1), "snr_db": snr_db(ref, np.asarray(out, dtype=np.float32)),
                   "ane_op_share": ane_share(path, units) if units in (ct.ComputeUnit.CPU_AND_NE, ct.ComputeUnit.ALL) else None}
            results["runs"].append(row)
            print(json.dumps(row), flush=True)
    print(json.dumps(results, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
