---
name: listen
description: Use when the user asks what a GarageBand export sounds like, whether it is too loud/thin/bright/thumpy, or to check a mix — analyzes the audio with gb_analyze and explains it in plain words with the spectrogram.
version: 0.9.2
---

# Listen to an export (gb-mcp)

You cannot hear. Measure, look at the spectrogram, explain plainly, and let the user's ears decide.

1. The file must be inside the workspace (default `~/Music/gb-mcp`), as WAV/AIFF/FLAC. Exports from `gb_export` are in `exports/`.
2. With the Song JSON: `gb_analyze against_song {path, song}` (sections, tempo and key are checked against intent).
   Without: `gb_analyze audio {path}`. Keep responses small with `fields` (e.g. `["loudness","tonal_balance","drums","sections","flags","suggestions","spectrogram"]`).
3. Open the spectrogram PNG (`spectrogram` path) with your file-reading tool: low frequencies at the bottom, sections marked.
4. Explain in plain words, using `gb://knowledge/analysis`:
   - loudness: integrated LUFS (streaming ≈ −14, club ≈ −9…−7), true peak ≤ −1 dBTP
   - tone: low-end share (thin if < 0.2), tilt (bright/tinny above −2 dB/oct), centroid
   - drums: percussive ratio (forward?), kick hit share per section (thumpy?), kick band share (boomy?)
   - structure: section loudness, drop vs breakdown contrast, pump in the drop, tempo/key vs intent
5. Read `ml` too: the beat grid (does it sit on the song's tempo?), the key (exact / relative / other) and the genre ranking — a ranking among 47 genres, never a grade. If `ml.unavailable`, say the model sidecar is off and go on.
6. Two versions? `gb_analyze compare {before, after, song}` and report per-section deltas.

Thresholds are heuristics (calibrated on few examples): present them as "what to listen for", never as verdicts.
