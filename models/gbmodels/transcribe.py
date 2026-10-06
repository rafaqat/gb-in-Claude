# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Transcription (M13.14): a recording's stems -> notes and drum hits on the song map's GarageBand bar lines, for a
Song JSON draft that plays like the recording. Bass and lead: pYIN pitch tracks cut into notes (segment_notes), each
start and end on the nearest 16th step. Drums: an NMF of the drum stem with a kick, a snare and a hat template; the
rises of each activation are its strokes. Pure functions first (tested on synthetic data); run() reads the stems.
Measured in eval/m13-transcribe (GM renders with known notes)."""
import numpy as np

STEPS = 16  # 16th steps per 4/4 GarageBand bar


def _steps(lines) -> list[tuple[int, int, float, float]]:
    """(bar 1-based, step, start_s, end_s) of every 16th step between the bar lines."""
    out = []
    for g, (lo, hi) in enumerate(zip(lines, lines[1:])):
        d = (hi - lo) / STEPS
        out += [(g + 1, k, lo + k * d, lo + (k + 1) * d) for k in range(STEPS)]
    return out


# A peak below this share of the voice's loud hits (99th percentile) is not a hit. Kick and hats take their ghost
# strokes; the snare needs a firmer hit because a kick's spill lands on it (measured: eval/m13-transcribe).
HIT_FLOOR = {"kick": 0.15, "snare": 0.25, "hat": 0.15}
SPILL_WEAK, SPILL_LOUD = 0.3, 0.8  # a weak hit on a step where another voice hits loud is that voice's spill


def drum_hits(env: dict, times: np.ndarray, lines) -> dict:
    """Per voice, the hits [{bar, step, strength}]: local peaks of its onset envelope above its HIT_FLOOR, each on the
    nearest 16th step (the strongest wins a step); strength 0-1 against the voice's loud hits. A weak hit on a step
    where another voice hits loud is dropped: spill, not a stroke."""
    times = np.asarray(times, dtype=float)
    grid = _steps(lines)
    starts = np.array([s[2] for s in grid])
    half = (grid[-1][3] - grid[-1][2]) / 2  # half a 16th step
    out = {}
    for voice, e in env.items():
        e = np.asarray(e, dtype=float)
        ref = float(np.percentile(e, 99)) or 1.0
        p = np.concatenate([[-np.inf], e, [-np.inf]])  # a hit on the first frame is a peak too
        peak = (p[1:-1] > p[:-2]) & (p[1:-1] >= p[2:]) & (e >= HIT_FLOOR.get(voice, 0.25) * ref)
        best: dict[int, float] = {}
        for i in np.flatnonzero(peak):
            if not lines[0] - half <= times[i] < lines[-1] - half:
                continue  # before the first bar line or after the last step (a tail): no step to put it on
            k = int(np.argmin(np.abs(starts - times[i])))
            best[k] = max(best.get(k, 0.0), min(1.0, float(e[i]) / ref))
        out[voice] = best
    loud = {k for found in out.values() for k, s in found.items() if s >= SPILL_LOUD}
    return {voice: [{"bar": grid[k][0], "step": grid[k][1], "strength": round(s, 2)} for k, s in sorted(found.items())
                    if not (s < SPILL_WEAK and k in loud)] for voice, found in out.items()}


HOLD = 0.4         # semitones: a frame this close to a run's pitch stays in the run (intonation, a light vibrato)
MIN_NOTE_S = 0.08  # a shorter run is part of a glide, a scoop, a fall or a wide vibrato, not a note of its own
GLIDE_S = 0.15     # short runs together longer than this are a note (a wide vibrato), not a glide between two notes
GAP_S = 0.04       # a dropout this short does not end a voiced stretch


def _stretches(midi: np.ndarray, times: np.ndarray) -> list[list[dict]]:
    """Voiced stretches (a dropout up to GAP_S does not end one), each a list of runs {start, end, i, j}: frames i..j-1
    that stay within HOLD of the run's first rounded pitch."""
    hop = float(np.median(np.diff(times))) if len(times) > 1 else 0.01
    out: list[list[dict]] = []
    run = None
    for k, (t, m) in enumerate(zip(times, midi)):
        if np.isnan(m):
            continue
        if run is not None and t - run["end"] <= GAP_S + 1e-9:
            if abs(m - run["center"]) <= HOLD:
                run["end"], run["j"] = t + hop, k + 1
                continue
            run = {"start": run["end"], "end": t + hop, "i": k, "j": k + 1, "center": round(m)}
            out[-1].append(run)
            continue
        run = {"start": t, "end": t + hop, "i": k, "j": k + 1, "center": round(m)}
        out.append([run])
    return out


