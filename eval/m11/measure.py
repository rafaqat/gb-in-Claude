# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""M11 gate: measure each expression feature of eval/m11/gate.song.json in a GarageBand export.

Usage: models/.venv/bin/python eval/m11/measure.py <export.wav> [eval/m11/gate.song.json]
Each section holds one feature; it passes when the export shows the effect. Exit code 1 if any check fails.
"""
import json
import sys

import librosa
import numpy as np
import soundfile as sf

PPQ = 480


def section_times(song):
    """Section start/end seconds through the tempo map (same rule as src/song/expression.ts sectionTimes)."""
    beats_per_bar = song.get("timeSignature", [4, 4])[0]
    changes, cursor, current = [(0, song["tempo"])], 0, song["tempo"]
    for s in song["sections"]:
        beats = s["bars"] * beats_per_bar
        if "tempo" in s:
            changes.append((cursor, s["tempo"]))
            current = s["tempo"]
        if "tempoTo" in s:
            start = current
            for k in range(1, beats):
                changes.append((cursor + k * PPQ, start + (s["tempoTo"] - start) * k / max(1, beats - 1)))
            current = s["tempoTo"]
        cursor += beats * PPQ
    changes.sort(key=lambda c: c[0])

    def seconds(tick):
        total = 0.0
        for i, (t0, bpm) in enumerate(changes):
            if t0 >= tick:
                break
            t1 = min(tick, changes[i + 1][0] if i + 1 < len(changes) else tick)
            total += (t1 - t0) * 60 / (bpm * PPQ)
        return total

    out, cursor = {}, 0
    for s in song["sections"]:
        end = cursor + s["bars"] * beats_per_bar * PPQ
        out[s["name"]] = (seconds(cursor), seconds(end))
        cursor = end
    return out


def main(wav, song_path):
    song = json.load(open(song_path))
    times = section_times(song)
    x, sr = sf.read(wav)
    L, R = x[:, 0], x[:, 1]
    M = (L + R) / 2
    db = lambda v: 20 * np.log10(v + 1e-12)
    rms = lambda s: np.sqrt(np.mean(s ** 2))
    cut = lambda s, a, b: s[int(a * sr):int(b * sr)]

    def cents(a, b, lo=300, hi=1100):
        y = librosa.resample(cut(M, a, b), orig_sr=sr, target_sr=22050)
        f0, v, _ = librosa.pyin(y, fmin=lo, fmax=hi, sr=22050, frame_length=2048, hop_length=128)
        return 1200 * np.log2(f0[v] / 440.0)

    def centroid(a, b):
        seg = cut(M, a, b)
        S = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
        f = np.fft.rfftfreq(len(seg), 1 / sr)
        return float((S * f).sum() / max(S.sum(), 1e-12))

    results = []

    def check(name, measured, passed, rule):
        results.append({"feature": name, "measured": measured, "pass": bool(passed), "rule": rule})

    a, b = times["meend"]
    c = cents(a + 0.1, b - 0.1)
    d5, e5 = 500, 700  # D5 and E5 in cents from A4
    between = int(np.sum((c > d5 + 25) & (c < e5 - 25)))
    check("meend (slide d5→e5)", f"starts {np.median(c[:20]):.0f}¢, ends {np.median(c[-20:]):.0f}¢, {between} frames between",
          between >= 5 and abs(np.median(c[:20]) - d5) < 40 and abs(np.median(c[-20:]) - e5) < 40,
          "starts on D5, ends on E5, passes through the pitches between")
    a, b = times["shruti"]
    m = float(np.median(cents(a + 0.3, b - 0.3)))
    check("shruti (a4-30c)", f"{m:.1f}¢", abs(m + 30) <= 8, "median −30 ± 8 cents")
    a, b = times["vibrato"]
    s = float(np.std(cents(a + (b - a) * 0.5, b - 0.2)))
    check("vibrato (wide)", f"pitch wobble {s:.1f}¢", s > 15, "pitch wobble > 15 cents in the second half")
    a, b = times["hairpin"]
    rise = db(rms(cut(M, b - 0.6, b - 0.1))) - db(rms(cut(M, a + 0.1, a + 0.6)))
    check("hairpin (pp<ff)", f"{rise:+.1f} dB", rise > 10, "level rises > 10 dB")

    def between_notes(sec):
        a, _ = times[sec]
        # just after each 0.5 s note's key-off: the unpedalled piano's later release/room sound starts ~0.8 s and would mask it
        return np.mean([db(rms(cut(M, o + 0.55, o + 0.95))) - db(rms(cut(M, o, o + 0.3))) for o in (a, a + 2.0)])
    gain = between_notes("pedon") - between_notes("pedoff")
    check("pedal (bar)", f"{gain:+.1f} dB between notes", gain > 6, "pedal keeps notes ringing: > 6 dB more between notes")
    a, b = times["pan"]
    lr = db(rms(cut(L, a + 0.2, b - 0.2))) - db(rms(cut(R, a + 0.2, b - 0.2)))
    check("pan (−1)", f"L−R {lr:+.1f} dB", lr > 8, "left louder than right by > 8 dB")
    a, b = times["bright"]
    c0, c1 = centroid(a + 0.1, a + 1.1), centroid(b - 1.1, b - 0.1)
    check("brightness (1→0)", f"centroid {c0:.0f} → {c1:.0f} Hz", c1 < 0.75 * c0, "centroid falls > 25 %")
    a, b = times["fade"]
    drop = db(rms(cut(M, a + 0.1, a + 0.6))) - db(rms(cut(M, b - 0.6, b - 0.1)))
    check("volume fade (1→0)", f"{-drop:+.1f} dB", drop > 15, "level falls > 15 dB")
    a, _ = times["rit0"]
    _, b = times["rit"]
    on = librosa.onset.onset_detect(y=cut(M, a - 0.05, b + 0.3), sr=sr, units="time")
    gaps = np.diff(on)
    first, last = float(np.median(gaps[:3])), float(np.median(gaps[-2:]))
    check("ritardando (120→60)", f"beat {first:.2f} s → {last:.2f} s", abs(first - 0.5) < 0.06 and last > 1.6 * first,
          "beats 0.5 s apart, then > 1.6× further apart")

    width = max(len(r["feature"]) for r in results)
    for r in results:
        print(f"{'PASS' if r['pass'] else 'FAIL'}  {r['feature']:{width}s}  {r['measured']:45s}  ({r['rule']})")
    json.dump(results, open(wav.rsplit(".", 1)[0] + "-m11-gate.json", "w"), indent=1)
    return all(r["pass"] for r in results)


if __name__ == "__main__":
    ok = main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "eval/m11/gate.song.json")
    sys.exit(0 if ok else 1)
