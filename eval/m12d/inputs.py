# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""M12d inputs: MuLaCover's melody / chord / drum MIDI + lyrics + tags from a gb-mcp MIDI song (models/.venv).

    models/.venv/bin/python eval/m12d/inputs.py <song.mid> <bars> <melody tracks> <chord tracks> <out folder> [drum track]

Track arguments may join several tracks with "+" (a melody may move from one instrument to another). Melody and drum MIDI
hold those tracks' notes, re-timed to the song's first tempo (MuLaCover reads only the first tempo and puts notes on
a sixteenth grid), cut at <bars> bars of 4/4. The chord MIDI is one block chord per bar: the pitch classes the chord
tracks play in that bar (the lowest note's first, at most 4) — MuLaCover's own transcriber also gives block chords,
and an arpeggio is not one. Paths are relative to the workspace (out/). Never overwrites.
"""
import os, sys
import mido

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # eval/: _paths
from _paths import ROOT, workspace  # noqa: E402
WORKSPACE = workspace()


def one_track(src: mido.MidiFile, name: str, bars: int, channel: int) -> mido.MidiFile:
    tempo = next((m.tempo for t in src.tracks for m in t if m.type == "set_tempo"), 500000)
    end = bars * 4 * src.ticks_per_beat
    track = mido.merge_tracks([t for t in src.tracks if t.name in name.split("+")])
    out = mido.MidiFile(ticks_per_beat=src.ticks_per_beat)
    meta = mido.MidiTrack([mido.MetaMessage("set_tempo", tempo=tempo, time=0), mido.MetaMessage("time_signature", numerator=4, denominator=4, time=0)])
    notes, tick, last = mido.MidiTrack([mido.MetaMessage("track_name", name=name, time=0)]), 0, 0
    sounding = set()
    for m in track:
        tick += m.time
        if m.type not in ("note_on", "note_off"):
            continue
        on = m.type == "note_on" and m.velocity > 0
        if (on and tick >= end) or (not on and m.note not in sounding):
            continue  # a note starting after the cut, or the end of one that never started inside it
        at = min(tick, end)
        notes.append(m.copy(channel=channel, time=at - last)); last = at
        (sounding.add if on else sounding.discard)(m.note)
    for n in sorted(sounding):  # close notes still sounding at the cut
        notes.append(mido.Message("note_off", note=n, velocity=0, channel=channel, time=end - last)); last = end
    out.tracks += [meta, notes]
    return out


def bar_chords(src: mido.MidiFile, names: str, bars: int) -> mido.MidiFile:
    from collections import Counter
    tempo = next((m.tempo for t in src.tracks for m in t if m.type == "set_tempo"), 500000)
    bar = 4 * src.ticks_per_beat
    per_bar = [Counter() for _ in range(bars)]
    low = [None] * bars
    for t in (t for t in src.tracks if t.name in names.split("+")):
        tick = 0
        for m in t:
            tick += m.time
            if m.type == "note_on" and m.velocity > 0 and tick < bars * bar:
                b = tick // bar
                per_bar[b][m.note % 12] += 1
                low[b] = m.note if low[b] is None else min(low[b], m.note)
    out = mido.MidiFile(ticks_per_beat=src.ticks_per_beat)
    meta = mido.MidiTrack([mido.MetaMessage("set_tempo", tempo=tempo, time=0), mido.MetaMessage("time_signature", numerator=4, denominator=4, time=0)])
    notes, last = mido.MidiTrack([mido.MetaMessage("track_name", name="chords", time=0)]), 0
    for b, counts in enumerate(per_bar):
        if not counts:
            continue
        root = low[b] % 12
        pcs = [root] + [pc for pc, _ in counts.most_common() if pc != root][:3]
        for i, pc in enumerate(pcs):
            notes.append(mido.Message("note_on", note=48 + pc, velocity=80, time=b * bar - last if i == 0 else 0)); last = b * bar
        for i, pc in enumerate(pcs):
            notes.append(mido.Message("note_off", note=48 + pc, velocity=0, time=(b + 1) * bar - last if i == 0 else 0)); last = (b + 1) * bar
    out.tracks += [meta, notes]
    return out


def main(song: str, bars: int, melody: str, chords: str, folder: str, drums: str | None = None) -> int:
    src = mido.MidiFile(os.path.join(WORKSPACE, song))
    out = os.path.join(WORKSPACE, folder)
    os.makedirs(out, exist_ok=True)
    jobs = [("melody.mid", melody, 0), ("chord.mid", chords, 0)] + ([("drums.mid", drums, 9)] if drums else [])
    for file, name, channel in jobs:
        path = os.path.join(out, file)
        if os.path.lexists(path):
            sys.exit(f"{path} exists; nothing written")
        (bar_chords(src, name, bars) if file == "chord.mid" else one_track(src, name, bars, channel)).save(path)
        print(f"{file}: {name}, {bars} bars")
    return 0


if __name__ == "__main__":
    a = sys.argv[1:]
    sys.exit(main(a[0], int(a[1]), a[2], a[3], a[4], a[5] if len(a) > 5 else None))
