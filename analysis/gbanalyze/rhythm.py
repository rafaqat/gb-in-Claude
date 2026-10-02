# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Onsets, tempo and sidechain-pump detection (numpy/scipy only)."""
import numpy as np

FRAME_RATE = 100.0  # onset-envelope frames per second (10 ms hop)
_N_FFT = 2048
_BPM_RANGE = (60.0, 200.0)
_PRIOR_CENTER_BPM = 120.0
_MATCH_TOLERANCE = 0.02  # 2 %
# factor applied to the estimate → name (how the estimate relates to the intended tempo)
_FOLDS = ((1.0, "same"), (0.5, "half"), (2.0, "double"), (2.0 / 3.0, "two_thirds"), (1.5, "three_halves"))


def onset_envelope(x: np.ndarray, rate: float) -> np.ndarray:
    """Spectral-flux onset strength at FRAME_RATE, computed in bounded-memory chunks."""
    mono = x.mean(axis=1) if x.ndim == 2 else x
    hop = int(round(rate / FRAME_RATE))
    n_frames = max(0, 1 + (len(mono) - _N_FFT) // hop)
    if n_frames < 2:
        return np.zeros(0)
    window = np.hanning(_N_FFT).astype(np.float32)
    env = np.zeros(n_frames)
    previous = None
    chunk = 2048
    for first in range(0, n_frames, chunk):
        idx = np.arange(first, min(n_frames, first + chunk))
        frames = np.stack([mono[i * hop:i * hop + _N_FFT] for i in idx]).astype(np.float32) * window
        mag = np.log1p(10.0 * np.abs(np.fft.rfft(frames, axis=1)))
        stacked = mag if previous is None else np.vstack([previous, mag])
        flux = np.maximum(0.0, np.diff(stacked, axis=0)).sum(axis=1)
        if previous is None:
            env[idx[1:]] = flux
        else:
            env[idx] = flux
        previous = mag[-1:]
    return env


def _moving(values: np.ndarray, width: int, fn) -> np.ndarray:
    from scipy.ndimage import median_filter, uniform_filter1d

    return median_filter(values, size=width, mode="nearest") if fn == "median" else uniform_filter1d(values, size=width, mode="nearest")


def onset_times(x: np.ndarray, rate: float) -> np.ndarray:
    env = onset_envelope(x, rate)
    if env.size == 0 or env.max() <= 0:
        return np.zeros(0)
    e = env / env.max()
    threshold = _moving(e, int(0.5 * FRAME_RATE), "median") + 0.05
    peaks = []
    for i in range(1, len(e) - 1):
        lo, hi = max(0, i - 3), min(len(e), i + 4)
        if e[i] >= threshold[i] and e[i] == e[lo:hi].max() and (not peaks or i - peaks[-1] >= 5):
            peaks.append(i)
    return np.array(peaks) / FRAME_RATE


def onset_density(x: np.ndarray, rate: float) -> float:
    seconds = len(x) / rate
    return float(len(onset_times(x, rate)) / seconds) if seconds > 0 else 0.0


def _parabolic(y: np.ndarray, i: int) -> float:
    if 0 < i < len(y) - 1:
        a, b, c = y[i - 1], y[i], y[i + 1]
        denom = a - 2 * b + c
        if denom != 0:
            return i + 0.5 * (a - c) / denom
    return float(i)


def tempo(x: np.ndarray, rate: float, intended_bpm: float | None = None) -> dict:
    """Autocorrelation tempo of the onset envelope, refined on the 1-bar lag; optional octave folding."""
    none = {"bpm": None, "bpm_folded": None, "relation_to_intended": None, "matches_intended": None, "confidence": None}
    env = onset_envelope(x, rate)
    if env.size < FRAME_RATE * 4 or env.max() <= 0:
        return none
    e = env - _moving(env, int(FRAME_RATE), "mean")
    n = len(e)
    spectrum = np.fft.rfft(e, 2 * n)
    ac = np.fft.irfft(np.abs(spectrum) ** 2)[:n]
    if ac[0] <= 0:
        return none
    ac /= ac[0]
    lag_lo, lag_hi = int(FRAME_RATE * 60 / _BPM_RANGE[1]), int(FRAME_RATE * 60 / _BPM_RANGE[0]) + 1
    lags = np.arange(max(1, lag_lo), min(n - 1, lag_hi))
    bpms = 60.0 * FRAME_RATE / lags
    prior = np.exp(-0.5 * np.log2(bpms / _PRIOR_CENTER_BPM) ** 2)
    best = int(lags[np.argmax(ac[lags] * prior)])
    lag = _parabolic(ac, best)
    bar = int(round(4 * lag))  # refine on the 4-beat lag: 4x the resolution
    if bar + 2 < n:
        window = np.arange(bar - 2, bar + 3)
        peak = int(window[np.argmax(ac[window])])
        if ac[peak] > 0.3 * ac[best]:
            lag = _parabolic(ac, peak) / 4.0
    bpm = 60.0 * FRAME_RATE / lag
    out = {**none, "bpm": float(bpm), "confidence": float(ac[best])}
    if intended_bpm:
        factor, name = min(_FOLDS, key=lambda f: abs(bpm * f[0] - intended_bpm) / intended_bpm)
        folded = bpm * factor
        out.update(bpm_folded=float(folded), relation_to_intended=name,
                   matches_intended=bool(abs(folded - intended_bpm) / intended_bpm <= _MATCH_TOLERANCE))
    return out


_PUMP_BAND = (250.0, 2500.0)  # where pads/strings live
_KICK_BAND = (40.0, 120.0)
_ENV_RATE = 200.0  # envelope frames per second
_PHASE_BINS = 24
_PUMP_MIN_DEPTH_DB = 3.0
_PUMP_MAX_TROUGH_PHASE = 0.3  # the dip comes right after the kick …
_PUMP_MIN_PEAK_PHASE = 0.45  # … and the level recovers later in the beat
_PUMP_MIN_STRENGTH = 0.2


def _band_envelope(mono: np.ndarray, rate: float, band) -> np.ndarray:
    from scipy.signal import butter, sosfilt

    y = sosfilt(butter(6, band, btype="bandpass", fs=rate, output="sos"), mono)
    hop = int(round(rate / _ENV_RATE))
    n = len(y) // hop
    return (y[: n * hop] ** 2).reshape(n, hop).mean(axis=1)


def _fold(power: np.ndarray, period_frames: float):
    phase = (np.arange(len(power)) + 0.5) / period_frames % 1.0
    bins = np.minimum((phase * _PHASE_BINS).astype(int), _PHASE_BINS - 1)
    folded = np.array([power[bins == b].mean() if np.any(bins == b) else 0.0 for b in range(_PHASE_BINS)])
    return folded, bins


def pump(x: np.ndarray, rate: float, bpm: float | None) -> dict:
    """Beat-synchronous envelope of the pad band: a dip right after the kick that recovers = sidechain pump."""
    none = {"detected": None, "depth_db": None, "trough_phase": None, "peak_phase": None, "strength": None}
    mono = x.mean(axis=1)
    if not bpm or not np.any(mono):
        return none
    period = 60.0 / bpm * _ENV_RATE
    mid = _band_envelope(mono, rate, _PUMP_BAND)
    low = _band_envelope(mono, rate, _KICK_BAND)
    if len(mid) < 4 * period or mid.max() <= 0:
        return none
    floor = mid.max() * 1e-9
    mid_folded, bins = _fold(mid, period)
    low_folded, _ = _fold(low, period)
    # phase reference = the kick (strongest low-band point of the beat) when there is one
    low_db = 10 * np.log10(low_folded + floor)
    reference = int(np.argmax(low_folded)) if low_db.max() - low_db.min() >= 6.0 else 0
    rotated = np.roll(mid_folded, -reference)
    db = 10 * np.log10(rotated + floor)
    trough, peak = int(np.argmin(db)), int(np.argmax(db))
    depth = float(db[peak] - db[trough])
    env_db = 10 * np.log10(mid + floor)
    pattern = (10 * np.log10(mid_folded + floor))[bins]
    var = np.var(env_db)
    strength = float(1.0 - np.var(env_db - pattern) / var) if var > 0 else 0.0
    trough_phase, peak_phase = (trough + 0.5) / _PHASE_BINS, (peak + 0.5) / _PHASE_BINS
    detected = (depth >= _PUMP_MIN_DEPTH_DB and trough_phase <= _PUMP_MAX_TROUGH_PHASE
                and peak_phase >= _PUMP_MIN_PEAK_PHASE and strength >= _PUMP_MIN_STRENGTH)
    return {"detected": bool(detected), "depth_db": depth, "trough_phase": trough_phase,
            "peak_phase": peak_phase, "strength": strength}


_THUMP_BAND = (40.0, 120.0)
_HIT_WINDOW = 0.2  # the kick's share of the beat


def kick_thump(x: np.ndarray, rate: float, bpm: float | None, beat_phase: float | None = None) -> dict:
    """How hard the kick band punches on the beat: folded 40–120 Hz envelope peak vs its median (dB),
    plus the band's share of total energy. Held bass between kicks lowers the punch (less thumpy).
    beat_phase: where the beat starts within the folded period (0.0 when x starts on a bar line). When given, the
    hit window is locked to the beat — a loud offbeat bass is then never mistaken for the kick."""
    none = {"punch_db": None, "kick_band_share": None, "hit_share": None}
    mono = x.mean(axis=1)
    if not bpm or not np.any(mono):
        return none
    period = 60.0 / bpm * _ENV_RATE
    band = _band_envelope(mono, rate, _THUMP_BAND)
    if len(band) < 4 * period or band.max() <= 0:
        return none
    folded, _ = _fold(band, period)
    floor = band.max() * 1e-9
    db = 10 * np.log10(folded + floor)
    total = float(np.mean(mono ** 2))
    # energy in the hit window above the band's own average, as a share of the whole mix:
    # a held bass is flat over the beat (≈ 0); a kick piles energy into the first fifth of the beat
    hit_bins = max(1, int(round(_HIT_WINDOW * _PHASE_BINS)))
    start = int(round(beat_phase * _PHASE_BINS)) % _PHASE_BINS if beat_phase is not None else int(np.argmax(folded))
    hits = np.roll(folded, -start)[:hit_bins]
    excess = float(np.sum(np.maximum(0.0, hits - folded.mean())) / _PHASE_BINS)
    return {
        "punch_db": float(db.max() - np.median(db)),
        "kick_band_share": float(band.mean() / total) if total > 0 else None,
        "hit_share": excess / total if total > 0 else None,
    }
