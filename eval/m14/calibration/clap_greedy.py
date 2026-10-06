# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Greedy per-genre CLAP prompt choice (M14.1): mean reciprocal rank of each clip's own label among all genres. Only the
27 new genres' prompts move; the 20 M8 labels keep "<genre> music".

    models/.venv/bin/python eval/m14/calibration/clap_greedy.py [second prefix, default m14-cal2]
    BOTH=1 …   choose on both clip sets (the shipped prompts); the second set is then not a held-out check

The clips: <workspace>/gen/m14-cal-<slug>.wav (seed 1) and <prefix>-<slug>.wav (seed 2), made from cal_jobs.py's jobs.
Audio embeddings are cached in <workspace>/eval-m14-cal/, keyed on the clips (path, size, time) and the labels, so a
changed clip or label set is embedded again. The chosen prompts are written there too, never beside this script."""
import hashlib
import json
import os
import sys

S = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(S, "..", ".."))  # eval/: _paths
from _paths import ROOT, workspace  # noqa: E402

sys.path.insert(0, os.path.join(ROOT, "models"))


def clip(ws: str, prefix: str, slug: str) -> str:
    return os.path.join(ws, "gen", f"{prefix}-{slug}.wav")


def cache_path(ws: str, cache_dir: str, prefix: str, labels: dict) -> str:
    """A cache file per clip set: its key covers each clip's path, size and modification time, and the label set."""
    parts = []
    for slug in sorted(labels):
        p = clip(ws, prefix, slug)
        st = os.stat(p) if os.path.exists(p) else None
        parts.append([slug, labels[slug], os.path.abspath(p), st.st_size if st else None, st.st_mtime_ns if st else None])
    key = hashlib.sha256(json.dumps(parts).encode()).hexdigest()[:16]
    return os.path.join(cache_dir, f"{prefix}-{key}.npz")


def second_label(both: bool) -> str:
    return "seed 2 (also chosen on — not a held-out check)" if both else "seed 2 (held out)"


def summary_line(name: str, base: dict, new: dict) -> str:
    import numpy as np
    mrr = lambda r: float(np.mean([1 / v for v in r.values()]))
    top5 = lambda r: sum(v <= 5 for v in r.values())
    return (f"{name}: MRR {mrr(base):.3f} → {mrr(new):.3f} · top-5 {top5(base)} → {top5(new)}/{len(new)} · "
            f"median {np.median(list(base.values()))} → {np.median(list(new.values()))}")


def main():
    import numpy as np
    from gbmodels import clap
    from gbmodels.genres import GENRES, M14_GENRES

    ws = workspace(); cache_dir = os.path.join(ws, "eval-m14-cal"); os.makedirs(cache_dir, exist_ok=True)
    both_sets = bool(os.environ.get("BOTH"))
    labels = json.load(open(os.path.join(S, "cal-labels.json"))); cand = json.load(open(os.path.join(S, "prompts-cand.json")))
    h = clap.load("cpu")

    def audio(prefix):
        cache = cache_path(ws, cache_dir, prefix, labels)
        if not os.path.exists(cache):
            np.savez(cache, **{s: clap.embed_audio(h, clip(ws, prefix, s))[0] for s in labels})
        return dict(np.load(cache))
    A1, A2 = audio("m14-cal"), audio(sys.argv[1] if len(sys.argv) > 1 else "m14-cal2")
    emb = {}

    def E(p):
        if p not in emb:
            t = h["model"].get_text_embedding([p], use_tensor=False)[0]; emb[p] = t / np.linalg.norm(t)
        return emb[p]

    def ranks(choice, A):
        T = np.stack([E(choice[g]) for g in GENRES])
        return {lab: list(np.argsort(T @ A[s])[::-1]).index(GENRES.index(lab)) + 1 for s, lab in labels.items()}
    mrr = lambda r: float(np.mean([1 / v for v in r.values()]))
    score = lambda c: (mrr(ranks(c, A1)) + mrr(ranks(c, A2))) / 2 if both_sets else mrr(ranks(c, A1))
    choice = {g: f"{g} music" for g in GENRES}
    best = score(choice); improved = True
    while improved:
        improved = False
        for g in M14_GENRES:
            for p in [f"{g} music"] + cand.get(g, []):
                if p == choice[g]:
                    continue
                trial = {**choice, g: p}; m = score(trial)
                if m > best + 1e-9:
                    choice, best, improved = trial, m, True
    plain = {g: f"{g} music" for g in GENRES}
    print(summary_line("seed 1 (chosen on)", ranks(plain, A1), ranks(choice, A1)))
    b2, n2 = ranks(plain, A2), ranks(choice, A2)
    print(summary_line(second_label(both_sets), b2, n2))
    for lab in labels.values():
        print(f"  {lab:20s} {b2[lab]:3d} → {n2[lab]:3d}   {choice[lab]!r}")
    out = os.path.join(cache_dir, f"prompts-chosen{'-both' if both_sets else ''}.json")
    json.dump({g: choice[g] for g in M14_GENRES if choice[g] != f"{g} music"}, open(out, "w"), indent=1)
    print("chosen prompts →", out)


if __name__ == "__main__":
    main()
