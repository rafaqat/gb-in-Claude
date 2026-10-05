# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Install the gb_generate engines at their reviewed versions (M12b); scripts/install-engines.sh runs this. Apple Silicon.

    install-engines.sh ace-step | mulacover | all [--dry-run] [--accept-noncommercial]

Per engine, in order: the code (cloned at the reviewed commit — a checkout at another commit or with local changes
stops the install), its own venv (checked by importing its libraries), its weights (the reviewed Hugging Face
revisions; an interrupted download resumes). What is already installed is checked, not redone. MuLaCover's weights
and outputs are non-commercial: it is installed only after its licence is accepted. The pins are the engine modules'
own (gbmodels/ace_step.py, gbmodels/mulacover.py). Folders: GB_MCP_ENGINE_HOME (default ~/Library/Caches/gb-mcp), or
GB_MCP_ACESTEP / GB_MCP_MULACOVER / GB_MCP_MULACOVER_CKPT for one folder each — the server reads the same variables.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import date

from . import ace_step, mulacover

MODELS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MLX = "mlx==0.32.3"  # ≥ 0.32.0: the fused-RoPE fix (eval/m12d/MLX-ROPE-BUG.md)
PACKAGES_GB = 3.0
MULACOVER_LICENCE = (
    "MuLaCover's weights AND everything they generate are licensed CC BY-NC 4.0 with extra terms (MODEL_LICENSE in its\n"
    "repository): non-commercial use only. gb-mcp's own code (MIT) and ACE-Step (MIT) are not affected.")


class InstallError(RuntimeError):
    pass


ENGINES = {
    "ace-step": {
        "title": "ACE-Step 1.5 (MIT)", "repo": "https://github.com/ace-step/ACE-Step-1.5", "commit": ace_step.PINNED_COMMIT,
        "dir_env": "GB_MCP_ACESTEP", "dir": "ace-step", "gb": 10.1, "licence": None, "gbmodels_env": "ace-step",
        "venv": [["uv", "sync", "--frozen"]], "imports": ["acestep", "mlx.core"],
        "weights": [("ACE-Step/Ace-Step1.5", ace_step.WEIGHTS_REVISION, "{code}/checkpoints")],
    },
    "mulacover": {
        "title": "MuLaCover (weights and outputs CC BY-NC 4.0)", "repo": "https://github.com/HeartMuLa/MuLaCover",
        "commit": mulacover.PINNED_COMMIT, "dir_env": "GB_MCP_MULACOVER", "dir": "mulacover", "ckpt_env": "GB_MCP_MULACOVER_CKPT",
        "ckpt": "mulacover-ckpt", "gb": 15.4, "licence": MULACOVER_LICENCE, "gbmodels_env": "mulacover",
        "venv": [["uv", "venv", "--python", "3.12", ".venv"],
                 ["uv", "pip", "install", "--python", ".venv/bin/python", "torch==2.10.0", "torchaudio==2.10.0", "-e", ".[audio]", MLX]],
        "imports": ["mulacover", "mlx.core", "torch", "mido"],
        "weights": [(repo, rev, "{ckpt}/" + name) for name, (repo, rev) in mulacover.WEIGHTS.items()],
    },
}


@dataclass
class Step:
    kind: str  # clone | venv | weights | check
    label: str
    commands: list = field(default_factory=list)  # [(argv, cwd)]


def paths(name: str, env=os.environ) -> dict:
    e = ENGINES[name]
    home = env.get("GB_MCP_ENGINE_HOME") or os.path.expanduser("~/Library/Caches/gb-mcp")
    code = env.get(e["dir_env"]) or os.path.join(home, e["dir"])
    ckpt = (env.get(e["ckpt_env"]) or os.path.join(home, e["ckpt"])) if "ckpt" in e else None
    return {"home": home, "code": code, "python": os.path.join(code, ".venv", "bin", "python"),
            "weights": [(repo, rev, folder.format(code=code, ckpt=ckpt)) for repo, rev, folder in e["weights"]]}


