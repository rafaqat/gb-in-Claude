# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Tonal balance, spectral tilt, centroid and stereo width (numpy/scipy only)."""
import numpy as np

# Mix bands (Hz). "Tinny" = little energy in sub+low and a high centroid / flat-or-rising tilt.
BANDS = {
    "sub": (20.0, 60.0),
    "low": (60.0, 250.0),
    "mid": (250.0, 2000.0),
    "presence": (2000.0, 6000.0),
    "air": (6000.0, 20000.0),
}
_OCTAVE_CENTERS = (63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0)
_FULL_RANGE = (20.0, 20000.0)


def _psd(mono: np.ndarray, rate: float):
    from scipy.signal import welch

    nperseg = min(len(mono), 16384 if rate > 48000 else 8192)
    return welch(mono, fs=rate, nperseg=nperseg, window="hann", scaling="density")


def _band_power(f: np.ndarray, p: np.ndarray, lo: float, hi: float) -> float:
    mask = (f >= lo) & (f < min(hi, f[-1]))
    return float(p[mask].sum() * (f[1] - f[0]))


def _db_or_none(v: float):
    return None if v <= 0 else float(10.0 * np.log10(v))


def tonal_balance(x: np.ndarray, rate: float) -> dict:
    """Band energy shares of the mono mix, octave-band tilt (dB/oct, pink = 0) and spectral centroid."""
    mono = x.mean(axis=1)
    empty = {"bands": {name: {"share": None, "db": None} for name in BANDS}, "tilt_db_per_octave": None, "centroid_hz": None}
    if len(mono) < 1024 or not np.any(mono):
        return empty
    f, p = _psd(mono, rate)
    total = _band_power(f, p, *_FULL_RANGE)
    if total <= 0:
        return empty
    bands = {}
    for name, (lo, hi) in BANDS.items():
        share = _band_power(f, p, lo, hi) / total
        bands[name] = {"share": share, "db": _db_or_none(share)}

    centers, octave_db = [], []
    for c in _OCTAVE_CENTERS:
        lo, hi = c / np.sqrt(2.0), c * np.sqrt(2.0)
        if hi > f[-1]:
            continue
        power = _band_power(f, p, lo, hi)
        if power > 0:
            centers.append(c)
            octave_db.append(10.0 * np.log10(power))
    tilt = float(np.polyfit(np.log2(centers), octave_db, 1)[0]) if len(centers) >= 3 else None

    in_range = (f >= _FULL_RANGE[0]) & (f < _FULL_RANGE[1])
    centroid = float(np.sum(f[in_range] * p[in_range]) / np.sum(p[in_range]))
    return {"bands": bands, "tilt_db_per_octave": tilt, "centroid_hz": centroid}


WIDTH_BANDS = {"low": (20.0, 150.0), "mid": (150.0, 4000.0), "high": (4000.0, 20000.0)}


def stereo_width(x: np.ndarray, rate: float) -> dict:
    """Side/(mid+side) energy ratio overall and per band: 0 = mono, 0.5 = uncorrelated, 1 = out of phase."""
    if x.shape[1] < 2:
        return {"mono_source": True, "overall": 0.0, "bands": {name: 0.0 for name in WIDTH_BANDS}}
    mid, side = (x[:, 0] + x[:, 1]) / 2.0, (x[:, 0] - x[:, 1]) / 2.0
    if not np.any(mid) and not np.any(side):
        return {"mono_source": False, "overall": None, "bands": {name: None for name in WIDTH_BANDS}}
    f, pm = _psd(mid, rate)
    _, ps = _psd(side, rate)

    def ratio(lo, hi):
        m, s = _band_power(f, pm, lo, hi), _band_power(f, ps, lo, hi)
        return None if m + s <= 0 else s / (m + s)

    return {
        "mono_source": False,
        "overall": ratio(*_FULL_RANGE),
        "bands": {name: ratio(lo, hi) for name, (lo, hi) in WIDTH_BANDS.items()},
    }
