# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Measure probe 2 (midi-messages-probe-2.py): before 0.6–2.8 s vs after 3.2–5.4 s of each 6 s window."""
import json, sys
import numpy as np, soundfile as sf, librosa
wav, meta = sys.argv[1], json.load(open(sys.argv[2])); W = meta["win"]
x, sr = sf.read(wav); L, R = x[:, 0], x[:, 1]; M = (L + R) / 2; S = (L - R) / 2
db = lambda v: 20 * np.log10(v + 1e-12); rms = lambda s: np.sqrt(np.mean(s ** 2))
cut = lambda s, a, b: s[int(a * sr):int(b * sr)]
def pitch(seg, lo=100, hi=1500):
    y = librosa.resample(seg, orig_sr=sr, target_sr=22050)
    f0, v, _ = librosa.pyin(y, fmin=lo, fmax=hi, sr=22050, frame_length=2048, hop_length=128)
    return f0, v
def cents_stats(seg, lo=100, hi=1500):
    f0, v = pitch(seg, lo, hi); c = 1200 * np.log2(f0[v] / 440.0)
    return (np.median(c), np.std(c)) if v.sum() > 5 else (np.nan, np.nan)
def am(seg):  # amplitude wobble: std of the 20 ms RMS envelope in dB
    fr = librosa.feature.rms(y=seg, frame_length=882, hop_length=441)[0]; return np.std(db(fr[fr > 0]))
def cent(seg):
    Sp = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))); f = np.fft.rfftfreq(len(seg), 1 / sr); return (Sp * f).sum() / max(Sp.sum(), 1e-12)
def peaky(seg):
    Sp = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))); return db(Sp.max() / np.mean(Sp))
def tail(onsets, n0, n1, t0, t1):
    return np.mean([db(rms(cut(M, o + t0, o + t1))) - db(rms(cut(M, o + n0, o + n1))) for o in onsets])
out = {}
for k, name in enumerate(meta["tests"]):
    w = k * W; b, a = (w + 0.6, w + 2.8), (w + 3.2, w + 5.4)
    if name in ("SynCC1", "StrCC1", "SynPres", "SynPoly"):
        (m1, s1), (m2, s2) = cents_stats(cut(M, *b)), cents_stats(cut(M, *a))
        r = f"pitch wobble {s1:.1f} → {s2:.1f} cents · level wobble {am(cut(M, *b)):.2f} → {am(cut(M, *a)):.2f} dB · centroid {cent(cut(M, *b)):.0f} → {cent(cut(M, *a)):.0f} Hz · level {db(rms(cut(M,*a)))-db(rms(cut(M,*b))):+.1f} dB"
    elif name == "SynPorta":
        def glide(a0, a1):
            f0, v = pitch(cut(M, a0, a1), 150, 500); ff = f0[v]
            between = np.sum((ff > 228) & (ff < 318)); return between * 128 / 22050 * 1000 / 4  # ms per transition (≈4 transitions)
        r = f"time between the two pitches per transition {glide(*b):.0f} → {glide(*a):.0f} ms"
    elif name == "SynReso":
        r = f"spectral peakiness {peaky(cut(M, *b)):.1f} → {peaky(cut(M, *a)):.1f} dB · centroid {cent(cut(M, *b)):.0f} → {cent(cut(M, *a)):.0f} Hz"
    elif name in ("SynRel", "FluRev", "SynRev"):
        r = f"tail after the note {tail([w + 0.5, w + 1.5], 0, 0.2, 0.35, 0.9):+.1f} → {tail([w + 3.5, w + 4.5], 0, 0.2, 0.35, 0.9):+.1f} dB"
    elif name == "SynCho":
        wd = lambda s: db(rms(cut(S, *s))) - db(rms(cut(M, *s))); r = f"side/mid {wd(b):+.1f} → {wd(a):+.1f} dB"
    elif name.endswith("Bend"):
        lo, hi = {"SynBend": (150, 600), "StrBend": (200, 1000), "BasBend": (60, 400), "HrpBend": (200, 1000)}[name]
        (m1, _), (m2, _) = cents_stats(cut(M, w + 1.0, w + 2.8), lo, hi), cents_stats(cut(M, w + 3.7, w + 5.4), lo, hi)
        r = f"bend at full scale: {(m2 - m1) / 100:+.2f} semitones (12 = RPN range honoured, 2 = default only)"
    elif name == "PnoOffVel":
        r = f"release (after note-off) {tail([w + 0.5, w + 1.5], 0, 0.3, 0.32, 0.6):+.1f} → {tail([w + 3.5, w + 4.5], 0, 0.3, 0.32, 0.6):+.1f} dB"
    out[name] = r; print(f"{name:10s} {r}")
json.dump(out, open(sys.argv[3], "w"), indent=1)
