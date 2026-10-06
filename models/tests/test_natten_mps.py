# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""M13.13 neighborhood attention in plain PyTorch (gbmodels/natten_mps.py) against NATTEN 0.17.5 itself: reference
outputs from its CPU build (tests/fixtures/natten-0.17.5-reference.npz; edge-heavy shapes, dilations 1–4, 1D and 2D)."""
import os
import unittest

import numpy as np
import torch

from gbmodels import natten_mps as na

REF = np.load(os.path.join(os.path.dirname(__file__), "fixtures", "natten-0.17.5-reference.npz"))
DEVICES = ["cpu"] + (["mps"] if torch.backends.mps.is_available() else [])


def t(name, device):
    return torch.from_numpy(REF[name]).to(device)


class OneD(unittest.TestCase):
    def test_qk_with_bias_and_av_match_natten(self):
        for case in "abcd":
            L, K, d = (int(x) for x in REF[f"1d_{case}_cfg"])
            for dev in DEVICES:
                with self.subTest(case=case, L=L, K=K, dilation=d, device=dev):
                    p = lambda x: t(f"1d_{case}_{x}", dev)  # noqa: E731
                    attn = na.natten1dqkrpb(p("q"), p("k"), p("rpb"), K, d)
                    np.testing.assert_allclose(attn.cpu().numpy(), REF[f"1d_{case}_attn"], rtol=1e-4, atol=1e-4)
                    av = na.natten1dav(p("attn").softmax(-1), p("v"), K, d)
                    np.testing.assert_allclose(av.cpu().numpy(), REF[f"1d_{case}_av"], rtol=1e-4, atol=1e-5)


class TwoD(unittest.TestCase):
    def test_qk_with_bias_and_av_match_natten(self):
        for case in "abc":
            X, Y, K, d = (int(x) for x in REF[f"2d_{case}_cfg"])
            for dev in DEVICES:
                with self.subTest(case=case, X=X, Y=Y, K=K, dilation=d, device=dev):
                    p = lambda x: t(f"2d_{case}_{x}", dev)  # noqa: E731
                    attn = na.natten2dqkrpb(p("q"), p("k"), p("rpb"), K, d)
                    np.testing.assert_allclose(attn.cpu().numpy(), REF[f"2d_{case}_attn"], rtol=1e-4, atol=1e-4)
                    av = na.natten2dav(p("attn").softmax(-1), p("v"), K, d)
                    np.testing.assert_allclose(av.cpu().numpy(), REF[f"2d_{case}_av"], rtol=1e-4, atol=1e-5)


class Limits(unittest.TestCase):
    def test_an_even_kernel_or_a_group_shorter_than_the_kernel_is_refused(self):
        q = torch.zeros(1, 1, 8, 4)
        with self.assertRaisesRegex(ValueError, "odd"):
            na.na1d_qk(q, q, 4)
        with self.assertRaisesRegex(ValueError, "fewer than kernel_size"):
            na.na1d_qk(q, q, 5, 2)  # groups of 4 positions
