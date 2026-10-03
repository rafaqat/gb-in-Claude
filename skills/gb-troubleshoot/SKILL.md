---
name: gb-troubleshoot
description: Use when a gb-mcp tool returns status "failed" or "uncertain" (SCREEN_LOCKED, DIALOG_UNEXPECTED, TARGET_NOT_FOUND, TARGET_DISABLED, PERMISSION_*, GB_NOT_RUNNING, FILE_EXISTS, DEPENDENCY_MISSING, …) — the recovery for each code, without ever bypassing gb-mcp's safety rules.
version: 0.2.0
---

# gb-mcp troubleshooting

## First rules
- `status: "uncertain"`: an action was delivered but not confirmed. Run `gb_project status` (and for exports, look in the inbox `exports/`) **before** anything else.
- Never retry when `safe_to_retry` is false. Never click, type or use AppleScript in GarageBand yourself. Never delete or overwrite files.
- `gb_system doctor` diagnoses the environment (permissions, helper, GarageBand version, screen lock, analysis tools).

## Codes
| Code | Meaning | Do |
|---|---|---|
| SCREEN_LOCKED | the Mac is locked: GarageBand has no usable windows | ask the user to unlock, then retry; composing/analysis still work |
| DIALOG_UNEXPECTED | GarageBand shows a dialog gb-mcp will not answer | ask the user to answer it; then `gb_project status`; never press it |
| GB_NOT_RUNNING | GarageBand is closed | `gb_project open_midi` (or `open_band`) opens it with your song |
| NO_PROJECT_OPEN | only GarageBand's project chooser is showing | `gb_project open_midi` (or `open_band`) opens your song |
| DOCUMENT_ALREADY_OPEN | a project with that name is open, so GarageBand would not read the file again | ask the user to close it (saving it first if they want it), or build under a new filename |
| CONTENT_NOT_INSTALLED | the patch needs sound content that is not downloaded | pick an installed patch (`gb_sound patches`); downloading is the user's decision — tell them, never start it |
| NOT_FRONTMOST | macOS refused to bring GarageBand forward for a real click | ask the user to click GarageBand's window once, then retry |
| HIT_TEST_MISMATCH | something covers the target (popover, notification, other window) — nothing was clicked | ask the user to clear it, then retry |
| NOT_SUPPORTED | not possible in this state (e.g. `rewind` while playing; `db` before the fader taper is measured) | follow the hint (e.g. `gb_transport stop` first; use `raw`) |
| TARGET_NOT_FOUND | element not on screen — for exports: the inbox folder is not a save-panel recent place | export once by hand to the inbox via Where ▸ (or set `GB_MCP_EXPORT_INBOX`); UI targets: `gb_system ui_snapshot` |
| TARGET_DISABLED | control greyed out (panel still loading / needs input) | wait a moment; retry if `safe_to_retry` |
| TARGET_AMBIGUOUS / TARGET_CHANGED | several matches / UI changed mid-action | re-read state (`gb_system ui_snapshot`), retry; never guess by position |
| READBACK_MISMATCH | the value did not take — from `gb_project open_band`: GarageBand loaded the .band differently from the file | re-read; retry once if `safe_to_retry`. open_band: never retry — report `context.differences` to the user (the .band format guess is wrong for that donor) |
| MUTATION_IN_PROGRESS | another GarageBand action is running | wait, then retry |
| DEADLINE_EXCEEDED | GarageBand did not answer in time (busy or modal) | `gb_system ui_snapshot panel=dialog`; ask the user if a dialog is up |
| PERMISSION_AX_DENIED / PERMISSION_AUTOMATION_DENIED | macOS privacy permission missing | ask the user to grant it (doctor's `fix` has the exact Settings path) |
| HELPER_UNAVAILABLE / DEPENDENCY_MISSING | native helper / renderer / Python libs missing | `gb_system doctor`; user runs `npm run build:native` in gb-mcp |
| FILE_EXISTS | name already used (never overwritten) | pick a new filename (`-v2`) |
| PATH_INVALID / PATH_OUTSIDE_WORKSPACE / FILE_NOT_FOUND | bad or out-of-workspace path | workspace-relative paths only (e.g. `exports/x.wav`) |
| SONG_INVALID / VALIDATION_FAILED | Song JSON wrong / musically impossible | fix the field at `error.path` / each issue in `context.issues` (`gb://schema/song`) |
| AUDIO_INVALID | not a readable WAV/AIFF/FLAC (gb_band: not 16/24-bit PCM WAV) | export as WAVE; for gb_band convert the sample to 16- or 24-bit PCM WAV |
| DONOR_INVALID | the donor is not a project GarageBand 10.4.14 saved | ask the user for a donor saved by GarageBand (`gb://knowledge/band-files`); Logic Pro projects do not work |
| DONOR_TOO_SMALL | more audio items than the donor has audio regions | fewer items, or ask the user to add regions to the donor |
| TRACK_NOT_IN_DONOR | that track has no audio region in the donor | `gb_band inspect` the donor and use one of its audio tracks |
| MIDI_REGION_NOT_IN_DONOR | the donor has no MIDI region with that name | use a name from `context.donor_regions` |

## Export landed somewhere else?
`gb_export` moves a stray file from `~/Music/GarageBand` into the inbox and says `relocated_from`. If it reports the file there and could not move it, analyze it only after the user moves it into the workspace.
