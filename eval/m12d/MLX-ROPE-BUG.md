# MLX bug: `mx.fast.rope` gives wrong results for batch > 1 when the sequence length is 1

Date: 2026-10-05. Found while porting MuLaCover's token generator to MLX (M12d).

## Summary

- In MLX 0.30.6 to 0.31.2, `mx.fast.rope` rotates **every batch row after the first** wrongly when the input has
  **batch size > 1 and sequence length 1**. Batch row 0 is correct.
- The error is large (max absolute error 3–5 for unit-normal input), not a rounding error.
- It happens at **any** offset (also 0), in **both** modes (`traditional=True` and `False`), with `base` and with
  custom `freqs`.
- Sequence length ≥ 2 is correct. Batch size 1 is correct.
- **Fixed upstream in MLX 0.32.0** (released 2026-07-07): "Fix rope single token multiple sequences",
  [ml-explore/mlx#3498](https://github.com/ml-explore/mlx/pull/3498). MLX 0.32.3 (the latest release on 2026-10-05)
  is correct. **No upstream report is necessary.**

## Owner and links

- MLX is open source (MIT) from Apple's machine-learning research team, GitHub organisation `ml-explore`.
- Website and docs: https://ml-explore.github.io/mlx/ · Code: https://github.com/ml-explore/mlx ·
  Issues: https://github.com/ml-explore/mlx/issues
- Reported by others in May 2026 (both closed):
  [#3494](https://github.com/ml-explore/mlx/issues/3494) "mx.fast.rope produces wrong output for batch rows >= 1 when
  seq_len == 1"; [#3496](https://github.com/ml-explore/mlx/issues/3496) the same fault through `MLXNN.RoPE` (MLX Swift).
- Fixed by [#3498](https://github.com/ml-explore/mlx/pull/3498) (maintainer `angeloskath`, merged 2026-05-11, released
  in v0.32.0 on 2026-07-07). The PR notes the bug existed "for more than a year".
- The MuLaCover venv had 0.30.6 at first because it copied ACE-Step's locked version, which predates the fix.

## Environment

| Item | Value |
|---|---|
| Machine | MacBook Air, Apple M4, 32 GB |
| macOS | 26.1 |
| Python | 3.12 |
| MLX with the bug | 0.30.6, 0.31.0, 0.31.1, 0.31.2 (all tested) |
| MLX without the bug | 0.32.0, 0.32.3 (tested) |
| Device | `Device(gpu, 0)` |

## Who is affected

The shape `(B, H, 1, D)` with `B ≥ 2` is the shape of a **batched decode step**: one new token for each of several
sequences. Two common cases:

- classifier-free guidance that puts the conditioned and the unconditioned sequence in one batch of 2;
- batched text generation, one token per step.

A model that decodes with batch 1, or that only runs full sequences (length ≥ 2), is not affected.

## Reproduce

The script compares `mx.fast.rope` with a float64 numpy rotation, for each batch row.

```python
import mlx.core as mx
import numpy as np


def reference(x, offset, dims, base=10000.0, traditional=True):
    """RoPE in float64 numpy: positions offset .. offset + L - 1 along axis -2."""
    x = np.asarray(x, dtype=np.float64)
    L = x.shape[-2]
    inv_freq = 1.0 / (base ** (np.arange(0, dims, 2) / dims))
    ang = (offset + np.arange(L))[:, None] * inv_freq[None, :]
    c, s = np.cos(ang), np.sin(ang)
    out = x.copy()
    if traditional:  # rotate (x0, x1), (x2, x3), ...
        a, b = x[..., 0:dims:2], x[..., 1:dims:2]
        out[..., 0:dims:2], out[..., 1:dims:2] = a * c - b * s, b * c + a * s
    else:  # rotate (x_i, x_{i + dims/2})
        a, b = x[..., : dims // 2], x[..., dims // 2 : dims]
        out[..., : dims // 2], out[..., dims // 2 : dims] = a * c - b * s, b * c + a * s
    return out


mx.random.seed(0)
print("mlx", mx.__version__, mx.default_device())
for shape in [(1, 4, 1, 64), (2, 4, 1, 64), (3, 4, 1, 64), (2, 4, 2, 64), (2, 1, 1, 64)]:
    for traditional in (True, False):
        for offset in (0, 6):
            x = mx.random.normal(shape)
            got = np.array(mx.fast.rope(x, 64, traditional=traditional, base=10000.0, scale=1.0, offset=offset))
            ref = reference(np.array(x), offset, 64, traditional=traditional)
            err = np.abs(got - ref).max(axis=(1, 2, 3))  # per batch row
            print(f"shape {str(shape):14} traditional={str(traditional):5} offset={offset}: "
                  f"max error per batch row {np.array2string(err, precision=1)}")
```

## Result

MLX 0.30.6 (rows after the first are wrong only when `L == 1` and `B > 1`):

```text
shape (1, 4, 1, 64)  traditional=True  offset=6: max error per batch row [7.9e-07]
shape (2, 4, 1, 64)  traditional=True  offset=0: max error per batch row [0. 3.]
shape (2, 4, 1, 64)  traditional=True  offset=6: max error per batch row [5.0e-07 4.9e+00]
shape (2, 4, 1, 64)  traditional=False offset=6: max error per batch row [1.2e-06 4.6e+00]
shape (3, 4, 1, 64)  traditional=True  offset=6: max error per batch row [5.3e-07 4.3e+00 3.7e+00]
shape (2, 4, 2, 64)  traditional=True  offset=6: max error per batch row [9.6e-07 9.0e-07]
shape (2, 1, 1, 64)  traditional=True  offset=6: max error per batch row [5.7e-07 4.6e+00]
```

MLX 0.32.3 (all rows correct):

```text
shape (2, 4, 1, 64)  traditional=True  offset=0: max error per batch row [0. 0.]
shape (2, 4, 1, 64)  traditional=True  offset=6: max error per batch row [5.e-07 2.e-06]
shape (2, 4, 1, 64)  traditional=False offset=6: max error per batch row [1.2e-06 1.1e-06]
```

Bisect on `shape (2, 4, 1, 64), traditional=True, offset=6`, error of batch row 1:

| MLX | Row 1 error | Result |
|---|---|---|
| 0.30.6 | 4.9 | wrong |
| 0.31.0 | 4.9 | wrong |
| 0.31.1 | 4.9 | wrong |
| 0.31.2 | 4.9 | wrong |
| 0.32.0 | 2e-06 | correct |
| 0.32.3 | 2e-06 | correct |

## How we found it

1. The MuLaCover MLX port uses classifier-free guidance with batch 2, and it decodes one 80 ms frame per step.
   That is the shape `(2, H, 1, D)`.
2. Replacing a hand-written RoPE with `mx.fast.rope` (for speed) made one cross-attention test fail at the
   first decode step, by a small amount.
3. The equivalent self-attention test still passed. The cause: the tests used small random weights, so the
   attention was almost uniform and a wrong rotation hardly changed the output.
4. A comparison with a float64 numpy rotation showed the fused kernel wrong for batch rows ≥ 1 at length 1.
   A test with sharp attention (q/k weights × 12) then failed at the first decode step, as it must.

## Workaround in gb-mcp

Fold the batch into the head axis before the fused call. MLX is correct for batch 1.

```python
def rope_heads(x, offset, theta):
    b, h, s, d = x.shape
    out = mx.fast.rope(x.reshape(1, b * h, s, d), d, traditional=True, base=None, scale=1.0,
                       offset=offset, freqs=1.0 / theta)
    return out.reshape(b, h, s, d)
```

- File: `models/mulacover_mlx/llama.py` (`rope_heads`).
- Check: 72 shape cases (batch 1–3, length 1–74, offset 0–500, head size 8–128) within 2.4e-7 of the reference.
- Test: `models/mulacover_mlx/tests/test_llama.py`, `SharpAttentionMatches`. It fails on the faulty kernel and
  passes with the workaround.
- The workaround is also correct on MLX ≥ 0.32.0, so it can stay after an upgrade.

## Impact on gb-mcp

| Component | MLX | Affected? |
|---|---|---|
| MuLaCover MLX port (`models/mulacover_mlx`) | 0.30.6 | Yes: batch-2 decode. Fixed by the workaround (the first version of the port used a hand-written RoPE and was correct). |
| ACE-Step 1.5 LM (M12a) | 0.30.6 | No. Its guidance uses two separate batch-1 caches. Its batch path runs only for `batch_size ≥ 2`, and M12a used 1. |
| ACE-Step 1.5 DiT (M12a) | 0.30.6 | No. It runs full sequences (length > 1). |

## Recommendations

1. Done: MuLaCover's venv is on MLX 0.32.3. The repro, the 12 port tests and the greedy comparison with the
   authors' model all pass; tokens got 30 % faster (0.21 → 0.148 s per frame). MLX 0.32 also changed its random-number
   stream (seed 42 draws 7647 on 0.30.6, 7496 on 0.32.3), so a seed reproduces a song only on the same MLX version.
   The workaround and the sharp-attention test stay.
2. Leave ACE-Step's venv on its locked version (0.30.6). It is not affected.
3. Tests for attention code must use sharp attention (scaled q/k weights). Small random weights hide position errors.
4. Check fused kernels against an independent reference (numpy) for the exact decode shape, not only for prefill.
