# Model benchmark — Apple M4, 32 GB, macOS 26.1 (2026-10-03 20:57, 5 back-to-back runs)

| Model | Device | Load s | Cold run 1 s | Median run s (2–5) | Worst run s (2–5) | Peak memory GB (RSS + Metal) | Run 5 / run 1 | Run 5 / run 2 (throttle) | Go? |
|---|---|---|---|---|---|---|---|---|---|
| S-KEY (Deezer), ONNX export | coreml | 1.0 | 13.71 | 0.21 | 0.23 | 1.5 + 0.0 | 0.01 | 0.87 | go |
| beat_this (final0) | mps | 21.1 | 3.94 | 0.44 | 0.44 | 0.5 + 1.5 | 0.11 | 1.00 | go |
| LAION CLAP, music checkpoint (music_audioset_epoch_15_esc_90.14, HTSAT-base) | mps | 10.1 | 0.91 | 0.59 | 0.60 | 3.1 + 2.4 | 0.66 | 1.02 | go |
| Anticipatory Music Transformer (music-medium-800k) | mps | 6.5 | 373.84 | 430.18 | 451.23 | 1.0 + 4.4 | 1.20 | 1.09 | no-go: warm run 430.2s > 60s |
| Foundation-1 (Stable Audio Open fine-tune) | mps | 12.1 | 159.05 | 165.05 | 168.85 | 7.9 + 10.0 | 1.03 | 1.01 | no-go: warm run 165.0s > 30s; peak 17.9 GB > 12 GB |
| Anticipatory Music Transformer, patched sampler (prefix KV cache, no mask sync) | mps | 5.4 | 133.62 | 134.53 | 138.78 | 0.5 + 3.3 | 0.98 | 0.96 | no-go: warm run 134.5s > 60s |
| AMT, patched sampler, float16 on Metal (exact window) | mps | 3.9 | 85.77 | 90.61 | 94.88 | 2.6 + 2.2 | 1.02 | 0.97 | no-go: warm run 90.6s > 60s |
| AMT, patched sampler, float16, chunked window (128 events; changes sampling context) | mps | 4.7 | 13.45 | 14.07 | 14.16 | 2.6 + 2.2 | 1.05 | 1.04 | go |
| AMT on MLX, float16, patched sampler (exact window) | mlx | 0.6 | 52.36 | 65.80 | 66.46 | 3.1 + 1.8 | 1.26 | 1.05 | no-go: warm run 65.8s > 60s |
| AMT on MLX, float16, chunked window (128 events; changes sampling context) | mlx | 0.6 | 12.99 | 13.07 | 13.71 | 3.1 + 1.8 | 1.01 | 0.96 | go |
| Foundation-1, float16 on Metal (100 steps) | mps | 10.5 | 167.02 | 144.60 | 168.72 | 8.7 + 7.8 | 0.82 | 0.81 | no-go: warm run 144.6s > 30s; peak 16.4 GB > 12 GB |
| Foundation-1, float16 on Metal, 50 steps (listening check needed) | mps | 11.5 | 66.91 | 67.96 | 70.21 | 8.7 + 7.8 | 1.03 | 1.03 | no-go: warm run 68.0s > 30s; peak 16.4 GB > 12 GB |
| beat_this (final0), float16 on Metal | mps | 1.3 | 2.84 | 0.57 | 0.63 | 0.5 + 1.3 | 0.22 | 1.32 | go |
| LAION CLAP music, audio encoder float16 on Metal | mps | 9.7 | 1.06 | 0.66 | 0.67 | 3.1 + 2.4 | 0.62 | 1.00 | no-go: output has NaN/Inf |
| S-KEY, Core ML MLProgram, all compute units, compiled-model cache | cpu | 0.3 | 0.96 | 0.10 | 0.11 | 0.6 + 0.0 | 0.10 | 0.98 | go |
