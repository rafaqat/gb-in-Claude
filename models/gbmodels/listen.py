# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""What gb_analyze hears with models (M8), in one sidecar request: beats and the grid (beat_this, Metal), the key
(S-KEY, CPU — fastest in the benchmark) and a genre ranking (LAION CLAP, Metal). Genre numbers rank; they never grade."""
import numpy as np

from gbmodels import beatthis, clap, skey
from gbmodels.genres import GENRES
from gbmodels.scoring import grid_score, key_match


def load(device: str = "mps"):
    clap_h = clap.load(device)
    text = clap_h["model"].get_text_embedding([f"{g} music" for g in GENRES], use_tensor=False)
    return {"beats": beatthis.load(device), "key": skey.load("cpu"), "clap": clap_h,
            "genre_text": text / np.linalg.norm(text, axis=1, keepdims=True), "device": device}


def run(handle, inputs: dict) -> dict:
    """inputs: wav; optional bpm (the song's tempo: adds the grid check), key (adds the match), top (genres, default 3)."""
    beats, downbeats = handle["beats"]["model"](inputs["wav"])
    beats = [float(b) for b in beats]
    bpm = beatthis.tempo(beats)  # the mean of the regular intervals: a median is quantised by the 20 ms frames
    out = {"beats": {"count": len(beats), "downbeats": len(downbeats), "bpm": round(bpm, 2) if bpm else None}}
    if inputs.get("bpm"):
        out["beats"]["grid"] = grid_score(beats, float(inputs["bpm"]), swing=inputs.get("swing"), swing_unit=inputs.get("swing_unit", "16th"))
    k = skey.run(handle["key"], {"wav": inputs["wav"]})
    out["key"] = {"key": k["key"]}
    if inputs.get("key"):
        out["key"]["vs_song"] = key_match(k["key"], inputs["key"])
    audio, _ = clap.embed_audio(handle["clap"], inputs["wav"])
    sims = handle["genre_text"] @ audio
    order = np.argsort(sims)[::-1][: int(inputs.get("top", 3))]
    out["genre"] = {"ranking": [{"genre": GENRES[i], "similarity": round(float(sims[i]), 4)} for i in order],
                    "note": "a ranking among gb-mcp's 20 genres, not a grade"}
    return out
