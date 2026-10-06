# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""M12a benchmark, part 2: measure what ACE-Step made (models/.venv).

    models/.venv/bin/python eval/m12a/measure.py [out.json]

Reads <workspace>/gen/m12a/results.jsonl (from generate.py). Per job:
- control: measured tempo (beat_this, folded toward the request) and key (S-KEY) against the requested ones; length;
- vocals: Demucs htdemucs vocal stem → its level against the mix and the share of voiced frames (pYIN);
- covers only: the sung pitch against every pitched MIDI line of the source song, by pitch class, in frames where
  the line holds a note and the voice is voiced — and the same with the line moved ±2 bars (chance level for this
  key); plus the correlation of the cover's per-bar loudness with its source's (control: the source moved ±2 bars).
  (Chroma was tried first and dropped: the test song sits on an E drone, so aligned and shifted chroma scored the same.)
- metric self-check, once per source: the same pitch measure on the source's own Demucs "other" stem (its bansuri,
  strings…) must find the source's lines above the control; else the cover numbers mean nothing.
Stems go to <workspace>/gen/m12a/stems/ (reused when present; never overwritten).
"""
import json, os, re, sys
import numpy as np, soundfile as sf, librosa, mido

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # eval/: _paths
from _paths import ROOT, workspace  # noqa: E402
WORKSPACE = workspace()
GEN = os.path.join(WORKSPACE, "gen", "m12a")
sys.path.insert(0, os.path.join(ROOT, "models"))
from gbmodels import stems  # noqa: E402

PCS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
SR = 22050
HOP = 512
DRUM_TRACKS = {"Drums"}
# the source of each cover → its MIDI (same timeline: the export starts at bar 1)
SOURCES = {"probe-export/song-stems.wav": ("song.mid", 132.0)}


def key_of(label: str):
    """'E minor' / 'Em' / 'E:min' / 'F# Major' → (pitch class, 'major' | 'minor'); None if unreadable."""
    m = re.match(r"^\s*([A-Ga-g])([#b♯♭]?)\s*[:\s]?\s*(.*)$", label or "")
    if not m:
        return None
    pc = (PCS[m.group(1).upper()] + {"#": 1, "♯": 1, "b": -1, "♭": -1}.get(m.group(2), 0)) % 12
    rest = m.group(3).strip().lower()
    mode = "minor" if rest.startswith("min") or rest == "m" else "major"
    return pc, mode


def key_relation(want: str, got: str) -> str:
    a, b = key_of(want), key_of(got)
    if not a or not b:
        return "unknown"
    if a == b:
        return "exact"
    rel = (a[0] + (3 if a[1] == "minor" else -3)) % 12  # relative major / minor
    if b == (rel, "major" if a[1] == "minor" else "minor"):
        return "relative"
    if a[1] == b[1] and (b[0] - a[0]) % 12 in (5, 7):
        return "fifth"
    return "other"


def midi_lines(path: str) -> dict:
    """{track name: [(start s, end s, pitch)]} with the file's tempo map."""
    mid = mido.MidiFile(path)
    tempo_map = []
    for track in mid.tracks:
        tick = 0
        for msg in track:
            tick += msg.time
            if msg.type == "set_tempo":
                tempo_map.append((tick, msg.tempo))
    tempo_map = sorted(tempo_map) or [(0, 500000)]

    def seconds(tick: int) -> float:
        s, last_tick, tempo = 0.0, 0, tempo_map[0][1] if tempo_map[0][0] == 0 else 500000
        for t, tp in tempo_map:
            if t >= tick:
                break
            s += mido.tick2second(t - last_tick, mid.ticks_per_beat, tempo)
            last_tick, tempo = t, tp
        return s + mido.tick2second(tick - last_tick, mid.ticks_per_beat, tempo)

    lines = {}
    for track in mid.tracks:
        if not track.name or track.name in DRUM_TRACKS:
            continue
        tick, on, notes = 0, {}, []
        for msg in track:
            tick += msg.time
            if msg.type == "note_on" and msg.velocity > 0:
                on[msg.note] = tick
            elif msg.type in ("note_off", "note_on") and msg.note in on:
                notes.append((seconds(on.pop(msg.note)), seconds(tick), msg.note))
        if notes:
            lines[track.name] = notes
    return lines


def line_frames(notes, n_frames: int, shift_s: float = 0.0) -> np.ndarray:
    """Per frame: the highest MIDI pitch sounding in the line (NaN where silent)."""
    out = np.full(n_frames, np.nan)
    t = librosa.frames_to_time(np.arange(n_frames), sr=SR, hop_length=HOP)
    for s, e, p in notes:
        sel = (t >= s + shift_s) & (t < e + shift_s)
        out[sel] = np.fmax(out[sel], p)
    return out


def pitch_class_match(f0_midi: np.ndarray, line: np.ndarray):
    both = ~np.isnan(f0_midi) & ~np.isnan(line)
    if both.sum() < 50:
        return None, int(both.sum())
    d = np.abs(((f0_midi[both] - line[both]) + 6) % 12 - 6)  # pitch-class distance in semitones
    return round(float(np.mean(d <= 0.5)), 3), int(both.sum())


