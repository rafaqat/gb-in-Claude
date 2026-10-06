# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Greedy per-genre CLAP prompt choice on one clip set (mean reciprocal rank of the clip's own label), reported on the
held-out set. Only the 27 new genres' prompts move; the 20 M8 labels keep "<genre> music"."""
import json, os, sys
import numpy as np
from gbmodels import clap
from gbmodels.genres import GENRES, M14_GENRES

S = os.path.dirname(os.path.abspath(__file__))  # the clips: <workspace>/gen/m14-cal-<slug>.wav (seed 1), m14-cal2-<slug>.wav (seed 2)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(S)))  # gb-mcp/
WORKSPACE = os.environ.get("GB_MCP_WORKSPACE") or os.path.expanduser("~/Music/gb-mcp")
labels = json.load(open(f"{S}/cal-labels.json")); cand = json.load(open(f"{S}/prompts-cand.json"))
h = clap.load("cpu")
def audio(prefix):
    cache = f"{S}/{prefix}-audio.npz"
    if not os.path.exists(cache):
        np.savez(cache, **{s: clap.embed_audio(h, os.path.join(WORKSPACE, "gen", f"{prefix}-{s}.wav"))[0] for s in labels})
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
choice = {g: f"{g} music" for g in GENRES}
both = lambda c: (mrr(ranks(c, A1)) + mrr(ranks(c, A2))) / 2 if os.environ.get("BOTH") else mrr(ranks(c, A1))
best = both(choice); improved = True
while improved:
    improved = False
    for g in M14_GENRES:
        for p in [f"{g} music"] + cand.get(g, []):
            if p == choice[g]: continue
            trial = {**choice, g: p}; m = both(trial)
            if m > best + 1e-9: choice, best, improved = trial, m, True
def report(name, A):
    b, n = ranks({g: f"{g} music" for g in GENRES}, A), ranks(choice, A)
    print(f"{name}: MRR {mrr(b):.3f} → {mrr(n):.3f} · top-5 {sum(v <= 5 for v in b.values())} → {sum(v <= 5 for v in n.values())}/27 · median {np.median(list(b.values()))} → {np.median(list(n.values()))}")
    return b, n
report("seed 1 (chosen on)", A1); b2, n2 = report("seed 2 (held out)", A2)
for lab in labels.values():
    print(f"  {lab:20s} {b2[lab]:3d} → {n2[lab]:3d}   {choice[lab]!r}")
json.dump({g: choice[g] for g in M14_GENRES if choice[g] != f"{g} music"}, open(f"{S}/prompts-chosen{'-both' if os.environ.get('BOTH') else ''}.json", "w"), indent=1)
