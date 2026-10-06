# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Song map (M13.6): the bar structure of a recording, for MIDI parts and GarageBand projects next to it.

From the beats and downbeats (beat_this) and the stems (Demucs): the tempo and how steady it is, the bar grid, the
bars that are not 4 beats long (ACE-Step inserts 2-beat bars), the chords per half bar, where the voice rests, where
a high melody already plays, and where to place the stems so the song's downbeats fall on GarageBand bar lines.
Pure functions first (tested on synthetic data); run() reads the files.
"""
import numpy as np

STEADY_TOL = 0.15  # an interval within 15 % of the median belongs to the steady grid


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) index ranges where mask is True."""
    out, start = [], None
    for i, m in enumerate(mask):
        if m and start is None:
            start = i
        if not m and start is not None:
            out.append((start, i))
            start = None
    if start is not None:
        out.append((start, len(mask)))
    return out


def fit_grid(beats) -> dict:
    """period and t0 (a grid line) from the longest run of steady beats — a free intro or a break does not bend it.
    Inside the run, beats are numbered by time (a missed beat does not shift the count), then a line is fitted."""
    b = np.asarray(beats, dtype=float)
    ibi = np.diff(b)
    med = float(np.median(ibi))
    runs = _runs(np.abs(ibi / med - 1) <= STEADY_TOL)
    if not runs:
        raise ValueError("no steady beats: the tempo is free throughout")
    from gbmodels.beatthis import tempo
    s, e = max(runs, key=lambda r: r[1] - r[0])
    run = b[s:e + 1]
    # the period from the mean of the regular intervals (a jump to a swung off-beat is not regular, so it does not
    # bend it — a straight line through the beats would), the phase from a trimmed circular mean
    period = 60.0 / tempo(run)
    keep = run
    for _ in range(3):
        phase = float(np.angle(np.mean(np.exp(2j * np.pi * keep / period)))) / (2 * np.pi) * period
        off = (run - phase + period / 2) % period - period / 2
        keep = run[np.abs(off) <= period / 6]
    t0 = phase + np.floor((run[0] - phase) / period + 0.5) * period
    return {"period": float(period), "t0": float(t0), "steady_from_s": float(run[0]), "steady_to_s": float(run[-1]),
            "resid_std_ms": round(float(off[np.abs(off) <= period / 6].std() * 1000), 1), "on_grid": round(float(np.mean(np.abs(off) <= period / 6)), 3)}


SKIP_COST, JOIN_COST, MISS_COST, LATE_COST = 0.6, 1.0, 0.2, 1e-4
MAX_STEP = 32  # beats between two kept downbeats (up to 7 missed bars)


