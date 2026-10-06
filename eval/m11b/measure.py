# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""M11b gate measure: did the stem land at its bar, and do the MIDI parts still play?

    models/.venv/bin/python eval/m11b/measure.py <export.wav> <stem.wav> <midi-only export.wav> <bpm> [out.json]

1. Stem placement: the best lag (±0.5 s) of the stem against the export at four points; the export's gain on it.
2. MIDI parts: remove the fitted stem from the export; the rest must match a MIDI-only export of the same song in
   log-mel (GarageBand instruments do not render the same samples twice, so a waveform match is not expected).
   Control: the rest against the stem. Then the level of the rest vs the MIDI-only export per 8 bars.
Paths are relative to the workspace (out/).
"""
import json, os, sys
import numpy as np, soundfile as sf, librosa

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # eval/: _paths
from _paths import ROOT, workspace  # noqa: E402
WORKSPACE = workspace()


def mono(rel):
    y, sr = sf.read(os.path.join(WORKSPACE, rel), always_2d=True)
    return y.mean(1), sr


def main(export, stem, midi_only, bpm, out=None):
    x, sr = mono(export); s, sr_s = mono(stem); m, sr_m = mono(midi_only)
    assert sr == sr_s == sr_m, (sr, sr_s, sr_m)
    n = min(len(s), len(x))
    lags = []
    for t0 in (10, 30, 60, 90):
        a, w = t0 * sr, 8 * sr
        if a + w + sr > n: continue
        ref = s[a:a + w]
        best = max(((lag, np.dot(ref, x[a + lag:a + lag + w]) / (np.linalg.norm(ref) * np.linalg.norm(x[a + lag:a + lag + w]) + 1e-12))
                    for lag in range(-sr // 2, sr // 2, 16)), key=lambda t: t[1])
        lags.append({"at_s": t0, "lag_ms": round(best[0] / sr * 1000, 1), "corr": round(float(best[1]), 3)})
    g = float(np.dot(s[:n], x[:n]) / np.dot(s[:n], s[:n]))
    rest = x.copy(); rest[:n] -= g * s[:n]

    def logmel(y):
        return librosa.power_to_db(librosa.feature.melspectrogram(y=y.astype(np.float32), sr=sr, n_fft=4096, hop_length=2048, n_mels=64))

    def corr(a, b):
        k = min(a.shape[1], b.shape[1])
        return round(float(np.corrcoef(a[:, :k].ravel(), b[:, :k].ravel())[0, 1]), 3)

    R, M, S = logmel(rest), logmel(m), logmel(s)
    bar = 4 * 60 / bpm
    bars = int(round(len(x) / sr / bar))
    db = lambda y, a, z: round(float(20 * np.log10(np.sqrt(np.mean(y[a:z] ** 2)) + 1e-12)), 1)
    sections = []
    for b0 in range(0, bars, 8):
        a, z = int(b0 * bar * sr), int(min(bars, b0 + 8) * bar * sr)
        sections.append({"bars": f"{b0 + 1}-{min(bars, b0 + 8)}", "rest_db": db(rest, a, z), "midi_only_db": db(m, a, z)})
    result = {"export": export, "stem": stem, "midi_only": midi_only, "bpm": bpm,
              "stem_lags": lags, "stem_gain": round(g, 3),
              "rest_vs_midi_only_logmel_corr": corr(R, M), "rest_vs_stem_logmel_corr_control": corr(R, S),
              "sections": sections}
    passed = (all(abs(l["lag_ms"]) <= 5 for l in lags) and result["rest_vs_midi_only_logmel_corr"] >= 0.95
              and result["rest_vs_midi_only_logmel_corr"] > result["rest_vs_stem_logmel_corr_control"]
              and all(abs(s_["rest_db"] - s_["midi_only_db"]) <= 3 for s_ in sections))
    result["passed"] = passed
    print(json.dumps(result, indent=1))
    if out:
        with open(out, "w") as f: json.dump(result, f, indent=1)
    return 0 if passed else 1


if __name__ == "__main__":
    a = sys.argv[1:]
    sys.exit(main(a[0], a[1], a[2], float(a[3]), a[4] if len(a) > 4 else None))