def bar_loudness(path: str, bpm: float) -> np.ndarray:
    """RMS level (dB) of each bar, from bar 1 at time 0."""
    y, _ = librosa.load(path, sr=SR, mono=True)
    n = int(round(4 * 60 / bpm * SR))
    return np.array([20 * np.log10(np.sqrt(np.mean(y[i:i + n] ** 2)) + 1e-9) for i in range(0, len(y) - n + 1, n)])


def corr_shift(a: np.ndarray, b: np.ndarray, shift: int = 0) -> float:
    n = min(len(a), len(b)) - abs(shift)
    a2, b2 = a[max(0, shift):max(0, shift) + n], b[max(0, -shift):max(0, -shift) + n]
    return round(float(np.corrcoef(a2, b2)[0, 1]), 3)


def voiced_f0(path: str) -> np.ndarray:
    """pYIN f0 as MIDI numbers, NaN where unvoiced or quieter than −45 dBFS."""
    v, _ = librosa.load(path, sr=SR, mono=True)
    f0, voiced, _ = librosa.pyin(v, fmin=80, fmax=1000, sr=SR, hop_length=HOP)
    loud = librosa.feature.rms(y=v, hop_length=HOP)[0][:len(f0)] > 10 ** (-45 / 20)
    return np.where(voiced & loud, librosa.hz_to_midi(f0), np.nan)


def follow_lines(f0_midi: np.ndarray, lines: dict, bar: float) -> dict:
    out = {}
    for name, notes in lines.items():
        hit, frames = pitch_class_match(f0_midi, line_frames(notes, len(f0_midi)))
        ctrl = [pitch_class_match(f0_midi, line_frames(notes, len(f0_midi), s))[0] for s in (-2 * bar, 2 * bar)]
        ctrl = [c for c in ctrl if c is not None]
        out[name] = {"match": hit, "frames": frames, "control": round(float(np.mean(ctrl)), 3) if ctrl else None}
    return out


def separated(handle, wav: str, stem_dir: str, part: str) -> str:
    path = os.path.join(stem_dir, f"{os.path.splitext(os.path.basename(wav))[0]}-{part}.wav")
    if not os.path.lexists(path):
        stems.separate(handle, {"wav": wav, "out_dir": stem_dir})
    return path


def main(out_path: str | None) -> int:
    rows = [json.loads(l) for l in open(os.path.join(GEN, "results.jsonl"))]
    rows = list({r["id"]: r for r in rows if r.get("ok")}.values())  # last run of each job
    handle = stems.load("mps")
    stem_dir = os.path.join(GEN, "stems")
    measured, checks = [], {}
    for r in rows:
        job, wav = r["job"], os.path.join(WORKSPACE, r["path"])
        ins = stems.inspect(handle, {"wav": wav, "near_bpm": job.get("bpm") or 120})
        m = {"id": r["id"], "task": r["task"], "gen_seconds": r["seconds"], "audio_seconds": r.get("audio_seconds"),
             "rtf": round(r["seconds"] / r["audio_seconds"], 2) if r.get("audio_seconds") else None,
             "mlx_peak_gb": r.get("mlx_peak_gb"), "rss_peak_gb": r.get("rss_peak_gb"),
             "bpm_wanted": job.get("bpm"), "bpm_measured": ins["bpm"],
             "bpm_error_pct": round(100 * (ins["bpm"] / job["bpm"] - 1), 2) if ins["bpm"] and job.get("bpm") else None,
             "key_wanted": job.get("keyscale"), "key_measured": ins["key"],
             "key_relation": key_relation(job.get("keyscale", ""), ins["key"]) if job.get("keyscale") else None,
             "seconds_wanted": job.get("duration"), "seconds_measured": ins["seconds"]}
        vocal = separated(handle, wav, stem_dir, "vocals")
        x, _ = librosa.load(wav, sr=SR, mono=True)
        v, _ = librosa.load(vocal, sr=SR, mono=True)
        rms = lambda y: 20 * np.log10(np.sqrt(np.mean(y ** 2)) + 1e-12)
        f0_midi = voiced_f0(vocal)
        m.update({"vocals_vs_mix_db": round(rms(v) - rms(x), 1), "voiced_share": round(float(np.mean(~np.isnan(f0_midi))), 3)})
        if job.get("src") in SOURCES:
            mid, bpm = SOURCES[job["src"]]
            bar = 4 * 60 / bpm
            lines = midi_lines(os.path.join(WORKSPACE, mid))
            src_wav = os.path.join(WORKSPACE, job["src"])
            if job["src"] not in checks:
                checks[job["src"]] = follow_lines(voiced_f0(separated(handle, src_wav, stem_dir, "other")), lines, bar)
            a, b = bar_loudness(src_wav, bpm), bar_loudness(wav, bpm)
            m.update({"strength": job.get("strength"), "sung_vs_lines": follow_lines(f0_midi, lines, bar),
                      "bar_loudness_vs_source": corr_shift(a, b),
                      "bar_loudness_vs_source_control": round((corr_shift(a, b, 2) + corr_shift(a, b, -2)) / 2, 3)})
        measured.append(m)
        print(json.dumps(m), flush=True)
    print("metric check (source other stem):", json.dumps(checks), flush=True)
    if out_path:
        with open(out_path, "w") as f:
            json.dump({"measured": measured, "metric_check_source_other_stem": checks}, f, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else None))