def _step_cost(s: int, at: int) -> float:
    """Cost of two consecutive bar lines `s` grid beats apart: 4k is free but for missed downbeats; anything else
    holds one joining bar (2, 3 or 5 beats) — slightly dearer later, so an ambiguous join goes as early as it can."""
    if s <= 0 or s > MAX_STEP:
        return np.inf
    if s % 4 == 0:
        return (s // 4 - 1) * MISS_COST
    if s < 2:
        return np.inf
    return JOIN_COST + max(0, (s - (5 if s % 4 == 1 else s % 4)) // 4) * MISS_COST + LATE_COST * at


def linear_clock(grid: dict, end_s: float) -> dict:
    """A straight beat clock from a grid (a steady song, or tests): index i at t0 + i x period."""
    P, t0 = grid["period"], grid["t0"]
    idx = np.arange(int(np.floor(-t0 / P)) - 4, int(np.ceil((end_s - t0) / P)) + 5)
    return {"index": idx, "time": t0 + idx * P, "period": P}


def musical_bars(downbeats, clock: dict, end_s: float) -> list[dict]:
    """The song's own bars from its downbeats on the beat clock: [{beat (clock index), start_s, end_s, beats}]. The
    detections are read as the cheapest chain of bar lines (_step_cost; a detection left out costs SKIP_COST): a
    lone detection on the other half of the bar (the tracker's doubt) is dropped, a real change of phase becomes
    one joining bar. On a clock that follows the band, a take that drifts gets no invented bars."""
    ci, ct, P = clock["index"], clock["time"], clock["period"]
    pick = [int(np.argmin(np.abs(ct - d))) for d in np.asarray(downbeats, dtype=float)]
    idx = np.unique([int(ci[j]) for j, d in zip(pick, downbeats) if abs(ct[j] - d) < P / 4])
    n = len(idx)
    if n == 0:
        return []
    best = np.array([SKIP_COST * i for i in range(n)], dtype=float)  # i = the first bar line, all before it skipped
    prev = np.full(n, -1)
    for i in range(n):
        for k in range(max(0, i - 40), i):
            c = best[k] + _step_cost(int(idx[i] - idx[k]), int(idx[i])) + SKIP_COST * (i - k - 1)
            if c < best[i]:
                best[i], prev[i] = c, k
    end = int(np.argmin(best + SKIP_COST * (n - 1 - np.arange(n))))
    chain = []
    while end >= 0:
        chain.append(int(idx[end]))
        end = int(prev[end])
    chain.reverse()
    at = dict(zip(ci.tolist(), ct.tolist()))
    bars: list[dict] = []

    def add(beat: int, beats: int) -> None:
        if beat in at and beat + beats in at:
            bars.append({"beat": beat, "start_s": at[beat], "end_s": at[beat + beats], "beats": beats})

    for a, b in zip(chain, chain[1:]):
        gap, r = b - a, (b - a) % 4
        join = 0 if r == 0 else (5 if r == 1 and gap >= 5 else r)
        for k in range((gap - join) // 4):
            add(a + 4 * k, 4)
        if join:
            add(b - join, join)
    beat = chain[-1]
    while beat + 4 in at and at[beat + 4] <= end_s + P / 2:
        add(beat, 4)
        beat += 4
    return bars


NAMES = "C C# D Eb E F F# G Ab A Bb B".split()
_PC = {n: i for i, n in enumerate(NAMES)} | {"Db": 1, "D#": 3, "Gb": 6, "G#": 8, "A#": 10, "Cb": 11, "Fb": 4, "E#": 5, "B#": 0}
ROOT_BONUS, KEY_BONUS, SPLIT_MARGIN = 0.08, 0.04, 0.06


def _triads():
    out = {}
    for r in range(12):
        for q, iv in (("", (0, 4, 7)), ("m", (0, 3, 7))):
            t = np.zeros(12)
            t[[(r + i) % 12 for i in iv]] = 1
            out[NAMES[r] + q] = (r, t / np.linalg.norm(t))
    return out


TRIADS = _triads()


def diatonic(key: str | None) -> set[str]:
    """The key's triads (major: I ii iii IV V vi; minor: i III iv v V VI VII), e.g. "D major" or S-KEY's "D Major"."""
    if not key:
        return set()
    root, mode = key.split()[0], key.split()[1].lower()
    t = _PC[root]
    steps = [(0, ""), (2, "m"), (4, "m"), (5, ""), (7, ""), (9, "m")] if mode == "major" else \
        [(0, "m"), (3, ""), (5, "m"), (7, "m"), (7, ""), (8, ""), (10, "")]
    return {NAMES[(t + s) % 12] + q for s, q in steps}


def _best(other: np.ndarray, bass: np.ndarray, a: int, b: int, in_key: set[str]) -> tuple[str, float]:
    seg = lambda c: c[:, a:b].mean(1) if c[:, a:b].shape[1] else np.zeros(12)  # noqa: E731 — a bar past the audio's end: no notes
    co, cb = seg(other), seg(bass)
    v = co / (np.linalg.norm(co) + 1e-9) + 0.6 * cb / (np.linalg.norm(cb) + 1e-9)
    v = v / (np.linalg.norm(v) + 1e-9)
    root = int(cb.argmax())
    scored = sorted(((float(v @ t) + (ROOT_BONUS if r == root else 0) + (KEY_BONUS if k in in_key else 0), k)
                     for k, (r, t) in TRIADS.items()), reverse=True)
    return scored[0][1], round(scored[0][0] - scored[1][0], 3)


def bar_chords(other: np.ndarray, bass: np.ndarray, fps: float, bars: list[dict], key: str | None = None) -> list[dict]:
    """Per bar: its chord, or two (one per half) when both halves are sure (margin >= SPLIT_MARGIN) and differ.
    other / bass: 12 x frames chroma of the instrument and bass stems at `fps` frames per second."""
    in_key = diatonic(key)
    other, bass = np.nan_to_num(other), np.nan_to_num(bass)  # chroma of digital silence is 0/0: no notes, not NaN
    steps = [(n["start_s"] - b["start_s"]) / b["beats"] for b, n in zip(bars, bars[1:])]
    period = float(np.median(steps)) if steps else 0.5
    f = lambda t: int(round(t * fps))  # noqa: E731
    out = []
    for b in bars:
        s, e = b["start_s"], b.get("end_s", b["start_s"] + b["beats"] * period)
        period_here = (e - s) / b["beats"]
        whole, margin = _best(other, bass, f(s), max(f(e), f(s) + 1), in_key)
        chords = [whole]
        if b["beats"] >= 4:
            mid = s + b["beats"] / 2 * period_here
            (h1, m1), (h2, m2) = _best(other, bass, f(s), f(mid), in_key), _best(other, bass, f(mid), f(e), in_key)
            if h1 != h2 and m1 >= SPLIT_MARGIN and m2 >= SPLIT_MARGIN:
                chords = [h1, h2]
        out.append({**b, "chords": chords, "margin": margin})
    return out


def anchor_bar(bars: list[dict]) -> dict:
    """The first bar of the bar-line phase that most 4-beat bars share: GarageBand's 4/4 grid follows it, so the
    sections on the other phase are the ones that run half a bar off (not the other way round)."""
    full = [b for b in bars if b["beats"] == 4]
    phases = np.bincount([b["beat"] % 4 for b in full], minlength=4)
    best = int(phases.argmax())
    return next(b for b in full if b["beat"] % 4 == best)


def placement(first_bar_s: float, bpm: float) -> dict:
    """Where the stems go so that the song's first bar line lands on a GarageBand bar line: the song starts at
    {bar: 1, beat} of a project at guide_bpm; song time t is GarageBand time t + offset_s."""
    guide = round(float(bpm), 2)
    beat_s = 60.0 / guide
    bar_s = 4 * beat_s
    offset = (bar_s - first_bar_s % bar_s) % bar_s
    return {"guide_bpm": guide, "bar": 1, "beat": round(1 + offset / beat_s, 4), "offset_s": round(offset, 4)}


def _walk(beats: np.ndarray, start: float, period: float, step: int, until: float) -> list[float]:
    """Beat times from `start`, one by one (step +1 forward, -1 back): each predicted from the recent local period and
    snapped to a detected beat within a quarter beat — a missed or stray detection keeps the prediction."""
    out, t, recent = [start], start, [period] * 8
    while (t < until) if step > 0 else (t > until):
        p = float(np.mean(recent[-8:]))
        guess = t + step * p
        j = int(np.argmin(np.abs(beats - guess)))
        nxt = float(beats[j]) if abs(beats[j] - guess) < p / 4 else guess
        recent.append(abs(nxt - t))
        t = nxt
        out.append(t)
    return out


def beat_clock(beats, end_s: float, grid: dict | None = None) -> dict:
    """The song's beats as a clock that follows the band: walked from the first beat of the steady run, forward past
    the end and back before 0 s (_walk). index 0 = that beat."""
    b = np.asarray(beats, dtype=float)
    g = grid or fit_grid(b)
    start = float(b[int(np.argmin(np.abs(b - g["steady_from_s"])))])
    fwd = _walk(b, start, g["period"], +1, end_s + 6 * g["period"])
    back = _walk(b, start, g["period"], -1, -6 * g["period"])
    idx = np.array([-i for i in range(len(back) - 1, 0, -1)] + list(range(len(fwd))))
    return {"index": idx, "time": np.array(back[:0:-1] + fwd), "period": g["period"]}


def tempo_map(clock: dict, bars: list[dict]) -> tuple[list[dict], dict, list[float]]:
    """For a take that drifts: one tempo per GarageBand bar (Song JSON tempoMap) so the 4/4 bar lines follow the
    band's own beats from the anchor bar, and the stem placement that goes with it (bar 1's tempo)."""
    at = dict(zip(clock["index"].tolist(), clock["time"].tolist()))
    first = anchor_bar(bars)["beat"]
    while first in at and at[first] > 0:
        first -= 4
    if first not in at:
        raise ValueError("the beat clock does not reach the song's start")
    tm, last, i, bar = [], None, first, 1
    while i + 4 in at:
        bpm = round(240.0 / (at[i + 4] - at[i]), 3)
        if bpm != last:
            tm.append({"bar": bar, "bpm": bpm})
            last = bpm
        i, bar = i + 4, bar + 1
    offset = -at[first]
    place = {"guide_bpm": tm[0]["bpm"], "bar": 1, "beat": round(1 + offset / (60.0 / tm[0]["bpm"]), 4), "offset_s": round(offset, 4)}
    lines = [at[k] for k in range(first, i + 1, 4)]
    return tm, place, lines


def linear_lines(place: dict, gb_bars: int) -> list[float]:
    """GarageBand bar lines in song seconds for a project at one tempo: bar g starts at (g-1) x bar - offset."""
    bar_s = 240.0 / place["guide_bpm"]
    return [g * bar_s - place["offset_s"] for g in range(gb_bars + 1)]


def gb_position(t: float, lines: list[float]) -> tuple[int, float]:
    """(bar, beat) in the GarageBand project of song time t, from its bar lines (song seconds)."""
    k = max(0, min(len(lines) - 2, int(np.searchsorted(lines, t, side="right")) - 1))
    return k + 1, round(1 + 4 * (t - lines[k]) / (lines[k + 1] - lines[k]), 3)


def gb_sections(found: list[dict], lines: list[float]) -> list[dict]:
    """M13.13: sections [{start_s, end_s, label}] (all-in-one) on GarageBand bars. Each starts at the bar line nearest
    its start; it lasts to the next one's bar (the last: to the end); a section that ends up with no bar of its own
    disappears into the next. Repeated labels are numbered (verse 1, verse 2); offset_beats = the model's start minus
    the bar line, in beats."""
    gb_bars = len(lines) - 1
    starts = []
    for f in found:
        g = int(np.argmin([abs(x - f["start_s"]) for x in lines[:gb_bars]]))
        if starts and starts[-1][0] == g:
            starts[-1] = (g, f)  # the later section owns the bar
        else:
            starts.append((g, f))
    count = {}
    for _, f in starts:
        count[f["label"]] = count.get(f["label"], 0) + 1
    seen, out = {}, []
    for k, (g, f) in enumerate(starts):
        end = starts[k + 1][0] if k + 1 < len(starts) else gb_bars
        seen[f["label"]] = seen.get(f["label"], 0) + 1
        name = f["label"] if count[f["label"]] == 1 else f"{f['label']} {seen[f['label']]}"
        beat_s = (lines[g + 1] - lines[g]) / 4
        out.append({"name": name, "label": f["label"], "gb_bar": g + 1, "bars": end - g, "start_s": round(f["start_s"], 3),
                    "offset_beats": round((f["start_s"] - lines[g]) / beat_s, 2)})
    return out


def gb_chords(bars: list[dict], lines: list[float]) -> list[list[str | None]]:
    """Per GarageBand bar, the chord at the middle of each half (None before the first bar or after the last) — a
    Song JSON chords string per half bar, even where the song's own bars run half a bar off the 4/4 grid."""
    def at(t: float) -> str | None:
        for b in bars:
            if b["start_s"] <= t < b["end_s"]:
                ch = b["chords"]
                return ch[0] if len(ch) == 1 or t < (b["start_s"] + b["end_s"]) / 2 else ch[1]
        return None

    return [[at(lo + (hi - lo) * f) for f in (0.25, 0.75)] for lo, hi in zip(lines, lines[1:])]


def vocal_slots(voice: np.ndarray, sr: int, lines: list[float]) -> list[str]:
    """Per GarageBand bar, 8 eighth-note slots: '#' where the voice sounds (within 18 dB of its loud level), '.' where
    it rests — the places for an answering line."""
    db = []
    for lo, hi in zip(lines, lines[1:]):
        for k in range(8):
            a, z = int(round((lo + (hi - lo) * k / 8) * sr)), int(round((lo + (hi - lo) * (k + 1) / 8) * sr))
            seg = voice[max(0, a):max(0, z)]
            db.append(20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-10) if len(seg) else -200.0)
    db = np.array(db)
    sounding = db[db > -80]
    n = len(lines) - 1
    if not len(sounding):
        return ["........"] * n
    marks = np.where(db > float(np.percentile(sounding, 90)) - 18.0, "#", ".")
    return ["".join(marks[g * 8:(g + 1) * 8]) for g in range(n)]


def tempo_curve(beats, window: int = 16) -> list[dict]:
    """The local tempo per `window` beats — a take that speeds up shows here (a fixed grid cannot follow it)."""
    from gbmodels.beatthis import tempo
    b = np.asarray(beats, dtype=float)
    out = []
    for i in range(0, len(b) - window, window):
        seg = b[i:i + window + 1]
        bpm = tempo(seg)
        if bpm and np.isfinite(bpm):
            out.append({"from_s": round(float(seg[0]), 2), "to_s": round(float(seg[-1]), 2), "bpm": round(bpm, 2)})
    return out


def is_steady(tempi: list[float], bpm: float) -> bool:
    """The local tempi stay within 1 % (10th to 90th percentile: one window in a free break does not count)."""
    if not tempi:
        return True
    lo, hi = np.percentile(tempi, [10, 90])
    return bool((hi - lo) / bpm < 0.01)


def melody_bars(other: np.ndarray, sr: int, lines: list[float], share: float = 0.3) -> list[int]:
    """GarageBand bars where the instrument stem already carries a high melody (pYIN, C5–E7, voiced > 30 %)."""
    import librosa
    hop = 1024
    f0, voiced, prob = librosa.pyin(other, fmin=librosa.note_to_hz("C5"), fmax=librosa.note_to_hz("E7"), sr=sr, frame_length=2048, hop_length=hop)
    t = librosa.times_like(f0, sr=sr, hop_length=hop)
    on = voiced & (prob > 0.5)
    out = []
    for g, (lo, hi) in enumerate(zip(lines, lines[1:])):
        sel = (t >= lo) & (t < hi)
        if sel.any() and on[sel].mean() > share:
            out.append(g + 1)
    return out


def _gaps(slots: list[str], min_slots: int = 3) -> list[dict]:
    """Rests of the voice inside sung passages: runs of at least `min_slots` eighths, with voice before and after."""
    flat = "".join(slots)
    out = []
    for m in __import__("re").finditer(r"\.{%d,}" % min_slots, flat):
        if m.start() == 0 or m.end() == len(flat) or m.end() - m.start() > 24:  # not the intro, the ending or a break
            continue
        out.append({"bar": m.start() // 8 + 1, "slot": m.start() % 8 + 1, "eighths": m.end() - m.start()})
    return out


def load(device: str, **_) -> dict:
    return {"device": device, "beats": None, "key": None}


def run(handle: dict, inputs: dict) -> dict:
    """inputs: wav (the mix), stems {vocals, bass, other}, out (the map JSON, never overwritten), key (optional),
    melody (default true), sections (optional: all-in-one's [{start_s, end_s, label}]). Returns the summary; the full
    map (every bar) is in `out`."""
    import json
    import os
    import librosa
    import soundfile as sf
    from gbmodels import beatthis, skey

    out = inputs["out"]
    if os.path.lexists(out):
        raise FileExistsError(f"{os.path.basename(out)} already exists")
    if handle["beats"] is None:
        handle["beats"] = beatthis.load(handle["device"])
    beats, downs = (np.asarray(x) for x in handle["beats"]["model"](inputs["wav"]))
    duration = sf.info(inputs["wav"]).duration
    grid = fit_grid(beats)
    bpm = 60.0 / grid["period"]
    curve = tempo_curve(beats)
    tempi = [c["bpm"] for c in curve] or [bpm]
    steady = is_steady(tempi, bpm)
    key = inputs.get("key")
    if not key:
        if handle["key"] is None:
            handle["key"] = skey.load("cpu")
        key = skey.run(handle["key"], {"wav": inputs["wav"]})["key"]
    clock = beat_clock(beats, duration, grid)
    bars = musical_bars(downs, clock, end_s=duration)
    if not bars:
        raise ValueError("no downbeats found: the map needs a pulse")
    SR, HOP = 22050, 512
    stems = inputs["stems"]
    load_mono = lambda p: librosa.load(p, sr=SR, mono=True)[0]  # noqa: E731
    other, bass, voice = load_mono(stems["other"]), load_mono(stems["bass"]), load_mono(stems["vocals"])
    chroma = lambda y: librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=HOP)  # noqa: E731
    bars = bar_chords(chroma(other), chroma(bass), SR / HOP, bars, key)
    if steady:  # one tempo: GarageBand's bar lines are straight
        tm = None
        a = anchor_bar(bars)["start_s"]  # a detected beat (20 ms frames): use the fitted grid line next to it
        place = placement(grid["t0"] + round((a - grid["t0"]) / grid["period"]) * grid["period"], bpm)
        bar_s = 240.0 / place["guide_bpm"]
        lines = linear_lines(place, int(np.ceil((duration + place["offset_s"]) / bar_s)))
    else:  # the take drifts: a tempo per GarageBand bar so its bar lines follow the band (Song JSON tempoMap)
        tm, place, lines = tempo_map(clock, bars)
    gb_bars = len(lines) - 1
    chords = gb_chords(bars, lines)
    voice_slots = vocal_slots(voice, SR, lines)
    melody = melody_bars(other, SR, lines) if inputs.get("melody", True) else None
    for b in bars:
        b["gb_bar"], b["gb_beat"] = gb_position(b["start_s"], lines)
        b["start_s"], b["end_s"] = round(b["start_s"], 3), round(b["end_s"], 3)
    irregular = [{"start_s": b["start_s"], "beats": b["beats"], "gb_bar": b["gb_bar"], "gb_beat": b["gb_beat"]} for b in bars if b["beats"] != 4]
    sections = gb_sections(inputs["sections"], lines) if inputs.get("sections") else None
    full = {"wav": inputs["wav"], "bpm": round(bpm, 3), "grid": grid, "tempo_curve": curve, "steady": steady, "key": key,
            "place": place, "tempo_map": tm, "bar_lines_s": [round(x, 4) for x in lines], "bars": bars, "irregular": irregular, "sections": sections,
            "gb": [{"bar": g + 1, "chords": chords[g], "voice": voice_slots[g], "melody": bool(melody and g + 1 in melody)} for g in range(gb_bars)]}
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)
    with os.fdopen(fd, "w") as fh:
        json.dump(full, fh, indent=1)
    text = lambda pair: "-" if pair[0] is None and pair[1] is None else (pair[0] or pair[1]) if pair[0] == pair[1] or None in pair else f"{pair[0]} {pair[1]}"  # noqa: E731
    return {"map": out, "bpm": round(bpm, 2), "steady": steady, "tempo_range": [round(float(np.percentile(tempi, 10)), 2), round(float(np.percentile(tempi, 90)), 2)], "key": key,
            "timing_spread_ms": grid["resid_std_ms"], "on_grid": grid["on_grid"], "first_bar_s": round(bars[0]["start_s"], 3), "bars": len(bars),
            "irregular": irregular, "place": place, "tempo_map": tm, "gb_bars": gb_bars,
            "sections": [{k: s[k] for k in ("name", "gb_bar", "bars")} for s in sections] if sections else None,
            "chords": " | ".join(text(c) for c in chords), "voice": "|".join(voice_slots), "gaps": _gaps(voice_slots),
            "melody_bars": melody}
