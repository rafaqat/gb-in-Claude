# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""RoFormer vocal separation (M13.12): Kim Jensen's MelBand RoFormer through audio-separator, in its own venv (a sidecar
with GBMODELS_ENV=roformer; scripts/install-engines.sh roformer). It splits a mix into the vocal and the rest.

Measured on a 63.5 s mix with known stems: vocal SDR 18.79 dB against 12.70 dB for Demucs htdemucs,
the rest 18.80 dB against 12.59 dB; 37 s against 5 s on an M4. gb_stem separate {model: "roformer"} then lets Demucs
split the rest into drums, bass and other (stems.split). The weights are the author's file at a pinned revision (MIT);
the model folder holds a link to them, the model's config and an empty download list, so nothing is fetched at load.

    run(handle, {"wav", "out_dir", "base"}) → out_dir/<base>-vocals.wav and <base>-instrumental.wav (24-bit PCM)
"""
import hashlib
import json
import os

AUDIO_SEPARATOR = "0.47.0"  # MIT; its MelBand RoFormer code runs the weights
WEIGHTS_REPO = "KimberleyJSN/melbandroformer"
WEIGHTS_REVISION = "ac9b0614ab3cd7f77219e18ba494dfd93956c348"  # MIT (the repository's licence tag)
WEIGHTS_FILE = "MelBandRoformer.ckpt"
WEIGHTS_SHA256 = "87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e"
MODEL_FILE = "vocals_mel_band_roformer.ckpt"  # the name audio-separator knows the model by
CONFIG_FILE = "vocals_mel_band_roformer.yaml"
# The model's configuration, as audio-separator publishes it (model-configs release, sha256 b958b29c…cd38).
CONFIG = """audio:
  chunk_size: 352800
  dim_f: 1024
  dim_t: 256
  hop_length: 441
  n_fft: 2048
  num_channels: 2
  sample_rate: 44100
  min_mean_abs: 0.001

model:
  dim: 384
  depth: 6
  stereo: true
  num_stems: 1
  time_transformer_depth: 1
  freq_transformer_depth: 1
  num_bands: 60
  dim_head: 64
  heads: 8
  attn_dropout: 0
  ff_dropout: 0
  flash_attn: True
  dim_freqs_in: 1025
  sample_rate: 44100  # needed for mel filter bank from librosa
  stft_n_fft: 2048
  stft_hop_length: 441
  stft_win_length: 2048
  stft_normalized: False
  mask_estimator_depth: 2
  multi_stft_resolution_loss_weight: 1.0
  multi_stft_resolutions_window_sizes: !!python/tuple
  - 4096
  - 2048
  - 1024
  - 512
  - 256
  multi_stft_hop_size: 147
  multi_stft_normalized: False

training:
  instruments:
  - vocals
  - other
  target_instrument: vocals

inference:
  dim_t: 1101
  num_overlap: 1
  chunk_size: 352800
"""
# audio-separator reads these lists before it loads a model; empty, they make it use only its own bundled list
_LISTS = ("vr_download_list", "mdx_download_list", "demucs_download_list", "mdx_download_vip_list",
          "mdx23c_download_list", "mdx23c_download_vip_list", "roformer_download_list")


def verify(path: str, sha256: str) -> None:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 22), b""):
            h.update(block)
    if h.hexdigest() != sha256:
        raise ValueError(f"{os.path.basename(path)} is not the pinned weights (sha256 {h.hexdigest()[:12]}…): run "
                         "scripts/install-engines.sh roformer again")


def prepare_model_dir(work: str, ckpt: str) -> None:
    """The folder audio-separator loads from: a link to the weights under its model name, the config, empty lists."""
    os.makedirs(work, exist_ok=True)
    link = os.path.join(work, MODEL_FILE)
    if os.path.islink(link) and os.readlink(link) != ckpt:
        os.unlink(link)
    if not os.path.lexists(link):
        os.symlink(ckpt, link)
    with open(os.path.join(work, CONFIG_FILE), "w") as f:
        f.write(CONFIG)
    with open(os.path.join(work, "download_checks.json"), "w") as f:
        json.dump({name: {} for name in _LISTS}, f)


def pick(files: list[str]) -> dict:
    """audio-separator names its outputs <base>_(vocals)_<model>.wav and <base>_(other)_<model>.wav (any case)."""
    found = {}
    for f in files:
        name = os.path.basename(f).lower()
        for stem in ("vocals", "other"):
            if f"_({stem})_" in name:
                found[stem] = f
    missing = [s for s in ("vocals", "other") if s not in found]
    if missing:
        raise ValueError(f"audio-separator wrote no {' or '.join(missing)} file (got {', '.join(os.path.basename(f) for f in files)})")
    return found


def _engine_dir() -> str:
    home = os.environ.get("GB_MCP_ENGINE_HOME") or os.path.expanduser("~/Library/Caches/gb-mcp")
    return os.environ.get("GB_MCP_ROFORMER") or os.path.join(home, "roformer")


def load(device: str, **_) -> dict:
    ckpt = os.path.join(_engine_dir(), "models", WEIGHTS_FILE)
    if not os.path.isfile(ckpt):
        raise FileNotFoundError(f"{ckpt} is missing: run scripts/install-engines.sh roformer")
    verify(ckpt, WEIGHTS_SHA256)
    work = os.path.join(_engine_dir(), "audio-separator")
    prepare_model_dir(work, ckpt)
    return {"work": work, "separator": None}


def run(handle: dict, inputs: dict) -> dict:
    import shutil
    import tempfile
    import soundfile as sf
    from gbmodels.stems import write_pcm

    base = inputs["base"]
    out_dir = inputs["out_dir"]
    targets = {"vocals": os.path.join(out_dir, f"{base}-vocals.wav"), "instrumental": os.path.join(out_dir, f"{base}-instrumental.wav")}
    existing = [p for p in targets.values() if os.path.lexists(p)]
    if existing:
        raise FileExistsError(f"already exist: {', '.join(os.path.basename(p) for p in existing)}")
    tmp = tempfile.mkdtemp(prefix=".roformer-", dir=out_dir)
    try:
        if handle["separator"] is None:
            from audio_separator.separator import Separator
            sep = Separator(model_file_dir=handle["work"], output_dir=tmp, output_format="WAV")
            sep.load_model(model_filename=MODEL_FILE)
            handle["separator"] = sep
        sep = handle["separator"]
        sep.output_dir = tmp
        if getattr(sep, "model_instance", None) is not None:
            sep.model_instance.output_dir = tmp
        files = [f if os.path.isabs(f) else os.path.join(tmp, f) for f in sep.separate(inputs["wav"])]
        got = pick(files)
        parts = {stem: sf.read(got[stem], always_2d=True, dtype="float32") for stem in ("vocals", "other")}
        rate = parts["vocals"][1]
        peak = max(float(abs(x).max()) for x, _ in parts.values())
        gain = 0.999 / peak if peak > 1.0 else 1.0  # one gain for both: vocal + instrumental stay the mix
        for stem, target in (("vocals", targets["vocals"]), ("other", targets["instrumental"])):
            write_pcm(target, parts[stem][0] * gain, rate, 24)
        return {"stems": targets, "model": f"MelBand RoFormer (Kim) {WEIGHTS_REPO}@{WEIGHTS_REVISION[:7]}", "rate": rate}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
