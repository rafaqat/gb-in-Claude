# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""The MLX generation loop vs the authors' MuLaCoverGenPipeline._forward (tiny random model, greedy, CFG): the same
frames; plus EOS and the padding-token check with a scripted stand-in model."""
import unittest
from types import SimpleNamespace

import mlx.core as mx
import numpy as np
import torch
from mulacover.pipeline import MuLaCoverGenPipeline

from mulacover_mlx.generate import generate
from mulacover_mlx.llama import load_torch
from mulacover_mlx.model import MuLaCoverMLX
from mulacover_mlx.tests.test_model import DIMS, torch_model


def model_inputs():
    g = torch.Generator().manual_seed(7)
    S, L = 5, 12
    tokens = torch.cat([torch.randint(0, 21, (1, S, 8), generator=g), torch.randint(0, 40, (1, S, 1), generator=g)], -1).repeat(2, 1, 1)
    mask = torch.zeros(2, L, dtype=torch.bool)
    mask[:, -2:] = True
    return {"tokens": tokens, "tokens_mask": (torch.rand(1, S, 9, generator=g) > 0.3).repeat(2, 1, 1),
            "input_pos": torch.arange(S).repeat(2, 1), "qwen_embedding": torch.randn(1, 24, generator=g).repeat(2, 1),
            "muq_embedding": torch.zeros(2, 16), "qwen_indices": torch.full((2,), 1), "muq_indices": torch.full((2,), 2),
            "pianoroll": torch.randn(1, L, 256, generator=g).repeat(2, 1, 1), "drum_pianoroll": torch.randn(1, L, 128, generator=g).repeat(2, 1, 1),
            "chord": torch.randn(1, L, 12, generator=g).repeat(2, 1, 1), "context_mask": mask}


def authors_forward(model, inputs, frames: int, eos: int):
    pipe = MuLaCoverGenPipeline.__new__(MuLaCoverGenPipeline)
    pipe.devices, pipe.dtypes = {"mulacover": torch.device("cpu")}, {"mulacover": torch.float32}
    pipe._mulacover, pipe._cache_batch_size, pipe.lazy_load = model, None, False
    pipe.config, pipe.model_config = SimpleNamespace(audio_eos_id=eos, empty_id=0), model.config
    return pipe._forward(dict(inputs), max_audio_length_ms=frames * 80, temperature=1.0, topk=1, cfg_scale=1.5, disable_progress=True)["frames"].numpy()


class LoopMatchesAuthors(unittest.TestCase):
    def test_six_frames_greedy(self):
        r = torch_model()
        m = MuLaCoverMLX(DIMS)
        load_torch(m, r.state_dict())
        inputs = model_inputs()
        want = authors_forward(r, inputs, 6, eos=22)  # eos above the tiny vocabulary: no early stop
        got = generate(m, inputs, max_frames=6, temperature=1.0, topk=1, cfg_scale=1.5, eos_id=22, empty_id=0)
        self.assertEqual(got.shape, (8, 6))
        np.testing.assert_array_equal(got, want)


class Scripted:
    """Stand-in model: start() → state; frame() returns the next scripted (2, 8) sample."""
    def __init__(self, rows):
        self.rows = [mx.array(r, dtype=mx.int32) for r in rows]

    def start(self, *a, **k):
        return SimpleNamespace(caches=[])

    def frame(self, state, tokens, tokens_mask, temperature, topk, first=None):
        return self.rows.pop(0)


class LoopStops(unittest.TestCase):
    def test_eos_ends_the_song_and_keeps_the_frames_before(self):
        rows = [[[1] * 8] * 2, [[2] * 8] * 2, [[9] + [1] * 7] * 2]
        out = generate(Scripted(rows), model_inputs(), max_frames=10, temperature=1.0, topk=1, cfg_scale=1.5, eos_id=9, empty_id=0)
        np.testing.assert_array_equal(out, np.array([[1, 2]] * 8))

    def test_a_padding_token_is_an_error(self):
        rows = [[[1] * 7 + [8]] * 2]
        with self.assertRaisesRegex(RuntimeError, "padding token"):
            generate(Scripted(rows), model_inputs(), max_frames=10, temperature=1.0, topk=1, cfg_scale=1.5, eos_id=9, empty_id=0)


if __name__ == "__main__":
    unittest.main()
