# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""CLI for the TS server. stdout carries exactly one JSON document; diagnostics go to stderr.

    python3 -m gbanalyze.cli analyze --input <wav|aiff|flac> [--context <json>] [--spectrogram <new.png>]
    python3 -m gbanalyze.cli master --input <wav|aiff|flac> --output <new.wav> [--lufs -14] [--peak -1]

→ {"ok": true, "result": {...}}  or  {"ok": false, "error": {"code": "...", "message": "..."}}  (exit 2)
"""
import json
import math
import sys
import warnings

MAX_SECONDS = 20 * 60
# Memory, not only duration: a FLAC at 655350 Hz passed the 20-minute check and took
# gigabytes. At most 192 kHz, and at most as many samples as 20 minutes of 48 kHz stereo (10 minutes at 96 kHz).
MAX_RATE = 192_000
MAX_SAMPLES = 20 * 60 * 48_000 * 2


class CliError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _clean(value):
    """JSON-safe: numpy scalars → Python, NaN/inf → None."""
    if isinstance(value, dict):
        return {str(k): _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    if hasattr(value, "item") and not isinstance(value, (str, bytes)):
        value = value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _parse_args(argv):
    if not argv or argv[0] != "analyze":
        raise CliError("INPUT_INVALID", "usage: analyze --input <file> [--context <json>] [--spectrogram <png>]")
    opts, i = {}, 1
    while i < len(argv):
        flag = argv[i]
        if flag not in ("--input", "--context", "--spectrogram") or i + 1 >= len(argv):
            raise CliError("INPUT_INVALID", f"unexpected argument {flag!r}")
        opts[flag[2:]] = argv[i + 1]
        i += 2
    if "input" not in opts:
        raise CliError("INPUT_INVALID", "--input is required")
    if "context" in opts:
        try:
            opts["context"] = json.loads(opts["context"])
        except json.JSONDecodeError as e:
            raise CliError("INPUT_INVALID", f"--context is not valid JSON: {e.msg}") from None
        if not isinstance(opts["context"], dict):
            raise CliError("INPUT_INVALID", "--context must be a JSON object")
    return opts


def _load(path):
    from pathlib import Path
    import soundfile as sf

    if not Path(path).is_file():
        raise CliError("FILE_NOT_FOUND", "input file does not exist")
    try:
        info = sf.info(path)
    except Exception:
        raise CliError("AUDIO_INVALID", "not a readable audio file (use WAV, AIFF or FLAC)") from None
    if info.channels > 2:
        raise CliError("NOT_SUPPORTED", f"{info.channels} channels; only mono or stereo")
    if info.samplerate > MAX_RATE:
        raise CliError("NOT_SUPPORTED", f"sample rate {info.samplerate} Hz; at most {MAX_RATE} Hz")
    if info.frames / info.samplerate > MAX_SECONDS:
        raise CliError("NOT_SUPPORTED", "audio longer than 20 minutes")
    if info.frames * info.channels > MAX_SAMPLES:
        raise CliError("NOT_SUPPORTED", "too many samples to analyse (at most 20 minutes of 48 kHz stereo, or 10 at 96 kHz)")
    x, rate = sf.read(path, always_2d=True, dtype="float64")
    if len(x) == 0:
        raise CliError("AUDIO_INVALID", "audio file is empty")
    return x, rate


def _master(argv) -> dict:
    """master --input <file> --output <new.wav> [--lufs N] [--peak N] (M13.2)."""
    opts, i = {}, 1
    while i < len(argv):
        flag = argv[i]
        if flag not in ("--input", "--output", "--lufs", "--peak") or i + 1 >= len(argv):
            raise CliError("INPUT_INVALID", f"unexpected argument {flag!r}")
        opts[flag[2:]] = argv[i + 1]
        i += 2
    if "input" not in opts or "output" not in opts:
        raise CliError("INPUT_INVALID", "--input and --output are required")
    try:
        lufs, peak = float(opts.get("lufs", -14)), float(opts.get("peak", -1))
    except ValueError:
        raise CliError("INPUT_INVALID", "--lufs and --peak must be numbers") from None
    if not -30 <= lufs <= -5 or not -6 <= peak <= 0:
        raise CliError("INPUT_INVALID", "--lufs must be -30 to -5 and --peak -6 to 0")
    _load(opts["input"])  # the same checks as analyze: exists, readable, mono/stereo, at most 20 minutes
    from .master import master
    try:
        return master(opts["input"], opts["output"], lufs=lufs, peak_db=peak)
    except FileExistsError:
        raise CliError("FILE_EXISTS", "the output path already exists; nothing written") from None
    except ValueError as e:
        raise CliError("AUDIO_INVALID", str(e)) from None


def main(argv=None) -> int:
    warnings.simplefilter("ignore")
    argv = sys.argv[1:] if argv is None else argv
    try:
        if argv and argv[0] == "master":
            print(json.dumps({"ok": True, "result": _clean(_master(argv))}, allow_nan=False, separators=(",", ":")))
            return 0
        try:
            from .analyze import analyze
            from .spectrogram import write_spectrogram
        except ImportError as e:
            raise CliError("DEPENDENCY_MISSING", f"python dependency missing: {e.name}") from None
        opts = _parse_args(argv)
        x, rate = _load(opts["input"])
        result = analyze(x, rate, opts.get("context"))
        if "spectrogram" in opts:
            try:
                write_spectrogram(x, rate, opts["spectrogram"],
                                  sections=[(s["name"], s["start_s"], s["end_s"]) for s in result["sections"]],
                                  title=(opts.get("context") or {}).get("title", ""))
            except FileExistsError:
                raise CliError("FILE_EXISTS", "spectrogram path already exists; nothing written") from None
            result["spectrogram"] = opts["spectrogram"]
        else:
            result["spectrogram"] = None
        print(json.dumps({"ok": True, "result": _clean(result)}, allow_nan=False, separators=(",", ":")))
        return 0
    except CliError as e:
        print(json.dumps({"ok": False, "error": {"code": e.code, "message": str(e)}}))
        return 2
    except Exception as e:  # last-resort safety net: still one JSON document
        print(json.dumps({"ok": False, "error": {"code": "ANALYSIS_FAILED", "message": f"{type(e).__name__}: {e}"}}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
