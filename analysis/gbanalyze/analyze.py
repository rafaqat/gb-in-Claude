# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Whole-file analysis: metrics → flags → suggestions tied to Song JSON paths."""
import numpy as np

from .loudness import integrated_lufs, levels
from .spectral import tonal_balance, stereo_width
from .rhythm import tempo, onset_density, pump, kick_thump
from .percussive import drum_balance
from .tonality import estimate_key, key_relation

# Heuristic thresholds for electronic music. They are reported with every result so agents can see the basis;
# compare runs (gb_analyze compare) rather than trusting any absolute number.
THRESHOLDS = {
    "thin_low_end_share": 0.20,  # sub+low (20–250 Hz) share of total energy below this = thin
    "bright_tilt_db_per_octave": -2.0,  # octave-band slope above this = bright/tinny (pink = 0, typical mixes ≈ -3…-6)
    "true_peak_max_dbtp": -1.0,
    "wide_low_end": 0.25,  # side/(mid+side) energy below 150 Hz
    "drop_minus_breakdown_min_lu": 3.0,
    "quiet_mix_lufs": -20.0,
    "key_confidence_min": 0.05,
    # drums — calibrated on one labelled example (a mix judged "drums too forward and thumpy":
    # intro kick hit share 0.23 / kick band 0.67, build kick band 0.69, intro percussive ratio +5.5 dB)
    "thumpy_kick_hit_share": 0.15,  # kick energy at the hit, above the low band's average, share of the mix
    "low_end_heavy_band_share": 0.60,  # 40–120 Hz (kick + bass) share of the mix in a section with drums
    "drums_forward_ratio_db": -6.0,  # percussive vs harmonic energy (Driedger margin HPSS)
}
_MIN_SECTION_SECONDS = 1.0


def _track_path(context: dict, roles) -> str:
    for t in context.get("tracks", []):
        if t.get("role") in roles:
            return f"tracks.{t['name']}"
    return "tracks"


def _section_windows(context: dict, seconds: float):
    tempo_bpm, beats = context.get("tempo"), context.get("beats_per_bar", 4)
    if not tempo_bpm or not context.get("sections"):
        return [], []
    bar_s = beats * 60.0 / tempo_bpm
    windows, missing, cursor = [], [], 0.0
    for s in context["sections"]:
        # M11: with a tempo map gb-mcp passes each section's real start and end (seconds)
        start, end = (s["start_s"], s["end_s"]) if "start_s" in s and "end_s" in s else (cursor, cursor + s["bars"] * bar_s)
        cursor = end
        if start >= seconds:
            missing.append(s["name"])
            continue
        windows.append((s["name"], start, min(end, seconds), end > seconds))
    return windows, missing


def _section_metrics(x, rate, name, start, end, truncated, bpm):
    seg = x[int(start * rate):int(end * rate)]
    tb = tonal_balance(seg, rate)
    low_share = None
    if tb["bands"]["sub"]["share"] is not None:
        low_share = tb["bands"]["sub"]["share"] + tb["bands"]["low"]["share"]
    long_enough = end - start >= 4 * 60.0 / (bpm or 120)
    p = pump(seg, rate, bpm) if long_enough else {"detected": None, "depth_db": None}
    # sections start on bar lines, so the beat grid is known: lock the kick window to the beat
    k = kick_thump(seg, rate, bpm, beat_phase=0.0) if long_enough else {"hit_share": None, "kick_band_share": None}
    return {
        "name": name, "start_s": start, "end_s": end, "truncated": truncated,
        "lufs": integrated_lufs(seg, rate) if end - start >= _MIN_SECTION_SECONDS else None,
        "onset_density": onset_density(seg, rate),
        "centroid_hz": tb["centroid_hz"], "tilt_db_per_octave": tb["tilt_db_per_octave"], "low_share": low_share,
        "pump": {"detected": p["detected"], "depth_db": p["depth_db"]},
        "percussive_ratio_db": drum_balance(seg, rate)["percussive_ratio_db"],
        "kick_hit_share": k["hit_share"],
        "kick_band_share": k["kick_band_share"],
    }


