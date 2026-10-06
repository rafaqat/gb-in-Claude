# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Stem tools (M11b): bring outside audio (separated or generated stems, loops, recordings) to a gb-mcp song —
inspect it, align it (tempo, pitch, format) and separate it — so gb_band can place it on the song's bars.

    run(handle, {"op": "inspect" | "prepare" | "separate", ...})

Percussive audio is re-timed by its strokes (each stroke keeps its sound and moves; pitch untouched); tonal audio
goes through Rubber Band's R3 engine (external `rubberband` program). gb_band takes 16/24-bit integer PCM only.
"""
import numpy as np
import soundfile as sf

FADE_S = 0.005


def read(path: str) -> tuple[np.ndarray, int]:
    """Audio as float frames × channels (mono becomes one channel)."""
    x, sr = sf.read(path, always_2d=True, dtype="float32")
    return x, sr


def write_pcm(path: str, x: np.ndarray, sr: int, bits: int = 24) -> None:
    """Integer PCM, never overwriting and never through a link: the audio goes to a fresh temporary file in the same
    folder, then gets the final name by a hard link, which refuses an existing name (a file or a link, dangling or
    not) and never follows one."""
    import os
    import tempfile
    peak = float(np.abs(x).max()) if x.size else 0.0
    if peak > 1.0:  # never clip on the way to integer PCM
        x = x / peak * 0.999
    fd, tmp = tempfile.mkstemp(suffix=".wav", dir=os.path.dirname(os.path.abspath(path)))
    os.close(fd)
    try:
        sf.write(tmp, x, sr, subtype=f"PCM_{bits}", format="WAV")
        os.link(tmp, path)
    finally:
        os.unlink(tmp)


def slice_stretch(x: np.ndarray, sr: int, factor: float) -> np.ndarray:
    """Re-time percussive audio by its strokes: each slice (onset to next onset) keeps its sound and moves to
    onset × factor; overlapping rings add up; every slice ends with a 5 ms fade. factor < 1 = faster."""
    import librosa
    mono = x.mean(axis=1)
    on = librosa.onset.onset_detect(y=mono, sr=sr, units="samples", backtrack=True)
    on = np.unique(np.concatenate([[0], on])).astype(int)
    out = np.zeros((int(round(len(x) * factor)) + int(0.5 * sr), x.shape[1]), dtype=np.float32)
    fade = np.linspace(1.0, 0.0, int(FADE_S * sr), dtype=np.float32)[:, None]
    for i, a in enumerate(on):
        b = on[i + 1] if i + 1 < len(on) else len(x)
        seg = x[a:b].copy()
        if len(seg) > len(fade):
            seg[-len(fade):] *= fade
        at = int(round(a * factor))
        out[at:at + len(seg)] += seg[: max(0, len(out) - at)]
    return out[: int(round(len(x) * factor))]


def detect_mode(x: np.ndarray, sr: int) -> str:
    """'percussive' when the percussive part of the sound carries more energy than the harmonic part."""
    import librosa
    h, p = librosa.effects.hpss(x.mean(axis=1))
    return "percussive" if float(np.mean(p ** 2)) > float(np.mean(h ** 2)) else "tonal"


def resample(x: np.ndarray, sr: int, rate: int) -> np.ndarray:
    if sr == rate:
        return x
    import librosa
    return librosa.resample(x.T, orig_sr=sr, target_sr=rate, res_type="soxr_hq").T.astype(np.float32)


def fold(bpm: float, near: float) -> float:
    """A tracker can lock to half or double time: take the ×½ / ×1 / ×2 reading closest to the expected tempo."""
    return min((bpm / 2, bpm, bpm * 2), key=lambda b: abs(np.log2(b / near)))


def measure_bpm(handle: dict, path: str, near: float | None = None) -> float:
    """Tempo from the beat tracker (beat_this): the mean of the regular beat intervals (beatthis.tempo — not the median,
    which the tracker's 20 ms frames quantise), folded toward `near`."""
    from gbmodels import beatthis
    if handle.get("beats") is None:
        handle["beats"] = beatthis.load(handle["device"])
    beats, _ = handle["beats"]["model"](path)
    if len(beats) < 3:
        raise ValueError("too few beats to measure a tempo; pass from_bpm")
    bpm = beatthis.tempo(beats)
    return round(fold(bpm, near) if near else bpm, 2)


def inspect(handle: dict, inputs: dict) -> dict:
    """What gb_band needs to know before placing a file: format, length, tempo, key, kind of sound, peak."""
    info = sf.info(inputs["wav"])
    x, sr = read(inputs["wav"])
    if handle.get("key") is None:
        from gbmodels import skey
        handle["key"] = skey.load("cpu")
    from gbmodels import skey
    key = skey.run(handle["key"], {"wav": inputs["wav"]})
    try:
        bpm = measure_bpm(handle, inputs["wav"], inputs.get("near_bpm"))
    except ValueError:
        bpm = None
    peak = float(np.abs(x).max()) if x.size else 0.0
    return {"wav": inputs["wav"], "rate": info.samplerate, "subtype": info.subtype, "channels": info.channels,
            "seconds": round(info.frames / info.samplerate, 3), "bpm": bpm, "key": key["key"],
            "key_confidence": key["confidence"], "mode": detect_mode(x, sr),
            "peak_dbfs": round(20 * np.log10(peak), 2) if peak > 0 else None,
            "placeable": info.subtype in ("PCM_16", "PCM_24")}


def prepare(inputs: dict, handle: dict | None = None) -> dict:
    """wav → out at the song's tempo, pitch and format. inputs: wav, out, to_bpm, from_bpm (or measured),
    semitones (0), mode ('auto' | 'percussive' | 'tonal'), rate (44100), bits (24)."""
    import os
    if os.path.lexists(inputs["out"]):  # refuse early, before the work; write_pcm refuses again atomically
        raise FileExistsError(f"{os.path.basename(inputs['out'])} already exists")
    x, sr = read(inputs["wav"])
    mode = inputs.get("mode", "auto")
    if mode == "auto":
        mode = detect_mode(x, sr)
    to_bpm = float(inputs["to_bpm"])
    if inputs.get("from_bpm") is not None:
        from_bpm = float(inputs["from_bpm"])
    elif handle is not None:
        from_bpm = measure_bpm(handle, inputs["wav"], near=to_bpm)
    else:
        raise ValueError("from_bpm is missing and there is no beat tracker to measure it")
    factor = from_bpm / to_bpm  # the new length over the old one
    semitones = float(inputs.get("semitones", 0))
    stretched = abs(factor - 1.0) > 0.002 or semitones != 0
    if stretched:
        x = slice_stretch(x, sr, factor) if mode == "percussive" and semitones == 0 else rubberband(x, sr, factor, semitones)
    rate, bits = int(inputs.get("rate", 44100)), int(inputs.get("bits", 24))
    y = resample(x, sr, rate)
    write_pcm(inputs["out"], y, rate, bits)
    return {"out": inputs["out"], "mode": mode, "from_bpm": from_bpm, "to_bpm": to_bpm, "factor": round(factor, 6),
            "semitones": semitones, "stretched": stretched, "measured": inputs.get("from_bpm") is None, "rate": rate, "bits": bits, "seconds": round(len(y) / rate, 3)}


def rubberband(x: np.ndarray, sr: int, factor: float, semitones: float) -> np.ndarray:
    """Tonal stretch / pitch shift with Rubber Band's R3 (finer) engine: length × factor, pitch + semitones."""
    import os
    import shutil
    import subprocess
    import tempfile
    exe = os.environ.get("GB_MCP_RUBBERBAND") or shutil.which("rubberband")
    if not exe:
        raise RuntimeError("Rubber Band is not installed: brew install rubberband (or set GB_MCP_RUBBERBAND)")
    with tempfile.TemporaryDirectory() as d:
        src, dst = os.path.join(d, "in.wav"), os.path.join(d, "out.wav")
        sf.write(src, x, sr, subtype="FLOAT")
        # argv only, no shell; -3 = R3 engine, -t = time ratio, -p = semitones, -q = quiet
        subprocess.run([exe, "-3", "-q", "-t", f"{factor:.6f}", "-p", f"{semitones:.4f}", src, dst],
                       check=True, capture_output=True, timeout=600)
        y, _ = sf.read(dst, always_2d=True, dtype="float32")
    return y


DEMUCS_MODEL = "htdemucs"  # Demucs v4 hybrid transformer (MIT): vocals, drums, bass, other


def separate(handle: dict, inputs: dict) -> dict:
    """wav → out_dir/<name>-<stem>.wav for vocals, drums, bass, other (24-bit PCM at Demucs' 44.1 kHz).
    Never overwrites: an existing stem file is an error."""
    import os
    os.makedirs(inputs["out_dir"], exist_ok=True)
    base = os.path.splitext(os.path.basename(inputs["wav"]))[0]
    targets = {s: os.path.join(inputs["out_dir"], f"{base}-{s}.wav") for s in ("vocals", "drums", "bass", "other")}
    existing = [p for p in targets.values() if os.path.lexists(p)]  # a dangling link counts
    if existing:
        raise FileExistsError(f"stems already exist: {', '.join(os.path.basename(p) for p in existing)}")
    sep = _demucs(handle)
    _, parts = sep.separate_audio_file(inputs["wav"])
    for name, path in targets.items():
        write_pcm(path, parts[name].detach().cpu().numpy().T, sep.samplerate, int(inputs.get("bits", 24)))
    return {"stems": targets, "model": DEMUCS_MODEL, "rate": sep.samplerate}


def _demucs(handle: dict):
    if handle.get("demucs") is None:
        from demucs.api import Separator
        try:
            handle["demucs"] = Separator(model=DEMUCS_MODEL, device=handle["device"])
        except Exception:
            handle["demucs"] = Separator(model=DEMUCS_MODEL, device="cpu")  # an op Metal lacks: run on the CPU
    return handle["demucs"]


def split(handle: dict, inputs: dict) -> dict:
    """M13.12: an instrumental (the mix without its vocal, from RoFormer) → out_dir/<base>-drums, -bass, -other.wav.
    Demucs gives drums and bass; other is all the rest (Demucs' other and the vocal it still hears), so the three add
    up to the instrumental. One gain for all three if a peak would clip. Never overwrites."""
    import os
    os.makedirs(inputs["out_dir"], exist_ok=True)
    base = inputs["base"]
    targets = {s: os.path.join(inputs["out_dir"], f"{base}-{s}.wav") for s in ("drums", "bass", "other")}
    existing = [p for p in targets.values() if os.path.lexists(p)]
    if existing:
        raise FileExistsError(f"stems already exist: {', '.join(os.path.basename(p) for p in existing)}")
    sep = _demucs(handle)
    whole, parts = sep.separate_audio_file(inputs["wav"])
    x = whole.detach().cpu().numpy().T
    out = {s: parts[s].detach().cpu().numpy().T for s in ("drums", "bass")}
    out["other"] = x - out["drums"] - out["bass"]
    peak = max(float(np.abs(v).max()) for v in out.values())
    gain = 0.999 / peak if peak > 1.0 else 1.0
    for name, path in targets.items():
        write_pcm(path, out[name] * gain, sep.samplerate, int(inputs.get("bits", 24)))
    return {"stems": targets, "model": DEMUCS_MODEL, "rate": sep.samplerate}


def load(device: str, **_) -> dict:
    return {"device": device, "beats": None, "key": None, "demucs": None}  # models load on first use


def run(handle: dict, inputs: dict) -> dict:
    op = inputs.get("op")
    if op == "prepare":
        return prepare(inputs, handle)
    if op == "inspect":
        return inspect(handle, inputs)
    if op == "separate":
        return separate(handle, inputs)
    if op == "split":
        return split(handle, inputs)
    raise ValueError(f"op must be inspect, prepare, separate or split (got {op!r})")
