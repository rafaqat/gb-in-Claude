# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Shared scoring (M8): the beat-grid check and the key match, used by gb_analyze (via the sidecar) and eval/run.py."""

TOLERANCE_S = 0.07
PITCH = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8,
         "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}

GRID_MULTIPLES = (0.5, 1, 2)  # a tracker may count half- or double-time: recorded, not failed


def _recall(b, period, delay, span):
    """Share of the grid's own beats (span start..end) that have a detected beat within the tolerance. The phase is the
    one that matches the most detections (robust to extra beats a tracker puts on subdivisions)."""
    import numpy as np
    best = (0.0, 0.0)
    for ph in b % period:  # each detection proposes a phase; keep the one most detections agree with
        k = np.round((b - ph - delay / 2) / period)
        hit = np.abs(b - (ph + k * period + delay * (k % 2))) <= TOLERANCE_S
        if hit.sum() > best[0]:
            best = (hit.sum(), ph)
    ph = best[1]
    start, end = span
    k0, k1 = int(np.ceil((start - ph) / period - 1e-9)), int(np.floor((end - ph) / period + 1e-9))
    grid = np.array([ph + k * period + delay * (k % 2) for k in range(k0, k1 + 1)])
    if len(grid) == 0:
        return 0.0
    return float(np.mean([np.min(np.abs(b - g)) <= TOLERANCE_S for g in grid]))


def grid_score(beats, bpm, swing=None, swing_unit="16th", span=None):
    """Share of detected beats within ±70 ms of a grid at the brief's tempo, or at half/double it when the tracker
    counted that way (closest to the detected tempo). GarageBand trims leading silence, so the phase is fitted.
    swing (percent, 50 = straight): when the tracker counts at the swing's own step, every second grid point is
    expected late by the swing delay — both parities are tried, the better fit is kept."""
    import numpy as np
    if len(beats) < 4:
        return {"beats": len(beats), "pass_rate": 0.0, "tempo_ratio": None, "grid_multiple": None, "note": "fewer than 4 beats detected"}
    detected = 60.0 / float(np.median(np.diff(beats)))
    multiple = min(GRID_MULTIPLES, key=lambda m: abs(np.log(detected / (bpm * m))))
    period = 60.0 / (bpm * multiple)
    b = np.asarray(beats)
    phase = np.angle(np.mean(np.exp(2j * np.pi * b / period))) / (2 * np.pi) * period
    unit = 60.0 / bpm / (2 if swing_unit == "8th" else 4)
    delay = (swing - 50) / 50 * unit if swing and swing > 50 and abs(period - unit) < 1e-9 else 0.0
    if delay == 0.0:
        offsets = (b - phase + period / 2) % period - period / 2
        rate = float(np.mean(np.abs(offsets) <= TOLERANCE_S))
    else:
        rate = 0.0
        for parity in (0, 1):
            ph = phase
            for _ in range(4):  # fit the phase against on/off positions
                k = np.round((b - ph - delay / 2) / period)
                resid = b - (ph + k * period + delay * ((k + parity) % 2))
                ph += float(np.mean(resid))
            rate = max(rate, float(np.mean(np.abs(resid) <= TOLERANCE_S)))
    # recall is measured on the song's own beats (a double-time reading still contains them); a half-time reading is a
    # legitimate coarser count, so its grid is used
    beat_period = 60.0 / (bpm * min(multiple, 1))
    recall = _recall(b, beat_period, delay if abs(beat_period - unit) < 1e-9 else 0.0, span or (float(b.min()), float(b.max())))
    # precision: share of detections on the grid (the original pass_rate); recall: share of the grid's beats detected —
    # extra beats on subdivisions (a jazz ride's triplets) lower precision but are not wrong
    out = {"beats": len(beats), "pass_rate": round(rate, 4), "precision": round(rate, 4), "recall": round(recall, 4), "detected_bpm": round(detected, 2),
           "tempo_ratio": round(detected / bpm, 3), "grid_multiple": multiple}
    if delay:
        out["swing"] = swing
    return out


def key_match(found, wanted):
    """found: S-KEY's "G# Major"; wanted: the brief's "F minor"."""
    f_root, f_mode = found.split()[0], found.split()[1].lower()
    w_root, w_mode = wanted.split()[0], wanted.split()[1].lower()
    fp, wp = PITCH[f_root], PITCH[w_root]
    if fp == wp and f_mode == w_mode:
        return "exact"
    if f_mode != w_mode and ((w_mode == "minor" and fp == (wp + 3) % 12) or (w_mode == "major" and fp == (wp + 9) % 12)):
        return "relative"
    return "other"