def _contrast(sections):
    measured = [s for s in sections if s["lufs"] is not None]
    if not measured:
        return {"loudest": None, "quietest": None, "range_lu": None, "drop_minus_breakdown_lu": None}
    loud = max(measured, key=lambda s: s["lufs"])
    quiet = min(measured, key=lambda s: s["lufs"])
    by_name = {s["name"]: s["lufs"] for s in measured}
    dmb = by_name["drop"] - by_name["breakdown"] if "drop" in by_name and "breakdown" in by_name else None
    return {"loudest": loud["name"], "quietest": quiet["name"], "range_lu": loud["lufs"] - quiet["lufs"], "drop_minus_breakdown_lu": dmb}


def _suggestion(code, severity, metric, value, threshold, path, message, section=None):
    out = {"code": code, "severity": severity, "metric": {"name": metric, "value": value, "threshold": threshold}, "path": path, "message": message}
    if section is not None:
        out["section"] = section
    return out


def _drum_sections(context: dict) -> set:
    """Sections where a drums-role track has a part (no part info → no drum judgements)."""
    names = set()
    for t in context.get("tracks", []):
        if t.get("role") == "drums":
            names.update(t.get("sections", []))
    return names


def _drum_rules(result: dict, context: dict):
    t = THRESHOLDS
    flags, out = [], []
    drum_sections = _drum_sections(context)
    path = _track_path(context, ("drums",))
    for s in result["sections"]:
        if s["name"] not in drum_sections:
            continue
        hit, band = s.get("kick_hit_share"), s.get("kick_band_share")
        if hit is not None and hit > t["thumpy_kick_hit_share"]:
            flags.append("thumpy_kick")
            out.append(_suggestion(
                "THUMPY_KICK", "warning", "kick_hit_share", hit, t["thumpy_kick_hit_share"], path,
                f"The kick hits dominate '{s['name']}'. Lower the drums (Song JSON track level), soften the kick "
                "(o steps instead of x) or use a tighter kit.", section=s["name"]))
        if band is not None and band > t["low_end_heavy_band_share"]:
            flags.append("low_end_heavy")
            out.append(_suggestion(
                "LOW_END_HEAVY", "info", "kick_band_share", band, t["low_end_heavy_band_share"],
                f"{path}|{_track_path(context, ('bass',))}",
                f"40–120 Hz (kick + bass) carries most of the energy in '{s['name']}'. If it sounds boomy, lower the kick "
                "or the bass level, or move the bass up an octave in this section.", section=s["name"]))
        ratio = s.get("percussive_ratio_db")
        if ratio is not None and ratio > t["drums_forward_ratio_db"]:
            flags.append("drums_forward")
            out.append(_suggestion(
                "DRUMS_FORWARD", "warning", "percussive_ratio_db", ratio, t["drums_forward_ratio_db"], path,
                f"Drums sit in front of the music in '{s['name']}'. Lower the drum level or velocities and give pads/lead more "
                "room (ignore if this section is a deliberate drum feature such as a roll).", section=s["name"]))
    return sorted(set(flags)), out


