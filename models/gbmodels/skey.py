# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""S-KEY (Deezer) as ONNX: 24 major/minor key probabilities from 22.05 kHz mono, peak-normalised audio.
ONNX runs through onnxruntime: "coreml" (Apple Neural Engine/GPU via Core ML) or "cpu" — MPS does not apply."""
import json
import os

from huggingface_hub import snapshot_download

REPO = "musetric/skey-onnx"
SR = 22050


CACHE_DIR = os.path.join(os.path.expanduser("~"), "Library", "Caches", "gb-mcp", "coreml")


def load(device: str, compiled_cache: bool = False):
    """compiled_cache: keep Core ML's compiled model on disk (MLProgram, all compute units incl. the Neural Engine),
    so the compile (~14 s) happens once per machine instead of once per process."""
    import onnxruntime as ort
    root = snapshot_download(REPO)
    coreml = "CoreMLExecutionProvider"
    if compiled_cache:
        os.makedirs(CACHE_DIR, exist_ok=True)
        coreml = (coreml, {"ModelFormat": "MLProgram", "MLComputeUnits": "ALL", "ModelCacheDirectory": CACHE_DIR})
    providers = [coreml, "CPUExecutionProvider"] if device == "coreml" else ["CPUExecutionProvider"]
    session = ort.InferenceSession(os.path.join(root, "skey.onnx"), providers=providers)
    key_map = json.load(open(os.path.join(root, "config.json")))["keyMap"]
    return {"session": session, "keys": key_map, "device": device, "providers": session.get_providers()}


def run(handle, inputs: dict) -> dict:
    """inputs: wav (path)."""
    import librosa
    import numpy as np
    y, _ = librosa.load(inputs["wav"], sr=SR, mono=True)
    y = (y / max(float(np.abs(y).max()), 1e-9)).astype(np.float32)[None, :]
    probs = handle["session"].run(["probs"], {"audio": y})[0].reshape(-1)
    best = int(np.argmax(probs))
    return {"key": handle["keys"][best], "confidence": round(float(probs[best]), 4)}
