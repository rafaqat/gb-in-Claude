// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodTypeAny } from "zod";
import { createGbSong, GB_SONG_COMMANDS, GbSongInput } from "./gb-song.js";
import { createGbStem, GB_STEM_COMMANDS, GbStemInput } from "./gb-stem.js";
import { createGbGenerate, ENGINES, GB_GENERATE_COMMANDS, GbGenerateInput, ACE_TRACKS } from "./gb-generate.js";
import { createGbAnalyze, GB_ANALYZE_COMMANDS, ANALYSIS_FIELDS, GbAnalyzeInput } from "./gb-analyze.js";
import type { AnalyzerPort } from "../analysis/analyzer.js";
import type { ModelSidecar } from "../models/sidecar.js";
import type { GmRendererPort } from "../render/gm-renderer.js";
import { ANALYSIS_GUIDE } from "../knowledge/analysis-guide.js";
import { registerSoundTools, GB_SOUND_COMMANDS, GbSoundInput, createPatchCatalog, type PatchCatalog } from "./gb-sound.js";
import { registerSystemTools, GbSystemInput, type GbSystemDeps, type ToolRegistry } from "./gb-system.js";
import { registerGarageBandTools } from "./gb-garageband.js";
import { GB_PROJECT_COMMANDS, GbProjectInput, type ProjectScripts } from "../garageband/project.js";
import { GB_EXPORT_COMMANDS, GbExportInput } from "../garageband/export.js";
import { GB_TRACKS_COMMANDS, GbTracksInput } from "../garageband/tracks.js";
import { GB_TRANSPORT_COMMANDS, GbTransportInput } from "../garageband/transport.js";
import { GB_MIX_COMMANDS, GbMixInput } from "../garageband/mix.js";
import { registerSchemaResources } from "../knowledge/schemas.js";
import { GM_PATCH_MAP, GM_DRUM_KIT_MAP, patchFor } from "../knowledge/gm-patch-map.js";
import { SONG_FORMAT_GUIDE } from "../knowledge/song-format.js";
import { BAND_FILES_GUIDE } from "../knowledge/band-files.js";
import { GENERATE_GUIDE } from "../knowledge/generate.js";
import { GENRES_GUIDE } from "../knowledge/genre-styles.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { registerPrompts } from "./prompts.js";
import { FromAudioInput } from "./from-audio.js";
import { STYLES } from "../song/styles.js";
import { guarded } from "./tool-result.js";
import type { Envelope } from "./envelope.js";
import type { Result } from "../result.js";
import { createGbBand, GB_BAND_COMMANDS, GbBandInput, BandAudioItem, BandMidiItem } from "./gb-band.js";

export const SERVER_VERSION = "0.8.0";

const json = (uri: string, value: unknown) => ({ contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }] });

export type GarageBandOptions = {
  scripts: ProjectScripts; openFile: (path: string) => Promise<Result<void, string>>; inboxDir: string; defaultExportDir?: string;
  /** Defaults to reading the console session's lock flag (tests pass a constant). */
  screenLocked?: () => Promise<boolean>;
};
export type ServerOptions = {
  workspaceDir: string; analyzer?: AnalyzerPort; gmRenderer?: GmRendererPort; system?: GbSystemDeps; garageband?: GarageBandOptions;
  /** M8 model sidecar for gb_analyze's `ml` field (optional). */
  listener?: ModelSidecar;
  /** M12b engine sidecars for gb_generate, one per installed engine (missing = not installed). */
  engines?: Partial<Record<(typeof ENGINES)[number], ModelSidecar>>;
  /** M13.12 the RoFormer separator's sidecar for gb_stem separate {model: "roformer"} (missing = not installed). */
  separator?: ModelSidecar;
  /** M13.13 the all-in-one sidecar for gb_analyze map's sections (missing = not installed). */
  sections?: ModelSidecar;
  /** ACE-Step's example songs (examples/text2music in its checkout) for gb_generate examples. */
  aceExamplesDir?: string;
  /** The installed patch catalog shared by gb_sound and gb_tracks set_instrument (default: scan this Mac). */
  patchCatalog?: PatchCatalog;
};

