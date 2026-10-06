# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""CLaMP 3 (C2, symbolic): text ↔ MIDI similarity, used to judge infill takes (M10). The model code is the authors'
(github.com/sanderwood/clamp3, MIT), cloned to ~/Library/Caches/gb-mcp/clamp3 (GB_MCP_CLAMP3 overrides); the MIDI →
MTF conversion below follows their preprocessing/midi/batch_midi2mtf.py (--m3_compatible). Scores rank takes; they
are not grades."""
import os
import subprocess
import sys

from huggingface_hub import hf_hub_download

CODE = os.environ.get("GB_MCP_CLAMP3", os.path.expanduser("~/Library/Caches/gb-mcp/clamp3"))
REPO = "https://github.com/sanderwood/clamp3"
# The authors' Python code is imported, so it is pinned to the reviewed commit and its imported files' hashes:
# a changed or tampered checkout is refused before anything is imported.
PINNED_COMMIT = "9016d2b0c8d12d1aa79c2e0ab201e6822bdc83a8"
PINNED_FILES = {
    "code/config.py": "50421c974ab37ff02ae1dfb9b47830881c40e4e48d1ae9a452a9fd87e0ca41ec",
    "code/utils.py": "f865d2c669f91296d0e764a721c1f612ed49547256e6d3bf72707eee35a4ce96",
}
WEIGHTS = ("sander-wood/clamp3", "weights_clamp3_c2_h_size_768_t_model_FacebookAI_xlm-roberta-base_t_length_128_"
           "a_size_768_a_layers_12_a_length_128_s_size_768_s_layers_12_p_size_64_p_length_512.pth")
WEIGHTS_REVISION = "355625cc1c6f73726bbcd0eb9276ac7152d56426"  # pinned
# the text model the authors load by name inside CLaMP3Model: downloaded pinned and handed over as a local folder
TEXT_MODEL = ("FacebookAI/xlm-roberta-base", "e73636d4f797dec63c3081bb6ed5c7b0bb3f2089")
TEXT_FILES = ["config.json", "model.safetensors", "sentencepiece.bpe.model", "tokenizer_config.json", "tokenizer.json"]
SKIPPED_META = {"text", "copyright", "track_name", "instrument_name", "lyrics", "marker", "cue_marker", "device_name"}


def midi_to_mtf(path: str) -> str:
    """MIDI → MTF text (one message per line), as the authors' converter does with --m3_compatible."""
    import mido
    mid = mido.MidiFile(path)
    lines = [f"ticks_per_beat {mid.ticks_per_beat}"]
    for msg in mid.merged_track:
        if msg.is_meta and msg.type in SKIPPED_META:
            continue
        lines.append(" ".join(str(v) for v in msg.dict().values()).strip().encode("unicode_escape").decode("utf-8"))
    return "\n".join(lines)


def verify_code(path: str) -> None:
    """Raise ValueError unless `path` is the pinned commit with unchanged imported files."""
    import hashlib
    head = subprocess.run(["git", "-C", path, "rev-parse", "HEAD"], capture_output=True, text=True)
    if head.returncode != 0 or head.stdout.strip() != PINNED_COMMIT:
        raise ValueError(f"CLaMP 3 checkout is not the reviewed commit {PINNED_COMMIT[:12]} (delete {path} to fetch it again)")
    for rel, digest in PINNED_FILES.items():
        with open(os.path.join(path, rel), "rb") as f:
            if hashlib.sha256(f.read()).hexdigest() != digest:
                raise ValueError(f"CLaMP 3 file {rel} differs from the reviewed version; refusing to import it")


def fetch_pinned(path: str) -> None:
    """Clone exactly the reviewed commit (not the branch head)."""
    os.makedirs(path, exist_ok=True)
    for args in (["init", "-q"], ["remote", "add", "origin", REPO], ["fetch", "-q", "--depth", "1", "origin", PINNED_COMMIT], ["checkout", "-q", PINNED_COMMIT]):
        subprocess.run(["git", "-C", path, *args], check=True)


