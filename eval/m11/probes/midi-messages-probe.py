# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""MIDI message probe (usage: midi-messages-probe.py out.mid meta.json): one test per track, 4 s window each (60 BPM: 480 ticks = 1 s); the message changes at +2 s."""
import json, sys
import mido
TPS, WIN = 480, 4
CHANNELS = [c for c in range(16) if c != 9]
def cc(ch, n, v): return mido.Message("control_change", channel=ch, control=n, value=v)
def rpn(ch, msb, lsb, data_msb, data_lsb=0):
    return [cc(ch, 101, msb), cc(ch, 100, lsb), cc(ch, 6, data_msb), cc(ch, 38, data_lsb), cc(ch, 101, 127), cc(ch, 100, 127)]
def repeated(pitch, every, dur):  # (start_s, dur_s, pitch) over the window
    return [(i * every, dur, pitch) for i in range(int(WIN / every))]
def sustained(pitch):
    return [(0.0, 1.9, pitch), (2.0, 1.9, pitch)]
# name, program, notes(window-relative), events at 0 s, events at +2 s
TESTS = [
    ("CC7vol", 73, repeated(69, 0.5, 0.4), lambda c: [cc(c, 7, 100)], lambda c: [cc(c, 7, 40)]),
    ("CC11expr", 73, repeated(69, 0.5, 0.4), lambda c: [cc(c, 11, 127)], lambda c: [cc(c, 11, 40)]),
    ("CC10pan", 48, repeated(60, 0.5, 0.4), lambda c: [cc(c, 10, 64)], lambda c: [cc(c, 10, 0)]),
    ("CC1mod", 73, sustained(69), lambda c: [cc(c, 1, 0)], lambda c: [cc(c, 1, 127)]),
    ("CC64sus", 0, repeated(60, 0.5, 0.1), lambda c: [cc(c, 64, 0)], lambda c: [cc(c, 64, 127)]),
    ("CC74cut", 81, repeated(57, 0.5, 0.4), lambda c: [cc(c, 74, 64)], lambda c: [cc(c, 74, 0)]),
    ("CC73atk", 81, repeated(57, 0.5, 0.4), lambda c: [cc(c, 73, 0)], lambda c: [cc(c, 73, 127)]),
    ("CC91rev", 73, repeated(69, 1.0, 0.2), lambda c: [cc(c, 91, 0)], lambda c: [cc(c, 91, 127)]),
    ("CC93cho", 48, repeated(60, 0.5, 0.4), lambda c: [cc(c, 93, 0)], lambda c: [cc(c, 93, 127)]),
    ("ChanPres", 73, sustained(69), lambda c: [mido.Message("aftertouch", channel=c, value=0)], lambda c: [mido.Message("aftertouch", channel=c, value=127)]),
    ("PolyAT", 73, sustained(69), lambda c: [mido.Message("polytouch", channel=c, note=69, value=0)], lambda c: [mido.Message("polytouch", channel=c, note=69, value=127)]),
    ("ProgChg", 0, repeated(69, 0.5, 0.4), lambda c: [], lambda c: [mido.Message("program_change", channel=c, program=73)]),
    ("RPNfine", 73, sustained(69), lambda c: [], lambda c: rpn(c, 0, 1, 96)),
    ("RPNcoarse", 73, sustained(69), lambda c: [], lambda c: rpn(c, 0, 2, 66)),
    ("Tempo", 73, [], lambda c: [], lambda c: []),
]
mid = mido.MidiFile(type=1, ticks_per_beat=480)
cond = mido.MidiTrack(); mid.tracks.append(cond)
tempo_at = (len(TESTS) - 1) * WIN + 2
cond.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(60)))
cond.append(mido.MetaMessage("time_signature", numerator=4, denominator=4))
cond.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(120), time=tempo_at * TPS))
for k, (name, prog, notes, at0, at2) in enumerate(TESTS):
    ch = CHANNELS[k]; w = k * WIN * TPS; ev = []
    ev.append((0, mido.Message("program_change", channel=ch, program=prog)))
    ev += [(w, m) for m in at0(ch)] + [(w + 2 * TPS - 5, m) for m in at2(ch)]
    if name == "Tempo":  # a note on every beat: 1 s apart before the change, 0.5 s after if the tempo map is honoured
        notes_t = [(w + i * TPS, int(0.3 * TPS), 69) for i in range(2)] + [(w + 2 * TPS + i * TPS, int(0.15 * TPS), 69) for i in range(4)]
    else:
        notes_t = [(w + int(s * TPS), int(d * TPS), p) for s, d, p in notes]
    for at, d, p in notes_t:
        ev += [(at, mido.Message("note_on", channel=ch, note=p, velocity=90)), (at + d, mido.Message("note_off", channel=ch, note=p, velocity=0))]
    t = mido.MidiTrack(); t.append(mido.MetaMessage("track_name", name=name)); last = 0
    for at, m in sorted(ev, key=lambda e: (e[0], e[1].type == "note_on")):
        t.append(m.copy(time=at - last)); last = at
    mid.tracks.append(t)
mid.save(sys.argv[1])
json.dump({"tests": [t[0] for t in TESTS], "win": WIN, "tempo_at": tempo_at}, open(sys.argv[2], "w"))
print("ok", len(TESTS), "tests")
