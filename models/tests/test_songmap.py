# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Song map (M13.6): the bar structure of a recording — pure functions on synthetic beats, chroma and envelopes."""
import unittest

import numpy as np

from gbmodels import songmap

FRAME = 0.02
framed = lambda t: np.round(np.asarray(t, dtype=float) / FRAME) * FRAME  # noqa: E731
BEAT = 60 / 79


class GridTest(unittest.TestCase):
    def test_the_grid_comes_from_the_steady_beats_not_the_free_intro(self):
        intro = [0.14, 1.30, 1.80, 3.90]                         # rubato, off any grid
        steady = framed(2.757 + np.arange(300) * BEAT)            # 79 BPM from 2.757 s
        g = songmap.fit_grid(np.concatenate([intro, steady]))
        self.assertAlmostEqual(60 / g["period"], 79.0, delta=0.05)
        on = (np.asarray(steady) - g["t0"]) / g["period"]
        self.assertLess(np.max(np.abs(on - np.round(on))) * g["period"], 0.025)  # every steady beat within 25 ms

    def test_a_tracker_that_jumps_to_the_swung_off_beat_does_not_bend_the_tempo(self):
        period = 60 / 84.85
        t = 1.0 + np.arange(300) * period
        t[100:160] += period / 3                                  # 60 beats caught a third of a beat late
        g = songmap.fit_grid(framed(t))
        self.assertAlmostEqual(60 / g["period"], 84.85, delta=0.05)


class SteadyTest(unittest.TestCase):
    def test_one_slow_window_in_a_free_break_does_not_make_a_steady_song_unsteady(self):
        self.assertTrue(songmap.is_steady([84.9] * 18 + [78.3], 84.87))

    def test_a_take_that_speeds_up_is_not_steady(self):
        self.assertFalse(songmap.is_steady(list(np.linspace(85.5, 88.8, 19)), 86.1))


class BarsTest(unittest.TestCase):
    def test_a_two_beat_bar_between_two_downbeat_phases_and_a_stray_half_bar_detection(self):
        grid = {"period": BEAT, "t0": 2.757}
        at = lambda k: grid["t0"] + k * BEAT  # noqa: E731
        idx = list(range(2, 59, 4)) + list(range(60, 101, 4)) + [62]  # phase 2, a 2-beat bar at 58, phase 0; 62 is stray
        bars = songmap.musical_bars(framed(sorted(at(k) for k in idx)), songmap.linear_clock(grid, at(104)), end_s=at(104))
        lengths = {round(b["beat"]): b["beats"] for b in bars}
        self.assertEqual(lengths[58], 2)
        self.assertEqual([lengths[k] for k in (2, 54, 60, 64, 100)], [4, 4, 4, 4, 4])
        self.assertNotIn(62, lengths)
        self.assertEqual([b for b in bars if b["beats"] != 4], [b for b in bars if round(b["beat"]) == 58])


def _chroma_of(pcs_per_half, frames_per_half=20):
    """12 x frames chroma: each half bar lights its pitch classes."""
    cols = []
    for pcs in pcs_per_half:
        c = np.full(12, 0.05)
        c[list(pcs)] = 1.0
        cols += [c] * frames_per_half
    return np.array(cols).T


class ChordsTest(unittest.TestCase):
    def test_one_chord_per_bar_and_a_split_where_both_halves_are_sure(self):
        D, G, Bm, A = (2, 6, 9), (7, 11, 2), (11, 2, 6), (9, 1, 4)
        other = _chroma_of([D, D, G, G, Bm, Bm, D, A])               # 4 bars, the last splits D | A
        bass = _chroma_of([(2,), (2,), (7,), (7,), (11,), (11,), (2,), (9,)])
        bars = [{"beat": 4 * k, "start_s": 2.0 * k, "beats": 4} for k in range(4)]
        out = songmap.bar_chords(other, bass, fps=20, bars=bars, key="D major")
        self.assertEqual([b["chords"] for b in out], [["D"], ["G"], ["Bm"], ["D", "A"]])

    def test_a_bar_of_digital_silence_gets_a_finite_margin_so_the_map_stays_valid_json(self):
        import json
        other = _chroma_of([(2, 6, 9)] * 4)
        other[:, 40:] = np.nan  # librosa's chroma of exact zeros is 0/0
        bass = _chroma_of([(2,)] * 4)
        bars = [{"beat": 4 * k, "start_s": 2.0 * k, "beats": 4} for k in range(2)]
        out = songmap.bar_chords(other, bass, fps=20, bars=bars, key="D major")
        json.dumps(out, allow_nan=False)  # raises on NaN
        self.assertEqual(out[0]["chords"], ["D"])

    def test_a_bar_past_the_end_of_the_audio_gets_a_finite_margin_too(self):
        import json
        other, bass = _chroma_of([(2, 6, 9)] * 4), _chroma_of([(2,)] * 4)  # 80 frames = 4 s at 20 fps
        bars = [{"beat": 4 * k, "start_s": 2.0 * k, "beats": 4} for k in range(3)]  # the third bar starts at 4 s
        json.dumps(songmap.bar_chords(other, bass, fps=20, bars=bars, key="D major"), allow_nan=False)


class AnchorTest(unittest.TestCase):
    def test_the_grid_follows_the_bar_lines_that_cover_most_of_the_song(self):
        bars = [{"beat": b, "start_s": b * 0.5, "beats": 4} for b in (2, 6, 10)] + [{"beat": 14, "start_s": 7.0, "beats": 2}] + \
               [{"beat": b, "start_s": b * 0.5, "beats": 4} for b in (16, 20, 24, 28, 32)]
        self.assertEqual(songmap.anchor_bar(bars)["beat"], 16)  # phase 0 (5 bars) wins over phase 2 (3 bars)