def load(device: str = "mps"):
    import torch
    if not os.path.isdir(os.path.join(CODE, ".git")):
        fetch_pinned(CODE)
    verify_code(CODE)  # before any import of the authors' code
    sys.path.insert(0, os.path.join(CODE, "code"))
    import config as C  # the authors' config: sizes and the text model name
    from transformers import AutoTokenizer, BertConfig
    from utils import CLaMP3Model, M3Patchilizer
    bert = lambda hidden, layers, length: BertConfig(vocab_size=1, hidden_size=hidden, num_hidden_layers=layers,
                                                     num_attention_heads=hidden // 64, intermediate_size=hidden * 4,
                                                     max_position_embeddings=length)
    # file by file (works from the cache offline; a filtered snapshot_download needs the repo listing from the network)
    text_dir = os.path.dirname([hf_hub_download(TEXT_MODEL[0], f, revision=TEXT_MODEL[1]) for f in TEXT_FILES][0])
    model = CLaMP3Model(audio_config=bert(C.AUDIO_HIDDEN_SIZE, C.AUDIO_NUM_LAYERS, C.MAX_AUDIO_LENGTH),
                        symbolic_config=bert(C.M3_HIDDEN_SIZE, C.PATCH_NUM_LAYERS, C.PATCH_LENGTH),
                        text_model_name=text_dir, hidden_size=C.CLAMP3_HIDDEN_SIZE, load_m3=False)
    state = torch.load(hf_hub_download(*WEIGHTS, revision=WEIGHTS_REVISION), map_location="cpu", weights_only=True)["model"]
    model.load_state_dict(state)
    model = model.to(device).eval()
    tokenizer = AutoTokenizer.from_pretrained(text_dir)  # a local folder, pinned above
    return {"model": model, "device": device, "config": C, "tokenizer": tokenizer, "patchilizer": M3Patchilizer()}


def _global(handle, data, max_len, pad_value, features):
    """The authors' segment-and-average: segments of max_len, each padded, then a length-weighted mean."""
    import torch
    dev = handle["device"]
    segments = [data[i:i + max_len] for i in range(0, len(data), max_len)]
    segments[-1] = data[-max_len:]
    outs = []
    for seg in segments:
        mask = torch.cat((torch.ones(seg.size(0)), torch.zeros(max_len - seg.size(0))))
        pad = torch.full((max_len - seg.size(0), *seg.shape[1:]), pad_value, dtype=seg.dtype)
        outs.append(features(torch.cat((seg, pad)).unsqueeze(0).to(dev), mask.unsqueeze(0).to(dev)))
    full, rest = divmod(len(data), max_len)
    weights = torch.tensor([max_len] * full + ([rest] if rest else []), device=dev, dtype=torch.float32).view(-1, 1)
    v = (torch.cat(outs, 0) * weights).sum(0) / weights.sum()
    return v / v.norm()


def embed_text(handle, text: str):
    import torch
    tok = handle["tokenizer"]
    ids = tok(text, return_tensors="pt")["input_ids"].squeeze(0)
    with torch.inference_mode():
        return _global(handle, ids, handle["config"].MAX_TEXT_LENGTH, tok.pad_token_id,
                       lambda x, m: handle["model"].get_text_features(text_inputs=x, text_masks=m, get_global=True))


def embed_midi(handle, path: str):
    import torch
    p = handle["patchilizer"]
    data = torch.tensor(p.encode(midi_to_mtf(path), add_special_patches=True))
    with torch.inference_mode():
        return _global(handle, data, handle["config"].PATCH_LENGTH, p.pad_token_id,
                       lambda x, m: handle["model"].get_symbolic_features(symbolic_inputs=x, symbolic_masks=m, get_global=True))


def run(handle, inputs: dict) -> dict:
    """inputs: midis (paths), prompt (text). → cosine similarity of each MIDI to the prompt, and the best index."""
    t = embed_text(handle, inputs["prompt"])
    scores = [round(float(embed_midi(handle, m) @ t), 4) for m in inputs["midis"]]
    return {"scores": scores, "best": max(range(len(scores)), key=scores.__getitem__), "note": "a ranking of takes, not a grade"}
