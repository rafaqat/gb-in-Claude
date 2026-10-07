---
name: revise-track
description: Use when the user gives feedback on a gb-mcp track ("drums too forward", "tinny", "drop is weak", "too busy", "robotic", "boring") — maps it to Song JSON changes, re-renders, exports, analyzes and compares before/after honestly.
version: 0.9.3
---

# Revise a track from feedback (gb-mcp)

## 1. Start from the last version
Load the latest `<workspace>/songs/<slug>-vN.song.json` and know its export (`exports/<slug>-vN.wav`). If unsure which, ask.

## 2. Map the feedback to one or two changes (no more per version)
| The user says | Change in Song JSON | Flag that should move |
|---|---|---|
| drums too forward / too loud | drums track `level` −3…−6 dB; only one section? that part's grid `levels` | `drums_forward` |
| thumpy / boomy kick | grid `levels: {"kick": -6}`; `o` instead of `x` on weak beats; tighter kit via drums `program` | `thumpy_kick` |
| muddy / boomy low end | lower bass `level` or lift bass `octave` in that section | `low_end_heavy` |
| tinny / thin | bass part in the section, octave 1–2, fuller bass `program` (39) | `thin_low_end` |
| harsh / too bright | lead/arp `level` down or octave down, warmer patch | `bright_tilt` |
| drop is weak | add drums/bass/lead parts to the drop, or strip the breakdown | `weak_drop` |
| too busy | fewer tracks in the section, simpler grids/arp style | onset density |
| robotic / mechanical | `humanize: "natural"` or `"loose"`; vary parts between sections | — |
| boring / repetitive | different parts per section, multi-bar grids (`|`) with fills | — |
| clipping / distorted | lower the loudest tracks' `level` | `true_peak_over`, `clipping` |
Use `gb://knowledge/analysis` (flags table) and the current analysis' `suggestions[].path` to target the exact track/section.

## 3. New version, same loop
Save `<workspace>/songs/<slug>-v(N+1).song.json`, then: `gb_song validate` → `gb_song render_midi {filename: "<slug>-v(N+1).mid"}` → `gb_project open_midi` → `gb_export song {filename: "<slug>-v(N+1).wav"}` → `gb_analyze against_song`.

## 3b. Quick A/B without re-rendering (levels, pan, patch)
For a level/pan/patch question the open project can answer faster: `gb_mix set_volume` / `set_pan` or `gb_tracks set_instrument` (each `dry_run: true` first) → `gb_export song {filename: "<slug>-vN-ab.wav"}` → `gb_analyze compare`. Keep what wins by writing it into the Song JSON (`level`, `program`) — GarageBand-only changes vanish at the next `open_midi`. Velocity `levels` (Song JSON) also change timbre on sampled instruments; a fader does not.

## 4. Compare and report honestly
- `gb_analyze compare {before: "exports/<slug>-vN.wav", after: "exports/<slug>-v(N+1).wav", song}`.
- Report the per-section deltas that match the feedback (e.g. `percussive_ratio_db_delta`, `kick_hit_share_delta`, `delta_lu`) — not just the verdict. `unchanged` with big metric moves is possible: say so.
- If the numbers improved but the user still hears the problem, the ears win: ask what exactly they hear, then iterate.
- If a flag contradicts the user ("bright_tilt" but they like it bright), keep their taste and say the flag is a heuristic.

## Guardrails
New filenames every version; never overwrite or delete. `uncertain` → `gb_project status` first; never retry when `safe_to_retry` is false. Errors → `gb-troubleshoot`.
