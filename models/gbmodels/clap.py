# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""LAION CLAP (music checkpoint): an audio embedding and its cosine similarity to text prompts.
The non-fusion model sees 10 s at a time, so a recording is cut into 10 s windows whose embeddings are averaged.
Scores rank candidates and compare before/after; they are not grades (no thresholds)."""
from huggingface_hub import hf_hub_download

CKPT = ("lukewys/laion_clap", "music_audioset_epoch_15_esc_90.14.pt")
SR = 48000
WINDOW_S = 10


def load(device: str, dtype: str = "float32"):
    import laion_clap
    import torch
    model = laion_clap.CLAP_Module(enable_fusion=False, amodel="HTSAT-base", device=device)
    model.load_ckpt(hf_hub_download(*CKPT), verbose=False)
    # float16 runs through autocast (matmuls in float16, sensitive ops float32): casting the weights breaks the
    # audio branch's float32 front end
    return {"model": model, "device": device, "dtype": dtype}


def embed_audio(handle, wav: str):
    import librosa
    import numpy as np
    import torch
    y, _ = librosa.load(wav, sr=SR, mono=True)
    n = SR * WINDOW_S
    windows = [y[i:i + n] for i in range(0, max(len(y) - n + 1, 1), n)]
    windows = [np.pad(w, (0, n - len(w))) for w in windows]
    x = torch.from_numpy(np.stack(windows).astype(np.float32)).to(handle["device"])
    half = handle.get("dtype", "float32") != "float32"
    with torch.inference_mode(), torch.autocast(handle["device"], dtype=torch.float16, enabled=half):
        e = handle["model"].get_audio_embedding_from_data(x=x, use_tensor=True).float().cpu().numpy()
    e = e.mean(axis=0)
    return e / np.linalg.norm(e), len(windows)


def run(handle, inputs: dict) -> dict:
    """inputs: wav (path), prompts (list of text)."""
    import numpy as np
    import torch
    audio, windows = embed_audio(handle, inputs["wav"])
    with torch.inference_mode():
        text = handle["model"].get_text_embedding(inputs["prompts"], use_tensor=False)
    text = text / np.linalg.norm(text, axis=1, keepdims=True)
    return {"windows": windows, "similarity": {p: round(float(s), 4) for p, s in zip(inputs["prompts"], text @ audio)}}
