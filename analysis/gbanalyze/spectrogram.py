# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Spectrogram PNG (log-frequency, dB) with section markers. Exclusive create: never overwrites."""
import numpy as np

_MAX_COLUMNS = 1600
_F_RANGE = (30.0, 16000.0)
_DB_RANGE = 80.0


def write_spectrogram(x: np.ndarray, rate: float, path, sections=(), title: str = "") -> None:
    from pathlib import Path

    if Path(path).exists():  # fail fast; the exclusive open below is the race-safe guard
        raise FileExistsError(str(path))
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from scipy.signal import spectrogram

    mono = x.mean(axis=1)
    nperseg = 4096
    hop = max(nperseg // 4, int(np.ceil(len(mono) / _MAX_COLUMNS)))
    f, t, s = spectrogram(mono, fs=rate, nperseg=nperseg, noverlap=max(0, nperseg - hop), scaling="spectrum", mode="psd")
    keep = (f >= _F_RANGE[0]) & (f <= min(_F_RANGE[1], rate / 2))
    db = 10 * np.log10(s[keep] + 1e-20)
    top = db.max() if db.size else 0.0

    fig, ax = plt.subplots(figsize=(16, 6), dpi=100)
    ax.pcolormesh(t, f[keep], db, shading="auto", cmap="magma", vmin=top - _DB_RANGE, vmax=top)
    ax.set_yscale("log")
    ax.set_ylim(*_F_RANGE)
    ax.set_xlabel("seconds")
    ax.set_ylabel("Hz")
    ax.set_title(title or "spectrogram")
    for name, start, _end in sections:
        ax.axvline(start, color="cyan", linewidth=0.8, alpha=0.8)
        ax.text(start, _F_RANGE[1] * 0.8, f" {name}", color="cyan", fontsize=8, va="top")
    fig.tight_layout()
    with open(path, "xb") as fh:  # exclusive create: refuses to overwrite
        fig.savefig(fh, format="png")
    plt.close(fig)
