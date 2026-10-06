# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Lyric check (M13.11): what a generated vocal sings against the written lyrics, line by line.

Whisper (large-v3-turbo on MLX, a pinned revision) transcribes the vocal stem with word times; an edit-distance
alignment then places every lyric word against the heard words in order. Each lyric line is sung (>= 85 % of its
words heard), partial (>= a third) or missing, with its times and the words actually heard; the whole gets a word
error rate. The alignment is pure (align); run() adds the transcription.
"""
import re

WHISPER_REPO = "mlx-community/whisper-large-v3-turbo"
WHISPER_REVISION = "a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb"  # weights: OpenAI Whisper (MIT), MLX conversion
SUNG, PARTIAL = 0.85, 1 / 3
_TAG = re.compile(r"^\s*\[([^\]]*)\]\s*$")


def _norm(word: str) -> str:
    return re.sub(r"[^\w]", "", word.lower().replace("’", "'").replace("'", ""))


def parse(text: str) -> list[dict]:
    """Lyric lines with their section ([Verse 1 - Female] → "Verse 1"); tags and empty lines are not lines."""
    out, section = [], None
    for raw in text.splitlines():
        tag = _TAG.match(raw)
        if tag:
            section = re.split(r"\s+[-–:]\s+|:", tag.group(1))[0].strip() or None
            continue
        ws = [w for w in (_norm(x) for x in raw.split()) if w]
        if ws:
            out.append({"line": raw.strip(), "section": section, "words": ws})
    return out


def _alignment(ref: list[str], hyp: list[str]) -> list[tuple[int | None, int | None]]:
    """Levenshtein alignment with backtrace: pairs (ref index or None, hyp index or None)."""
    n, m = len(ref), len(hyp)
    d = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        d[i][0] = i
    for j in range(m + 1):
        d[0][j] = j
    for i in range(1, n + 1):
        ri, row, up = ref[i - 1], d[i], d[i - 1]
        for j in range(1, m + 1):
            row[j] = min(up[j] + 1, row[j - 1] + 1, up[j - 1] + (ri != hyp[j - 1]))
    pairs, i, j = [], n, m
    while i or j:
        if i and j and d[i][j] == d[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]):
            pairs.append((i - 1, j - 1)); i, j = i - 1, j - 1
        elif i and d[i][j] == d[i - 1][j] + 1:
            pairs.append((i - 1, None)); i -= 1
        else:
            pairs.append((None, j - 1)); j -= 1
    return pairs[::-1]


def align(text: str, heard: list[dict]) -> dict:
    """heard: [{word, start, end}] in time order (Whisper words). Returns per-line status and the word error rate."""
    lines = parse(text)
    ref, owner = [], []
    for k, ln in enumerate(lines):
        ref += ln["words"]
        owner += [k] * len(ln["words"])
    hyp_words = [{"w": _norm(h["word"]), **h} for h in heard]
    hyp_words = [h for h in hyp_words if h["w"]]
    pairs = _alignment(ref, [h["w"] for h in hyp_words])
    hits = [0] * len(lines)
    got: list[list[dict]] = [[] for _ in lines]
    errors = 0
    for r, h in pairs:
        if r is not None and h is not None:
            got[owner[r]].append(hyp_words[h])
            if ref[r] == hyp_words[h]["w"]:
                hits[owner[r]] += 1
            else:
                errors += 1
        else:
            errors += 1
    out = []
    for k, ln in enumerate(lines):
        cover = hits[k] / len(ln["words"])
        status = "sung" if cover >= SUNG else "partial" if cover >= PARTIAL else "missing"
        g = got[k]
        out.append({"line": ln["line"], "section": ln["section"], "status": status, "coverage": round(cover, 2),
                    "heard": " ".join(x["word"].strip() for x in g),
                    "start_s": round(g[0]["start"], 2) if g else None, "end_s": round(g[-1]["end"], 2) if g else None})
    return {"lines": out, "wer": round(errors / max(1, len(ref)), 3),
            "summary": {s: sum(1 for x in out if x["status"] == s) for s in ("sung", "partial", "missing")}}


def load(device: str, **_) -> dict:
    return {"model_dir": None}


def run(handle: dict, inputs: dict) -> dict:
    """inputs: wav (a vocal stem), lyrics (text), language (optional, e.g. "en"). The model downloads once, pinned."""
    if handle["model_dir"] is None:
        from huggingface_hub import snapshot_download
        handle["model_dir"] = snapshot_download(WHISPER_REPO, revision=WHISPER_REVISION)
    import mlx_whisper
    r = mlx_whisper.transcribe(inputs["wav"], path_or_hf_repo=handle["model_dir"], word_timestamps=True,
                               language=inputs.get("language"), condition_on_previous_text=False)
    heard = [{"word": w["word"], "start": float(w["start"]), "end": float(w["end"])} for seg in r.get("segments", []) for w in seg.get("words", [])]
    out = align(inputs["lyrics"], heard)
    out["transcript"] = r.get("text", "").strip()
    out["model"] = f"{WHISPER_REPO}@{WHISPER_REVISION[:7]}"
    return out
