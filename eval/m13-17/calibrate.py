# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""M13.17 calibration: how well does a GM draft stand in for the GarageBand export of the same template?

    models/.venv/bin/python eval/m13-17/calibrate.py --live m13 [--seed 1] base kit-909 …

For every frozen brief: render the template draft per variant (eval/m13-17/variants.ts, the macOS GM synth), take its
CLAP similarities to the 20 "<genre> music" prompts (its genre profile), and compare that profile with the profile of
the live export of the same brief (eval/results/<live>/renders.json, read only): Pearson r per brief, and the
Spearman correlation of draft rank vs live rank over the 20 briefs. A variant that changes no brief's drums or
patches gives the base numbers again.
Writes eval/results/m13-17/calibrate-<live>.json and .md.
"""
import argparse
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import screen  # noqa: E402  (same folder)


def spearman(a, b):
    import numpy as np
    ra, rb = np.argsort(np.argsort(a)), np.argsort(np.argsort(b))
    return float(np.corrcoef(ra, rb)[0, 1])


def main():
    import numpy as np
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", required=True, help="a live eval label: eval/results/<live>/renders.json lists the GarageBand exports")
    ap.add_argument("--renders", help="that renders.json, when it is in another checkout (read only)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("variants", nargs="+")
    a = ap.parse_args()
    briefs = screen.load_briefs()
    renders = json.load(open(a.renders or os.path.join(screen.ROOT, "eval", "results", a.live, "renders.json")))
    scorer = screen.Scorer(briefs)
    live = {}
    for b in briefs:
        wav = (renders.get(b["id"]) or {}).get("wav")
        if wav and os.path.exists(wav):
            emb, _ = screen.clap.embed_audio(scorer.clap, wav)  # read only: the export is only loaded
            live[b["id"]] = scorer.text @ emb
    result = {"live": a.live, "seed": a.seed, "variants": {}}
    rows = [f"# M13.17 calibration: GM drafts vs live exports ({a.live})", "",
            "Per variant: Pearson r of each brief's draft genre profile (CLAP, 20 prompts) with its live export's profile; "
            "Spearman of draft rank vs live rank over the briefs.", "",
            "| Variant | Median r | Spearman rank | " + " | ".join(b["id"].split("-", 1)[0] for b in briefs if b["id"] in live) + " |",
            "|---|---|---|" + "---|" * len(live)]
    for v in a.variants:
        per = {}
        for b in briefs:
            if b["id"] not in live:
                continue
            m = screen.render(b, [v], [a.seed])[0]
            if "error" in m:
                print(f"  {b['id']} {v}: {m['error']}", flush=True)
                continue
            s = scorer.score(m, b)
            i = scorer.genres.index(b["genre"])
            ls = live[b["id"]]
            per[b["id"]] = {"r": round(float(np.corrcoef(s["sims"], ls)[0, 1]), 3), "draft_rank": s["rank"],
                            "live_rank": int(1 + np.sum(ls > ls[i]))}
        ids = list(per)
        rho = spearman([per[k]["draft_rank"] for k in ids], [per[k]["live_rank"] for k in ids])
        result["variants"][v] = {"per_brief": per, "median_r": statistics.median(p["r"] for p in per.values()), "spearman_rank": round(rho, 3)}
        rows.append(f"| {v} | {result['variants'][v]['median_r']} | {round(rho, 3)} | " + " | ".join(str(per[k]["r"]) if k in per else "–" for k in live) + " |")
        print(rows[-1], flush=True)
    out = os.path.join(screen.ROOT, "eval", "results", "m13-17")
    os.makedirs(out, exist_ok=True)
    json.dump(result, open(os.path.join(out, f"calibrate-{a.live}.json"), "w"), indent=1)
    open(os.path.join(out, f"calibrate-{a.live}.md"), "w").write("\n".join(rows) + "\n")


if __name__ == "__main__":
    main()
