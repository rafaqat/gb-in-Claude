# gb-mcp — GarageBand for Claude Code

An [MCP](https://modelcontextprotocol.io) server that lets **Claude Code** make music in **GarageBand** on macOS:
compose a song as JSON, render it to MIDI, open it in GarageBand, change tracks, instruments, transport and mix,
export a WAV, and "listen" to the result (loudness, tone, drums, tempo, key, a spectrogram) — then revise.

- **No API key.** Claude Code is the composer; gb-mcp is its hands and ears.
- **Verified, not hoped.** Every GarageBand action is read back. A result is `verified`, `uncertain` (delivered but
  not confirmed — check before retrying) or `failed` (nothing happened, with a hint).
- **Sung vocals (optional).** `gb_generate` makes vocals and music with two AI engines on your Mac — ACE-Step 1.5
  and MuLaCover (non-commercial outputs) — and gb-mcp places them next to your MIDI tracks in GarageBand.
- **Safe by default.** It never overwrites or deletes files, backs up unsaved projects before replacing them, never
  answers a dialog it did not open, never starts a content download, and only borrows the keyboard focus for a click
  while you pause typing.

> Not affiliated with Apple. GarageBand is a trademark of Apple Inc.

## Listen

Three versions of *Twinkle, Twinkle, Little Star*. Claude Code wrote each one as Song JSON, GarageBand's own
instruments play it through gb-mcp, and `gb_analyze` checked every export. They are pastiches in each composer's
style, not affiliated with the composers.

GitHub starts each player muted: turn the sound on in the player.

### In the style of John Williams

Celesta and harp magic, a brass fanfare, a march, then a jump up to E♭ for the finale.

https://github.com/user-attachments/assets/bd76db5a-bce2-4683-864b-7b516084aec5

[▶ Listen (MP3)](media/twinkle-williams.mp3) · [Song JSON](examples/twinkle-williams.song.json)

### In the style of Hans Zimmer

A ticking ostinato, brass "braams", and a storm in D minor that breaks into D major.

https://github.com/user-attachments/assets/0f1adb5a-aa1d-4645-8ae6-9de8a9cd78f1

[▶ Listen (MP3)](media/twinkle-zimmer.mp3) · [Song JSON](examples/twinkle-zimmer.song.json)

### In the style of J. S. Bach

A toccata flourish, then a three-voice fugue on the tune for pipe organ, ending on a D-major chord.

https://github.com/user-attachments/assets/4b70c3b3-0a6a-4c90-86cb-a91b52e067ef

[▶ Listen (MP3)](media/twinkle-bach.mp3) · [Song JSON](examples/twinkle-bach.song.json)

The Williams celesta is GarageBand's Toy Celesta, loaded with `gb_tracks set_instrument`; the Song JSON alone
gives the General MIDI celesta.

## Requirements

| | |
|---|---|
| macOS | 14 Sonoma or later |
| GarageBand | 10.4 (tested with 10.4.14) — free on the App Store |
| Node.js | 22.13 or later (`brew install node`) |
| Swift | Xcode or the Command Line Tools (`xcode-select --install`) — builds two small native helpers |
| Python | 3.10 or later (`brew install python`) — for audio analysis |
| Rubber Band | optional — `gb_stem prepare` uses it to stretch tonal stems (`brew install rubberband`) |
| AI engines | optional — `gb_generate`: Apple Silicon, ~26 GB of disk, [uv](https://docs.astral.sh/uv/) (`brew install uv`); see below |
| Claude Code | [installed](https://docs.claude.com/en/docs/claude-code) and signed in |

## Install

### Option A — the install script

```bash
git clone https://github.com/rafaqat/gb-in-Claude.git
cd gb-in-Claude
./scripts/install.sh            # or first: ./scripts/install.sh --dry-run
```

The script:

1. checks the requirements above;
2. installs the Node dependencies (`npm ci`);
3. builds the native helpers (`npm run build:native` → `native/bin/gb-helper` and `native/bin/gm-render`);
4. creates a Python virtual environment in `.venv` with numpy, scipy, soundfile and matplotlib;
5. creates the workspace `~/Music/gb-mcp` (set `GB_MCP_WORKSPACE` to choose another folder);
6. registers the server with Claude Code (`claude mcp add gb-mcp -s user …`; set `GB_MCP_SCOPE=project` for one
   project only);
7. copies the four skills into `~/.claude/skills/` (an existing, different copy is left alone).

Options: `--dry-run` (print, change nothing), `--no-register`, `--no-skills`, and `--with-models` for the optional
AI models (see [Optional: AI models](#optional-ai-models-apple-silicon)).

### Option B — let Claude Code install it

```bash
cd gb-in-Claude
claude
```

then type `/setup-gb-mcp`. Claude runs the script, explains anything missing, and checks the result with the doctor.

### Option C — by hand

```bash
npm ci
npm run build:native
python3 -m venv .venv && .venv/bin/python3 -m pip install -r analysis/requirements.txt
mkdir -p ~/Music/gb-mcp/exports
claude mcp add gb-mcp -s user \
  -e GB_MCP_WORKSPACE="$HOME/Music/gb-mcp" -e GB_MCP_PYTHON="$PWD/.venv/bin/python3" \
  -- "$PWD/node_modules/.bin/tsx" "$PWD/src/index.ts"
cp -R skills/* ~/.claude/skills/
```

**Restart Claude Code** after installing so it loads the server (`/mcp` lists it).

## One-time macOS and GarageBand setup

1. **Accessibility** — gb-mcp reads and operates GarageBand through the macOS Accessibility API. Allow the app you run
   Claude Code in: *System Settings ▸ Privacy & Security ▸ Accessibility* ▸ enable **Terminal** (or iTerm2,
   Ghostty, VS Code, Cursor, the Claude app …). macOS grants it to the app that starts the server, so if you switch
   apps, allow that one too.
2. **Automation** — the first time gb-mcp lists or backs up GarageBand projects, macOS asks *"… wants to control
   GarageBand"*. Click **Allow**. (Change it later under *Privacy & Security ▸ Automation*.)
3. **The export folder** — gb-mcp chooses the export destination from the save panel's recent places and never
   browses the file list. Do this once: open any project in GarageBand, *Share ▸ Export Song to Disk… ▸ Where ▸
   Other…*, pick `~/Music/gb-mcp/exports`, export.
4. **Check** — in Claude Code say **"run the gb-mcp doctor"**. Every ✗ comes with the fix.

Not needed: Screen Recording, Full Disk Access, the microphone.

While gb-mcp works: keep the Mac unlocked (a locked screen leaves GarageBand without windows — gb-mcp stops with
`SCREEN_LOCKED`), and leave GarageBand's dialogs to gb-mcp only when it opened them.

## Claude Code settings (optional)

**Allow the tools without a prompt each time** — add to `~/.claude/settings.json` (or a project's
`.claude/settings.json`):

```json
{
  "permissions": {
    "allow": ["mcp__gb-mcp"]
  }
}
```

Use `"mcp__gb-mcp__gb_song"`, `"mcp__gb-mcp__gb_analyze"` … to allow single tools instead.

**Environment** (set with `-e` when registering; the install script sets the first and last):

| Variable | Default | Meaning |
|---|---|---|
| `GB_MCP_WORKSPACE` | `~/Music/gb-mcp` | Where songs, MIDI files, exports, spectrograms and project backups go. Tools only read and write inside it. |
| `GB_MCP_EXPORT_INBOX` | `exports` | The export folder, relative to the workspace (must be a save-panel recent place — see setup step 3). |
| `GB_MCP_PYTHON` | `python3` | The Python used for analysis (the script points it at `.venv`). |

## Use it

Talk to Claude Code:

| You want | Say |
|---|---|
| A new track | *Make a dreamy ambient track in D minor at 100 BPM, about 3 minutes* |
| An arrangement | *Open examples/twinkle-epic.song.json, render it and open it in GarageBand* |
| A revision | *The drums are too loud in the intro — fix it and compare with the last version* |
| Mixing | *Turn the strings down 3 dB and pan the horns a little left* |
| Instruments | *Put Liverpool Bass on the bass track* (installed sounds only) |
| Playback | *Play it* · *Stop* · *Set the tempo to 124* · *Metronome off* |
| Listening | *Export it and tell me how it sounds* |
| A check-up | *Run the gb-mcp doctor* |
| Your own audio | *Put vocals.wav on bar 9 and the drum loop from bar 1, using my donor project* (see below) |
| A song with vocals | *Write a warm acoustic folk song with a female voice about an old lighthouse keeper. Make it a WAV and a GarageBand project made from its stems* |
| Another take | *Make another take with a different seed and tell me how the two differ in tempo and key* |
| Stems | *Split exports/demo.wav into vocals, drums, bass and other, and put the vocals next to my song from bar 5* |

More sample prompts, by task: [examples/prompts.md](examples/prompts.md).

### Tools

| Tool | Commands | Touches GarageBand |
|---|---|---|
| `gb_song` | validate · preview · render_midi · render_draft · band_plan · template · infill | no — writes files to the workspace |
| `gb_band` | inspect · build | no — writes a GarageBand project (.band) with your WAVs and MIDI notes |
| `gb_analyze` | audio · against_song · compare (+ field `ml` with the optional models) | no — reads audio, writes spectrogram PNGs |
| `gb_stem` | inspect · prepare · separate | no — reads outside audio, writes placeable stems (needs the optional models) |
| `gb_generate` | start · status · list | no — sung covers and music from AI engines as background jobs (needs an engine) |
| `gb_sound` | patches · plugins · loops · samples · palette | no — read-only catalog of what this Mac can play |
| `gb_system` | doctor · describe · ui_snapshot | read-only |
| `gb_project` | status · open_midi · open_band · save_copy | opens a song (unsaved projects are backed up first) and verifies the NEW document once its window shows the tempo and the tracks; save_copy writes a donor copy |
| `gb_tracks` | list · select · mute · solo · set_instrument · add_audio | yes — add_audio refuses while playback runs (GarageBand disables New Tracks… then) and names only the new tracks |
| `gb_transport` | state · play · stop · rewind · set_tempo · set_metronome · set_count_in | yes |
| `gb_mix` | get · set_volume (raw or dB) · set_pan | yes |
| `gb_export` | song (WAVE) | yes — exports into the workspace, never overwrites; switches the metronome off for the export (GarageBand would render its click into the file) and back on after it |

Every changing command accepts `dry_run: true` (plan only); every reading command accepts `fields` (return less).
Inputs are strict: a misspelled parameter is rejected before anything runs.

Resources: `gb://knowledge/song-format` (read first), `gb://knowledge/analysis`, `gb://knowledge/production`,
`gb://knowledge/styles`, `gb://knowledge/gm-patch-map`, `gb://knowledge/band-files`, `gb://knowledge/generate`, and the JSON Schemas `gb://schema/song` and
`gb://schema/tools`.

### The workspace

```
~/Music/gb-mcp/
├── songs/       Song JSON (each version a new file: name-v1, name-v2 …)
├── *.mid        rendered MIDI files
├── exports/     WAV exports from GarageBand
├── analysis/    spectrogram pictures
├── bands/      GarageBand projects written by gb_band (readback/ holds GarageBand's own check copies)
├── donors/     copies of open projects (gb_project save_copy), used as gb_band donors
├── stems/      placeable stems from gb_stem (24-bit PCM)
├── gen/        audio from gb_generate (gen/jobs/ keeps each job)
└── sessions/    automatic backups of unsaved GarageBand projects (.band)
```

### Audio: samples, stems and vocals

MIDI cannot carry audio, so `gb_band` writes a GarageBand project file directly. It fills the slots of a
**donor**: a small project you save once in GarageBand with the audio tracks (one region each) and named MIDI
regions you need. `gb_band inspect` shows a donor's slots; `gb_band build` places your 16/24-bit PCM WAVs at any bar
and beat and writes new MIDI notes; `gb_project open_band` opens the result and checks it against the copy GarageBand
saves itself. In Song JSON, a track can carry `donorTrack` and `audio` clips placed per section; `gb_song band_plan`
turns them into `gb_band build`'s audio list. The details are in `gb://knowledge/band-files`. The project format is
GarageBand 10.4.14's and is not documented by Apple: a GarageBand update can break `gb_band` until it is re-probed.

**Stems next to your MIDI song — no hand-made donor.** Any audio track of a project now takes stems: `gb_band build`
adds the region slots it needs. With the optional models:

1. `gb_stem inspect` — format, length, tempo, key, percussive or tonal; `gb_stem separate` — vocals / drums / bass /
   other (Demucs); `gb_stem prepare {to_bpm, from_bpm?, semitones?}` — a placeable 24-bit stem at the song's tempo
   (drums re-timed stroke by stroke, tonal parts stretched with Rubber Band), checked by measuring its tempo.
2. `gb_project open_midi` your song, then `gb_tracks add_audio {count}` — new empty audio tracks.
3. `gb_project save_copy {filename}` — the project as a donor in `donors/`, with its tracks listed.
4. `gb_band build {donor, audio: [{wav, bar, track}]}` — the stems on the audio tracks, the MIDI parts kept.
5. `gb_project open_band` — open it and check GarageBand's own copy; `gb_export song` to hear it.

The format facts behind this are in `eval/m11b/BAND-FORMAT.md`; the live end-to-end check is `eval/m11b`.

Song JSON is described in `gb://knowledge/song-format`; `examples/twinkle-epic.song.json` shows most of it
(sections, drum grids, chord parts, melodies, levels).

### Generated vocals and music: gb_generate (optional engines)

MIDI cannot sing. `gb_generate` runs two AI engines on your Mac (Apple Silicon) and gives you a checked WAV:

| Engine | Tasks | Melody | Time (M4 Air) | Licence |
|---|---|---|---|---|
| `ace_step` — [ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5) | `cover`: re-sing / re-play a song export to a caption and lyrics; `text`: music from a caption, bpm, key, length | follows the source melody loosely | cover ≈ the song's length | MIT |
| `mulacover` — [MuLaCover](https://github.com/HeartMuLa/MuLaCover) | `cover`: sing lyrics on the song's own melody, chords and drums (from its MIDI) | reads the melody as MIDI | 30 s of song ≈ 2–2.5 min | weights AND outputs **non-commercial** (CC BY-NC 4.0) |

Install the engines once — each at a reviewed version, in its own environment, outside this repository:

```sh
./scripts/install-engines.sh ace-step        # 10 GB;  or: mulacover (15 GB; asks you to accept its licence), all
./scripts/install-engines.sh all --dry-run   # the plan, nothing changed
```

Before Claude Code writes a caption or lyrics, it calls `gb_generate examples {query}`: ACE-Step's own example songs
(200, MIT; read from the installed engine) that fit the request best, with caption, lyrics, bpm, key and length. The
server's instructions tell it to write in their style, with new words. Captions can be up to 1000 characters.

It is safe to re-run (an interrupted download resumes); restart Claude Code afterwards. A generation takes minutes, so
it is a **job**: `gb_generate start` returns at once, `gb_generate status {job}` follows it until `done`, with the
measured tempo (the mean of the regular beat intervals — not a median, which the tracker's 20 ms frames round) and key. Then `gb_stem separate` takes the vocal, `gb_stem prepare` re-times it to the song (MuLaCover
picks its own tempo — the status gives the exact call), and `gb_tracks add_audio` + `gb_project save_copy` +
`gb_band build` place it next to your MIDI tracks. One engine runs at a time (each needs ~14 GB of memory). Read
`gb://knowledge/generate`. MuLaCover's token generator runs on this repository's own MLX port
(`models/mulacover_mlx`, about 3× the original's speed on Apple Silicon; `eval/m12d`); measurements: `eval/m12a`,
`eval/m12b`.

### Genre drafts, grooves, swing and glide

`gb_song template {genre, key, bpm}` returns a complete Song JSON draft for one of 20 genres — form, chord
progressions in any key, the genre's GarageBand drum kit and instruments, a hook, and drums — for Claude to develop:
lo-fi hip-hop, R&B, ambient, jazz ballad, reggaeton, synthwave, pop, afrobeats, funk, indie rock, deep house, techno,
UK garage, trap, drum and bass, EDM, classical/pop crossover, ambient trance, Levantine strings and epic orchestral.

Song JSON also takes `groove` (the timing and accents of real drummers in 18 styles, mined from the Groove MIDI
Dataset), `swing` (50 straight … 75 hard, on 16ths or 8ths) and, per track, `glide` (legato, so a mono 808 slides).

### Expression: slides, vibrato, dynamics, pedal, pan, tempo changes

Song JSON can shape a performance with the MIDI messages GarageBand actually honours — measured in its exports
(`eval/m11/MESSAGES.md`):

- **Slides (meend) and microtones** in the notes: `"d5@7>e5@2"` bends one note into the next, `"a4@2>c5@2>b4@4"`
  bends through several in one breath, `"e5-20c"` tunes a note 20 cents flat. Accents `"a5!"`, soft notes `"a5?"`.
- **Vibrato** per track (pitch bend, so sampled instruments respond too): `"vibrato": "light" | "normal" | "wide"`.
- **Per part:** `dynamics` hairpins (`"p<f"`, `"pp<ff>mp"`), sustain `pedal`, `pan` (fixed, sweep or auto-pan),
  synth `brightness`, `volume` fades.
- **Per section:** a new `tempo`, or `tempoTo` for a ritardando or accelerando.

How far a sound can bend is a property of the GarageBand patch — Flute Solo ±12 semitones, most others ±2, the harp
not at all — and `gb_song validate` refuses a slide the instrument cannot play. `gb_band build` writes the same bends
into `.band` files. `eval/m11` is the live check: one Song JSON, every feature measured in the GarageBand export.

### Optional: AI models (Apple Silicon)

`./scripts/install.sh --with-models` creates `models/.venv` (Python 3.12, PyTorch on Metal, MLX). Model weights download
from Hugging Face on first use (~4 GB). gb-mcp starts one long-lived model process and keeps the models loaded:

- `gb_analyze` adds a field `ml`: beats and a grid check (beat_this), the key (S-KEY) and a ranking of the closest of
  the 20 genres (LAION CLAP — a ranking for comparing versions, not a grade). About 3 s per analysis once loaded.
- `gb_song infill {song, section, tracks}` lets the Anticipatory Music Transformer rewrite chosen melodic tracks of
  one section on the song's own instruments: `exact` ≈ 1–1.5 min per 8 bars, `fast` ≈ 20 s (shorter context — listen
  before trusting it). The model hears the song before and after the section. With `candidates: 2–4` and a `judge`
  text ("warm neo-soul keys"), CLaMP 3 ranks the takes against that text and the best comes back; a take that runs
  away is stopped early (`capped`) and never chosen.

- `gb_stem` (above) separates with Demucs htdemucs, measures tempo (beat_this) and key (S-KEY), and aligns stems to
  the song; it never overwrites a file.

Without the models everything else works; `ml` says so `infill` and `gb_stem` answer `DEPENDENCY_MISSING`. Measured speeds,
memory and what each optimisation bought (an exact KV-cache sampler, float16, an MLX port): `models/bench/results.md`.
`eval/` holds 20 frozen genre briefs and `eval/run.py`, which renders, exports and scores them to compare versions.

## Troubleshooting

| Code | Do this |
|---|---|
| `PERMISSION_AX_DENIED` | Allow Accessibility for the app running Claude Code (setup step 1), then restart that app |
| `PERMISSION_AUTOMATION_DENIED` | Allow it to control GarageBand under *Privacy & Security ▸ Automation* |
| `SCREEN_LOCKED` | Unlock the Mac and ask again |
| `USER_INPUT_ACTIVE` | You were typing or using the mouse when a click was needed — pause a moment and ask again |
| `DIALOG_UNEXPECTED` | Answer the GarageBand dialog yourself, then ask again |
| `NO_PROJECT_OPEN` / `GB_NOT_RUNNING` | Ask Claude to open a song first |
| `TARGET_NOT_FOUND` on export | The export folder is not a save-panel recent place yet — setup step 3 |
| `CONTENT_NOT_INSTALLED` | That sound needs a download; pick an installed one or download it yourself in GarageBand |
| `HELPER_UNAVAILABLE` | Build the native helpers: `npm run build:native` |
| `uncertain` result | Something was delivered but not confirmed — ask for the GarageBand status before repeating |

The skill `gb-troubleshoot` (installed with the others) gives Claude the full list.

## Development

```bash
npm test             # TypeScript tests (vitest) — no GarageBand needed: a fake Accessibility layer stands in
npm run test:all     # + Python analysis tests + Swift helper tests
npm run typecheck
```

`src/` TypeScript server · `native/` Swift Accessibility helper and GM draft renderer · `analysis/` Python audio
analysis · `skills/` Claude Code skills · `test/fixtures/` recorded GarageBand UI trees.

GarageBand's interface differs between versions; the element locators live in `src/ax/locators.ts`.

## Uninstall

```bash
./scripts/uninstall.sh     # removes the MCP registration and unchanged skill copies; keeps your workspace
```

## License

[MIT](LICENSE)

### Credits

- `src/song/grooves.json` is derived from the [Groove MIDI Dataset](https://magenta.tensorflow.org/datasets/groove)
  (Gillick, Roberts, Engel, Eck, Bamman — Google Magenta), licensed
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): per-style hit probabilities, velocities and timing,
  computed by `models/mine_grooves.py`.
- The optional models are downloaded from their authors under their own licenses and are not part of this
  repository: [Anticipatory Music Transformer](https://github.com/jthickstun/anticipation) (Apache-2.0),
  [beat_this](https://github.com/CPJKU/beat_this) (MIT), [LAION CLAP](https://github.com/LAION-AI/CLAP),
  [S-KEY](https://huggingface.co/musetric/skey-onnx) (MIT), [CLaMP 3](https://github.com/sanderwood/clamp3) (MIT; its
  code is cloned on first use), [Demucs](https://github.com/adefossez/demucs) (MIT). `gb_stem prepare` calls
  [Rubber Band](https://breakfastquay.com/rubberband/) (GPL) as an external program if you install it; it is not part
  of this repository. `models/bench` also measured
  [Foundation-1](https://huggingface.co/RoyalCities/Foundation-1) (Stability AI Community License), which gb-mcp does
  not use yet.
- The `gb_generate` engines are downloaded by `scripts/install-engines.sh` from their authors and are not part of this
  repository: [ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5) (MIT, code and weights);
  **MuLaCover by MuLa Labs** — https://github.com/HeartMuLa/MuLaCover — (code Apache-2.0; weights CC BY-NC 4.0 with
  output terms: generated audio is for non-commercial use only), with
  [HeartCodec](https://huggingface.co/HeartMuLa/HeartCodec-oss-20260123) (Apache-2.0) and
  [Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) (Apache-2.0). `models/mulacover_mlx` is this
  repository's own MLX implementation of MuLaCover's token generator (MIT); it loads the weights you downloaded.
