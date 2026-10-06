# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Per gb-mcp genre and mode: songs, and the 4-chord loops (rotation classes, 4 different diatonic triads with the
tonic among them) in verses and choruses, plus chorus openings to choose each loop's start. '_all' pools every genre."""
import collections, json, sys
import pandas as pd
from stats import GENRES, SEC, chord, key_of, roman, changes, loop_class

DIATONIC = {"major": {"I", "ii", "iii", "IV", "V", "vi"}, "minor": {"i", "III", "iv", "v", "V", "VI", "VII"}}
TONIC = {"major": "I", "minor": "i"}

def main(csv, out):
    d = pd.read_csv(csv, usecols=["chords", "genres"], dtype=str)
    new = lambda: {"songs": 0, "verse": collections.Counter(), "chorus": collections.Counter(), "verse_open": collections.Counter(), "chorus_open": collections.Counter()}
    st = collections.defaultdict(lambda: {"major": new(), "minor": new()})
    for chords, tags in zip(d["chords"], d["genres"].fillna("")):
        hit = [g for g, keys in GENRES.items() if any(k in tags for k in keys)]
        if not hit or not isinstance(chords, str): continue
        parts, cur, allch = collections.defaultdict(list), "intro", []
        for tok in chords.split():
            m = SEC.match(tok)
            if m: cur = m[1]; continue
            c = chord(tok)
            if c: parts[cur].append(c); allch.append(c)
        if len(allch) < 4: continue
        t, mode = key_of(allch)
        for g in hit + ["_all"]:
            s = st[g][mode]; s["songs"] += 1
            for sec, seq in parts.items():
                bucket = "chorus" if sec in ("chorus", "drop", "hook") else "verse" if sec in ("verse", "intro", "prechorus", "pre-chorus") else None
                if not bucket: continue
                c = changes([roman(pc, k, t, mode) for pc, k in seq])
                ok = lambda w: len(set(w)) == 4 and set(w) <= DIATONIC[mode] and TONIC[mode] in w
                s[bucket].update({loop_class(c[i:i + 4]) for i in range(len(c) - 3) if ok(c[i:i + 4])})
                if len(c) >= 4 and ok(c[:4]): s[bucket + "_open"][" ".join(c[:4])] += 1
    res = {g: {m: {"songs": v["songs"], **{k: v[k].most_common(40) for k in ("verse", "chorus", "verse_open", "chorus_open")}} for m, v in modes.items()} for g, modes in st.items()}
    json.dump(res, open(out, "w"), indent=1)

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
