# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""MuLaCover's inputs from a gb-mcp song MIDI (M12b): melody tracks merged and cut to a bar range, one block chord per
bar from the chord tracks, drums on channel 10; never overwrites; unknown tracks are named.
    cd gb-mcp/models && .venv/bin/python -m unittest tests.test_mulacover_inputs"""
import os
import tempfile
import unittest

import mido

from gbmodels.mulacover_inputs import build

PPQ, BAR = 480, 4 * 480


def song(path):
    mid = mido.MidiFile(ticks_per_beat=PPQ)
    conductor = mido.MidiTrack([mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(132), time=0)])
    mid.tracks.append(conductor)

    def track(name, notes, channel=0):  # notes: (start, end, pitch)
        events = sorted([(s, 1, p) for s, e, p in notes] + [(e, 0, p) for s, e, p in notes])  # offs before ons at a tick
        t, msgs = 0, [mido.MetaMessage("track_name", name=name, time=0)]
        for at, on, p in events:
            msgs.append(mido.Message("note_on" if on else "note_off", note=p, velocity=90 if on else 0, channel=channel, time=at - t))
            t = at
        mid.tracks.append(mido.MidiTrack(msgs))

    track("Lead", [(0, 480, 72), (BAR, BAR + 480, 76), (2 * BAR + 1440, 3 * BAR + 480, 79)])  # C5, E5, G5 across bars 3–4
    track("Violins", [(3 * BAR, 3 * BAR + 960, 81)])  # A5 in bar 4
    track("Pad", [(0, BAR, 48), (0, BAR, 52), (0, BAR, 55), (BAR, 2 * BAR, 45), (BAR, 2 * BAR, 48), (BAR, 2 * BAR, 52)])
    track("Bass", [(0, BAR, 36), (BAR, 2 * BAR, 33)])
    track("Drums", [(i * 480, i * 480 + 120, 36) for i in range(16)], channel=9)
    mid.save(path)


def notes(path):
    """[(start, end, pitch, channel)] and the count of note-offs that close nothing."""
    mid = mido.MidiFile(path)
    out, on, unmatched = [], {}, 0
    for tr in mid.tracks:
        t = 0
        for m in tr:
            t += m.time
            if m.type == "note_on" and m.velocity > 0:
                on[m.note] = (t, m.channel)
            elif m.type in ("note_on", "note_off"):
                if m.note in on:
                    s, ch = on.pop(m.note)
                    out.append((s, t, m.note, ch))
                else:
                    unmatched += 1
    return sorted(out), unmatched


def tempo(path):
    return next(m.tempo for tr in mido.MidiFile(path).tracks for m in tr if m.type == "set_tempo")


class BuildsMuLaCoverInputs(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.mid = os.path.join(self.dir, "song.mid")
        song(self.mid)

    def test_melody_merged_and_cut_to_bars_1_to_3(self):
        r = build(self.mid, os.path.join(self.dir, "in"), melody=["Lead", "Violins"], chords=["Pad", "Bass"], drums=["Drums"], bars=3)
        got, unmatched = notes(r["melody"])
        self.assertEqual(got, [(0, 480, 72, 0), (BAR, BAR + 480, 76, 0), (2 * BAR + 1440, 3 * BAR, 79, 0)])  # G5 cut at bar 4; no A5
        self.assertEqual(unmatched, 0)
        self.assertEqual(tempo(r["melody"]), mido.bpm2tempo(132))
        self.assertEqual((r["bpm"], r["bars"]), (132.0, 3))

    def test_one_block_chord_per_bar_lowest_note_first(self):
        r = build(self.mid, os.path.join(self.dir, "in"), melody=["Lead"], chords=["Pad", "Bass"], bars=2)
        got, unmatched = notes(r["chord"])
        bar1 = [n for n in got if n[0] == 0]
        bar2 = [n for n in got if n[0] == BAR]
        self.assertEqual(unmatched, 0)
        self.assertEqual({n[2] % 12 for n in bar1}, {0, 4, 7})  # C major
        self.assertEqual({n[2] % 12 for n in bar2}, {9, 0, 4})  # A minor
        self.assertTrue(all(e - s == BAR for s, e, _, _ in got))
        self.assertIsNone(r["drums"])

    def test_a_range_from_bar_2_starts_at_zero(self):
        r = build(self.mid, os.path.join(self.dir, "in"), melody=["Lead"], chords=["Pad"], start_bar=2, bars=2)
        got, _ = notes(r["melody"])
        self.assertEqual(got, [(0, 480, 76, 0), (BAR + 1440, 2 * BAR, 79, 0)])

    def test_without_a_bar_count_the_range_runs_to_the_last_event(self):
        r = build(self.mid, os.path.join(self.dir, "in"), melody=["Lead"], chords=["Pad"])
        self.assertEqual(r["bars"], 4)  # the last note ends in bar 4
        self.assertAlmostEqual(r["seconds"], 4 * 4 * 60 / 132, places=2)

    def test_drums_on_channel_10(self):
        r = build(self.mid, os.path.join(self.dir, "in"), melody=["Lead"], chords=["Pad"], drums=["Drums"], bars=1)
        got, _ = notes(r["drums"])
        self.assertEqual({n[3] for n in got}, {9})
        self.assertEqual(len(got), 4)

    def test_unknown_track_names_the_tracks_and_nothing_is_overwritten(self):
        with self.assertRaisesRegex(ValueError, "Bansuri.*Lead, Violins, Pad, Bass, Drums"):
            build(self.mid, os.path.join(self.dir, "in"), melody=["Bansuri"], chords=["Pad"])
        out = os.path.join(self.dir, "in2")
        build(self.mid, out, melody=["Lead"], chords=["Pad"], bars=1)
        with self.assertRaises(FileExistsError):
            build(self.mid, out, melody=["Lead"], chords=["Pad"], bars=1)


if __name__ == "__main__":
    unittest.main()
