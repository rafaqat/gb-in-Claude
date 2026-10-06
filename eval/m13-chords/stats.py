# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Chordonomicon (CC BY-NC 4.0, ailsntua/Chordonomicon @ f3a8b67) → common 4-chord loops per gb-mcp genre, in Roman
numerals (triads). Local research only: the data and the counts stay out of the repo."""
import re, sys, json, collections
import pandas as pd

PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
TOK = re.compile(r"^([A-G])(s|b)?([^/]*)")
def chord(tok):
    m = TOK.match(tok)
    if not m: return None
    pc = (PC[m[1]] + (1 if m[2] == "s" else -1 if m[2] == "b" else 0)) % 12
    q = m[3]
    kind = "dim" if q.startswith(("dim", "hdim")) else "min" if q.startswith("min") else "maj"
    return pc, kind

MAJ = {0: ("I", "maj"), 2: ("ii", "min"), 4: ("iii", "min"), 5: ("IV", "maj"), 7: ("V", "maj"), 9: ("vi", "min"), 11: ("vii°", "dim")}
MIN = {0: ("i", "min"), 2: ("ii°", "dim"), 3: ("III", "maj"), 5: ("iv", "min"), 7: ("v", "min"), 8: ("VI", "maj"), 10: ("VII", "maj")}
ROMAN = ["I", "bII", "II", "bIII", "III", "IV", "#IV", "V", "bVI", "VI", "bVII", "VII"]
MIN_ROMAN = ["I", "bII", "II", "III", "#III", "IV", "#IV", "V", "VI", "#VI", "VII", "#VII"]  # minor-key letters (III = b3)

def key_of(chs):
    """Best of 24 keys: diatonic chords score 1, the tonic chord 1 more, a first or last tonic 0.5 more."""
    best, bk = -1, None
    for t in range(12):
        for mode, tab in (("major", MAJ), ("minor", MIN)):
            s = 0.0
            for i, (pc, k) in enumerate(chs):
                d = tab.get((pc - t) % 12)
                if d and d[1] == k:
                    s += 1 + (1 if d[0] in ("I", "i") else 0)
            for pc, k in (chs[0], chs[-1]):
                d = tab.get((pc - t) % 12)
                if d and d[0] in ("I", "i") and d[1] == k: s += 0.5
            if s > best + 1e-9: best, bk = s, (t, mode)
    return bk

def roman(pc, k, t, mode):
    iv = (pc - t) % 12
    tab = MAJ if mode == "major" else MIN
    d = tab.get(iv)
    if d and d[1] == k: return d[0]
    name = (ROMAN if mode == "major" else MIN_ROMAN)[iv]
    return name.lower() + ("°" if k == "dim" else "") if k != "maj" else name

def changes(seq):
    return [c for i, c in enumerate(seq) if i == 0 or c != seq[i - 1]]

def loop_class(w):
    """A 4-chord loop up to rotation (I V vi IV = V vi IV I), shown from its smallest rotation."""
    return min(" ".join(w[i:] + w[:i]) for i in range(len(w)))

def loops(seq, n=4):
    """Rotation classes of the 4-chord windows of the chord changes, with 3 or more different chords."""
    s = changes(seq)
    return [loop_class(s[i:i + n]) for i in range(len(s) - n + 1) if len(set(s[i:i + n])) == n]

def opening(seq, n=4):
    s = changes(seq)
    return " ".join(s[:n]) if len(s) >= n else None

GENRES = {  # gb-mcp genre → Spotify genre tags (substring match on the 'genres' column)
    "lo-fi hip-hop": ["lo-fi", "lofi", "chillhop"], "R&B": ["r&b", "neo soul"], "ambient": ["ambient"],
    "jazz ballad": ["vocal jazz", "jazz"], "reggaeton": ["reggaeton"], "synthwave": ["synthwave", "retrowave"],
    "pop": ["'pop'", "dance pop"], "afrobeats": ["afrobeats", "afropop", "nigerian pop"], "funk": ["funk"],
    "indie rock": ["indie rock"], "deep house": ["deep house"], "techno": ["techno"], "UK garage": ["uk garage", "2-step"],
    "trap": ["trap"], "drum and bass": ["drum and bass", "liquid funk"], "EDM (big room)": ["big room", "edm", "progressive house"],
    "classical/pop crossover": ["classical crossover"], "ambient trance": ["trance"], "Levantine strings": ["arab", "lebanese"],
    "epic orchestral": ["soundtrack", "epicore", "orchestral"],
}
SEC = re.compile(r"<([a-z]+)_\d+>")

def main(csv, out):
    d = pd.read_csv(csv, usecols=["chords", "genres", "main_genre"], dtype=str)
    stats = {g: {"songs": 0, "major": 0, "verse": collections.Counter(), "chorus": collections.Counter(), "verse_open": collections.Counter(), "chorus_open": collections.Counter()} for g in GENRES}
    for chords, tags in zip(d["chords"], d["genres"].fillna("")):
        hit = [g for g, keys in GENRES.items() if any(k in tags for k in keys)]
        if not hit or not isinstance(chords, str): continue
        parts, cur = collections.defaultdict(list), "intro"
        allch = []
        for tok in chords.split():
            m = SEC.match(tok)
            if m: cur = m[1]; continue
            c = chord(tok)
            if c: parts[cur].append(c); allch.append(c)
        if len(allch) < 4: continue
        t, mode = key_of(allch)
        for g in hit:
            st = stats[g]; st["songs"] += 1; st["major"] += mode == "major"
            for sec, seq in parts.items():
                r = [roman(pc, k, t, mode) for pc, k in seq]
                bucket = "chorus" if sec in ("chorus", "drop", "hook") else "verse" if sec in ("verse", "intro", "prechorus", "pre-chorus") else None
                if bucket:
                    st[bucket].update(set(loops(r)))  # count songs, not repeats
                    o = opening(r)  # parts joins all verses (all choruses): this is the first one's opening
                    if o:
                        st[bucket + "_open"][o] += 1
    res = {g: {"songs": s["songs"], "major_share": round(s["major"] / max(1, s["songs"]), 2),
               "verse": s["verse"].most_common(15), "chorus": s["chorus"].most_common(15),
               "verse_open": s["verse_open"].most_common(15), "chorus_open": s["chorus_open"].most_common(15)} for g, s in stats.items()}
    json.dump(res, open(out, "w"), indent=1)

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