def _rules(result: dict, context: dict):
    t = THRESHOLDS
    flags, out = [], []
    lv = result["loudness"]["levels"]
    if lv["clip_runs"]:
        flags.append("clipping")
        out.append(_suggestion("CLIPPING", "error", "clip_runs", lv["clip_runs"], 0, "mix",
                               "The export clips. Lower track volumes or note velocities, then export again."))
    if lv["true_peak_dbtp"] is not None and lv["true_peak_dbtp"] > t["true_peak_max_dbtp"]:
        flags.append("true_peak_over")
        out.append(_suggestion("TRUE_PEAK_OVER", "warning", "true_peak_dbtp", lv["true_peak_dbtp"], t["true_peak_max_dbtp"], "mix",
                               "Peaks above -1 dBTP can distort after encoding. Pull the master or loudest tracks down 1–2 dB."))
    bands = result["tonal_balance"]["bands"]
    if bands["sub"]["share"] is not None:
        low = bands["sub"]["share"] + bands["low"]["share"]
        if low < t["thin_low_end_share"]:
            flags.append("thin_low_end")
            out.append(_suggestion("THIN_LOW_END", "warning", "sub_plus_low_share", low, t["thin_low_end_share"],
                                   _track_path(context, ("bass",)),
                                   "Little energy below 250 Hz (sounds thin/tinny). Make sure a bass part plays in this section "
                                   "(octave 1–2), use a fuller bass program (e.g. 39 Taureg Moon Bass) and a kick in the drums."))
    tilt = result["tonal_balance"]["tilt_db_per_octave"]
    if tilt is not None and tilt > t["bright_tilt_db_per_octave"]:
        flags.append("bright_tilt")
        out.append(_suggestion("BRIGHT_MIX", "warning", "tilt_db_per_octave", tilt, t["bright_tilt_db_per_octave"],
                               _track_path(context, ("lead", "arp", "lead-high")),
                               "Spectrum tilts bright (tinny). Lower lead/arp velocities or octave, or choose warmer patches."))
    width_low = result["stereo_width"]["bands"].get("low")
    if width_low is not None and width_low > t["wide_low_end"]:
        flags.append("wide_low_end")
        out.append(_suggestion("WIDE_LOW_END", "warning", "low_band_width", width_low, t["wide_low_end"],
                               _track_path(context, ("bass",)), "Low end is wide; keep bass and kick centred (mono)."))
    lufs = result["loudness"]["integrated_lufs"]
    if lufs is not None and lufs < t["quiet_mix_lufs"]:
        flags.append("quiet_mix")
        out.append(_suggestion("QUIET_MIX", "info", "integrated_lufs", lufs, t["quiet_mix_lufs"], "mix",
                               "Quiet overall. Fine for drafts; for release add a mastering preset on the master track."))
    dmb = result["section_contrast"]["drop_minus_breakdown_lu"]
    if dmb is not None and dmb < t["drop_minus_breakdown_min_lu"]:
        flags.append("weak_drop")
        out.append(_suggestion("WEAK_DROP", "warning", "drop_minus_breakdown_lu", dmb, t["drop_minus_breakdown_min_lu"], "sections.drop",
                               "The drop is barely louder than the breakdown. Add drums/bass/lead layers to the drop or strip the breakdown back."))
    tp = result["rhythm"]["tempo"]
    if tp["matches_intended"] is False:
        flags.append("tempo_mismatch")
        out.append(_suggestion("TEMPO_MISMATCH", "warning", "bpm", tp["bpm"], context.get("tempo"), "tempo",
                               "Audio tempo differs from the song tempo. Check the GarageBand project tempo matches Song JSON."))
    key = result["key"]
    if key["relation"] == "mismatch" and (key["confidence"] or 0) >= t["key_confidence_min"]:
        flags.append("key_mismatch")
        out.append(_suggestion("KEY_MISMATCH", "info", "estimated_key", key["estimated"], key["declared"], "key",
                               "Estimated key differs from the declared key. Check chords and melody notes."))
    drop = next((s for s in result["sections"] if s["name"] == "drop"), None)
    if drop and drop["pump"]["detected"] is False:
        flags.append("no_pump_in_drop")
        out.append(_suggestion("NO_PUMP_IN_DROP", "info", "pump_detected", False, True, _track_path(context, ("pad",)),
                               "No sidechain pump in the drop. For trance, duck the pad on each kick (GarageBand: Tremolo synced to 1/4)."))
    return flags, out


def analyze(x: np.ndarray, rate: float, context: dict | None = None) -> dict:
    context = context or {}
    seconds = len(x) / rate
    intended = context.get("tempo")
    key = estimate_key(x, rate)
    declared = context.get("key")
    windows, missing = _section_windows(context, seconds)
    sections = [_section_metrics(x, rate, *w, intended) for w in windows]
    result = {
        "file": {"seconds": seconds, "sample_rate": int(rate), "channels": int(x.shape[1])},
        "loudness": {"integrated_lufs": integrated_lufs(x, rate), "levels": levels(x, rate)},
        "tonal_balance": tonal_balance(x, rate),
        "stereo_width": stereo_width(x, rate),
        "rhythm": {"tempo": tempo(x, rate, intended), "onset_density": onset_density(x, rate), "pump": pump(x, rate, intended)},
        "drums": {"percussive_ratio_db": drum_balance(x, rate)["percussive_ratio_db"],
                  "kick_band_share": kick_thump(x, rate, intended)["kick_band_share"]},
        "key": {"estimated": key["key"], "confidence": key["confidence"], "declared": declared,
                "relation": key_relation(declared, key["key"]) if declared and key["key"] else None},
        "sections": sections,
        "missing_sections": missing,
        "section_contrast": _contrast(sections),
        "thresholds": THRESHOLDS,
    }
    flags, suggestions = _rules(result, context)
    drum_flags, drum_suggestions = _drum_rules(result, context)
    result["flags"], result["suggestions"] = flags + drum_flags, suggestions + drum_suggestions
    return result
