// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/** Agent-facing guide to gb_band and gb_project open_band, served as gb://knowledge/band-files. Keep in sync with mcp/gb-band.ts. */
export const BAND_FILES_GUIDE = `# GarageBand project files (gb_band)

gb_band writes a GarageBand project (.band) directly. It is not limited to MIDI: it puts your WAV files
(samples, stems, vocals) on audio tracks and writes notes into MIDI regions.
The format is reverse-engineered for GarageBand 10.4.14. A GarageBand update can break it.
gb_project open_band finds that problem and reports READBACK_MISMATCH.

Workflow: gb_band inspect (donor) → gb_band build → gb_project open_band → gb_export song → gb_analyze.
From Song JSON: gb_song band_plan {song} returns the audio list for gb_band build (clips placed by section).

## Make a donor (once, in GarageBand, by a person)
gb_band cannot make new tracks. It fills the slots of a donor: a small project that GarageBand saved.
1. In GarageBand, make a new empty project. 4/4 only.
2. Add one audio track for each sample part. Drag a short WAV onto each audio track.
   Each audio region is one slot. Add more regions to a track for more samples on that track.
3. Add the software instrument tracks with the patches you want. Record or draw one short MIDI region
   on each track. Give each region a name (for example "Keys", "Bass").
4. Set the tempo.
5. Save the project into the workspace, for example donors/my-donor.band.
Logic Pro projects do not work as donors.

## inspect
gb_band inspect {path} → tempo, bars (song length), audio [{track, bar, beat, file, seconds}],
midi [{region, notes, bars}]. Use it on a donor to see its slots. Use it on a build to examine the result.

## build
{ donor, filename: "my-song-v1.band", audio: [...], midi?: [...], dry_run? } → bands/<filename>
audio item: { wav, bar (1-based), beat? (1–4.999, default 1), track (a donor audio track), name? }
- The donor must have at least one audio region for each item. gb_band removes the donor regions you do not use.
- The WAV must be 16- or 24-bit integer PCM inside the workspace. gb_band copies it into the project.
midi item: { region (a donor MIDI region name), notes (Song JSON note syntax), bars, velocity?, program? }
- Notes use the syntax of gb://knowledge/song-format, for example "d4 f#4 a4 d5 | a4@4".
- A MIDI region stays at its donor position. A region that you do not list keeps its donor notes.
The song length grows to the end of the last audio region (rounded up to a full bar).
It never becomes shorter than the donor.
gb_band never overwrites a file. Use a new filename for each version (-v2, -v3).

## Verify
gb_project open_band {path: "bands/my-song-v1.band"}:
1. It saves a copy of each unsaved project into sessions/.
2. It opens the file. It dismisses the save prompt only for a project that it backed up.
3. GarageBand saves its own copy of the loaded project into bands/readback/.
4. verified = that copy has the same tempo, length, audio regions and MIDI notes as the file.
Then export with gb_export song and listen with gb_analyze.

## Errors
DONOR_INVALID — the donor does not parse. Use a project that GarageBand 10.4.14 saved.
DONOR_TOO_SMALL — more audio items than the donor has audio regions. Add regions to the donor.
TRACK_NOT_IN_DONOR — the track has no audio region in the donor. gb_band inspect lists the tracks.
MIDI_REGION_NOT_IN_DONOR — the donor has no MIDI region with that name (context lists the names).
AUDIO_INVALID — the file is not a 16- or 24-bit PCM WAV.
DOCUMENT_ALREADY_OPEN — a project with this name is open in GarageBand. GarageBand would not read the file again.
  Close that project, or build with a new filename.
READBACK_MISMATCH — GarageBand loaded the file differently. context.differences lists each difference.
  Stop and report it: the format guess is wrong for this donor or this change.
`;
