# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""MuLaCover's symbolic inputs from a gb-mcp song MIDI (M12b). MuLaCover reads melody, chord and drum MIDI on a
sixteenth-note grid with the first tempo only (it takes no tempo from MIDI and chooses its own). From a song MIDI:
- melody: the named tracks merged (a melody may move from one instrument to another), cut to the bar range;
- chord: one block chord per bar — the pitch classes the named tracks sound in that bar, weighted by how long they
  sound (a held pad counts in every bar it covers), the lowest note's first, at most 4; MuLaCover's own transcriber
  also gives block chords, and an arpeggio is not one;
- drums: the named tracks on channel 10.
The bar range starts at 0 in the output. Nothing is overwritten. Runs in MuLaCover's venv and in models/.venv (mido)."""
import math
import os
from collections import Counter, defaultdict

import mido

CHORD_OCTAVE = 48  # C3: MuLaCover reduces chord notes to pitch classes, so the octave only keeps the file readable


def _first_meta(src: mido.MidiFile, kind: str):
    found = []
    for tr in src.tracks:
        t = 0
        for m in tr:
            t += m.time
            if m.type == kind:
                found.append((t, m))
    return min(found, key=lambda x: x[0])[1] if found else None


def _named(src: mido.MidiFile, names: list[str]) -> list[mido.MidiTrack]:
    available = [tr.name for tr in src.tracks if tr.name and any(m.type == "note_on" for m in tr)]
    missing = [n for n in names if n not in available]
    if missing:
        raise ValueError(f"no track {', '.join(missing)} in the song; its tracks: {', '.join(available)}")
    return [tr for tr in src.tracks if tr.name in names]


def _notes(tracks: list[mido.MidiTrack], start: int, end: int) -> list[tuple[int, int, int]]:
    """(start, end, pitch) clipped to [start, end) and moved so that `start` is 0."""
    out = []
    for tr in tracks:
        t, on = 0, defaultdict(list)
        for m in tr:
            t += m.time
            if m.type == "note_on" and m.velocity > 0:
                on[m.note].append(t)
            elif m.type in ("note_on", "note_off") and on[m.note]:
                s = on[m.note].pop(0)
                if s < end and t > start:
                    out.append((max(s, start) - start, min(t, end) - start, m.note))
    return sorted(out)


def _write(path: str, ppq: int, tempo: int, numerator: int, denominator: int, notes, channel: int) -> None:
    mid = mido.MidiFile(ticks_per_beat=ppq)
    mid.tracks.append(mido.MidiTrack([mido.MetaMessage("set_tempo", tempo=tempo, time=0),
                                      mido.MetaMessage("time_signature", numerator=numerator, denominator=denominator, time=0)]))
    events = sorted([(e, 0, p) for s, e, p in notes] + [(s, 1, p) for s, e, p in notes])  # at one tick: offs before ons
    msgs, t = [], 0
    for at, is_on, p in events:
        msgs.append(mido.Message("note_on" if is_on else "note_off", note=p, velocity=90 if is_on else 0, channel=channel, time=at - t))
        t = at
    mid.tracks.append(mido.MidiTrack(msgs))
    mid.save(path)


def _bar_chords(notes, bars: int, bar_ticks: int):
    blocks = []
    for b in range(bars):
        lo, hi = b * bar_ticks, (b + 1) * bar_ticks
        weight, lowest = Counter(), None
        for s, e, p in notes:
            overlap = min(e, hi) - max(s, lo)
            if overlap > 0:
                weight[p % 12] += overlap
                lowest = p if lowest is None else min(lowest, p)
        if lowest is None:
            continue
        root = lowest % 12
        pcs = [root] + [pc for pc, _ in weight.most_common() if pc != root][:3]
        blocks += [(lo, hi, CHORD_OCTAVE + pc) for pc in pcs]
    return blocks


def build(song_mid: str, out_dir: str, melody: list[str], chords: list[str], drums: list[str] | None = None,
          start_bar: int = 1, bars: int | None = None) -> dict:
    src = mido.MidiFile(song_mid)
    tempo_msg, sig = _first_meta(src, "set_tempo"), _first_meta(src, "time_signature")
    tempo = tempo_msg.tempo if tempo_msg else 500000
    num, den = (sig.numerator, sig.denominator) if sig else (4, 4)
    bar_ticks = src.ticks_per_beat * num * 4 // den
    melody_tracks, chord_tracks = _named(src, melody), _named(src, chords)
    drum_tracks = _named(src, drums) if drums else []
    start = (start_bar - 1) * bar_ticks
    if bars is None:  # to the song's last event
        last = max((sum(m.time for m in tr) for tr in src.tracks), default=0)
        bars = max(1, math.ceil((last - start) / bar_ticks))
    end = start + bars * bar_ticks
    targets = {"melody": os.path.join(out_dir, "melody.mid"), "chord": os.path.join(out_dir, "chord.mid"),
               "drums": os.path.join(out_dir, "drums.mid") if drums else None}
    taken = [p for p in targets.values() if p and os.path.lexists(p)]
    if taken:
        raise FileExistsError(f"already there: {', '.join(os.path.basename(p) for p in taken)}; nothing written")
    os.makedirs(out_dir, exist_ok=True)
    _write(targets["melody"], src.ticks_per_beat, tempo, num, den, _notes(melody_tracks, start, end), 0)
    _write(targets["chord"], src.ticks_per_beat, tempo, num, den, _bar_chords(_notes(chord_tracks, start, end), bars, bar_ticks), 0)
    if drums:
        _write(targets["drums"], src.ticks_per_beat, tempo, num, den, _notes(drum_tracks, start, end), 9)
    bpm = round(mido.tempo2bpm(tempo), 3)
    return {**targets, "bpm": bpm, "bars": bars, "seconds": round(bars * num * 60 / bpm * 4 / den, 3)}
