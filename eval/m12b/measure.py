# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""M12b gate, part 2: in the GarageBand export, does each generated vocal play at its bar, and do the MIDI parts still
play? (models/.venv)

    models/.venv/bin/python eval/m12b/measure.py <export.wav> <midi-only export.wav> <bpm> <out.json> <stem.wav>@<bar> …

1. The export ≈ Σ gain × stem (each at its bar) + the MIDI parts: gains by least squares.
2. Each vocal: remove the other vocals' fitted share, then find its lag (±0.5 s) in its 4 loudest 8 s windows.
3. The MIDI parts: the export minus all fitted vocals against a MIDI-only export of the song (log-mel; control: against
   the vocals), and its level per 8 bars.
Pass: every lag ≤ 5 ms; rest vs MIDI-only ≥ 0.95 and above the control; every 8 bars within 3 dB. Paths: workspace.
"""
import json, os, sys
import numpy as np, soundfile as sf, librosa

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # eval/: _paths
from _paths import ROOT, workspace  # noqa: E402
WORKSPACE = workspace()
SR = 44100


def mono(rel):
    y, sr = sf.read(os.path.join(WORKSPACE, rel), always_2d=True)
    y = y.mean(1)
    return y if sr == SR else librosa.resample(y, orig_sr=sr, target_sr=SR)


def placed(stem, at, n):
    out = np.zeros(n)
    a = int(round(at * SR))
    k = min(len(stem), n - a)
    if k > 0:
        out[a:a + k] = stem[:k]
    return out


def best_lag(ref_full, target, windows, w):
    lags = []
    for a in windows:
        ref = ref_full[a:a + w]
        best = max(((lag, np.dot(ref, target[a + lag:a + lag + w]) / (np.linalg.norm(ref) * np.linalg.norm(target[a + lag:a + lag + w]) + 1e-12))
                    for lag in range(-SR // 2, SR // 2, 16) if 0 <= a + lag and a + lag + w <= len(target)), key=lambda t: t[1])
        lags.append({"at_s": round(a / SR, 1), "lag_ms": round(best[0] / SR * 1000, 1), "corr": round(float(best[1]), 3)})
    return lags


def main(export, midi_only, bpm, out, stems):
    x, m = mono(export), mono(midi_only)
    n = len(x)
    bar = 4 * 60 / bpm
    S = [placed(mono(rel), (b - 1) * bar, n) for rel, b in stems]
    gains, *_ = np.linalg.lstsq(np.stack(S, 1), x, rcond=None)
    rest = x - sum(g * s for g, s in zip(gains, S))
    w = 8 * SR
    vocals = []
    for i, ((rel, b), s) in enumerate(zip(stems, S)):
        target = x - sum(g * sj for j, (g, sj) in enumerate(zip(gains, S)) if j != i)
        energy = [(float(np.sum(s[a:a + w] ** 2)), a) for a in range(0, n - w - SR, SR)]
        windows = [a for _, a in sorted(energy, reverse=True)[:4]]
        vocals.append({"stem": rel, "bar": b, "gain": round(float(gains[i]), 3), "lags": best_lag(s, target, sorted(windows), w)})

    def logmel(y):
        return librosa.power_to_db(librosa.feature.melspectrogram(y=y.astype(np.float32), sr=SR, n_fft=4096, hop_length=2048, n_mels=64))

    def corr(a, b):
        k = min(a.shape[1], b.shape[1])
        return round(float(np.corrcoef(a[:, :k].ravel(), b[:, :k].ravel())[0, 1]), 3)

    R, M, V = logmel(rest), logmel(m), logmel(sum(S))
    db = lambda y, a, z: round(float(20 * np.log10(np.sqrt(np.mean(y[a:z] ** 2)) + 1e-12)), 1)
    bars = int(round(n / SR / bar))
    sections = [{"bars": f"{b0 + 1}-{min(bars, b0 + 8)}", "rest_db": db(rest, int(b0 * bar * SR), int(min(bars, b0 + 8) * bar * SR)),
                 "midi_only_db": db(m, int(b0 * bar * SR), int(min(bars, b0 + 8) * bar * SR))} for b0 in range(0, bars, 8)]
    result = {"export": export, "midi_only": midi_only, "bpm": bpm, "vocals": vocals,
              "rest_vs_midi_only_logmel_corr": corr(R, M), "rest_vs_vocals_logmel_corr_control": corr(R, V), "sections": sections}
    result["passed"] = (all(abs(l["lag_ms"]) <= 5 for v in vocals for l in v["lags"])
                        and result["rest_vs_midi_only_logmel_corr"] >= 0.95
                        and result["rest_vs_midi_only_logmel_corr"] > result["rest_vs_vocals_logmel_corr_control"]
                        and all(abs(s["rest_db"] - s["midi_only_db"]) <= 3 for s in sections))
    print(json.dumps(result, indent=1))
    with open(out, "w") as f:
        json.dump(result, f, indent=1)
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    a = sys.argv[1:]
    stems = [(s.rsplit("@", 1)[0], int(s.rsplit("@", 1)[1])) for s in a[4:]]
    sys.exit(main(a[0], a[1], float(a[2]), a[3], stems))