class PlacementTest(unittest.TestCase):
    def test_the_first_bar_lands_on_a_garageband_bar_line(self):
        place = songmap.placement(first_bar_s=2.757, bpm=79.0)
        self.assertEqual((place["bar"], round(place["beat"], 3), place["guide_bpm"]), (1, 1.370, 79.0))
        self.assertEqual(songmap.gb_position(2.757, songmap.linear_lines(place, 4)), (2, 1.0))

    def test_chords_and_voice_per_garageband_bar(self):
        place = songmap.placement(first_bar_s=0.0, bpm=120.0)  # bar = 2 s; song time = GarageBand time
        bars = [{"beat": 0, "start_s": 0.0, "end_s": 2.0, "beats": 4, "chords": ["D"]}, {"beat": 4, "start_s": 2.0, "end_s": 3.0, "beats": 2, "chords": ["A"]},
                {"beat": 6, "start_s": 3.0, "end_s": 5.0, "beats": 4, "chords": ["G", "D"]}]
        lines = songmap.linear_lines(place, 3)
        self.assertEqual(songmap.gb_chords(bars, lines), [["D", "D"], ["A", "G"], ["D", None]])
        sr = 100
        voice = np.zeros(6 * sr)
        voice[: int(1.25 * sr)] = 0.5                                  # sings the first 5 eighths of bar 1
        self.assertEqual(songmap.vocal_slots(voice, sr, lines)[:2], ["#####...", "........"])


def _bar_lines(tempo_map, place, bars):
    """GarageBand time of each bar line (1-based) from a tempo map, in song seconds."""
    tempi = {t["bar"]: t["bpm"] for t in tempo_map}
    bpm, t, out = tempi.get(1, place["guide_bpm"]), -place["offset_s"], []
    for bar in range(1, bars + 1):
        bpm = tempi.get(bar, bpm)
        out.append(t)
        t += 240.0 / bpm
    return out


class DriftTest(unittest.TestCase):
    def test_a_take_that_speeds_up_has_no_invented_irregular_bars(self):
        bpm = np.linspace(85.0, 89.0, 400)
        beats = framed(3.0 + np.concatenate([[0.0], np.cumsum(60.0 / bpm[:-1])]))
        clock = songmap.beat_clock(beats, end_s=float(beats[-1]))
        bars = songmap.musical_bars(beats[::4][2:], clock, end_s=float(beats[-1]))
        self.assertEqual([b for b in bars if b["beats"] != 4], [])
        self.assertLess(max(abs(b["start_s"] - beats[8 + 4 * k]) for k, b in enumerate(bars[:90])), 0.025)


class TempoMapTest(unittest.TestCase):
    def test_garageband_bar_lines_follow_a_take_that_speeds_up(self):
        bpm = np.linspace(85.0, 89.0, 400)
        everything = framed(3.0 + np.concatenate([[0.0], np.cumsum(60.0 / bpm[:-1])]))
        beats = np.delete(everything, [50, 51, 200])                  # missed beats
        downs = everything[::4][2:]                                   # the true downbeats from the third bar on
        clock = songmap.beat_clock(beats, end_s=float(beats[-1]))
        bars = songmap.musical_bars(downs, clock, end_s=float(beats[-1]))
        tm, place, _ = songmap.tempo_map(clock, bars)
        lines = _bar_lines(tm, place, tm[-1]["bar"] + 1)
        anchor = songmap.anchor_bar(bars)["start_s"]
        k0 = int(np.argmin(np.abs(np.asarray(lines) - anchor)))
        full = framed(3.0 + np.concatenate([[0.0], np.cumsum(60.0 / bpm[:-1])]))
        a = int(np.argmin(np.abs(full - anchor)))
        err = [abs(lines[k0 + j] - full[a + 4 * j]) for j in range(95) if a + 4 * j < len(full) and k0 + j < len(lines)]
        self.assertGreaterEqual(len(err), 60)
        self.assertLess(max(err), 0.03)                               # every bar line within 30 ms of its downbeat


if __name__ == "__main__":
    unittest.main()


class SectionsTest(unittest.TestCase):
    """M13.13: the model's sections on GarageBand bars — each starts at the nearest bar line; repeated labels are
    numbered; how far the model's time sits from that line is kept (beats)."""

    def test_sections_snap_to_bar_lines_and_count_bars_to_the_next_one(self):
        lines = [2.0 * g for g in range(11)]  # 10 bars of 2 s
        found = [{"start_s": 0.1, "end_s": 3.9, "label": "intro"}, {"start_s": 3.9, "end_s": 8.2, "label": "verse"},
                 {"start_s": 8.2, "end_s": 12.0, "label": "verse"}, {"start_s": 12.0, "end_s": 20.0, "label": "chorus"}]
        got = songmap.gb_sections(found, lines)
        self.assertEqual([(s["name"], s["gb_bar"], s["bars"]) for s in got],
                         [("intro", 1, 2), ("verse 1", 3, 2), ("verse 2", 5, 2), ("chorus", 7, 4)])
        self.assertEqual([s["offset_beats"] for s in got], [0.2, -0.2, 0.4, 0.0])

    def test_a_section_shorter_than_half_a_bar_disappears_into_the_next(self):
        lines = [2.0 * g for g in range(5)]
        found = [{"start_s": 0.0, "end_s": 3.95, "label": "intro"}, {"start_s": 3.95, "end_s": 4.3, "label": "solo"},
                 {"start_s": 4.3, "end_s": 8.0, "label": "verse"}]
        self.assertEqual([(s["name"], s["gb_bar"], s["bars"]) for s in songmap.gb_sections(found, lines)],
                         [("intro", 1, 2), ("verse", 3, 2)])
