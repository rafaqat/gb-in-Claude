# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""MuLaCover (HeartMuLa, github.com/HeartMuLa/MuLaCover f01810c) re-implemented in MLX for Apple Silicon (M12d).
The token generator (3B Llama backbone + cross-attention to the melody / chord / drum roll + 300M depth decoder) runs
here; preprocessing and the codec stay in the authors' PyTorch code. Every module is tested against the authors'
PyTorch module with copied weights. Weights and outputs: CC BY-NC 4.0 (non-commercial)."""
