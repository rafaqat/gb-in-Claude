# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""M12b gate, part 1: both engines through gb_generate, their vocals placed next to the song's MIDI — over MCP only.

    models/.venv/bin/python eval/m12b/e2e.py <config.json>        (eval/m12b/example.json shows the fields)

The config names the song (MIDI, export, bpm), its melody / chord / drum tracks, the lyrics, tags and caption.
1 gb_generate start mulacover (the configured bars of the song's melody / chords / drums) → status until done
2 gb_generate start ace_step cover (the song export, with lyrics) → status until done
3 gb_stem separate each → the vocal stems; gb_stem prepare each to the song tempo (MuLaCover picks its own tempo)
4 gb_project open_midi → gb_tracks add_audio {count: 2} → gb_project save_copy → gb_band build (MuLaCover vocal on
  audio track 1 at its start bar, ACE-Step vocal on audio track 2 at bar 1) → gb_project open_band → gb_export song.
Part 2 is eval/m12b/measure.py. Stops at the first step that is not verified.
"""
import asyncio, json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # eval/: _paths
from _paths import ROOT, workspace  # noqa: E402
WORKSPACE = workspace()

async def main(config: str) -> int:
    with open(config) as f:
        cfg = json.load(f)
    mid, export, bpm, name = cfg["midi"], cfg["export"], float(cfg["bpm"]), cfg["name"]
    mc, ac = cfg["mulacover"], cfg["ace_step"]
    from mcp import ClientSession
    from mcp.client.stdio import StdioServerParameters, stdio_client
    params = StdioServerParameters(command=os.path.join(ROOT, "node_modules", ".bin", "tsx"), args=[os.path.join(ROOT, "src", "index.ts")],
                                   env={**os.environ, "GB_MCP_WORKSPACE": WORKSPACE})
    async with stdio_client(params) as (r, w), ClientSession(r, w) as session:
        await session.initialize()

        async def call(tool, args, keep=("status", "error", "message", "warnings")):
            res = json.loads((await session.call_tool(tool, args)).content[0].text)
            print(f"{tool} {args.get('command')}: {json.dumps({k: res[k] for k in keep if k in res})[:400]}", flush=True)
            return res

        async def generate(args):
            started = await call("gb_generate", {"command": "start", **args})
            if started["status"] != "verified":
                return None
            job, t = started["data"]["job"], time.time()
            print(f"   job {job}: eta {started['data']['eta_s']} s", flush=True)
            while True:
                await asyncio.sleep(started["data"]["poll_after_s"])
                st = json.loads((await session.call_tool("gb_generate", {"command": "status", "job": job})).content[0].text)
                if st["data"]["state"] != "running":
                    print(f"   {job}: {st['data']['state']} after {time.time() - t:.0f} s; {json.dumps(st['data'].get('result') or st['data'].get('error'))[:500]}", flush=True)
                    for w_ in st.get("warnings", []):
                        print("   warning:", w_[:300], flush=True)
                    return st["data"] if st["data"]["state"] == "done" else None

        mula = await generate({"engine": "mulacover", "task": "cover", "midi": mid, "melody": mc["melody"], "chords": mc["chords"],
                               "drums": mc.get("drums"), "start_bar": mc["start_bar"], "bars": mc["bars"], "lyrics": mc["lyrics"],
                               "tags": mc["tags"], "seed": mc.get("seed", 7), "filename": f"{name}-mulacover.wav"})
        if not mula:
            return 1
        ace = await generate({"engine": "ace_step", "task": "cover", "src": export, "caption": ac["caption"], "lyrics": ac["lyrics"],
                              "strength": ac.get("strength", 0.7), "bpm": int(bpm), "key": ac.get("key"), "seed": ac.get("seed", 2),
                              "filename": f"{name}-acestep.wav"})
        if not ace:
            return 1
        placed = []
        for label, res in (("mulacover", mula), ("acestep", ace)):
            rel = os.path.relpath(res["result"]["path"], WORKSPACE)
            sep = await call("gb_stem", {"command": "separate", "path": rel})
            if sep["status"] != "verified":
                return 1
            vocal = os.path.relpath(sep["data"]["stems"]["vocals"], WORKSPACE)
            measured = res["result"].get("bpm") or bpm
            prep = await call("gb_stem", {"command": "prepare", "path": vocal, "filename": f"{name}-{label}-vocals-{int(bpm)}.wav",
                                          "to_bpm": bpm, "from_bpm": measured if label == "mulacover" else bpm, "mode": "tonal"})
            if prep["status"] != "verified":
                return 1
            print(f"   {label} vocal prepared: {json.dumps({k: prep['data'].get(k) for k in ('path', 'seconds', 'measured_bpm')})}", flush=True)
            placed.append(os.path.relpath(prep["data"]["path"], WORKSPACE))
        if (await call("gb_project", {"command": "open_midi", "path": mid}))["status"] != "verified":
            return 1
        if (await call("gb_tracks", {"command": "add_audio", "count": 2}))["status"] != "verified":
            return 1
        donor = await call("gb_project", {"command": "save_copy", "filename": f"{name}-donor.band"})
        if donor["status"] != "verified":
            return 1
        audio = [t["number"] for t in donor["data"]["tracks"] if t["kind"] == "audio"]
        print("   audio tracks:", audio, flush=True)
        built = await call("gb_band", {"command": "build", "donor": f"donors/{name}-donor.band", "filename": f"{name}.band",
                                       "audio": [{"wav": placed[0], "bar": mc["start_bar"], "track": audio[0], "name": "MuLaCover vocal"},
                                                 {"wav": placed[1], "bar": 1, "track": audio[1], "name": "ACE-Step vocal"}]})
        if built["status"] != "verified":
            return 1
        opened = await call("gb_project", {"command": "open_band", "path": f"bands/{name}.band"})
        if opened["status"] != "verified":
            return 1
        print("   readback audio:", json.dumps(opened["data"].get("audio"))[:400], flush=True)
        exported = await call("gb_export", {"command": "song", "filename": f"{name}.wav"})
        if exported["status"] != "verified":
            return 1
        print("   export:", exported["data"]["path"], flush=True)
        print("   placed:", json.dumps(placed), flush=True)
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1])))
