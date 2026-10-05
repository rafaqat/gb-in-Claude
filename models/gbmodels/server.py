# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""The long-lived model sidecar (M8): models load once and stay warm; requests are JSON lines on stdin, replies JSON
lines on stdout (the protocol stream). Libraries that print are redirected to stderr, so stdout carries only replies.

    request:  {"id": 1, "op": "ping" | "load" | "run" | "loaded" | "unload", "model": "<registry key>", "inputs": {...}}
    reply:    {"id": 1, "ok": true, "result": {...}, "load_s": 1.2?, "run_s": 0.4?}
              {"id": 1, "ok": false, "error": {"code": "UNKNOWN_MODEL" | "BAD_REQUEST" | "MODEL_FAILED", "message": "..."}}

One server runs per Python environment (Foundation-1 lives in .venv-sat, the M12 engines in their own venvs); a request for a model of another
environment is answered with WRONG_ENVIRONMENT, never loaded half-way.
"""
import contextlib
import importlib
import json
import os
import sys
import time

from gbmodels.common import sync
from gbmodels.registry import MODELS

DEVICE = {"torch": "mps", "onnx": "coreml", "mlx": "mlx"}
# ".venv" or ".venv-sat" from the venv folder; GBMODELS_ENV names it where folders clash (the engines' venvs are
# also called .venv: "ace-step", "mulacover")
ENV = os.environ.get("GBMODELS_ENV") or os.path.basename(os.path.dirname(os.path.dirname(sys.executable)))


class Server:
    def __init__(self):
        self.handles: dict[str, tuple] = {}

    def _load(self, key: str) -> float | None:
        if key in self.handles:
            return None
        meta = MODELS[key]
        module, device = importlib.import_module(meta["module"]), meta.get("device", DEVICE[meta["kind"]])
        t = time.perf_counter()
        handle = module.load(device, **meta.get("load_options", {}))
        sync(device)
        self.handles[key] = (module, handle, meta, device)
        return round(time.perf_counter() - t, 3)

    def handle(self, req: dict) -> dict:
        rid, op = req.get("id"), req.get("op")
        if op == "ping":
            return {"id": rid, "ok": True, "result": {"env": ENV, "loaded": sorted(self.handles)}}
        if op == "loaded":
            return {"id": rid, "ok": True, "result": sorted(self.handles)}
        key = req.get("model")
        if op not in ("load", "run", "unload") or not isinstance(key, str):
            return {"id": rid, "ok": False, "error": {"code": "BAD_REQUEST", "message": "op must be ping, loaded, load, run or unload; load/run/unload need model"}}
        if key not in MODELS:
            return {"id": rid, "ok": False, "error": {"code": "UNKNOWN_MODEL", "message": f"models: {', '.join(sorted(MODELS))}"}}
        if MODELS[key]["venv"] != ENV:
            return {"id": rid, "ok": False, "error": {"code": "WRONG_ENVIRONMENT", "message": f"{key} runs in {MODELS[key]['venv']}, this server is {ENV}"}}
        if op == "unload":
            self.handles.pop(key, None)
            return {"id": rid, "ok": True, "result": sorted(self.handles)}
        try:
            reply = {"id": rid, "ok": True}
            load_s = self._load(key)
            if load_s is not None:
                reply["load_s"] = load_s
            if op == "run":
                module, handle, meta, device = self.handles[key]
                t = time.perf_counter()
                reply["result"] = module.run(handle, {**req.get("inputs", {}), **meta.get("run_options", {})})
                sync(device)
                reply["run_s"] = round(time.perf_counter() - t, 3)
            return reply
        except Exception as e:  # a failing model never takes the server down
            return {"id": rid, "ok": False, "error": {"code": "MODEL_FAILED", "message": f"{type(e).__name__}: {e}"[:500]}}


def main() -> None:
    protocol = sys.stdout
    sys.stdout = sys.stderr  # anything a library prints goes to stderr
    server = Server()
    print(json.dumps({"ready": True, "env": ENV, "models": sorted(k for k, m in MODELS.items() if m["venv"] == ENV)}), file=protocol, flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            reply = server.handle(req) if isinstance(req, dict) else {"id": None, "ok": False, "error": {"code": "BAD_REQUEST", "message": "a request is a JSON object"}}
        except json.JSONDecodeError as e:
            reply = {"id": None, "ok": False, "error": {"code": "BAD_REQUEST", "message": f"not JSON: {e.msg}"}}
        with contextlib.suppress(BrokenPipeError):
            print(json.dumps(reply), file=protocol, flush=True)


if __name__ == "__main__":
    main()
