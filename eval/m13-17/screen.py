# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""M13.17 screen: genre-template variants as GM-synth drafts, scored as eval/run.py scores a render.

    models/.venv/bin/python eval/m13-17/screen.py --brief 08-afrobeats --label r1 --seeds 1,2,3 base af-kick-four …

1. eval/m13-17/variants.ts renders each variant × seed with the frozen brief's genre, key and tempo (gb_song
   render_draft's code: the macOS GM synth, never GarageBand) into <workspace>/eval-m13-17/ (GB_MCP_WORKSPACE, default ~/Music/gb-mcp).
2. Each draft is scored like eval/run.py: LAION CLAP rank of the brief's genre among all 20 "<genre> music" prompts
   (1 = best), and the beat_this grid (recall, precision) at the brief's tempo and the song's swing.
Per variant: the median rank over seeds, its range, the margin to the best other genre, and the grid. Writes
eval/results/m13-17/<brief>-<label>.json and .md. A GM draft is a screen only; some kits and patches draft far from
GarageBand (calibrate.py, and the proxy-* variants that correct for it). Confirm winners live.
"""
import argparse
import json
import os
import statistics
import subprocess
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # gb-mcp/
sys.path.insert(0, os.path.join(ROOT, "eval"))  # _paths: the workspace (GB_MCP_WORKSPACE, default ~/Music/gb-mcp)
from _paths import workspace  # noqa: E402
OUT = os.environ.get("M13_17_OUT") or os.path.join(workspace(), "eval-m13-17")
sys.path.insert(0, os.path.join(ROOT, "models"))

from gbmodels import beatthis, clap  # noqa: E402
from gbmodels.scoring import grid_score  # noqa: E402


def load_briefs():
    d = os.path.join(ROOT, "eval", "briefs")
    return [json.load(open(os.path.join(d, f))) for f in sorted(os.listdir(d)) if f.endswith(".json")]


def render(brief, variants, seeds):
    os.makedirs(OUT, exist_ok=True)
    cmd = [os.path.join(ROOT, "node_modules", ".bin", "tsx"), os.path.join(ROOT, "eval", "m13-17", "variants.ts"),
           brief["genre"], brief["key"], str(brief["bpm"]), OUT, ",".join(map(str, seeds)), *variants]
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    if p.returncode != 0:
        raise SystemExit(p.stderr[-2000:])
    return json.loads(p.stdout.strip().splitlines()[-1])


class Scorer:
    """CLAP and beat_this, loaded once. Each draft's score is kept beside it in <wav>.score2.json, written once (a WAV's
    name is the hash of its song, so the score never goes stale)."""

    def __init__(self, briefs):
        import numpy as np
        self.np = np
        self.genres = [b["genre"] for b in briefs]
        self.beat, self.clap = beatthis.load("mps"), clap.load("mps")
        text = self.clap["model"].get_text_embedding([f"{g} music" for g in self.genres], use_tensor=False)
        self.text = text / np.linalg.norm(text, axis=1, keepdims=True)

    def score(self, item, brief):
        path = f"{item['wav']}.score2.json"
        if os.path.exists(path):
            return json.load(open(path))
        np = self.np
        beats, _ = self.beat["model"](item["wav"])
        audio, _ = clap.embed_audio(self.clap, item["wav"])
        sims = self.text @ audio
        i = self.genres.index(brief["genre"])
        g = grid_score(list(map(float, beats)), brief["bpm"], swing=item.get("swing"), swing_unit=item.get("swingUnit", "16th"))
        score = {"rank": int(1 + np.sum(sims > sims[i])), "sim": round(float(sims[i]), 4), "top": self.genres[int(np.argmax(sims))],
                 "recall": g.get("recall", 0.0), "precision": g["pass_rate"], "tempo_ratio": g.get("tempo_ratio"), "brief": brief["id"],
                 # margin: the brief's genre against the best other genre (> 0 means rank 1)
                 "margin": round(float(sims[i] - np.max(np.delete(sims, i))), 4), "sims": [round(float(x), 4) for x in sims]}
        with open(path, "x") as f:  # "x": never overwrite
            json.dump(score, f)
        return score


def summarize(rows):
    by = {}
    for r in rows:
        by.setdefault(r["variant"], []).append(r)
    out = []
    for v, rs in by.items():
        ranks = [r["rank"] for r in rs]
        out.append({"variant": v, "seeds": len(rs), "rank_median": statistics.median(ranks), "rank_min": min(ranks), "rank_max": max(ranks),
                    "ranks": ranks, "sim_median": round(statistics.median(r["sim"] for r in rs), 4),
                    "margin_median": round(statistics.median(r["margin"] for r in rs), 4),
                    "recall_median": round(statistics.median(r["recall"] for r in rs), 4), "recall_min": round(min(r["recall"] for r in rs), 4),
                    "precision_median": round(statistics.median(r["precision"] for r in rs), 4),
                    "top": Counter(r["top"] for r in rs).most_common(1)[0][0]})
    return out


def write_compact(path, doc):
    """JSON with one list item per line: small, and a diff shows which variant changed."""
    lines = []
    for k, v in doc.items():
        if isinstance(v, list) and v and isinstance(v[0], dict):
            lines.append(f"{json.dumps(k)}: [\n" + ",\n".join(json.dumps(x, separators=(",", ":")) for x in v) + "\n]")
        else:
            lines.append(f"{json.dumps(k)}: {json.dumps(v)}")
    open(path, "w").write("{" + ",\n".join(lines) + "}\n")


def markdown(brief, label, summ):
    rows = [f"# M13.17 screen — {brief['id']}, {brief['key']}, {brief['bpm']} BPM ({label})", "",
            "GM-synth drafts (not GarageBand). CLAP rank of the brief's genre among 20 prompts, lower is better.", "",
            "| Variant | Seeds | Rank median | Ranks | CLAP sim (median) | Margin to best other (median) | Grid recall median / min | Grid precision median | CLAP's top genre |",
            "|---|---|---|---|---|---|---|---|---|"]
    for s in summ:
        rows.append(f"| {s['variant']} | {s['seeds']} | {s['rank_median']} | {' '.join(map(str, s['ranks']))} | {s['sim_median']} | {s['margin_median']} | "
                    f"{s['recall_median']} / {s['recall_min']} | {s['precision_median']} | {s['top']} |")
    return "\n".join(rows) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--brief", required=True, help="a frozen brief id, e.g. 08-afrobeats")
    ap.add_argument("--label", required=True)
    ap.add_argument("--seeds", default="1,2,3", help="comma-separated, e.g. 1,2,3")
    ap.add_argument("--key", help="another key than the brief's (robustness: the template serves every key)")
    ap.add_argument("variants", nargs="+")
    a = ap.parse_args()
    briefs = load_briefs()
    brief = next(b for b in briefs if b["id"] == a.brief)
    if a.key:
        brief = {**brief, "key": a.key}
    seeds = [int(x) for x in a.seeds.split(",")]
    manifest = render(brief, a.variants, seeds)
    scorer = Scorer(briefs)
    for m in manifest:
        if "error" in m:
            print(f"  not rendered: {m['variant']} seed {m['seed']}: {m['error']}", flush=True)
    rows = [{**m, **scorer.score(m, brief)} for m in manifest if "error" not in m]
    summ = summarize(rows)
    res = os.path.join(ROOT, "eval", "results", "m13-17")
    os.makedirs(res, exist_ok=True)
    name = f"{a.brief}-{a.label}"
    write_compact(os.path.join(res, f"{name}.json"), {"brief": a.brief, "key": brief["key"], "label": a.label, "seeds": seeds, "summary": summ,
                  # per render: variant, seed and WAV only; its full score (all 20 similarities) is <wav>.score2.json in out/eval-m13-17/
                  "renders": [{"variant": r["variant"], "seed": r["seed"], "wav": os.path.basename(r["wav"])} for r in rows]})
    md = markdown(brief, a.label, summ)
    open(os.path.join(res, f"{name}.md"), "w").write(md)
    print(md)


if __name__ == "__main__":
    main()
