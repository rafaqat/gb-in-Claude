# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Evaluation run (M8): render every frozen brief through gb-mcp and score each render.

    models/.venv/bin/python eval/run.py --label baseline [--only 01-lofi-hiphop ...] [--score-only]

For each brief: gb_song render_midi → gb_project open_midi → gb_export song (live GarageBand, through gb-mcp's own
MCP server, so all of gb-mcp's safety rules apply), then score the exported WAV:
  - grid: beat_this beats against a grid at the brief's BPM (phase fitted, since GarageBand trims leading silence);
    pass rate = beats within ±70 ms of the grid; tempo ratio records half/double-time readings
  - key: S-KEY's key vs the brief's key → "exact" | "relative" | "other"
  - genre: LAION CLAP similarity to "<genre> music" (raw, for ranking and before/after only — never a threshold) and the
    rank of the brief's genre among all 20 genre prompts (1 = best)
Writes eval/results/<label>/scores.json and scores.md. The briefs are frozen; compare labels, never edit a brief.
"""
import argparse
import asyncio
import json
import os
import statistics
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # gb-mcp/
WORKSPACE = os.environ.get("GB_MCP_WORKSPACE") or os.path.expanduser("~/Music/gb-mcp")
sys.path.insert(0, os.path.join(ROOT, "models"))

from gbmodels import beatthis, clap, skey  # noqa: E402
from gbmodels.scoring import grid_score, key_match  # noqa: E402,F401


def load_briefs():
    d = os.path.join(ROOT, "eval", "briefs")
    return [json.load(open(os.path.join(d, f))) for f in sorted(os.listdir(d)) if f.endswith(".json")]


# ---------- rendering through gb-mcp ----------

async def render_all(briefs, label, attempt=1, compose="brief"):
    from mcp import ClientSession
    from mcp.client.stdio import StdioServerParameters, stdio_client

    params = StdioServerParameters(command=os.path.join(ROOT, "node_modules", ".bin", "tsx"), args=[os.path.join(ROOT, "src", "index.ts")],
                                   env={**os.environ, "GB_MCP_WORKSPACE": WORKSPACE})
    renders = {}
    async with stdio_client(params) as (r, w), ClientSession(r, w) as session:
        await session.initialize()

        async def call(tool, args):
            res = await session.call_tool(tool, args)
            return json.loads(res.content[0].text)

        for b in briefs:
            name = f"eval-{label}-{b['id']}" + (f"-r{attempt}" if attempt > 1 else "")  # files are never overwritten
            steps = {}
            song = b["song"]
            if compose == "template":  # M9: the brief answered by the genre template (genre, key, tempo, meter)
                steps["template"] = await call("gb_song", {"command": "template", "genre": b["genre"], "key": b["key"], "bpm": b["bpm"],
                                                           "meter": int(b["meter"].split("/")[0]), "title": name})
                if steps["template"]["status"] != "verified":
                    renders[b["id"]] = {"wav": None, "envelopes": {"template": steps["template"]}, "steps": {"template": {"status": steps["template"]["status"]}}}
                    print(f"  {b['id']}: template FAILED", flush=True)
                    continue
                song = steps["template"]["data"]["song"]
            swing = {"swing": song["swing"], "swing_unit": song.get("swingUnit", "16th")} if song.get("swing") else {}
            steps["render_midi"] = await call("gb_song", {"command": "render_midi", "song": song, "filename": f"{name}.mid"})
            if steps["render_midi"]["status"] == "verified":
                steps["open_midi"] = await call("gb_project", {"command": "open_midi", "path": f"{name}.mid"})
            if steps.get("open_midi", {}).get("status") == "verified":
                steps["export"] = await call("gb_export", {"command": "song", "filename": f"{name}.wav"})
            exported = steps.get("export", {})
            ok = exported.get("status") == "verified"
            renders[b["id"]] = {"wav": exported["data"]["path"] if ok else None, **swing,
                                "envelopes": {k: v for k, v in steps.items() if v.get("status") != "verified"},  # the full answer of any step that did not verify
                                "steps": {k: {"status": v["status"], **({"error": v.get("error"), "message": v.get("message")} if v["status"] != "verified" else {})}
                                          for k, v in steps.items()}}
            print(f"  {b['id']}: {'exported' if ok else 'FAILED ' + json.dumps(renders[b['id']]['steps'])[:300]}", flush=True)
    return renders


# ---------- scoring ----------

def score_all(briefs, renders):
    import numpy as np
    beat_h, key_h, clap_h = beatthis.load("mps"), skey.load("cpu"), clap.load("mps")
    genres = [b["genre"] for b in briefs]
    prompts = [f"{g} music" for g in genres]
    text = clap_h["model"].get_text_embedding(prompts, use_tensor=False)
    text = text / np.linalg.norm(text, axis=1, keepdims=True)
    scores = {}
    for i, b in enumerate(briefs):
        wav = renders.get(b["id"], {}).get("wav")
        if not wav or not os.path.exists(wav):
            scores[b["id"]] = {"genre": b["genre"], "scored": False}
            continue
        beats, _ = beat_h["model"](wav)
        key = skey.run(key_h, {"wav": wav})
        audio, _ = clap.embed_audio(clap_h, wav)
        sims = text @ audio
        rank = int(1 + np.sum(sims > sims[i]))
        scores[b["id"]] = {"genre": b["genre"], "bpm": b["bpm"], "key": b["key"], "scored": True,
                           "grid": grid_score(list(map(float, beats)), b["bpm"], swing=renders[b["id"]].get("swing"), swing_unit=renders[b["id"]].get("swing_unit", "16th")),
                           "key_found": key["key"], "key_match": key_match(key["key"], b["key"]),
                           "clap_similarity": round(float(sims[i]), 4), "clap_genre_rank": rank,
                           "clap_top_genre": genres[int(np.argmax(sims))]}
        print(f"  scored {b['id']}: grid {scores[b['id']]['grid']['pass_rate']} · key {key['key']} ({scores[b['id']]['key_match']}) · genre rank {rank}/20", flush=True)
    return scores


def summary(scores):
    s = [v for v in scores.values() if v.get("scored")]
    if not s:
        return {"scored": 0}
    return {"scored": len(s), "of": len(scores),
            "grid_pass_rate_median": round(statistics.median(v["grid"]["pass_rate"] for v in s), 4),
            "grid_recall_median": round(statistics.median(v["grid"].get("recall", 0.0) for v in s), 4),
            "grid_recall_min": round(min(v["grid"].get("recall", 0.0) for v in s), 4),
            "key_exact": sum(v["key_match"] == "exact" for v in s), "key_relative": sum(v["key_match"] == "relative" for v in s),
            "clap_genre_rank_median": statistics.median(v["clap_genre_rank"] for v in s),
            "clap_genre_top1": sum(v["clap_genre_rank"] == 1 for v in s)}


def markdown(label, scores, summ):
    rows = [f"# Evaluation — {label}", "", "CLAP numbers rank candidates and compare before/after; they are not grades.", "",
            f"Scored {summ.get('scored', 0)}/{summ.get('of', len(scores))} · grid recall (median / min) {summ.get('grid_recall_median')} / {summ.get('grid_recall_min')} · grid precision (median) {summ.get('grid_pass_rate_median')} · "
            f"key exact {summ.get('key_exact')} + relative {summ.get('key_relative')} · CLAP genre rank median {summ.get('clap_genre_rank_median')} "
            f"(top-1: {summ.get('clap_genre_top1')})", "",
            "| Brief | Genre | BPM | Grid recall | Grid precision | Detected BPM (ratio) | Key wanted → found | Key | CLAP sim | Genre rank /20 | CLAP's top genre |",
            "|---|---|---|---|---|---|---|---|---|---|---|"]
    for bid, v in scores.items():
        if not v.get("scored"):
            rows.append(f"| {bid} | {v['genre']} | – | not rendered | – | – | – | – | – | – | – |")
            continue
        g = v["grid"]
        rows.append(f"| {bid} | {v['genre']} | {v['bpm']} | {g.get('recall')} | {g['pass_rate']} | {g.get('detected_bpm')} ({g.get('tempo_ratio')}) | "
                    f"{v['key']} → {v['key_found']} | {v['key_match']} | {v['clap_similarity']} | {v['clap_genre_rank']} | {v['clap_top_genre']} |")
    return "\n".join(rows) + "\n"


def comparison(base_label, base, label, new):
    """Per brief: grid, key and genre rank before → after (rank: lower is better)."""
    rows = [f"# {label} vs {base_label}", "", f"{base_label}: {json.dumps(base['summary'])}", f"{label}: {json.dumps(new['summary'])}", "",
            "| Brief | Grid recall | Grid precision | Key | Genre rank /20 | Rank change |", "|---|---|---|---|---|---|"]
    for bid, v in new["scores"].items():
        o = base["scores"].get(bid, {})
        if not (v.get("scored") and o.get("scored")):
            rows.append(f"| {bid} | – | – | – | – | not comparable |")
            continue
        d = o["clap_genre_rank"] - v["clap_genre_rank"]
        rows.append(f"| {bid} | {o['grid'].get('recall')} → {v['grid'].get('recall')} | {o['grid']['pass_rate']} → {v['grid']['pass_rate']} | {o['key_match']} → {v['key_match']} | "
                    f"{o['clap_genre_rank']} → {v['clap_genre_rank']} | {'+' if d > 0 else ''}{d if d else '='} |")
    return "\n".join(rows) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--score-only", action="store_true", help="score the WAVs of an earlier render with this label")
    ap.add_argument("--attempt", type=int, default=1, help="retry renders under new file names (-r2, -r3 …)")
    ap.add_argument("--compose", choices=["brief", "template"], default="brief", help="template: answer each brief with gb_song template (M9)")
    ap.add_argument("--compare", help="another label: print how each score moved")
    a = ap.parse_args()
    briefs = load_briefs()
    out = os.path.join(ROOT, "eval", "results", a.label)
    os.makedirs(out, exist_ok=True)
    todo = [b for b in briefs if not a.only or b["id"] in a.only]
    renders_path = os.path.join(out, "renders.json")
    renders = json.load(open(renders_path)) if os.path.exists(renders_path) else {}
    if not a.score_only:
        renders.update(asyncio.run(render_all(todo, a.label, a.attempt, a.compose)))
        json.dump(renders, open(renders_path, "w"), indent=2)
    scores = score_all(briefs, renders)  # every brief, so genre ranks always compare against all 20 prompts
    summ = summary(scores)
    json.dump({"label": a.label, "summary": summ, "scores": scores}, open(os.path.join(out, "scores.json"), "w"), indent=2)
    open(os.path.join(out, "scores.md"), "w").write(markdown(a.label, scores, summ))
    print(markdown(a.label, scores, summ))
    if a.compare:
        other = json.load(open(os.path.join(ROOT, "eval", "results", a.compare, "scores.json")))
        text = comparison(a.compare, other, a.label, {"summary": summ, "scores": scores})
        open(os.path.join(out, f"vs-{a.compare}.md"), "w").write(text)
        print(text)


if __name__ == "__main__":
    main()
