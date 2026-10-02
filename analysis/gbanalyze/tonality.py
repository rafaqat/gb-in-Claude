# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Chroma and key estimation (Krumhansl–Kessler profiles), numpy/scipy only."""
import re
import numpy as np

TONICS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
_LETTERS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
_CHROMA_RANGE = (100.0, 5000.0)  # below ~100 Hz semitones are closer than the FFT bins


def chroma(x: np.ndarray, rate: float) -> np.ndarray | None:
    """Average pitch-class profile (12 values, sums to 1) from the long-term amplitude spectrum."""
    from scipy.signal import welch

    mono = x.mean(axis=1)
    if len(mono) < 8192 or not np.any(mono):
        return None
    f, p = welch(mono, fs=rate, nperseg=16384 if rate > 48000 else 8192, window="hann")
    keep = (f >= _CHROMA_RANGE[0]) & (f <= _CHROMA_RANGE[1])
    pitch_class = np.mod(np.round(12 * np.log2(f[keep] / 440.0) + 69).astype(int), 12)
    profile = np.bincount(pitch_class, weights=np.sqrt(p[keep]), minlength=12)
    total = profile.sum()
    return profile / total if total > 0 else None


def estimate_key(x: np.ndarray, rate: float) -> dict:
    c = chroma(x, rate)
    if c is None:
        return {"key": None, "confidence": None, "chroma": None}
    scores = []
    for tonic in range(12):
        for mode, profile in (("major", _MAJOR), ("minor", _MINOR)):
            scores.append((float(np.corrcoef(c, np.roll(profile, tonic))[0, 1]), f"{TONICS[tonic]} {mode}"))
    scores.sort(reverse=True)
    return {"key": scores[0][1], "confidence": scores[0][0] - scores[1][0], "chroma": [float(v) for v in c]}


def parse_key(name: str):
    """'F minor' / 'Ab major' / 'C# minor' → (pitch class, mode); None if not a major/minor key."""
    m = re.fullmatch(r"\s*([A-Ga-g])([#b]?)\s+(major|minor)\s*", name or "")
    if not m:
        return None
    letter, accidental, mode = m.groups()
    pc = (_LETTERS[letter.upper()] + {"#": 1, "b": -1, "": 0}[accidental]) % 12
    return pc, mode


def key_relation(declared: str, estimated: str) -> str | None:
    a, b = parse_key(declared), parse_key(estimated)
    if a is None or b is None:
        return None
    if a == b:
        return "match"
    if a[0] == b[0]:
        return "parallel"
    major, minor = (a, b) if a[1] == "major" else (b, a)
    if major[1] == "major" and minor[1] == "minor" and (minor[0] + 3) % 12 == major[0]:
        return "relative"
    return "mismatch"
