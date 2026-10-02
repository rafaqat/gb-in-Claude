# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""ITU-R BS.1770-4 loudness, true peak and level statistics (numpy/scipy only)."""
import numpy as np

# K-weighting stage parameters (De Man's derivation of the BS.1770 filters; exact ITU
# coefficients at 48 kHz, and valid at any sample rate).
_SHELF_GAIN_DB = 3.999843853973347
_SHELF_Q = 0.7071752369554196
_SHELF_FC = 1681.974450955533
_HP_Q = 0.5003270373238773
_HP_FC = 38.13547087602444


def k_weighting_coefficients(rate: float):
    """Return ((b, a) high-shelf, (b, a) high-pass) biquads for the K-weighting filter."""
    k = np.tan(np.pi * _SHELF_FC / rate)
    vh = 10.0 ** (_SHELF_GAIN_DB / 20.0)
    vb = vh ** 0.4996667741545416
    a0 = 1.0 + k / _SHELF_Q + k * k
    shelf_b = np.array([(vh + vb * k / _SHELF_Q + k * k) / a0, 2.0 * (k * k - vh) / a0, (vh - vb * k / _SHELF_Q + k * k) / a0])
    shelf_a = np.array([1.0, 2.0 * (k * k - 1.0) / a0, (1.0 - k / _SHELF_Q + k * k) / a0])

    k = np.tan(np.pi * _HP_FC / rate)
    d = 1.0 + k / _HP_Q + k * k
    hp_b = np.array([1.0, -2.0, 1.0])
    hp_a = np.array([1.0, 2.0 * (k * k - 1.0) / d, (1.0 - k / _HP_Q + k * k) / d])
    return (shelf_b, shelf_a), (hp_b, hp_a)


_BLOCK_SECONDS = 0.4
_STEP_SECONDS = 0.1  # 75 % overlap
_ABSOLUTE_GATE_LUFS = -70.0
_RELATIVE_GATE_LU = -10.0


def _k_weighted(x: np.ndarray, rate: float) -> np.ndarray:
    from scipy.signal import lfilter

    (b1, a1), (b2, a2) = k_weighting_coefficients(rate)
    return lfilter(b2, a2, lfilter(b1, a1, x, axis=0), axis=0)


def _block_powers(x: np.ndarray, rate: float) -> np.ndarray:
    """Mean square per channel of each 400 ms block (75 % overlap), K-weighted. Shape [blocks, channels]."""
    y = _k_weighted(x, rate)
    block, step = int(round(_BLOCK_SECONDS * rate)), int(round(_STEP_SECONDS * rate))
    if len(y) < block:
        return np.empty((0, y.shape[1]))
    # cumulative sum of squares → O(n) block means
    csum = np.vstack([np.zeros((1, y.shape[1])), np.cumsum(y ** 2, axis=0)])
    starts = np.arange(0, len(y) - block + 1, step)
    return (csum[starts + block] - csum[starts]) / block


def _loudness(power_sum: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore"):
        return -0.691 + 10.0 * np.log10(power_sum)


def integrated_lufs(x: np.ndarray, rate: float):
    """Gated integrated loudness (BS.1770-4) of mono/stereo audio [n, ch]; None if nothing passes the gates."""
    z = _block_powers(x, rate)
    if len(z) == 0:
        return None
    block_loudness = _loudness(z.sum(axis=1))  # channel weights G = 1 for L/R/mono
    above_abs = block_loudness > _ABSOLUTE_GATE_LUFS
    if not above_abs.any():
        return None
    relative_gate = _loudness(z[above_abs].mean(axis=0).sum()) + _RELATIVE_GATE_LU
    gated = above_abs & (block_loudness > relative_gate)
    return float(_loudness(z[gated].mean(axis=0).sum()))


_OVERSAMPLE = 4
_TP_CHUNK = 1 << 16  # input samples per chunk (bounded memory on long songs)
_TP_PAD = 128  # input samples of context on each side of a chunk (resampling filter edges)
_CLIP_LEVEL = 0.999
_CLIP_RUN = 3  # consecutive near-full-scale samples that indicate clipping


def _db(v):
    return None if v <= 0 else float(20.0 * np.log10(v))


def true_peak(x: np.ndarray) -> float:
    """Max |x| after 4x polyphase oversampling (BS.1770 Annex 2 style), processed in chunks."""
    from scipy.signal import resample_poly

    peak = 0.0
    for start in range(0, len(x), _TP_CHUNK):
        lo, hi = max(0, start - _TP_PAD), min(len(x), start + _TP_CHUNK + _TP_PAD)
        up = resample_poly(x[lo:hi], _OVERSAMPLE, 1, axis=0)
        keep = up[(start - lo) * _OVERSAMPLE:(min(len(x), start + _TP_CHUNK) - lo) * _OVERSAMPLE]
        if keep.size:
            peak = max(peak, float(np.max(np.abs(keep))))
    return peak


def _clip_runs(x: np.ndarray) -> tuple[int, int]:
    hot = np.abs(x) >= _CLIP_LEVEL
    runs = 0
    for ch in range(x.shape[1]):
        h = np.concatenate([[False], hot[:, ch], [False]]).astype(np.int8)
        edges = np.diff(h)
        lengths = np.flatnonzero(edges == -1) - np.flatnonzero(edges == 1)
        runs += int(np.sum(lengths >= _CLIP_RUN))
    return int(hot.sum()), runs


def levels(x: np.ndarray, rate: float) -> dict:
    """Sample peak, true peak, RMS, crest factor and clipping statistics."""
    sample_peak = float(np.max(np.abs(x))) if x.size else 0.0
    rms = float(np.sqrt(np.mean(x ** 2))) if x.size else 0.0
    clipped, runs = _clip_runs(x) if x.size else (0, 0)
    peak_db, rms_db = _db(sample_peak), _db(rms)
    return {
        "sample_peak_dbfs": peak_db,
        "true_peak_dbtp": _db(true_peak(x)) if sample_peak > 0 else None,
        "rms_dbfs": rms_db,
        "crest_db": None if peak_db is None or rms_db is None else peak_db - rms_db,
        "clipped_samples": clipped,
        "clip_runs": runs,
    }