def _parts(runs: list[dict]) -> list[dict]:
    """A stretch's runs as parts {start, end, i, j, note}: each run of MIN_NOTE_S or more is a note; consecutive
    shorter runs are one part — a note when together longer than GLIDE_S (a wide vibrato), else a glide."""
    parts: list[dict] = []
    for r in runs:
        long = r["end"] - r["start"] >= MIN_NOTE_S
        if not long and parts and not parts[-1]["held"]:
            parts[-1]["end"], parts[-1]["j"] = r["end"], r["j"]
            continue
        parts.append({"start": r["start"], "end": r["end"], "i": r["i"], "j": r["j"], "held": long})
    for p in parts:
        p["note"] = p["held"] or p["end"] - p["start"] > GLIDE_S
    return parts


def segment_notes(midi: np.ndarray, times: np.ndarray, onsets) -> list[tuple[float, float, int]]:
    """Notes (start_s, end_s, pitch) from a frame-wise MIDI track (NaN = unvoiced): in each voiced stretch, the
    notes of _parts. A glide between two notes belongs to the next one: it starts where the one before lets go (a
    singer's onset is where the pitch starts to move). A glide before the first note (a scoop) or after the last (a
    fall) belongs to it. A note's pitch is the median of its own frames. Neighbours of the same pitch, or an octave
    apart (the tracker slipped), join unless an onset strikes again; an onset inside a note splits it."""
    raw = np.asarray(midi, dtype=float)
    onsets = np.asarray(onsets, dtype=float)
    pitch_of = lambda p: int(round(float(np.median(raw[p["i"]:p["j"]][~np.isnan(raw[p["i"]:p["j"]])]))))  # noqa: E731
    notes: list[list] = []  # [start, end, pitch]
    for runs in _stretches(raw, np.asarray(times, dtype=float)):
        parts = _parts(runs)
        held = [p for p in parts if p["note"]]
        if not held:
            continue  # a blip shorter than a note
        bounds = [parts[0]["start"]] + [a["end"] for a in held[:-1]] + [parts[-1]["end"]]
        notes += [[bounds[k], bounds[k + 1], pitch_of(p)] for k, p in enumerate(held)]
    joined: list[list] = []
    for a, b, pitch in notes:
        if joined and a - joined[-1][1] <= GAP_S + 1e-9 and (pitch - joined[-1][2]) in (0, 12, -12) \
                and not np.any(np.abs(onsets - a) <= 0.05):
            prev = joined[-1]
            if pitch != prev[2] and b - a > prev[1] - prev[0]:
                prev[2] = pitch  # an octave slip: the longer part names the note
            prev[1] = b
            continue
        joined.append([a, b, pitch])
    out: list[tuple[float, float, int]] = []
    for a, b, pitch in joined:
        cuts = [float(o) for o in onsets if a + MIN_NOTE_S < o < b - MIN_NOTE_S]
        out += [(x, y, pitch) for x, y in zip([a, *cuts], [*cuts, b])]
    return out


def grid_notes(midi: np.ndarray, times: np.ndarray, onsets, lines) -> list[dict]:
    """Notes [{bar, step, len, pitch}] on the 16th steps between the bar lines: segment_notes, then each start and end
    on the nearest step line (at least one step; two notes on one step: the longer stays)."""
    grid = _steps(lines)
    edges = np.array([s[2] for s in grid] + [float(lines[-1])])
    best: dict[int, tuple[int, int]] = {}
    for a, b, pitch in segment_notes(midi, times, onsets):
        if b <= edges[0] or a >= edges[-1]:
            continue
        k = int(np.argmin(np.abs(edges[:-1] - a)))
        e = max(k + 1, int(np.argmin(np.abs(edges - b))))
        if k not in best or e - k > best[k][0]:
            best[k] = (e - k, pitch)
    starts = sorted(best)
    notes = []
    for i, k in enumerate(starts):
        length, pitch = best[k]
        if i + 1 < len(starts):
            length = min(length, starts[i + 1] - k)
        notes.append({"bar": grid[k][0], "step": grid[k][1], "len": length, "pitch": pitch})
    return notes


SR, HOP = 22050, 256
BASS_RANGE = ("E1", "C4")
LEAD_RANGE = ("C2", "C6")
QUIET_DB = 35.0  # frames this far under the stem's loud level are bleed from the other stems, not its own notes


def _level_db(y: np.ndarray) -> np.ndarray:
    import librosa
    return 20 * np.log10(librosa.feature.rms(y=y, frame_length=2048, hop_length=HOP)[0] + 1e-10)


def pitch_track(y: np.ndarray, fmin: str, fmax: str) -> tuple[np.ndarray, np.ndarray]:
    """(MIDI per frame with NaN where unvoiced or quiet, frame times) by pYIN."""
    import librosa
    f0, voiced, _ = librosa.pyin(y, fmin=librosa.note_to_hz(fmin), fmax=librosa.note_to_hz(fmax), sr=SR, frame_length=2048, hop_length=HOP)
    midi = np.where(voiced, librosa.hz_to_midi(np.where(voiced, f0, 1.0)), np.nan)
    db = _level_db(y)[:len(midi)]
    midi[: len(db)][db < np.percentile(db, 95) - QUIET_DB] = np.nan
    return midi, librosa.times_like(midi, sr=SR, hop_length=HOP)


