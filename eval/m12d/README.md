# M12d: MuLaCover on Apple Silicon

MuLaCover (github.com/HeartMuLa/MuLaCover; code Apache-2.0; weights AND outputs CC BY-NC 4.0, non-commercial) is
documented for Linux + NVIDIA. On a MacBook Air M4 (32 GB):

- `spike.py` — the authors' pipeline on PyTorch MPS, unchanged, with one in-memory shim (`mps_shims.py`: a CUDA-only
  `.type(t.type())` cast in the codec; the method's source hash is checked before it is replaced).
- `models/mulacover_mlx` — the token generator ported to MLX (Llama 3.2 backbone with cross-attention to the
  melody / chord / drum roll, style modulation, depth decoder, guidance, sampling). What is constant for a song (the
  adaptor contexts and their keys / values, the style modulation) is computed once, not per frame. 12 tests compare it
  with the authors' modules on copied weights; on the real weights frame 0 is identical and logits agree to cosine
  0.9998+ (streams split at bf16 near-ties, as two bf16 implementations do).
- `run_mlx.py generate | compare` — the MLX token generator with the authors' preprocessing and codec; `compare` runs
  greedy decoding in both and reports where they split. `inputs.py` — melody / chord / drum MIDI from a song MIDI
  (the tested version is `models/gbmodels/mulacover_inputs.py`).

| 30 s of audio | authors' code on MPS | MLX port |
|---|---|---|
| tokens | 233 s (0.62 s / frame) | 55.6 s (0.148 s / frame, MLX 0.32.3) |
| codec (PyTorch MPS) | 154 s | 65–85 s |

The codec's flow estimator was also ported to MLX (`models/mulacover_mlx/codec.py`, tested) and measured: no faster
than MPS for its large passes, so the codec stays on PyTorch. MuLaCover takes no tempo from MIDI and chooses its own:
measure the result and re-time it (gb_stem prepare). `MLX-ROPE-BUG.md`: an MLX fault (fixed upstream in 0.32.0) that
the port found and works around.
