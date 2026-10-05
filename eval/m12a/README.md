# M12a: ACE-Step 1.5 on this Mac — benchmark, cover-fidelity sweep, speed and Neural Engine tests

MacBook Air M4 (fanless), 32 GB. ACE-Step 1.5 (MIT) code `ca1e85f` in `~/Library/Caches/gb-mcp/ace-step` (its own
locked venv, `uv sync --frozen`); weights `ACE-Step/Ace-Step1.5@19671f4` (10.09 GB: turbo DiT, 1.7B LM, VAE, text
encoder). Turbo: 8 steps, shift 3, ODE. Runs are offline (`HF_HUB_OFFLINE=1`); the code is checked (commit + clean
tree) before import.

```sh
ACE=~/Library/Caches/gb-mcp/ace-step/.venv/bin/python
$ACE eval/m12a/generate.py eval/m12a/plan.json [ids…]          # out/gen/m12a/<id>.wav + results.jsonl
models/.venv/bin/python eval/m12a/measure.py eval/m12a/results-2026-10-05.json
GB_M12A_PLAN_KEY=speed_jobs GB_M12A_TAG=speed-<v> [ACESTEP_MLX_VAE_FP16=1] [GB_M12A_COMPILE=1] $ACE eval/m12a/generate.py eval/m12a/plan.json
models/.venv/bin/python eval/m12a/speed_compare.py eval/m12a/speed-2026-10-05.json
$ACE eval/m12a/vae_fp16_check.py <48 kHz music>                 # same latents, fp32 vs fp16 MLX VAE
~/Library/Caches/gb-mcp/ace-ane/bin/python eval/m12a/ane_vae.py <48 kHz music>   # Core ML / Neural Engine
```

## Results

**Cost.** 30 s text-to-music with the LM: 50–100 s (mean 69 s; LM 18 s, DiT 24 s, VAE decode 10 s). A 116 s cover
(no LM): 110–147 s, about real time. Peak memory: MLX 15.9 GB with the LM, 13.7 GB without. No thermal slowdown: the
same job took 76.0 s first and 76.7 s after 40 minutes of load. All 27 jobs succeeded.

**Control**. Tempo: every output within the beat tracker's resolution (50 frames/s → at
132 BPM it can only read 130.43 or 136.36, ±2.5 %). Key: 8 of 12 text prompts exact (misses: G major → B minor and
D major → F# minor, both 6 of 7 notes shared; D minor → F# minor; Eb major → B minor). Every cover kept E minor and
the source tempo. Instrumental requests stayed instrumental (vocal stem ≤ −25 dB), except the film-instrumental prompt, where
the vocal stem holds the bansuri (−10 dB); lyric requests sang (−2 to −12 dB).

**Cover fidelity** (source: a 116 s gb-mcp song export, lyrics added). The metric (pYIN on the Demucs vocal stem vs each MIDI
line, pitch class, against the same line moved ±2 bars) was checked on the source's own instrument stem: bansuri 0.444
vs 0.146 control. The covers' singer follows the bansuri melody only at strength ≥ 0.7: 0.3 → 0.07–0.13 (control
0.10–0.18, chance), 0.5 → 0.08–0.11 (chance), 0.7 → 0.21–0.24 (0.16), 0.9 → 0.25–0.29 (0.15), 1.0 → 0.24–0.31
(0.15–0.17); seed 2 often follows the violin counter-line instead. At 0.9–1.0 the flute itself may leak into the vocal
stem (the instrumental cover rules leakage out only at 0.7). Vocals get quieter as strength rises (−6.9 → −11.9 dB).
Per-bar loudness follows the source at every strength (0.49–0.90 vs control 0.23–0.59).

**Speed switches** (speed-2026-10-05.json; the same cover, cold then warm). VAE float16 (ACE-Step's own
`ACESTEP_MLX_VAE_FP16=1`): warm 114 → 90 s, VAE decode 37 → 19 s, MLX peak 13.7 → 10.0 GB; on the SAME latents
float16 vs float32 is 55.3 dB SNR (vae_fp16_check.py). DiT `mx.compile`: no gain. A warm process saves ~20 s per job.
The DiT's first step costs 11–18 s more than later steps on every job, also warm (step 1: 21 s cold / 14 s warm,
then ~3.2 s per step) — cause not found; the next speed target.

**Neural Engine** (ane-vae-2026-10-05.json). The VAE decoder (one 20.48 s chunk) as Core ML, coremltools 9.0:
CPU+ANE 12.6 s (load 243 s), CPU+GPU 2.74 s, all units 2.39 s, CPU only 2.98 s; MLX float16 ≈ 2.5 s. Core ML's compute
plan puts 0 of 232 compute ops on the ANE: the snake activation's `sin` (36 ops, every block) is CPU/GPU only, and
only 7 of 32 convolutions (the short early ones) are ANE-capable. So no ANE gain without rewriting the activation and
the time layout, for at most the ~19 s the VAE decode now takes. The DiT (2B, 2,897-token attention for 116 s) fits
the ANE worse; the LM's token-by-token decoding is bandwidth-bound, where the ANE does not help.

The gate: the user listens and decides.