def note_onsets(y: np.ndarray) -> np.ndarray:
    import librosa
    return librosa.onset.onset_detect(y=y, sr=SR, hop_length=HOP, units="time")


N_MELS, NMF_ITERS = 64, 60
# Band shapes the NMF starts from (weight per band, elsewhere TEMPLATE_FLOOR); the templates then adapt to the kit
TEMPLATES = {"kick": [(30.0, 150.0, 1.0)], "snare": [(150.0, 5000.0, 1.0), (5000.0, 11000.0, 0.3)], "hat": [(6000.0, 11000.0, 1.0)]}
TEMPLATE_FLOOR = 0.02


def drum_activations(S: np.ndarray, iters: int = NMF_ITERS) -> dict:
    """NMF (KL divergence) of a magnitude spectrogram on mel bands with one template per voice, started from the
    voice's band shape and adapted to the recording: each stroke is explained by its own template (most of a
    snare's low thump and high hiss stays with the snare). Returns each voice's activation per frame."""
    import librosa
    mel = librosa.filters.mel(sr=SR, n_fft=2048, n_mels=N_MELS, fmin=20.0, fmax=11000.0)
    V = mel @ S + 1e-9
    cf = librosa.mel_frequencies(n_mels=N_MELS + 2, fmin=20.0, fmax=11000.0)[1:-1]
    W = np.full((N_MELS, len(TEMPLATES)), TEMPLATE_FLOOR)
    for j, bands in enumerate(TEMPLATES.values()):
        for lo, hi, w in bands:
            W[(cf >= lo) & (cf < hi), j] = w
    W /= W.sum(0)
    H = np.full((len(TEMPLATES), V.shape[1]), float(V.mean()))
    for _ in range(iters):
        H *= (W.T @ (V / (W @ H + 1e-9))) / (W.sum(0)[:, None] + 1e-9)
        W *= ((V / (W @ H + 1e-9)) @ H.T) / (H.sum(1)[None, :] + 1e-9)
        W /= W.sum(0) + 1e-12
    return dict(zip(TEMPLATES, H))


def drum_envelopes(y: np.ndarray) -> tuple[dict, np.ndarray]:
    """Per voice, the rises of its NMF activation (its strokes), and the frame times."""
    import librosa
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=HOP))
    H = drum_activations(S)
    env = {v: np.maximum(0.0, np.diff(h, prepend=0.0)) for v, h in H.items()}  # from silence before the start
    return env, librosa.times_like(S, sr=SR, hop_length=HOP)


def load(device: str, **_) -> dict:
    return {"device": device}


SILENT_DB = 40.0  # a stem whose loud level is this far under the loudest stem's holds no part (Demucs left it empty)


def loud_db(y: np.ndarray) -> float:
    """The stem's loud level: the 95th percentile of its frame RMS in dB."""
    return float(np.percentile(_level_db(y), 95))


def run(handle: dict, inputs: dict) -> dict:
    """inputs: stems {vocals, drums, bass, other} (WAVs) and lines (the map's GarageBand bar lines, song seconds).
    Returns bass and lead notes [{bar, step, len, pitch}], drums {kick, snare, hat: [{bar, step, strength}]}, and the
    stem each line came from (None: that stem is silent, SILENT_DB under the loudest)."""
    import librosa
    lines = [float(x) for x in inputs["lines"]]
    load_mono = lambda p: librosa.load(p, sr=SR, mono=True)[0]  # noqa: E731
    stems = {k: load_mono(inputs["stems"][k]) for k in ("bass", "vocals", "drums", "other")}
    level = {k: loud_db(y) for k, y in stems.items()}
    sounds = lambda k: level[k] >= max(level.values()) - SILENT_DB  # noqa: E731
    bass, lead = [], []
    if sounds("bass"):
        midi, times = pitch_track(stems["bass"], *BASS_RANGE)
        bass = grid_notes(midi, times, note_onsets(stems["bass"]), lines)
    if sounds("vocals"):
        midi, times = pitch_track(stems["vocals"], *LEAD_RANGE)
        lead = grid_notes(midi, times, [], lines)  # no onsets: drum bleed in a vocal stem fires them
    drums = drum_hits(*drum_envelopes(stems["drums"]), lines) if sounds("drums") else {v: [] for v in TEMPLATES}
    return {"bass": bass, "bass_source": "bass" if sounds("bass") else None, "lead": lead,
            "lead_source": "vocals" if sounds("vocals") else None, "drums": drums}
