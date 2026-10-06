// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/** gb://knowledge/generate — how to use gb_generate (M12b): engines, steps, times, licences, install. */
export const GENERATE_GUIDE = `# gb_generate — vocals and music from AI engines

gb_generate makes audio that MIDI cannot: sung vocals, or a full re-recording of your song. It runs on this Mac
(Apple Silicon) and has two engines. Each generation is a **job**: \`start\` returns at once, then you poll \`status\`.

## Choose the engine

| | ace_step (ACE-Step 1.5) | mulacover (MuLaCover) |
|---|---|---|
| Tasks | \`cover\`: re-sing / re-play a song export to a caption and lyrics. \`text\`: music from a caption, bpm, key, length. \`repaint\`: regenerate \`start\`..\`end\` seconds of a song, keep the rest | \`cover\`: sing lyrics on the song's own melody, chords and drums (from its MIDI) |
| Melody | follows the source melody weakly (strength ≥ 0.7) | reads the melody as MIDI |
| Tempo | keeps the source tempo (cover); bpm is a request (text) | chooses its own tempo: gb_generate re-times the result to the song (see below) |
| Time (M4 Air, warm) | cover ≈ the song's length; text 30 s ≈ 50–100 s | 30 s ≈ 2–2.5 min; at most 300 s per job |
| Licence | MIT: outputs usable commercially | weights AND outputs CC BY-NC 4.0: **non-commercial** only |

One generation runs at a time (ENGINE_BUSY otherwise). Starting one engine closes the other: each needs about 14 GB.

## Write the caption and the lyrics

Before you write them, call \`gb_generate examples {query: "<the user's request>"}\`: it returns ACE-Step's own example
songs that fit the request best (caption, lyrics, bpm, key, length, language). Write in their style and structure;
write new words. ACE-Step reads about 256 tokens of the caption (≈ 1000 characters of English).

- **Caption — one paragraph, in this order:** genre and mood; the instruments and how they play; the voice (gender,
  timbre, range, delivery); the arrangement (builds, solos, breaks); the production and the overall mood. The words
  for each of gb-mcp's 47 genres (instruments, voice, production, tempo): gb://knowledge/genres.
- **Lyrics — one [Section] tag per line**, a blank line between sections: [Intro], [Verse 1], [Pre-Chorus], [Chorus],
  [Bridge], [Outro], [Build-Up], [Drop]. A tag may direct the part: [Intro - Guitar Riff], [Verse 1 - Female],
  [Chorus - Both], [Instrumental Break: Saxophone Solo], [whispered]. A part with no voice: [Verse 2 - Instrumental].
  Ad-libs are plain lines (Mm hmm). Mixed languages: a language tag such as [en] or [ja] before the lines.
- **MuLaCover:** the same lyrics format; style goes into tags as \`genre:[…]; instrument:[…]; mood:[…]\`.

Three of ACE-Step's examples (examples from ACE-Step 1.5 — github.com/ace-step/ACE-Step-1.5 — MIT licence, Copyright (c) 2026 ACEStep):

**example_76** — bpm 92, Ab major, 218 s, en

caption: A groovy neo-soul track with warm Wurlitzer keys, tight pocket drums, and silky female vocals. Features rich harmonies, subtle guitar licks, and a head-nodding groove that blends classic soul with modern production.

\`\`\`
[Intro]

[Verse 1]
Sunday morning golden light
You stayed over through the night
Coffee brewing records spin
This is where our love begins

[Pre-Chorus]
No rush no hurry
No stress no worry

[Chorus]
Easy like a Sunday morning
Love without a warning
You and me we flow so free
Easy like it's meant to be
…
\`\`\`

**example_54** — bpm 128, F minor, 210 s, en

caption: A high-energy EDM festival anthem with massive synth drops, pounding four-on-the-floor kicks, and euphoric build-ups. Features pitched vocal chops, soaring lead synths, and an explosive drop that commands the dancefloor.

\`\`\`
[Intro]

[Verse 1]
We came to light up the night
Hands up reaching for the sky
Feel the bass running through your veins
Let go of all your fears and pain

[Build-Up]
Can you feel it rising
The moment is now
We're all together
Scream it out loud

[Drop]
We are the fire
Burning so bright
We are the dreamers
Owning the night
Let the music take control
Feel it deep within your soul

[Verse 2]
Strangers become family here
United by the sound we hear
This moment will live forever more
This is what we're living for
…
\`\`\`

**example_66** — bpm 66, F major, 203 s, en

caption: A romantic duet ballad with lush orchestral strings, grand piano, and intertwining male and female vocals. The arrangement builds from intimate verses to a sweeping cinematic chorus, capturing the timeless essence of love.

\`\`\`
[Intro]

[Verse 1 - Female]
I never knew what love could be
Until you came and rescued me
In your eyes I found my home
Never have to be alone

[Verse 2 - Male]
You're the answer to my prayer
The one I searched for everywhere
Now that I have found you here
I'll hold you close and keep you near

[Chorus - Both]
Forever starts tonight
Two hearts become one light
Through every storm we'll find our way
I promise you I'll stay
Forever starts tonight
…
\`\`\`

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
3. Re-time to the song. MuLaCover chooses its own tempo (measured: 116–124 BPM for a 132 BPM song), so gb_generate
   re-times its result for you. When the result's tempo differs from the song's by more than 2 %, gb_generate writes a
   new file next to it, \`gen/vocals-v1-132bpm.wav\` (Rubber Band, 24-bit, 44.1 kHz), checks its length and measures
   its tempo: \`result.retimed\` = {path, bpm, from_bpm, to_bpm, seconds}. Use that file from here on. The original
   stays unchanged. \`retime: false\` keeps only the original. When gb_generate does not re-time (retime: false, a
   taken name, Rubber Band missing, no clear beat), the job is still done and a warning gives the exact call, e.g.
   \`gb_stem prepare {path: "gen/vocals-v1.wav", filename: …, to_bpm: 132, from_bpm: 115.38}\`. ACE-Step keeps the
   source tempo; when its result is off the song's tempo, the same warning gives the call.
4. Separate the vocals: \`gb_stem separate {path: "gen/vocals-v1-132bpm.wav", model: "roformer"}\` →
   \`stems/vocals-v1-132bpm-vocals.wav\`, at the song's tempo.
   \`model: "roformer"\` (\`./scripts/install-engines.sh roformer\`, 0.9 GB) leaves much less band in the vocal than the
   default htdemucs (vocal SDR 18.8 dB against 12.7 on a mix with known stems), at about 7× the time (35 s for 1 minute).
5. Place it: \`gb_tracks add_audio\`, \`gb_project save_copy\`, \`gb_band build\` (see gb://knowledge/band-files), then
   \`gb_project open_band\` and \`gb_export song\` to hear it.

## MIDI parts next to a generated song (gb_analyze map)

A generated song is not machine-timed: free intros, 2-beat bars, sometimes a tempo that drifts. Map it first:
\`gb_analyze map {path: "gen/song.wav"}\` (it separates the stems if needed) returns:
- \`bpm\`, \`steady\`: the grid. Not steady (a take that speeds up)? The map gives \`tempo_map\`: put
  \`tempo: tempo_map[0].bpm\` and \`tempoMap: tempo_map[1..]\` into the guide Song JSON — GarageBand's bar lines then
  follow the band, and the stems play unchanged (GarageBand does not stretch audio regions to a tempo map).
- \`place\`: \`{guide_bpm, bar: 1, beat}\` — make the project at guide_bpm and put the stems at that bar and beat
  (gb_band build); then the song's downbeats fall on GarageBand bar lines.
- \`chords\`: one entry per GarageBand bar, "D" or "D G" (two halves), "-" before the song's first bar — a Song JSON
  pad or bass part can copy it (start the part after the "-" bars).
- \`voice\`: 8 eighth-note slots per bar ('#' sung, '.' rest); \`gaps\`: rests inside sung passages — places for an
  answering line. \`melody_bars\`: bars where the song already has a high melody (keep a new lead out of them).
- \`irregular\`: the song's own bars of 2, 3 or 5 beats. Around them the GarageBand bar lines sit half a bar off the
  music; chords per half bar still sound right.
- \`sections\` (when \`./scripts/install-engines.sh sections\` is installed): [{name, gb_bar, bars}] — intro, verse 1,
  chorus… on GarageBand bars, from all-in-one (a model trained on the Harmonix Set; it has no pre-chorus label and often
  splits a long verse in two). Measured on a generated song: 5 of 9 sung section starts within 3 s; labels in order.
  Without it the map says how to add it.
The full map (every bar) is in \`analysis/<name>-map.json\`.

One call for a project from a recording: \`gb_project from_audio {path: "gen/song.wav", filename: "song-v1.band"}\` —
map, a muted guide at the song's tempo (with the tempo map when the take drifts), the four stems on audio tracks at the
map's bar and beat, opened in GarageBand. Then add MIDI parts with gb_band build (midi regions) or export it.
A Song JSON that plays like the recording (to edit, re-arrange and render): \`gb_song transcribe {path: "gen/song.wav",
filename: "song-v1.song.json"}\` — tempo, key, sections, chords, bass, lead and drums on the same bars (see
gb://knowledge/song-format, "From a recording").

## Change one part of a generated song (ace_step repaint)

\`gb_generate start {engine: "ace_step", task: "repaint", src: "gen/song.wav", start: 200, end: 230, caption: "…a quiet
bridge, voice and organ…", lyrics: "<the song's full lyrics, with the new words for that part>", mode: "balanced",
filename: "song-v2.wav"}\` — about 2–3 min for a 5-minute song. Outside start..end the song stays the same; the result
comes back at the source's level (\`repaint.level_matched\`; false when a peak would pass −0.1 dBFS). \`mode\`:
conservative keeps more of the source, aggressive less; \`end: -1\` repaints to the end (a new outro). Use the map
(\`gb_analyze map\`) to find the seconds of a section.

## Add an instrument to a generated song (ace_step lego, complete)

These two tasks need ACE-Step's base model, a second download: \`./scripts/install-engines.sh ace-step-base\` (4.8 GB,
MIT, a pinned revision). They are slower than turbo: 32 steps.
- \`lego\`: one new track over a range — \`{engine: "ace_step", task: "lego", src: "gen/song.wav", track: "woodwinds",
  start: 30, end: 90, caption: "…tin whistle answers the voice…", filename: "song-whistle.wav"}\`. The model reads the
  range plus 10 s on each side. The result is the new track alone, at its place in a song-length WAV (silence outside
  start..end): put it on its own audio track at bar 1, next to the song or its stems (gb_band build). About 4 min
  for a 60 s range.
- \`complete\`: a lone track (for example a sung vocal) gets the band around it — \`tracks: ["drums", "bass", "guitar"]\`.
  The result is the full mix. Live, its low end came out heavy: check it with gb_analyze.
- track names: woodwinds, brass, fx, synth, strings, percussion, keyboard, guitar, bass, drums, backing_vocals, vocals.

## Write lyrics that fit

- Section markers on their own lines: [Intro], [Verse], [Chorus], [Bridge], [Outro]; a blank line between sections.
- MuLaCover: about one syllable per melody note in the range you give. Too few syllables and the singer improvises.
- ACE-Step: \`lyrics: "[Instrumental]"\` (the default) gives no vocals.

## Inputs and limits

- Paths are relative to the workspace; outputs go to \`gen/<filename>\`; nothing is ever overwritten.
- ace_step: caption ≤ 1000 characters; lyrics ≤ 4096; strength 0–1 (cover default 0.7: higher keeps more of the source; repaint 0.5);
  text needs \`duration\` (10–600 s); bpm 30–300; key such as "E minor"; \`thinking: false\` skips the LM (faster).
- mulacover: tags ≤ 512 characters as \`name:[values]; …\`; a range longer than 300 s is refused (use start_bar, bars).
  \`retime\` (default true): re-time the result to the song (step 3).
- MuLaCover stops at the range's length + 2 s. When it sings slower than the song, the end of the range can be missing:
  a warning gives the result's length at the song's tempo and about how many bars are missing. Then generate the last
  bars again (start_bar, bars) or choose a shorter range.
- \`dry_run: true\` checks the inputs and shows the plan and an estimated time; nothing runs.
- Jobs are kept in \`gen/jobs/<job>.json\`; \`gb_generate list\` shows them. A job whose server stopped is \`interrupted\`.

## Install (once, ~31 GB)

Run \`./scripts/install-engines.sh ace-step\`, \`ace-step-base\`, \`mulacover\`, \`roformer\`, \`sections\` or \`all\` from the gb-mcp folder (Apple Silicon; needs git
and uv). Per engine it clones the code at the reviewed commit, creates the engine's own venv, and downloads the
reviewed weights; it is safe to re-run (an interrupted download resumes). \`--dry-run\` shows the plan. MuLaCover asks
you to accept its non-commercial licence first (\`--accept-noncommercial\` for scripts). Then restart Claude Code.

| Engine | Code (commit) | Weights (revision) | Size |
|---|---|---|---|
| ACE-Step 1.5 (MIT) | github.com/ace-step/ACE-Step-1.5 @ ca1e85f | ACE-Step/Ace-Step1.5 @ 19671f4 | 10 GB |
| ACE-Step base model, for lego / complete (MIT) | (the same code and venv) | ACE-Step/acestep-v15-base @ e432212 | 4.8 GB |
| all-in-one sections for gb_analyze map (MIT) | none: allin1 1.1.0 from PyPI, madmom @ 27f032e; NATTEN replaced by gb-mcp's natten_mps | taejunkim/allinone @ 379e5fd | 0.1 GB |
| RoFormer vocal separation for gb_stem (MIT) | none: audio-separator 0.47.0 from PyPI | KimberleyJSN/melbandroformer @ ac9b061 (sha256-checked) | 0.9 GB |
| MuLaCover (code Apache-2.0; weights CC BY-NC 4.0) | github.com/HeartMuLa/MuLaCover @ f01810c | HeartMuLa/MuLaCover @ bbbaef2, HeartMuLa/HeartCodec-oss-20260123 @ f889dab, Qwen/Qwen3-Embedding-0.6B @ 97b0c61 | 15 GB |

The engines live in ~/Library/Caches/gb-mcp (GB_MCP_ENGINE_HOME moves them). gb-mcp refuses another commit or a
changed checkout. MuLaCover's token generator runs on gb-mcp's MLX port (models/mulacover_mlx).

Attribution (required by MuLaCover's licence): MuLaCover by MuLa Labs — https://github.com/HeartMuLa/MuLaCover.

Without an engine, gb_generate answers DEPENDENCY_MISSING for it; everything else in gb-mcp works.
`;
