# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""How far forward the drums sit: median-filter harmonic/percussive separation (Fitzgerald 2010) with
Driedger's separation margin (beta = 2, binary masks, residual excluded), numpy/scipy only.

percussive_ratio_db — percussive vs harmonic energy (+6 dB of drums reads as +6 dB here).
Low, narrowband kicks are invisible to this method; kick "thump" is rhythm.kick_thump.
"""
import numpy as np

_TARGET_RATE = 22050.0  # analysis rate: plenty for drums vs harmony, 4x cheaper than 44.1/48 kHz
_N_FFT = 1024
_HOP = 512
_KERNEL = 17  # median-filter length in frames (time) and bins (frequency)
_MARGIN = 2.0
_EPS = 1e-12


def _magnitude(mono: np.ndarray) -> np.ndarray:
    """|STFT| as [freq, time] float32, built in chunks to bound memory."""
    n_frames = 1 + (len(mono) - _N_FFT) // _HOP
    window = np.hanning(_N_FFT).astype(np.float32)
    columns = []
    for first in range(0, n_frames, 4096):
        idx = range(first, min(n_frames, first + 4096))
        frames = np.stack([mono[i * _HOP:i * _HOP + _N_FFT] for i in idx]).astype(np.float32) * window
        columns.append(np.abs(np.fft.rfft(frames, axis=1)).T)
    return np.hstack(columns)


def drum_balance(x: np.ndarray, rate: float) -> dict:
    from scipy.ndimage import median_filter
    from scipy.signal import resample_poly

    none = {"percussive_ratio_db": None}
    mono = x.mean(axis=1)
    if rate > 1.5 * _TARGET_RATE:
        factor = int(round(rate / _TARGET_RATE))
        mono, rate = resample_poly(mono, 1, factor), rate / factor
    if len(mono) < _N_FFT * 4 or not np.any(mono):
        return none
    s = _magnitude(mono)
    harmonic = median_filter(s, size=(1, _KERNEL), mode="nearest")  # steady over time
    percussive = median_filter(s, size=(_KERNEL, 1), mode="nearest")  # broadband in one instant
    power = s ** 2
    e_p = float(power[percussive > _MARGIN * harmonic].sum())
    e_h = float(power[harmonic >= _MARGIN * percussive].sum())
    if e_p + e_h <= 0:
        return none
    return {"percussive_ratio_db": float(10 * np.log10((e_p + _EPS) / (e_h + _EPS)))}
