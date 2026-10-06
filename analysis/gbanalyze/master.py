# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""A mastered copy (M13.2): gain to a loudness target (BS.1770 integrated), then a true-peak limiter under a ceiling.

The limiter needs no state machine: the gain each sample needs is ceiling / its 4x-oversampled peak; a minimum filter
(2 x ramp + hold) followed by a moving average (ramp) never rises above the need at a peak, because every sample the
average reads lies inside the minimum's window. Limiting lowers the loudness, so gain and limiter run again (at most 4
passes) until the loudness is within 0.2 LU of the target. The written file is read back and measured.
"""
import os

import numpy as np
import soundfile as sf

from .loudness import integrated_lufs, true_peak, _OVERSAMPLE, _TP_CHUNK, _TP_PAD

RAMP_S = 0.010  # the gain moves over 10 ms (attack and release)
HOLD_S = 0.040  # and holds 40 ms around a peak (less pumping on bass)
PASSES = 4


def _db(v: float) -> float | None:
    return None if v <= 0 else float(20.0 * np.log10(v))


def _peak_per_sample(x: np.ndarray) -> np.ndarray:
    """Per original sample: the largest |x| among its 4 oversampled points, over all channels (chunked)."""
    from scipy.signal import resample_poly

    out = np.empty(len(x))
    for start in range(0, len(x), _TP_CHUNK):
        lo, hi = max(0, start - _TP_PAD), min(len(x), start + _TP_CHUNK + _TP_PAD)
        end = min(len(x), start + _TP_CHUNK)
        up = np.abs(resample_poly(x[lo:hi], _OVERSAMPLE, 1, axis=0))
        keep = up[(start - lo) * _OVERSAMPLE:(end - lo) * _OVERSAMPLE].max(axis=1)
        out[start:end] = np.maximum(keep.reshape(-1, _OVERSAMPLE).max(axis=1), np.abs(x[start:end]).max(axis=1))
    return out


def limit(x: np.ndarray, rate: float, ceiling: float) -> tuple[np.ndarray, float]:
    """x under `ceiling` (linear, true peak). Returns the limited signal and the largest gain reduction in dB."""
    from scipy.ndimage import minimum_filter1d, uniform_filter1d

    need = np.minimum(1.0, ceiling / np.maximum(_peak_per_sample(x), 1e-12))
    if need.min() >= 1.0:
        return x, 0.0
    ramp = max(1, int(round(RAMP_S * rate)))
    hold = int(round(HOLD_S * rate))
    held = minimum_filter1d(need, size=2 * ramp + hold, mode="nearest")
    gain = np.minimum(uniform_filter1d(held, size=ramp, mode="nearest"), held.max())
    gain = np.minimum(gain, need)  # rounding in the moving average must never let a peak through
    return x * gain[:, None], float(-20.0 * np.log10(gain.min()))


def master(src: str, out: str, lufs: float = -14.0, peak_db: float = -1.0) -> dict:
    x, rate = sf.read(src, always_2d=True, dtype="float64")
    before_lufs = integrated_lufs(x, rate)
    if before_lufs is None:
        raise ValueError("the input is silent: no loudness to master")
    before = {"lufs": round(before_lufs, 2), "true_peak_db": _db(true_peak(x))}
    ceiling = 10.0 ** (peak_db / 20.0)
    y, reduction, now = x, 0.0, before_lufs
    for _ in range(PASSES):
        y = y * 10.0 ** ((lufs - now) / 20.0)
        y, r = limit(y, rate, ceiling * 0.999)  # 0.01 dB margin for the 24-bit rounding
        reduction = max(reduction, r)
        now = integrated_lufs(y, rate)
        if abs(now - lufs) <= 0.2:
            break
    info = sf.info(src)
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)  # never overwrite
    with os.fdopen(fd, "wb") as fh:
        sf.write(fh, y, rate, subtype="PCM_24", format="WAV")
    z, zr = sf.read(out, always_2d=True, dtype="float64")  # read back: the numbers describe the written file
    after = {"lufs": round(integrated_lufs(z, zr), 2), "true_peak_db": _db(true_peak(z))}
    warnings = []
    if reduction > 6.0:
        warnings.append(f"the limiter takes up to {reduction:.1f} dB off the loudest peaks: a lower target (e.g. {lufs - 2:.0f} LUFS) keeps more punch")
    if abs(after["lufs"] - lufs) > 0.5:
        warnings.append(f"the loudness ends at {after['lufs']} LUFS, not {lufs}: the ceiling holds it back")
    return {"path": out, "rate": rate, "bits": 24, "seconds": round(len(z) / zr, 3), "source_subtype": info.subtype,
            "target": {"lufs": lufs, "true_peak_db": peak_db}, "before": before, "after": after,
            "gain_db": round(after["lufs"] - before["lufs"], 2), "limiter_max_reduction_db": round(reduction, 2), "warnings": warnings}