export function createServer(opts: ServerOptions): McpServer {
  const server = new McpServer({ name: "gb-mcp", version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const patchCatalog = opts.patchCatalog ?? createPatchCatalog();
  const live = Boolean(opts.system && opts.garageband);
  const gbBand = createGbBand({ workspaceDir: opts.workspaceDir });
  const gbAnalyzeHandler: ((input: unknown) => Promise<Envelope>) | undefined = opts.analyzer
    ? createGbAnalyze({ workspaceDir: opts.workspaceDir, analyzer: opts.analyzer, ...(opts.listener ? { listener: opts.listener } : {}),
      ...(opts.sections ? { sections: opts.sections } : {}) })
    : undefined;
  const gbSong = createGbSong({ workspaceDir: opts.workspaceDir, ...(opts.gmRenderer ? { gmRenderer: opts.gmRenderer } : {}), ...(opts.listener ? { models: opts.listener } : {}),
    ...(gbAnalyzeHandler ? { map: gbAnalyzeHandler } : {}) });

  server.registerTool(
    "gb_song",
    {
      title: "Compose a song (Song JSON → MIDI)",
      description:
        "Compose for GarageBand without touching it. validate: parse + musical checks + which GarageBand patch each " +
        "track gets. preview: ASCII 16th-note grid of one section. render_midi: humanize and write a Type-1 MIDI file " +
        "into the workspace (never overwrites; dry_run writes nothing). render_draft: quick WAV via the macOS GM synth " +
        "(structure checks only, not tone). band_plan: the song's audio clips as gb_band build's audio list (absolute " +
        "bar and beat; writes nothing). template: a complete Song JSON draft for a genre in a key and tempo (genre " +
        "grooves, progressions, instruments; writes nothing). infill: the AMT model rewrites chosen melodic tracks of one " +
        "section, keeping the rest (needs the model sidecar; writes nothing). transcribe: a recording → a Song JSON draft that " +
        "plays like it — tempo (a tempo map when the take drifts), key, sections, chords, bass, lead and drums on the " +
        "GarageBand bars of gb_analyze map. It separates the stems first when they are missing. It needs the model " +
        "sidecar. It is a draft: listen to it and correct it. With filename it writes songs/<filename> and never " +
        "overwrites. dry_run runs nothing. Read gb://knowledge/song-format first.",
      inputSchema: z.object({
        command: z.enum(GB_SONG_COMMANDS),
        song: z.any().describe("Song JSON — see gb://knowledge/song-format"),
        section: z.string().optional().describe("preview: section name"),
        maxBars: z.number().int().optional().describe("preview: limit bars shown"),
        filename: z.string().optional().describe("render_midi: e.g. ascent-v2.mid · render_draft: e.g. ascent-draft.wav · transcribe: e.g. song-v1.song.json, written to songs/ (no paths)"),
        dry_run: z.boolean().optional().describe("render_midi / render_draft / transcribe: validate and plan without writing"),
        path: z.string().optional().describe("transcribe: a recording inside the workspace, e.g. gen/song.wav"),
        genre: z.string().optional().describe("template: e.g. deep house, trap, jazz ballad (an unknown one lists them)"),
        variant: z.number().optional().describe("template: 0 its own progressions (default); 1–3 the genre's common 4-chord loops, for another draft"),
        key: z.string().optional().describe('template: e.g. "F minor"'),
        bpm: z.number().optional().describe("template: tempo (default: the genre's)"),
        meter: z.number().int().optional().describe("template: beats per bar (default 4)"),
        title: z.string().optional().describe("template: the draft's title"),
        tracks: z.array(z.string()).optional().describe("infill: melodic track names to rewrite in `section`"),
        mode: z.enum(["exact", "fast"]).optional().describe("infill: exact (≈1 min / 8 bars) or fast (≈15 s, shorter context)"),
        seed: z.number().int().optional().describe("infill: another seed gives another take"),
        candidates: z.number().int().optional().describe("infill: 1–4 takes; CLaMP 3 keeps the one closest to `judge`"),
        judge: z.string().optional().describe('infill: what the music should be, e.g. "warm neo-soul keys" (needed with candidates > 1)'),
        voice_leading: z.boolean().optional().describe("validate: add the classical voice-leading checks — parallel fifths/octaves lead ↔ bass, leaps over an octave, voice crossing (warnings)"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded("gb_song", gbSong, true),
  );

  server.registerTool(
    "gb_band",
    {
      title: "Write a GarageBand project (.band) directly: audio + MIDI",
      description:
        "Beyond MIDI: GarageBand projects written as files. inspect: read-only — tempo, song length, audio regions (track, " +
        "bar, beat, file, seconds) and MIDI regions (name, notes, bars) of a .band. build: copy a donor project that " +
        "GarageBand saved (it gives the tracks, patches and tempo) into bands/<filename>, place WAV files on its audio " +
        "tracks by bar and beat, and write Song JSON notes into its MIDI regions. Never overwrites; dry_run writes nothing. " +
        "Then gb_project open_band (verified by GarageBand's own re-save) and gb_export song. 4/4 donors only. " +
        "Read gb://knowledge/band-files.",
      inputSchema: z.object({
        command: z.enum(GB_BAND_COMMANDS),
        path: z.string().optional().describe("inspect: a .band inside the workspace, e.g. donors/donor-av.band"),
        donor: z.string().optional().describe("build: a .band that GarageBand saved — gb_band inspect shows its slots"),
        filename: z.string().optional().describe("build: e.g. my-song-v1.band (no paths); written to bands/"),
        audio: z.array(BandAudioItem).optional().describe("build: WAVs to place on the donor's audio tracks (an empty audio track is fine: slots are grafted). GarageBand's audio tracks are mono on this Mac: give a stereo WAV a pair track to keep its stereo image"),
        midi: z.array(BandMidiItem).optional().describe("build: new notes for the donor's MIDI regions, by region name"),
        dry_run: z.boolean().optional().describe("build: validate and plan without writing"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded("gb_band", gbBand, true),
  );

  server.registerTool(
    "gb_stem",
    {
      title: "Bring outside audio to a song: inspect, align, separate",
      description:
        "Stems for gb_band. inspect: format, length, tempo, key, percussive or tonal, peak, and whether gb_band can place " +
        "it. prepare: align a WAV to the song — stretch to to_bpm (from_bpm, or measured), shift by semitones, write 24-bit " +
        "PCM at the project rate into stems/<filename>; drums are re-timed by their strokes, tonal parts by Rubber Band; " +
        "verified by reading the file back and measuring its tempo. separate: split a mix into vocals, drums, bass and other " +
        "(Demucs) in stems/; model \"roformer\" (install-engines.sh roformer) takes the vocal out much more cleanly (18.8 " +
        "dB against 12.7) and adds <name>-instrumental.wav — use it for vocals you place, re-sing or check (7× slower). " +
        "Never overwrites; dry_run writes nothing. Needs the model sidecar. Then place the stems with gb_band build.",
      inputSchema: z.object({
        command: z.enum(GB_STEM_COMMANDS),
        path: z.string().optional().describe("a WAV/AIFF/FLAC inside the workspace, e.g. samples/tabla.wav"),
        filename: z.string().optional().describe("prepare: output name, e.g. tabla-132.wav (written to stems/)"),
        to_bpm: z.number().optional().describe("prepare: the song tempo"),
        from_bpm: z.number().optional().describe("prepare: the source tempo (default: measured)"),
        near_bpm: z.number().optional().describe("inspect: expected tempo (folds a half/double-time reading)"),
        semitones: z.number().optional().describe("prepare: pitch shift, −12…12"),
        mode: z.enum(["auto", "percussive", "tonal"]).optional().describe("prepare: how to stretch (default auto)"),
        rate: z.number().optional().describe("prepare: 44100 (default) or 48000"),
        model: z.enum(["htdemucs", "roformer"]).optional().describe("separate: htdemucs (default, fast) or roformer (a much cleaner vocal; install-engines.sh roformer)"),
        dry_run: z.boolean().optional().describe("prepare / separate: plan without writing"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded("gb_stem", createGbStem({ workspaceDir: opts.workspaceDir, ...(opts.listener ? { models: opts.listener } : {}),
      ...(opts.separator ? { roformer: opts.separator } : {}) }), true),
  );

  server.registerTool(
    "gb_generate",
    {
      title: "Generate vocals or music with an AI engine (background jobs)",
      description:
        "Audio MIDI cannot make: sung vocals, or a re-recording of the song. Engines: ace_step (ACE-Step 1.5, MIT) — task " +
        "cover (re-sing / re-play a song export to a caption and lyrics; strength = how closely it keeps the source) or text " +
        "(music from a caption, bpm, key, duration) or repaint (regenerate start..end seconds of src, keep the rest — e.g. " +
        "a new bridge or outro); with the base model (install-engines.sh ace-step-base): lego (add one track — e.g. woodwinds " +
        "for pipes or flute — over start..end of src) or complete (a lone track, e.g. a vocal, completed with tracks); " +
        "mulacover (MuLaCover; outputs NON-COMMERCIAL) — task cover (sing lyrics " +
        "on the song's own melody / chord / drum tracks from its MIDI; it picks its own tempo, so gb_generate re-times the " +
        "result to the song: result.retimed is a new file gen/<name>-<bpm>bpm.wav — place that one; retime: false keeps only " +
        "the original). start returns a job at once " +
        "(generation takes 1.5–8 min); poll status until state is done; the result is a checked WAV in gen/ with measured " +
        "bpm and key. One job at a time. Then gb_stem separate / prepare and gb_band build. Before you write a caption or " +
        "lyrics, call examples {query} — ACE-Step's own example songs that fit the request — and write in their style. " +
        "Read gb://knowledge/generate.",
      inputSchema: z.object({
        command: z.enum(GB_GENERATE_COMMANDS),
        engine: z.enum(ENGINES).optional().describe("start: ace_step or mulacover"),
        task: z.enum(["cover", "text", "repaint", "lego", "complete"]).optional().describe("start: ace_step cover | text | repaint | lego | complete; mulacover cover"),
        filename: z.string().optional().describe("start: output name in gen/, e.g. vocals-v1.wav"),
        job: z.string().optional().describe("status: the job id from start"),
        src: z.string().optional().describe("ace_step cover: the song to cover (workspace WAV, e.g. exports/song.wav)"),
        caption: z.string().optional().describe("ace_step: one paragraph — genre, mood, instruments, voice, arrangement, production; ≤ 1000 characters"),
        strength: z.number().optional().describe("ace_step cover: 0–1, how closely to keep the source (default 0.7)"),
        bpm: z.number().optional().describe("ace_step: tempo (text: requested; cover: the song's)"),
        key: z.string().optional().describe("ace_step: e.g. E minor"),
        duration: z.number().optional().describe("ace_step text: 10–600 s"),
        thinking: z.boolean().optional().describe("ace_step text: false skips the LM (faster)"),
        start: z.number().optional().describe("ace_step repaint: regenerate from this second of src"),
        end: z.number().optional().describe("ace_step repaint: to this second (default -1: the end)"),
        mode: z.enum(["conservative", "balanced", "aggressive"]).optional().describe("ace_step repaint: how far it may move from src (default balanced)"),
        track: z.enum(ACE_TRACKS).optional().describe("ace_step lego (base model): the track to add — woodwinds, brass, fx, synth, strings, percussion, keyboard, guitar, bass, drums, backing_vocals, vocals"),
        tracks: z.array(z.enum(ACE_TRACKS)).optional().describe("ace_step complete (base model): the tracks to add around src"),
        midi: z.string().optional().describe("mulacover: the song MIDI in the workspace (gb_song render_midi)"),
        melody: z.array(z.string()).optional().describe("mulacover: melody track name(s)"),
        chords: z.array(z.string()).optional().describe("mulacover: harmony track name(s) → one block chord per bar"),
        drums: z.array(z.string()).optional().describe("mulacover: drum track name(s)"),
        start_bar: z.number().optional().describe("mulacover: first bar (default 1)"),
        bars: z.number().optional().describe("mulacover: how many bars (default: to the end; ≤ 300 s)"),
        tags: z.string().optional().describe("mulacover: style, e.g. genre:[film song]; instrument:[bansuri]; mood:[warm]"),
        retime: z.boolean().optional().describe("mulacover: re-time the result to the song's tempo into a new file next to it (default true; the original stays)"),
        lyrics: z.string().optional().describe("section markers on their own lines: [Verse]\\n…; ace_step default [Instrumental]"),
        seed: z.number().optional().describe("another seed, another take"),
        dry_run: z.boolean().optional().describe("start: check and plan, run nothing"),
        query: z.string().optional().describe("examples: the user's request, e.g. 'warm acoustic love song, male voice'"),
        language: z.string().optional().describe("examples: vocal language code, e.g. en, ja, zh"),
        instrumental: z.boolean().optional().describe("examples: prefer instrumental examples"),
        limit: z.number().optional().describe("examples: how many, 1–8 (default 4)"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded("gb_generate", createGbGenerate({ workspaceDir: opts.workspaceDir, engines: opts.engines ?? {}, ...(opts.listener ? { listener: opts.listener } : {}),
      ...(opts.aceExamplesDir ? { aceExamplesDir: opts.aceExamplesDir } : {}) }), true),
  );

  if (gbAnalyzeHandler) {
    server.registerTool(
      "gb_analyze",
      {
        title: "Listen to an export (measure, flag, suggest)",
        description:
          "Measure audio in the workspace: loudness/true peak (BS.1770), tonal balance & tilt (tinny?), stereo width, " +
          "tempo, sidechain pump, key, per-section metrics, flags and suggestions pointing at Song JSON paths, plus a " +
          "spectrogram PNG path you can open. audio: a file · against_song: + song for sections/tempo/key intent · " +
          "compare: before vs after · master: a mastered copy in masters/ (gain to a loudness target, default −14 LUFS; " +
          "true-peak limiter under a ceiling, default −1 dBTP; 24-bit; measured on the written file; never overwrites) · " +
          "takes: 2–8 recordings side by side (length, loudness, true peak, tempo, key, flags) · map: the bar " +
          "structure of a recording (separates stems first if needed) — tempo and how steady, irregular bars, chords per " +
          "half bar and vocal rests per GarageBand bar, high-melody bars, the sections (intro, verse, chorus… on bars; " +
          "install-engines.sh sections), and where to place the stems (gb_band build: " +
          "bar 1, beat) in a project at guide_bpm; the full map is written to analysis/<name>-map.json and the result names " +
          "the four stems it used · lyrics: what the " +
          "voice sings (Whisper on its vocal stem) against the written lyrics — per line sung / partial / missing, times, " +
          "the words heard, and the word error rate. " +
          "Read gb://knowledge/analysis.",
        inputSchema: z.object({
          command: z.enum(GB_ANALYZE_COMMANDS),
          path: z.string().optional().describe("audio/against_song: WAV/AIFF/FLAC inside the workspace, e.g. exports/ascent.wav"),
          song: z.any().optional().describe("against_song/compare: Song JSON for sections, tempo, key"),
          before: z.string().optional().describe("compare: earlier export"),
          after: z.string().optional().describe("compare: later export"),
          spectrogram: z.boolean().optional().describe("write a spectrogram PNG (default true)"),
          fields: z.array(z.enum(ANALYSIS_FIELDS)).optional().describe("limit the response to these top-level fields"),
          filename: z.string().optional().describe("master: output name in masters/, e.g. song-master.wav"),
          lufs: z.number().optional().describe("master: loudness target, −30 to −5 LUFS (default −14)"),
          peak: z.number().optional().describe("master: true-peak ceiling, −6 to 0 dBTP (default −1)"),
          dry_run: z.boolean().optional().describe("master: plan only, write nothing"),
          paths: z.array(z.string()).optional().describe("takes: 2–8 recordings to compare side by side"),
          key: z.string().optional().describe('map: the song\'s key if known, e.g. "D major" (else measured)'),
          melody: z.boolean().optional().describe("map: find the bars with a high melody (default true)"),
          lyrics: z.string().optional().describe("lyrics: the written lyrics ([Section] tags allowed) to check the sung words against"),
          language: z.string().optional().describe('lyrics: the sung language, e.g. "en" (else detected)'),
        }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      guarded("gb_analyze", gbAnalyzeHandler, true),
    );
    server.registerResource("analysis", "gb://knowledge/analysis",
      { description: "How to read gb_analyze metrics and run the listen → change → compare loop", mimeType: "text/markdown" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: ANALYSIS_GUIDE }] }));
  }

  registerSoundTools(server, { workspaceDir: opts.workspaceDir, patchCatalog });

  if (opts.system) {
    const registry: ToolRegistry = {
      gb_song: { description: "compose: Song JSON → validate / preview / MIDI / GM draft", commands: GB_SONG_COMMANDS },
      gb_stem: { description: "outside audio: inspect / align (tempo, pitch, format) / separate into stems", commands: GB_STEM_COMMANDS },
      gb_generate: { description: "AI engines: sung covers and music (ace_step, mulacover) as background jobs", commands: GB_GENERATE_COMMANDS },
      gb_band: { description: "GarageBand project files: inspect a .band, build one with audio + MIDI from a donor", commands: GB_BAND_COMMANDS },
      gb_sound: { description: "read-only catalog: patches, plugins, loops, samples, palette", commands: GB_SOUND_COMMANDS },
      ...(opts.analyzer ? { gb_analyze: { description: "listen: measure, flag and compare exports", commands: GB_ANALYZE_COMMANDS } } : {}),
      ...(opts.garageband ? {
        gb_project: { description: "open a rendered song or a built .band in GarageBand (safe backups) / read the project / a recording → a project (from_audio)", commands: [...GB_PROJECT_COMMANDS, "from_audio"] },
        gb_export: { description: "export the open song as WAVE into the workspace", commands: GB_EXPORT_COMMANDS },
        gb_tracks: { description: "tracks: list, select (real click), mute/solo, load an installed Library patch", commands: GB_TRACKS_COMMANDS },
        gb_transport: { description: "transport: state, play/stop/rewind, tempo, metronome, count-in", commands: GB_TRANSPORT_COMMANDS },
        gb_mix: { description: "mix: track faders (raw / measured dB) and pan", commands: GB_MIX_COMMANDS },
      } : {}),
    };
    registerSystemTools(server, { ...opts.system, toolRegistry: { ...registry, ...(opts.system.toolRegistry ?? {}) } });
    if (opts.garageband) {
      registerGarageBandTools(server, { workspaceDir: opts.workspaceDir, helper: opts.system.helper, patchCatalog, ...opts.garageband },
        gbAnalyzeHandler ? { analyze: gbAnalyzeHandler, song: gbSong, band: gbBand } : undefined);
    }
  }

  server.registerResource("song-format", "gb://knowledge/song-format",
    { description: "Song JSON reference, part notation, and common mistakes", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: SONG_FORMAT_GUIDE }] }));

  server.registerResource("band-files", "gb://knowledge/band-files",
    { description: "gb_band: make a donor, build a .band with audio + MIDI, verify it with gb_project open_band", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: BAND_FILES_GUIDE }] }));

  server.registerResource("generate", "gb://knowledge/generate",
    { description: "gb_generate: engines (ACE-Step, MuLaCover), steps to a placed vocal, times, licences, install", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GENERATE_GUIDE }] }));

  server.registerResource("genres", "gb://knowledge/genres",
    { description: "The 47 genres: caption words for gb_generate (sound, voice, production), tempo, what a GarageBand draft lacks", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GENRES_GUIDE }] }));

  server.registerResource("styles", "gb://knowledge/styles",
    { description: "Style presets: GM program and GarageBand patch per role", mimeType: "application/json" },
    async (uri) => json(uri.href, Object.fromEntries(Object.entries(STYLES).map(([name, s]) => [name, {
      ...s,
      patches: Object.fromEntries(Object.entries(s.programs).map(([role, p]) => [role, patchFor(p, role === "drums" ? 10 : 1)])),
    }]))));

  server.registerResource("gm-patch-map", "gb://knowledge/gm-patch-map",
    { description: "GM program → GarageBand 10.4.14 patch (probed); drum kits on channel 10", mimeType: "application/json" },
    async (uri) => json(uri.href, { melodic: GM_PATCH_MAP, drumKits: GM_DRUM_KIT_MAP }));

  const schemas: Record<string, ZodTypeAny> = {
    gb_song: GbSongInput, gb_stem: GbStemInput, gb_generate: GbGenerateInput, gb_band: GbBandInput, gb_sound: GbSoundInput,
    ...(opts.analyzer ? { gb_analyze: GbAnalyzeInput } : {}),
    ...(opts.system ? { gb_system: GbSystemInput } : {}),
    ...(live ? { gb_project: z.discriminatedUnion("command", [...GbProjectInput.options, FromAudioInput]), gb_export: GbExportInput, gb_tracks: GbTracksInput, gb_transport: GbTransportInput, gb_mix: GbMixInput } : {}),
  };
  registerSchemaResources(server, { tools: schemas });
  registerPrompts(server);

  return server;
}