def code_state(path: str, commit: str) -> tuple[str, str]:
    if not os.path.isdir(os.path.join(path, ".git")):
        return ("missing", "")
    head = subprocess.run(["git", "-C", path, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    if head != commit:
        return ("wrong_commit", head)
    dirty = subprocess.run(["git", "-C", path, "status", "--porcelain"], capture_output=True, text=True).stdout.strip()
    return ("dirty", dirty[:200]) if dirty else ("ok", "")


def venv_state(python: str, imports: list[str]) -> str:
    if not os.path.exists(python):
        return "missing"
    r = subprocess.run([python, "-c", "import " + ", ".join(imports)], capture_output=True, text=True, cwd=MODELS_DIR)
    return "ok" if r.returncode == 0 else "broken"


def weights_state(folder: str) -> str:
    if not os.path.isdir(folder):
        return "missing"
    downloads = os.path.join(folder, ".cache", "huggingface", "download")
    if os.path.isdir(downloads) and any(f.endswith(".incomplete") for _, _, fs in os.walk(downloads) for f in fs):
        return "partial"
    found = any(f.endswith(".safetensors") for root, _, fs in os.walk(folder) if ".cache" not in root for f in fs)
    return "ok" if found else "missing"


def states(name: str, p: dict) -> dict:
    e = ENGINES[name]
    return {"code": code_state(p["code"], e["commit"]), "venv": venv_state(p["python"], e["imports"]),
            "weights": [weights_state(folder) for _, _, folder in p["weights"]]}


def plan(name: str, s: dict, p: dict | None = None) -> list[Step]:
    e, p = ENGINES[name], p or paths(name)
    steps = []
    code_status, detail = s["code"]
    if code_status == "wrong_commit":
        raise InstallError(f"{p['code']} is at {detail[:12] or 'an unreadable commit'}, not the reviewed commit {e['commit'][:12]}: "
                           "move that folder away, then run again")
    if code_status == "dirty":
        raise InstallError(f"{p['code']} has local changes; restore or move it, then run again")
    if code_status == "missing":
        c = e["commit"]
        steps.append(Step("clone", f"clone {e['repo']} at {c[:7]} into {p['code']}", [
            (["git", "init", "-q", p["code"]], None), (["git", "-C", p["code"], "remote", "add", "origin", e["repo"]], None),
            (["git", "-C", p["code"], "fetch", "-q", "--depth", "1", "origin", c], None), (["git", "-C", p["code"], "checkout", "-q", c], None)]))
    else:
        steps.append(Step("check", f"code at the reviewed commit {e['commit'][:7]}, unchanged"))
    if s["venv"] == "ok":
        steps.append(Step("check", f"venv imports {', '.join(e['imports'])}"))
    else:
        steps.append(Step("venv", f"{'repair' if s['venv'] == 'broken' else 'create'} its venv ({p['code']}/.venv)",
                          [(argv, p["code"]) for argv in e["venv"]]))
    for (repo, rev, folder), state in zip(p["weights"], s["weights"]):
        if state == "ok":
            steps.append(Step("check", f"weights {repo}@{rev[:7]} in {folder}"))
        else:
            fetch = f"from huggingface_hub import snapshot_download; snapshot_download({repo!r}, revision={rev!r}, local_dir={folder!r})"
            steps.append(Step("weights", f"{'resume' if state == 'partial' else 'download'} {repo}@{rev[:7]} into {folder}",
                              [([p["python"], "-c", fetch], None)]))
    return steps


def licence_ok(name: str, accepted: bool, ask) -> bool:
    text = ENGINES[name]["licence"]
    if text is None or accepted:
        return True
    if ask is None:
        raise InstallError(f"{text}\nRun with --accept-noncommercial to accept, or run in a terminal to be asked.")
    if ask(f"{text}\nType yes to accept and install MuLaCover: ").strip().lower() != "yes":
        raise InstallError("licence not accepted: MuLaCover is not installed")
    return True


def main(argv: list[str], env=os.environ, run=subprocess.run, ask=None) -> int:
    parser = argparse.ArgumentParser(prog="install-engines.sh", description="Install the gb_generate engines (Apple Silicon).")
    parser.add_argument("engines", nargs="+", choices=[*ENGINES, "all"])
    parser.add_argument("--dry-run", action="store_true", help="print the plan, change nothing")
    parser.add_argument("--accept-noncommercial", action="store_true", help="accept MuLaCover's CC BY-NC 4.0 licence")
    args = parser.parse_args(argv)
    names = list(ENGINES) if "all" in args.engines else list(dict.fromkeys(args.engines))
    if ask is None and sys.stdin.isatty():
        ask = input
    try:
        for name in names:
            e, p = ENGINES[name], paths(name, env)
            print(f"\n▸ {e['title']}")
            licence_ok(name, args.accept_noncommercial, ask)
            steps = plan(name, states(name, p), p)
            todo = [s for s in steps if s.kind != "check"]
            if any(s.kind == "weights" for s in todo) and not args.dry_run:
                free = shutil.disk_usage(p["home"] if os.path.isdir(p["home"]) else os.path.expanduser("~")).free / 1e9
                if free < e["gb"] + PACKAGES_GB + 5:
                    raise InstallError(f"{e['title']} needs about {e['gb'] + PACKAGES_GB:.0f} GB; {free:.0f} GB free")
            if todo and not args.dry_run and not shutil.which("uv"):
                raise InstallError("uv is required: brew install uv (or https://docs.astral.sh/uv/)")
            for step in steps:
                if step.kind == "check":
                    print(f"  ✓ {step.label}")
                    continue
                if args.dry_run:
                    print(f"  · (dry run) {step.kind}: {step.label}")
                    continue
                print(f"  … {step.label}", flush=True)
                os.makedirs(p["home"], exist_ok=True)
                for command, cwd in step.commands:
                    if run(command, cwd=cwd, check=False).returncode != 0:
                        raise InstallError(f"failed: {' '.join(command)[:200]}")
                print(f"  ✓ {step.label}")
            if e["licence"] and not args.dry_run and p["weights"]:
                note = os.path.join(os.path.dirname(p["weights"][0][2]), "LICENCE-ACCEPTED.txt")
                with open(note, "w") as f:
                    f.write(f"{e['title']}: licence accepted on {date.today().isoformat()}\n{e['licence']}\n")
            if not args.dry_run:
                ready = subprocess.run([p["python"], "-c", "import sys, json; sys.argv=['x']; from gbmodels import registry; "
                                        f"print(json.dumps(sorted(k for k, m in registry.MODELS.items() if m['venv'] == {e['gbmodels_env']!r})))"],
                                       capture_output=True, text=True, cwd=MODELS_DIR)
                if ready.returncode != 0:
                    raise InstallError(f"the engine's environment cannot load gb-mcp's model code: {ready.stderr.strip()[-200:]}")
                print(f"  ✓ ready for gb_generate (restart Claude Code to load it)")
    except InstallError as err:
        print(f"  ✗ {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
