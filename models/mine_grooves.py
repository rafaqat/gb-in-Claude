# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Mine genre grooves from the Groove MIDI Dataset (Magenta, CC BY 4.0) into gb-mcp/src/song/grooves.json (M9).

For every style's 4/4 beats: per drum voice and 16th step, the hit probability, the mean velocity and the mean timing
offset (fraction of a 16th: + is late), plus a readable grid (X accent · x hit · o ghost · . rest).
    models/.venv/bin/python models/mine_grooves.py [path/to/groove]"""
import csv
import json
import os
import sys
from collections import defaultdict

import mido

GMD = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/Library/Caches/gb-mcp/datasets/groove")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "song", "grooves.json")
# Roland TD-11 notes used by the dataset → gb-mcp's drum voices
VOICE = {36: "kick", 38: "snare", 40: "snare", 37: "rim", 42: "hat", 22: "hat", 44: "pedal-hat", 46: "open-hat", 26: "open-hat",
         43: "tom-low", 58: "tom-low", 47: "tom-mid", 45: "tom-mid", 48: "tom-high", 50: "tom-high",
         49: "crash", 55: "crash", 57: "crash", 52: "crash", 51: "ride", 59: "ride", 53: "ride"}
STEPS = 16


def hits(path):
    """(bar, step, voice, velocity, offset) for every drum hit; the file's tempo is the click the drummer played to."""
    mid = mido.MidiFile(path)
    out, tick = [], 0
    for msg in mido.merge_tracks(mid.tracks):
        tick += msg.time
        if msg.type == "note_on" and msg.velocity > 0 and msg.note in VOICE:
            sixteenth = tick / mid.ticks_per_beat * 4
            nearest = round(sixteenth)
            out.append((nearest // STEPS, nearest % STEPS, VOICE[msg.note], msg.velocity, sixteenth - nearest))
    return out


def grid_char(p, vel):
    if p >= 0.5:
        return "X" if vel >= 105 else "x"
    if p >= 0.3:
        return "o" if vel < 75 else "x"
    return "."


def main():
    rows = [r for r in csv.DictReader(open(os.path.join(GMD, "info.csv"))) if r["beat_type"] == "beat" and r["time_signature"] == "4-4"]
    by_style = defaultdict(list)
    for r in rows:
        by_style[r["style"].split("/")[0]].append(r)
    grooves = {}
    for style, files in sorted(by_style.items()):
        count = defaultdict(lambda: [0] * STEPS)
        vel = defaultdict(lambda: [0.0] * STEPS)
        off = defaultdict(lambda: [0.0] * STEPS)
        bars = 0
        for r in files:
            hs = hits(os.path.join(GMD, r["midi_filename"]))
            if not hs:
                continue
            bars += max(b for b, *_ in hs) + 1
            seen = set()
            for b, step, voice, v, o in hs:
                if (b, step, voice) in seen:  # one hit per voice per step and bar (flams count once)
                    continue
                seen.add((b, step, voice))
                count[voice][step] += 1
                vel[voice][step] += v
                off[voice][step] += o
        voices = {}
        for voice, c in count.items():
            p = [n / bars for n in c]
            if max(p) < 0.15:
                continue  # a voice this style barely uses
            mean_vel = [round(vel[voice][i] / c[i]) if c[i] else 0 for i in range(STEPS)]
            mean_off = [round(off[voice][i] / c[i], 3) if c[i] else 0.0 for i in range(STEPS)]
            voices[voice] = {"p": [round(x, 3) for x in p], "velocity": mean_vel, "offset": mean_off,
                             "grid": "".join(grid_char(p[i], mean_vel[i]) for i in range(STEPS))}
        grooves[style] = {"recordings": len(files), "bars": bars, "voices": voices}
        print(f"{style:14s} {len(files):3d} recordings {bars:5d} bars  " + "  ".join(f"{v}:{d['grid']}" for v, d in voices.items() if v in ("kick", "snare", "hat", "ride")), flush=True)
    doc = {"source": "Groove MIDI Dataset v1.0.0 (Magenta, CC BY 4.0) — 4/4 beats, mined by models/mine_grooves.py",
           "steps": STEPS, "offset_unit": "fraction of a 16th note (+ late, − early)", "styles": grooves}
    json.dump(doc, open(OUT, "w"), indent=1)
    print("wrote", os.path.normpath(OUT))


if __name__ == "__main__":
    main()
