# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""M11b end to end, through the current gb-mcp server over MCP (live GarageBand):
MIDI song + an outside stem in ONE GarageBand project, with no hand-made donor.

    models/.venv/bin/python eval/m11b/e2e.py <song.mid> <stem.wav in the workspace> <bpm> <name>

1 gb_stem inspect/prepare (24-bit, song tempo) → 2 gb_project open_midi → 3 gb_tracks add_audio → 4 gb_project
save_copy → 5 gb_band build (slot grafted on the new audio track) → 6 gb_project open_band (GarageBand's re-save
verified) → 7 gb_export song. Prints each step's status; stops at the first that is not verified.
"""
import asyncio, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # eval/: _paths
from _paths import ROOT, workspace  # noqa: E402
WORKSPACE = workspace()


async def main(mid: str, stem: str, bpm: float, name: str) -> int:
    from mcp import ClientSession
    from mcp.client.stdio import StdioServerParameters, stdio_client
    params = StdioServerParameters(command=os.path.join(ROOT, "node_modules", ".bin", "tsx"), args=[os.path.join(ROOT, "src", "index.ts")],
                                   env={**os.environ, "GB_MCP_WORKSPACE": WORKSPACE})
    async with stdio_client(params) as (r, w), ClientSession(r, w) as session:
        await session.initialize()

        async def call(tool, args, keep=("status", "error", "message", "warnings")):
            res = json.loads((await session.call_tool(tool, args)).content[0].text)
            brief = {k: res[k] for k in keep if k in res}
            print(f"{tool} {args.get('command')}: {json.dumps(brief)[:300]}", flush=True)
            return res

        steps = []
        ins = await call("gb_stem", {"command": "inspect", "path": stem, "near_bpm": bpm})
        print("   source:", {k: ins.get("data", {}).get(k) for k in ("subtype", "rate", "seconds", "bpm", "placeable")})
        if os.path.lexists(os.path.join(WORKSPACE, "stems", f"{name}-stem.wav")):
            print(f"   reusing stems/{name}-stem.wav (prepared by an earlier run)")
        else:
            prep = await call("gb_stem", {"command": "prepare", "path": stem, "filename": f"{name}-stem.wav", "to_bpm": bpm, "from_bpm": bpm})
            if prep["status"] != "verified": return 1
            print("   prepared:", {k: prep["data"].get(k) for k in ("path", "bits", "rate", "seconds", "measured_bpm")})
        if (await call("gb_project", {"command": "open_midi", "path": mid}))["status"] != "verified": return 1
        added = await call("gb_tracks", {"command": "add_audio", "count": 1})
        if added["status"] != "verified": return 1
        print("   added:", added["data"]["added"])
        donor = await call("gb_project", {"command": "save_copy", "filename": f"{name}-donor.band"})
        if donor["status"] != "verified": return 1
        audio = [t for t in donor["data"]["tracks"] if t["kind"] == "audio"]
        print("   donor tracks:", donor["data"]["tracks"])
        built = await call("gb_band", {"command": "build", "donor": f"donors/{name}-donor.band", "filename": f"{name}-stems.band",
                                       "audio": [{"wav": f"stems/{name}-stem.wav", "bar": 1, "track": audio[0]["number"], "name": "Tabla"}]})
        if built["status"] != "verified": return 1
        opened = await call("gb_project", {"command": "open_band", "path": f"bands/{name}-stems.band"})
        if opened["status"] != "verified": return 1
        print("   readback:", {k: opened["data"].get(k) for k in ("tempo", "bars", "audio", "midi")})
        exported = await call("gb_export", {"command": "song", "filename": f"{name}-stems.wav"})
        if exported["status"] != "verified": return 1
        print("   export:", exported["data"]["path"])
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4])))
