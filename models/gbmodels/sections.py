# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Song sections (M13.13): all-in-one (Kim & Nam 2023; github.com/mir-aidj/all-in-one, MIT; weights MIT) finds the
sections of a recording — intro, verse, chorus, bridge, solo, inst, break, outro — with their times. It runs in its own
venv (a sidecar with GBMODELS_ENV=sections; scripts/install-engines.sh sections) on Apple GPUs: its neighborhood
attention comes from gbmodels/natten_mps.py (plain PyTorch, tested against NATTEN 0.17.5), not from NATTEN's compiled
kernels, which need CUDA. It reads 16-bit copies of gb-mcp's own htdemucs stems (the separation it would run itself),
and its weights from the engine folder at a pinned revision — nothing is fetched at run time.

    run(handle, {"wav", "stems": {vocals, drums, bass, other}}) → {"sections": [{start_s, end_s, label}], "model"}
"""
import os
import sys

ALLIN1 = "1.1.0"
MADMOM_COMMIT = "27f032e8947204902c675e5e341a3faf5dc86dae"  # madmom from git (the PyPI release predates Python 3.12)
WEIGHTS_REPO = "taejunkim/allinone"
WEIGHTS_REVISION = "379e5fd010b3fdd0ee8381ff8cbcfa51d70b5c19"  # MIT (the repository's licence tag)
MODEL = "harmonix-all"  # the 8 folds trained on the Harmonix Set, averaged
STEMS = ("bass", "drums", "other", "vocals")


def install_natten() -> None:
    """Make `natten.functional` gb-mcp's plain-PyTorch neighborhood attention, before all-in-one is imported."""
    import types
    from gbmodels import natten_mps
    natten = types.ModuleType("natten")
    natten.functional = natten_mps
    sys.modules["natten"], sys.modules["natten.functional"] = natten, natten_mps


def stage_stems(work: str, name: str, stems: dict) -> None:
    """all-in-one skips its own separation when <demix_dir>/htdemucs/<name>/{bass,drums,other,vocals}.wav exist. They
    are 16-bit copies: madmom reads WAV through a memory map, which cannot read gb-mcp's 24-bit stems (its fallback,
    ffmpeg, then refuses the path object all-in-one passes — found live: )."""
    import soundfile as sf
    d = os.path.join(work, "htdemucs", name)
    os.makedirs(d)
    for s in STEMS:
        x, rate = sf.read(stems[s], always_2d=True, dtype="float32")
        sf.write(os.path.join(d, f"{s}.wav"), x, rate, subtype="PCM_16")


def segments(result) -> list[dict]:
    return [{"start_s": round(float(s.start), 3), "end_s": round(float(s.end), 3), "label": s.label}
            for s in result.segments if s.label not in ("start", "end")]


def _engine_dir() -> str:
    home = os.environ.get("GB_MCP_ENGINE_HOME") or os.path.expanduser("~/Library/Caches/gb-mcp")
    return os.environ.get("GB_MCP_SECTIONS") or os.path.join(home, "sections")


def load(device: str, **_) -> dict:
    weights = os.path.join(_engine_dir(), "models")
    if not os.path.isdir(weights):
        raise FileNotFoundError(f"{weights} is missing: run scripts/install-engines.sh sections")
    install_natten()
    import allin1.models.loaders as loaders

    def local(repo_id: str, filename: str, cache_dir=None, **_):  # the installed files, never the network
        path = os.path.join(weights, filename)
        if repo_id != WEIGHTS_REPO or not os.path.isfile(path):
            raise FileNotFoundError(f"{filename} is not in {weights}: run scripts/install-engines.sh sections")
        return path
    loaders.hf_hub_download = local
    return {"device": device}


def run(handle: dict, inputs: dict) -> dict:
    import shutil
    import tempfile
    import allin1

    wav, stems = inputs["wav"], inputs["stems"]
    name = os.path.splitext(os.path.basename(wav))[0]
    work = tempfile.mkdtemp(prefix="gb-mcp-sections-")
    try:
        stage_stems(os.path.join(work, "demix"), name, stems)
        r = allin1.analyze(wav, model=MODEL, device=handle["device"], demix_dir=os.path.join(work, "demix"),
                           spec_dir=os.path.join(work, "spec"), keep_byproducts=True, multiprocess=False)
        return {"sections": segments(r), "model": f"all-in-one {MODEL} ({WEIGHTS_REPO}@{WEIGHTS_REVISION[:7]})"}
    finally:
        shutil.rmtree(work, ignore_errors=True)  # the copies and spectrograms only: the stems stay
