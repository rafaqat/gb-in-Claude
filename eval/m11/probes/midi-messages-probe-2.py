# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""MIDI message probe 2 (GarageBand MIDI-file import). One test per track, a 6 s window each at 60 BPM (480 ticks = 1 s):
0–0.5 s silence (no bleed), 'before' 0.5–2.9 s, the message changes at 3.0 s, 'after' 3.1–5.5 s."""
import json, mido, sys
TPS, WIN = 480, 6
CH = [c for c in range(16) if c != 9]
cc = lambda ch, n, v: mido.Message("control_change", channel=ch, control=n, value=v)
def rpn(ch, msb, lsb, val):
    return [cc(ch, 101, msb), cc(ch, 100, lsb), cc(ch, 6, val), cc(ch, 38, 0), cc(ch, 101, 127), cc(ch, 100, 127)]
REP = lambda p, every=0.5, dur=0.4: [(0.5 + i * every, dur, p) for i in range(int(5.0 / every))]
SUS = lambda p: [(0.5, 2.4, p), (3.1, 2.4, p)]
LONG = lambda p: [(0.5, 5.0, p)]
LEGATO = lambda a, b: [(0.5 + i * 0.5, 0.52, a if i % 2 == 0 else b) for i in range(10)]
def bend_ramp(ch):  # 3.0–3.5 s: 0 → full scale
    return [(3.0 + i * 0.01, mido.Message("pitchwheel", channel=ch, pitch=min(8191, int(8192 * i / 50)))) for i in range(51)]
TESTS = [  # name, program, notes, at 0 s, at 3 s (list of (abs_s, msg) allowed via 'timed')
    ("SynCC1", 81, SUS(57), lambda c: [cc(c, 1, 0)], lambda c: [cc(c, 1, 127)]),
    ("StrCC1", 48, SUS(64), lambda c: [cc(c, 1, 0)], lambda c: [cc(c, 1, 127)]),
    ("SynPres", 81, SUS(57), lambda c: [mido.Message("aftertouch", channel=c, value=0)], lambda c: [mido.Message("aftertouch", channel=c, value=127)]),
    ("SynPoly", 81, SUS(57), lambda c: [mido.Message("polytouch", channel=c, note=57, value=0)], lambda c: [mido.Message("polytouch", channel=c, note=57, value=127)]),
    ("SynPorta", 81, LEGATO(57, 64), lambda c: [cc(c, 65, 0)], lambda c: [cc(c, 65, 127), cc(c, 5, 90)]),
    ("SynReso", 81, REP(45), lambda c: [cc(c, 71, 0)], lambda c: [cc(c, 71, 127)]),
    ("SynRel", 81, REP(57, 1.0, 0.2), lambda c: [cc(c, 72, 0)], lambda c: [cc(c, 72, 127)]),
    ("FluRev", 73, REP(69, 1.0, 0.2), lambda c: [cc(c, 91, 0)], lambda c: [cc(c, 91, 127)]),
    ("SynRev", 81, REP(57, 1.0, 0.2), lambda c: [cc(c, 91, 0)], lambda c: [cc(c, 91, 127)]),
    ("SynCho", 81, REP(57), lambda c: [cc(c, 93, 0)], lambda c: [cc(c, 93, 127)]),
    ("SynBend", 81, LONG(57), lambda c: rpn(c, 0, 0, 12), None),
    ("StrBend", 48, LONG(64), lambda c: rpn(c, 0, 0, 12), None),
    ("BasBend", 39, LONG(40), lambda c: rpn(c, 0, 0, 12), None),
    ("HrpBend", 46, LONG(64), lambda c: rpn(c, 0, 0, 12), None),
    ("PnoOffVel", 0, REP(60, 1.0, 0.3), lambda c: [], "offvel"),
]
mid = mido.MidiFile(type=1, ticks_per_beat=480)
cond = mido.MidiTrack(); mid.tracks.append(cond)
cond.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(60)))
cond.append(mido.MetaMessage("time_signature", numerator=4, denominator=4))
for k, (name, prog, notes, at0, at3) in enumerate(TESTS):
    ch = CH[k]; w = k * WIN; ev = [(0.0, mido.Message("program_change", channel=ch, program=prog))]
    ev += [(w + 0.05, m) for m in at0(ch)]
    if at3 is None: ev += [(w + t, m) for t, m in bend_ramp(ch)] + [(w + 5.9, mido.Message("pitchwheel", channel=ch, pitch=0))]
    elif at3 != "offvel": ev += [(w + 2.98, m) for m in at3(ch)]
    for s, d, p in notes:
        offv = 127 if (at3 == "offvel" and s >= 3.0) else 0
        ev += [(w + s, mido.Message("note_on", channel=ch, note=p, velocity=90)), (w + s + d, mido.Message("note_off", channel=ch, note=p, velocity=offv))]
    t = mido.MidiTrack(); t.append(mido.MetaMessage("track_name", name=name)); last = 0
    for at, m in sorted(((int(round(a * TPS)), m) for a, m in ev), key=lambda e: (e[0], e[1].type == "note_on")):
        t.append(m.copy(time=at - last)); last = at
    mid.tracks.append(t)
mid.save(sys.argv[1])
json.dump({"tests": [t[0] for t in TESTS], "win": WIN}, open(sys.argv[2], "w"))
print("ok", len(TESTS))
