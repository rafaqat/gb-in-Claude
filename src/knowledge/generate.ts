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

## Write the caption and the lyrics

Before you write them, call \`gb_generate examples {query: "<the user's request>"}\`: it returns ACE-Step's own example
songs that fit the request best (caption, lyrics, bpm, key, length, language). Write in their style and structure;
write new words. ACE-Step reads about 256 tokens of the caption (≈ 1000 characters of English).

- **Caption — one paragraph, in this order:** genre and mood; the instruments and how they play; the voice (gender,
  timbre, range, delivery); the arrangement (builds, solos, breaks); the production and the overall mood.
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
