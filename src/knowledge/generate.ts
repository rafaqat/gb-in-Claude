// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/** gb://knowledge/generate — how to use gb_generate (M12b): engines, steps, times, licences, install. */
export const GENERATE_GUIDE = `# gb_generate — vocals and music from AI engines

gb_generate makes audio that MIDI cannot: sung vocals, or a full re-recording of your song. It runs on this Mac
(Apple Silicon) and has two engines. Each generation is a **job**: \`start\` returns at once, then you poll \`status\`.

## Choose the engine

| | ace_step (ACE-Step 1.5) | mulacover (MuLaCover) |
|---|---|---|
| Tasks | \`cover\`: re-sing / re-play a song export to a caption and lyrics. \`text\`: music from a caption, bpm, key, length | \`cover\`: sing lyrics on the song's own melody, chords and drums (from its MIDI) |
| Melody | follows the source melody weakly (strength ≥ 0.7) | reads the melody as MIDI |
| Tempo | keeps the source tempo (cover); bpm is a request (text) | chooses its own tempo: re-time the result (see below) |
| Time (M4 Air, warm) | cover ≈ the song's length; text 30 s ≈ 50–100 s | 30 s ≈ 2–2.5 min; at most 300 s per job |
| Licence | MIT: outputs usable commercially | weights AND outputs CC BY-NC 4.0: **non-commercial** only |

One generation runs at a time (ENGINE_BUSY otherwise). Starting one engine closes the other: each needs about 14 GB.

## Steps: a sung part next to your MIDI song

1. Make the inputs.
   - ace_step cover: export the song (\`gb_export song\`), then \`gb_generate start {engine: "ace_step", task: "cover",
     src: "exports/song.wav", caption: "film song, female vocals, strings", lyrics: "[Verse]\\n…", strength: 0.7,
     filename: "cover-v1.wav"}\`.
   - mulacover: render the song (\`gb_song render_midi\`), then \`gb_generate start {engine: "mulacover", task: "cover",
     midi: "song.mid", melody: ["Bansuri", "Violins"], chords: ["Pad", "Bass"], drums: ["Drums"], start_bar: 5, bars: 16,
     lyrics: "[Verse]\\n…", tags: "genre:[film song]; instrument:[bansuri,strings]; mood:[warm]", filename: "vocals-v1.wav"}\`.
     \`melody\` may name several tracks (a melody that moves between instruments). \`chords\` become one block chord per bar.
2. Poll \`gb_generate status {job}\` every \`poll_after_s\` seconds until \`state\` is \`done\` (or \`failed\`).
   A done job gives \`result\`: path, seconds, rate, bits, measured \`bpm\` and \`key\`.
3. Separate the vocals: \`gb_stem separate {path: "gen/vocals-v1.wav"}\` → \`stems/vocals-v1-vocals.wav\`.
4. Re-time to the song: the status warning gives the exact call, e.g. \`gb_stem prepare {path: …, filename: …,
   to_bpm: 132, from_bpm: 115.38}\`.
5. Place it: \`gb_tracks add_audio\`, \`gb_project save_copy\`, \`gb_band build\` (see gb://knowledge/band-files), then
   \`gb_project open_band\` and \`gb_export song\` to hear it.

## Write lyrics that fit

- Section markers on their own lines: [Intro], [Verse], [Chorus], [Bridge], [Outro]; a blank line between sections.
- MuLaCover: about one syllable per melody note in the range you give. Too few syllables and the singer improvises.
- ACE-Step: \`lyrics: "[Instrumental]"\` (the default) gives no vocals.

## Inputs and limits

- Paths are relative to the workspace; outputs go to \`gen/<filename>\`; nothing is ever overwritten.
- ace_step: caption ≤ 512 characters; lyrics ≤ 4096; strength 0–1 (default 0.7; higher keeps more of the source);
  text needs \`duration\` (10–600 s); bpm 30–300; key such as "E minor"; \`thinking: false\` skips the LM (faster).
- mulacover: tags ≤ 512 characters as \`name:[values]; …\`; a range longer than 300 s is refused (use start_bar, bars).
- \`dry_run: true\` checks the inputs and shows the plan and an estimated time; nothing runs.
- Jobs are kept in \`gen/jobs/<job>.json\`; \`gb_generate list\` shows them. A job whose server stopped is \`interrupted\`.

## Install (once, ~26 GB)

Run \`./scripts/install-engines.sh ace-step\`, \`mulacover\` or \`all\` from the gb-mcp folder (Apple Silicon; needs git
and uv). Per engine it clones the code at the reviewed commit, creates the engine's own venv, and downloads the
reviewed weights; it is safe to re-run (an interrupted download resumes). \`--dry-run\` shows the plan. MuLaCover asks
you to accept its non-commercial licence first (\`--accept-noncommercial\` for scripts). Then restart Claude Code.

| Engine | Code (commit) | Weights (revision) | Size |
|---|---|---|---|
| ACE-Step 1.5 (MIT) | github.com/ace-step/ACE-Step-1.5 @ ca1e85f | ACE-Step/Ace-Step1.5 @ 19671f4 | 10 GB |
| MuLaCover (code Apache-2.0; weights CC BY-NC 4.0) | github.com/HeartMuLa/MuLaCover @ f01810c | HeartMuLa/MuLaCover @ bbbaef2, HeartMuLa/HeartCodec-oss-20260123 @ f889dab, Qwen/Qwen3-Embedding-0.6B @ 97b0c61 | 15 GB |

The engines live in ~/Library/Caches/gb-mcp (GB_MCP_ENGINE_HOME moves them). gb-mcp refuses another commit or a
changed checkout. MuLaCover's token generator runs on gb-mcp's MLX port (models/mulacover_mlx).

Attribution (required by MuLaCover's licence): MuLaCover by MuLa Labs — https://github.com/HeartMuLa/MuLaCover.

Without an engine, gb_generate answers DEPENDENCY_MISSING for it; everything else in gb-mcp works.
`;
