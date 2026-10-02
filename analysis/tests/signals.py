# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Deterministic synthetic test signals (float64, shape [n, channels])."""
import numpy as np

SR = 48000


def sine(freq, seconds, dbfs=-20.0, sr=SR, channels=2):
    t = np.arange(int(seconds * sr)) / sr
    x = (10 ** (dbfs / 20.0)) * np.sin(2 * np.pi * freq * t)
    return np.tile(x[:, None], (1, channels))


def silence(seconds, sr=SR, channels=2):
    return np.zeros((int(seconds * sr), channels))


def noise(seconds, dbfs_rms=-20.0, sr=SR, channels=2, seed=1, color="white"):
    rng = np.random.default_rng(seed)
    n = int(seconds * sr)
    x = rng.standard_normal((n, channels))
    if color == "pink":
        spec = np.fft.rfft(x, axis=0)
        f = np.fft.rfftfreq(n, 1 / sr)
        f[0] = f[1]
        spec /= np.sqrt(f)[:, None]
        x = np.fft.irfft(spec, n=n, axis=0)
    x /= np.sqrt(np.mean(x ** 2))
    return x * 10 ** (dbfs_rms / 20.0)


def clicks(bpm, seconds, sr=SR, channels=2, freq=1000.0, decay=0.004, level=0.5, offset_beats=0.0, every=1.0):
    """Short decaying tone bursts every `every` beats (starting at offset_beats)."""
    n = int(seconds * sr)
    x = np.zeros(n)
    period = 60.0 / bpm * every
    burst_t = np.arange(int(0.05 * sr)) / sr
    burst = level * np.exp(-burst_t / decay) * np.sin(2 * np.pi * freq * burst_t)
    t0 = offset_beats * 60.0 / bpm
    while t0 < seconds:
        i = int(round(t0 * sr))
        m = min(len(burst), n - i)
        if m > 0:
            x[i:i + m] += burst[:m]
        t0 += period
    return np.tile(x[:, None], (1, channels))


def kick(bpm, seconds, sr=SR, channels=2, level=0.8):
    """Four-on-the-floor sine kick (pitch drop 110→50 Hz, ~200 ms)."""
    n = int(seconds * sr)
    x = np.zeros(n)
    t = np.arange(int(0.2 * sr)) / sr
    freq = 50 + 60 * np.exp(-t / 0.03)
    phase = 2 * np.pi * np.cumsum(freq) / sr
    hit = level * np.exp(-t / 0.08) * np.sin(phase)
    period = 60.0 / bpm
    t0 = 0.0
    while t0 < seconds:
        i = int(round(t0 * sr))
        m = min(len(hit), n - i)
        x[i:i + m] += hit[:m]
        t0 += period
    return np.tile(x[:, None], (1, channels))


def pad(seconds, sr=SR, channels=2, level=0.15, freqs=(311.13, 392.0, 466.16, 622.25)):
    """Steady chord pad in the mid band (Eb major-ish), slight detune for width."""
    t = np.arange(int(seconds * sr)) / sr
    left = sum(np.sin(2 * np.pi * f * t) for f in freqs)
    right = sum(np.sin(2 * np.pi * f * 1.003 * t) for f in freqs)
    x = np.stack([left, right], axis=1)[:, :channels] * level / len(freqs)
    return x


def ducking(bpm, seconds, sr=SR, depth=0.75, recovery=0.12):
    """Sidechain gain curve: dips to (1-depth) at each beat, recovers exponentially."""
    t = np.arange(int(seconds * sr)) / sr
    phase_s = np.mod(t, 60.0 / bpm)
    return (1.0 - depth * np.exp(-phase_s / recovery))[:, None]


def chord_tones(midi_notes, seconds, sr=SR, channels=2, level=0.1):
    """Sum of sine partials (fundamental + 2 harmonics) for each MIDI note."""
    t = np.arange(int(seconds * sr)) / sr
    x = np.zeros_like(t)
    for m in midi_notes:
        f = 440.0 * 2 ** ((m - 69) / 12)
        x += np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * 2 * f * t) + 0.25 * np.sin(2 * np.pi * 3 * f * t)
    return np.tile((level * x / len(midi_notes))[:, None], (1, channels))


def progression(chords, seconds_each, repeats=2):
    return np.vstack([chord_tones(c, seconds_each) for _ in range(repeats) for c in chords])


def bass_line(bpm, seconds, sr=SR, channels=2, freq=43.65, level=0.35):
    """Offbeat saw-ish bass (F1), low-passed: real low end."""
    from scipy.signal import butter, sosfilt
    n = int(seconds * sr)
    t = np.arange(n) / sr
    saw = 2 * ((freq * t) % 1.0) - 1
    gate = ((np.mod(t, 60.0 / bpm) / (60.0 / bpm)) >= 0.5).astype(float)  # offbeat halves
    y = sosfilt(butter(4, 300, fs=sr, output="sos"), saw * gate) * level
    return np.tile(y[:, None], (1, channels))


def bright(seconds, sr=SR, channels=2, level=0.12):
    """High, thin content: high-passed pad + bells around 2–6 kHz."""
    from scipy.signal import butter, sosfilt
    p = pad(seconds, sr, channels, level=level, freqs=(1244.5, 1568.0, 1864.7, 2489.0))
    bells = chord_tones([96, 100, 103], seconds, sr, channels, level=level * 0.6)
    return sosfilt(butter(4, 700, btype="highpass", fs=sr, output="sos"), p + bells, axis=0)


def full_mix(bpm, seconds, sr=SR):
    return kick(bpm, seconds, sr) * 0.8 + bass_line(bpm, seconds, sr) + pad(seconds, sr) + clicks(bpm, seconds, sr, freq=8000, level=0.15, offset_beats=0.5)


def tinny_mix(bpm, seconds, sr=SR):
    return bright(seconds, sr) + clicks(bpm, seconds, sr, freq=8000, level=0.15, offset_beats=0.5)


def sustained_bass(seconds, sr=SR, channels=2, freq=43.65, level=0.3):
    """Held bass note (F1 + 2 harmonics): low-band energy with no beat pulse."""
    t = np.arange(int(seconds * sr)) / sr
    y = level * (np.sin(2 * np.pi * freq * t) + 0.5 * np.sin(2 * np.pi * 2 * freq * t) + 0.25 * np.sin(2 * np.pi * 3 * freq * t)) / 1.75
    return np.tile(y[:, None], (1, channels))
