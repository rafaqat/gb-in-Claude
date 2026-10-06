# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""ACE-Step 1.5 turbo as a gb_generate engine (M12b). Runs in ACE-Step's own venv (a sidecar with
GBMODELS_ENV=ace-step): the authors' code at a reviewed commit (checked before import), the weights at a reviewed
revision, offline. Measured on this Mac (eval/m12a): a 116 s cover in about 90 s warm; 30 s text-to-music 50–100 s
with the 1.7B LM. float16 VAE (same-latent SNR 55 dB, −3.7 GB); the LM loads only for `text`.
Tasks: cover (a source WAV re-sung / re-played to a caption and lyrics; strength = how closely it keeps the source),
text (music from a caption, bpm, key, length) and repaint (M13.9: regenerate start..end of a source, keep the rest; the
result comes back at the source's level — match_level); with the base model (M13.10): lego (one new track, from TRACKS,
over a range of a source) and complete (a lone track completed with TRACKS). Output: 16-bit 48 kHz WAV at `out`, never overwritten."""
import os
import shutil
import sys
import tempfile

ENGINE_HOME = os.environ.get("GB_MCP_ENGINE_HOME") or os.path.expanduser("~/Library/Caches/gb-mcp")  # scripts/install-engines.sh
CODE = os.environ.get("GB_MCP_ACESTEP") or os.path.join(ENGINE_HOME, "ace-step")
PINNED_COMMIT = "ca1e85fe9430179831e6bc6be790c332190a3866"  # github.com/ace-step/ACE-Step-1.5, MIT
WEIGHTS_REVISION = "19671f406d603126926c1b7e2adc169acbcade22"  # ACE-Step/Ace-Step1.5, MIT
DIT, LM = "acestep-v15-turbo", "acestep-5Hz-lm-1.7B"
# M13.10: the base model (an extra, pinned download: scripts/install-engines.sh ace-step-base) does lego and complete
BASE_DIT = "acestep-v15-base"
BASE_REVISION = "e432212fec32b8965a14ffa57ae653438d6abd14"  # ACE-Step/acestep-v15-base, MIT
TRACKS = ("woodwinds", "brass", "fx", "synth", "strings", "percussion", "keyboard", "guitar", "bass", "drums", "backing_vocals", "vocals")
TASKS = ("cover", "text", "repaint", "lego", "complete")
REPAINT_MODES = ("conservative", "balanced", "aggressive")
INSTRUMENTAL = "[Instrumental]"
# ACE-Step's own examples run to 724 characters; its text encoder keeps about 256 tokens (≈ 1000 characters of English)
CAPTION_MAX = 1000


def _number(inputs: dict, key: str, lo: float, hi: float, default=None, integer: bool = False):
    value = inputs.get(key, default)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not lo <= value <= hi or (integer and int(value) != value):
        raise ValueError(f"{key} must be {'an integer' if integer else 'a number'} from {lo} to {hi}")
    return int(value) if integer else float(value)


def _out(inputs: dict) -> str:
    out = inputs.get("out")
    if not isinstance(out, str) or not os.path.isabs(out) or not out.endswith(".wav"):
        raise ValueError("out must be an absolute .wav path")
    if os.path.lexists(out):
        raise FileExistsError(f"{os.path.basename(out)} already exists; nothing written")
    return out


def validate(inputs: dict) -> dict:
    task = inputs.get("task")
    if task not in TASKS:
        raise ValueError(f"task must be one of {', '.join(TASKS)}")
    caption = inputs.get("caption")
    if not isinstance(caption, str) or not caption.strip() or len(caption) > CAPTION_MAX:
        raise ValueError(f"caption must be 1–{CAPTION_MAX} characters")
    lyrics = inputs.get("lyrics", INSTRUMENTAL)
    if not isinstance(lyrics, str) or not lyrics.strip() or len(lyrics) > 4096:
        raise ValueError("lyrics must be 1–4096 characters ([Instrumental] for none)")
    v = {"task": task, "caption": caption.strip(), "lyrics": lyrics, "seed": _number(inputs, "seed", 0, 2**31 - 1, 42, True),
         "bpm": _number(inputs, "bpm", 30, 300, integer=True), "keyscale": str(inputs.get("key") or ""),
         "duration": _number(inputs, "duration", 10, 600), "vocal_language": inputs.get("vocal_language") or ("unknown" if lyrics == INSTRUMENTAL else "en")}
    if task in ("cover", "repaint", "lego", "complete"):
        src = inputs.get("src")
        if not isinstance(src, str) or not os.path.isabs(src) or not os.path.isfile(src):
            raise ValueError(f"src must be an existing absolute audio path (the song to {task})")
    if task == "cover":
        v.update(src=src, strength=_number(inputs, "strength", 0.0, 1.0, 0.7), thinking=False)  # cover does not use the LM
    elif task == "repaint":  # M13.9: regenerate start..end of src, keep the rest (the LM is not used)
        start = _number(inputs, "start", 0.0, 3600.0)
        if start is None:
            raise ValueError("start (seconds) is required for repaint")
        end = _number(inputs, "end", -1.0, 3600.0, -1.0)
        if end != -1.0 and end <= start:
            raise ValueError("end must be after start (or -1 for the song's end)")
        mode = inputs.get("mode", "balanced")
        if mode not in REPAINT_MODES:
            raise ValueError(f"mode must be one of {', '.join(REPAINT_MODES)}")
        v.update(src=src, start=start, end=end, mode=mode, strength=_number(inputs, "strength", 0.0, 1.0, 0.5), thinking=False)
    elif task == "lego":  # M13.10: a new track (one of TRACKS) over start..end, generated from the song around it
        track = inputs.get("track")
        if track not in TRACKS:
            raise ValueError(f"track must be one of {', '.join(TRACKS)}")
        start = _number(inputs, "start", 0.0, 3600.0, 0.0)
        end = _number(inputs, "end", -1.0, 3600.0, -1.0)
        if end != -1.0 and end <= start:
            raise ValueError("end must be after start (or -1 for the song's end)")
        v.update(src=src, track=track, start=start, end=end, strength=1.0, thinking=False)
    elif task == "complete":  # M13.10: a lone track (e.g. a vocal) completed with these tracks
        tracks = inputs.get("tracks")
        if not isinstance(tracks, list) or not tracks or any(t not in TRACKS for t in tracks):
            raise ValueError(f"tracks must be a non-empty list of {', '.join(TRACKS)}")
        v.update(src=src, tracks=list(dict.fromkeys(tracks)), strength=1.0, thinking=False)
    else:
        if v["duration"] is None:
            raise ValueError("duration (10–600 s) is required for text")
        v.update(src=None, strength=1.0, thinking=bool(inputs.get("thinking", True)))
    v["out"] = _out(inputs)
    return v


LEGO_CONTEXT_S = 10.0  # lego works on its range plus this much of the song on each side (not the whole song)


def crop_window(start: float, end: float, duration: float, context: float) -> tuple[float, float, float, float]:
    """(a, b): the part of the source lego reads — the range plus context, inside the song; and the range in it."""
    a = max(0.0, start - context)
    b = duration if end < 0 else min(duration, end + context)
    return a, b, start - a, -1.0 if end < 0 else end - a


def keep_range(piece, rate: int, start_s: float, end_s: float, fade_s: float = 0.05):
    """Only start..end of `piece` (end -1: to its end), with short linear fades: lego returns its context as a copy of
    the song, and that copy layered on the song would play twice."""
    import numpy as np
    out = np.zeros_like(piece)
    a = int(round(start_s * rate))
    z = len(piece) if end_s < 0 else min(len(piece), int(round(end_s * rate)))
    out[a:z] = piece[a:z]
    f = min(int(round(fade_s * rate)), max(0, (z - a) // 2))
    if f:
        ramp = (np.arange(1, f + 1) / (f + 1))[:, None]
        out[a:a + f] *= ramp
        out[z - f:z] *= ramp[::-1]
    return out


def pad_to(piece, rate: int, offset_s: float, frames: int):
    """`piece` back at `offset_s` in a song-length (`frames`) buffer of silence."""
    import numpy as np
    out = np.zeros((frames, piece.shape[1]))
    o = int(round(offset_s * rate))
    n = max(0, min(len(piece), frames - o))
    out[o:o + n] = piece[:n]
    return out


PEAK_CEILING = 10 ** (-0.1 / 20)  # a level match never takes a peak above -0.1 dBFS
REPAINT_MARGIN_S = 1.0  # around the repainted range the model crossfades: not used to measure the level


def match_level(src, out, sr: int, start: float, end: float):
    """ACE-Step normalises its output, so a repaint comes back at another level. Scale `out` to the source's level,
    measured where the source was kept (least squares), unless a peak would pass -0.1 dBFS: then as close as the
    ceiling allows, and level_matched is false. src and out: frames x channels at the same rate `sr`."""
    import numpy as np
    n = min(len(src), len(out))
    keep = np.ones(n, bool)
    a = int(max(0.0, start - REPAINT_MARGIN_S) * sr)
    z = n if end < 0 else min(n, int((end + REPAINT_MARGIN_S) * sr))
    keep[a:z] = False
    s, o = np.asarray(src[:n], float).mean(axis=1)[keep], np.asarray(out[:n], float).mean(axis=1)[keep]
    gain = float(np.dot(s, o) / np.dot(o, o)) if keep.any() and np.dot(o, o) > 0 else 1.0
    y = np.asarray(out, float) * gain
    peak = float(np.abs(y).max()) if len(y) else 0.0
    matched = peak <= PEAK_CEILING
    if not matched:
        y *= PEAK_CEILING / peak
        gain *= PEAK_CEILING / peak
    return y, {"gain_db": round(float(20 * np.log10(gain)), 2), "level_matched": matched}


def _write_padded(generated: str, out: str, crop: dict) -> None:
    import soundfile as sf
    piece, rate = sf.read(generated, always_2d=True, dtype="float64")
    piece = keep_range(piece, rate, *crop["local"])  # the new track only (the context came back as the song itself)
    y = pad_to(piece, rate, crop["from_s"], int(round(crop["song_s"] * rate)))
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)
    with os.fdopen(fd, "wb") as fh:
        sf.write(fh, y, rate, subtype="PCM_16", format="WAV")


def _write_level_matched(generated: str, v: dict) -> dict:
    """The repaint at the source's level, written to v["out"] (exclusive: never overwrites), 16-bit like ACE-Step."""
    import numpy as np
    import soundfile as sf
    out, rate = sf.read(generated, always_2d=True, dtype="float64")
    src, src_rate = sf.read(v["src"], always_2d=True, dtype="float64")
    if src_rate != rate:
        from math import gcd
        from scipy.signal import resample_poly
        g = gcd(int(rate), int(src_rate))
        src = resample_poly(src, int(rate) // g, int(src_rate) // g, axis=0)
    if src.shape[1] != out.shape[1]:
        src = np.repeat(src.mean(axis=1, keepdims=True), out.shape[1], axis=1)
    y, info = match_level(src, out, rate, v["start"], v["end"])
    fd = os.open(v["out"], os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)
    with os.fdopen(fd, "wb") as fh:
        sf.write(fh, y, rate, subtype="PCM_16", format="WAV")
    return info


def load(device: str, **_) -> dict:
    from .pinned import verify_checkout
    verify_checkout(CODE, PINNED_COMMIT, "ACE-Step 1.5", install_hint="see gb://knowledge/generate")
    os.environ["HF_HUB_OFFLINE"] = "1"  # the reviewed weights only; nothing is fetched
    os.environ["ACESTEP_MLX_VAE_FP16"] = "1"
    os.environ.setdefault("ACESTEP_GENERATION_TIMEOUT", "2400")  # the base model (lego, complete) can pass ACE-Step's 600 s
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    sys.path.insert(0, CODE)
    from acestep.handler import AceStepHandler
    dit = AceStepHandler()
    status, ok = dit.initialize_service(project_root=CODE, config_path=DIT, device="mps")
    if not ok:
        raise RuntimeError(f"ACE-Step DiT did not load: {status}")
    return {"dit": dit, "llm": None, "dit_base": None}


def _base(handle: dict):
    """The base model (lego, complete), loaded on its first use."""
    if handle.get("dit_base") is None:
        if not os.path.isfile(os.path.join(CODE, "checkpoints", BASE_DIT, "model.safetensors")):
            raise RuntimeError("the ACE-Step base model is not installed: ./scripts/install-engines.sh ace-step-base (4.8 GB)")
        from acestep.handler import AceStepHandler
        dit = AceStepHandler()
        status, ok = dit.initialize_service(project_root=CODE, config_path=BASE_DIT, device="mps")
        if not ok:
            raise RuntimeError(f"ACE-Step base model did not load: {status}")
        handle["dit_base"] = dit
    return handle["dit_base"]


def _instruction(v: dict) -> str | None:
    """lego / complete: ACE-Step's own instruction for the task (as its generate_instruction builds it)."""
    from acestep.constants import TASK_INSTRUCTIONS
    if v["task"] == "lego":
        return TASK_INSTRUCTIONS["lego"].format(TRACK_NAME=v["track"].upper())
    if v["task"] == "complete":
        return TASK_INSTRUCTIONS["complete"].format(TRACK_CLASSES=" | ".join(t.upper() for t in v["tracks"]))
    return None


def _llm(handle: dict):
    if handle["llm"] is None:
        from acestep.llm_inference import LLMHandler
        llm = LLMHandler()
        status, ok = llm.initialize(checkpoint_dir=os.path.join(CODE, "checkpoints"), lm_model_path=LM, backend="mlx", device="mps")
        if not ok:
            raise RuntimeError(f"ACE-Step LM did not load: {status}")
        handle["llm"] = llm
    return handle["llm"]


def run(handle: dict, inputs: dict) -> dict:
    v = validate(inputs)
    from acestep.inference import GenerationConfig, GenerationParams, generate_music
    raw = tempfile.mkdtemp(prefix=".ace-step-", dir=os.path.dirname(v["out"]))
    lego_crop = None
    if v["task"] == "lego":  # work on the range plus context (live: the whole song passed ACE-Step's time limit)
        import soundfile as sf
        x, sr0 = sf.read(v["src"], always_2d=True, dtype="float64")
        a, b, ls, le = crop_window(v["start"], v["end"], len(x) / sr0, LEGO_CONTEXT_S)
        lego_crop = {"from_s": a, "to_s": b, "song_s": len(x) / sr0, "local": (ls, le)}
        crop_path = os.path.join(raw, "lego-source.wav")
        sf.write(crop_path, x[int(a * sr0):int(b * sr0)], sr0, subtype="PCM_24")
        v = {**v, "src": crop_path, "start": ls, "end": le}
    llm = _llm(handle) if v["thinking"] else None
    repaint = v["task"] == "repaint"
    on_base = v["task"] in ("lego", "complete")
    extra = dict(repainting_start=v["start"], repainting_end=v["end"], repaint_mode=v["mode"], repaint_strength=v["strength"]) if repaint else {}
    if v["task"] == "lego":
        extra = dict(repainting_start=v["start"], repainting_end=v["end"])
    if on_base:  # the base model: 32 steps, CFG 7, shift 1 (ACE-Step's own defaults for it), and the task's instruction
        extra |= dict(instruction=_instruction(v), guidance_scale=7.0)
    params = GenerationParams(task_type=v["task"] if v["task"] in ("cover", "repaint", "lego", "complete") else "text2music", caption=v["caption"], lyrics=v["lyrics"],
                              instrumental=v["lyrics"] == INSTRUMENTAL, bpm=v["bpm"], keyscale=v["keyscale"], timesignature="4",
                              vocal_language=v["vocal_language"], duration=v["duration"] if v["duration"] is not None else -1.0,
                              inference_steps=32 if on_base else 8, shift=1.0 if on_base else 3.0, infer_method="ode", seed=v["seed"], thinking=v["thinking"],
                              src_audio=v["src"], audio_cover_strength=v["strength"] if v["task"] == "cover" else 1.0, **extra)
    config = GenerationConfig(batch_size=1, use_random_seed=False, seeds=[v["seed"]], audio_format="wav")
    try:
        result = generate_music(_base(handle) if on_base else handle["dit"], llm, params, config, save_dir=raw)
        if not result.success:
            raise RuntimeError(f"ACE-Step failed: {str(result.error)[:300]}")
        audio = result.audios[0]
        level = None
        if repaint:  # back to the source's level, so the kept part splices into a project (match_level)
            level = _write_level_matched(audio["path"], v)
        elif lego_crop:  # the generated piece back at its place in a song-length file (aligned like the stems)
            _write_padded(audio["path"], v["out"], lego_crop)
        else:
            os.link(audio["path"], v["out"])  # fails rather than overwrite
    finally:
        shutil.rmtree(raw, ignore_errors=True)
    costs = (result.extra_outputs or {}).get("time_costs") or {}
    return {"engine": "ace_step", "task": v["task"], "path": v["out"], "rate": audio["sample_rate"],
            "seconds": round(lego_crop["song_s"], 3) if lego_crop else round(audio["tensor"].shape[-1] / audio["sample_rate"], 3), "seed": v["seed"],
            "strength": v["strength"] if v["task"] in ("cover", "repaint") else None, "lm": LM if llm else None,
            **({"repaint": {"start": v["start"], "end": v["end"], "mode": v["mode"], **level}} if repaint else {}),
            **({"lego": {"track": v["track"], "start": inputs.get("start", 0.0), "end": inputs.get("end", -1.0), "worked_on_s": [lego_crop["from_s"], lego_crop["to_s"]]}} if lego_crop else {}),
            **({"complete": {"tracks": v["tracks"]}} if v["task"] == "complete" else {}),
            **({"model": BASE_DIT, "base_revision": BASE_REVISION} if on_base else {}),
            "time_costs": {k: round(c, 2) for k, c in costs.items() if isinstance(c, (int, float))},
            "code": PINNED_COMMIT, "weights": WEIGHTS_REVISION}
