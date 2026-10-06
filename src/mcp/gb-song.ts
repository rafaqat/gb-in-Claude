// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { z } from "zod";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { parseSong, type Song } from "../song/schema.js";
import { validateSong } from "../song/validate.js";
import { previewSong } from "../song/preview.js";
import { sectionTimes } from "../song/expression.js";
import { renderSong, PPQ } from "../song/render.js";
import { humanize } from "../song/humanize.js";
import { grooveFeel } from "../song/grooves.js";
import { applySwing } from "../song/swing.js";
import { writeSmf, type SmfSong } from "../midi/smf.js";
import { smfSongToEvents } from "../render/gm-events.js";
import type { GmRendererPort } from "../render/gm-renderer.js";
import { applyTrackLevels } from "../song/levels.js";
import { applyExpression } from "../song/expression.js";
import { patchFor } from "../knowledge/gm-patch-map.js";
import { bandPlan } from "../song/band-plan.js";
import { GENRE_TEMPLATES, templateSong } from "../song/genres.js";
import { COMMON_LOOPS } from "../song/common-loops.js";
import { notesToPart, type InfillNote } from "../song/infill.js";
import type { ModelSidecar } from "../models/sidecar.js";
import { draftSong, type SongMap, type Transcription } from "../song/draft.js";
import { resolveWorkspaceFile, workspaceOutputDir } from "../workspace/paths.js";
import { tmpdir } from "node:os";
import { verified, failed, type Envelope } from "./envelope.js";

/** Safe output names: no paths, no encodings, no hidden files, .mid only. */
const SafeMidiFilename = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}\.mid$/,
  "letters, digits, space, _ or -, ending in .mid (no paths)");
const SafeWavFilename = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}\.wav$/,
  "letters, digits, space, _ or -, ending in .wav (no paths)");
const SafeJsonFilename = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}(\.song)?\.json$/,
  "letters, digits, space, _ or -, ending in .song.json or .json (no paths)");
const SONGS_DIR = "songs";

export const GbSongInput = z.discriminatedUnion("command", [
  z.object({ command: z.literal("validate"), song: z.unknown(), voice_leading: z.boolean().optional().describe("add the classical voice-leading checks (warnings)") }).strict(),
  z.object({ command: z.literal("preview"), song: z.unknown(), section: z.string().min(1), maxBars: z.number().int().min(1).max(64).optional() }).strict(),
  z.object({ command: z.literal("render_midi"), song: z.unknown(), filename: z.string(), dry_run: z.boolean().optional() }).strict(),
  z.object({ command: z.literal("render_draft"), song: z.unknown(), filename: z.string(), dry_run: z.boolean().optional() }).strict(),
  z.object({ command: z.literal("band_plan"), song: z.unknown() }).strict(),
  z.object({
    command: z.literal("template"), genre: z.string().min(1).describe("one of gb-mcp's genres (an unknown one lists them)"),
    key: z.string().regex(/^[A-G][#b]? (major|minor)$/, 'like "F minor" or "Ab major"'),
    bpm: z.number().min(20).max(300).optional(), meter: z.number().int().min(2).max(7).optional(), title: z.string().min(1).max(80).optional(),
    variant: z.number().int().min(0).max(3).optional().describe("0 the template's own progressions; 1–3 the genre's common loops"),
  }).strict(),
  z.object({
    command: z.literal("infill"), song: z.unknown(), section: z.string().min(1),
    tracks: z.array(z.string().min(1)).min(1).max(8).describe("melodic tracks to rewrite in that section (not drums)"),
    mode: z.enum(["exact", "fast"]).default("exact").describe("exact ≈ 1 min per 8 bars; fast ≈ 15 s (shorter context)"),
    seed: z.number().int().optional(),
    candidates: z.number().int().min(1).max(4).default(1).describe("takes to generate (seeds seed, seed+1, …); CLaMP 3 keeps the best"),
    judge: z.string().min(3).max(300).optional().describe("what the music should be, e.g. \"warm neo-soul keys\": takes are ranked against it"),
  }).strict(),
  z.object({ command: z.literal("transcribe"), path: z.string().min(1), filename: z.string().optional(), dry_run: z.boolean().optional() }).strict(),
]);
export type GbSongInput = z.infer<typeof GbSongInput>;
export const GB_SONG_COMMANDS = ["validate", "preview", "render_midi", "render_draft", "band_plan", "template", "infill", "transcribe"] as const;

/** Song JSON audio clips are built by gb_band; the MIDI file and the GM draft leave them out. */
const AUDIO_LEFT_OUT = "AUDIO_LEFT_OUT: MIDI cannot carry the audio clips; gb_song band_plan + gb_band build place them";

/** models: the M8 model sidecar (gb_song infill, transcribe); optional — without it they are DEPENDENCY_MISSING.
 * map: gb_analyze (its map command) for transcribe. */
export type GbSongDeps = { workspaceDir: string; gmRenderer?: GmRendererPort; models?: ModelSidecar; map?: (input: unknown) => Promise<Envelope> };

/** The parts of the map file the draft reads (analysis/<name>-map.json, models/gbmodels/songmap.py). */
const MapFile = z.object({
  key: z.string().nullable(),
  place: z.object({ guide_bpm: z.number(), bar: z.number(), beat: z.number(), offset_s: z.number() }),
  tempo_map: z.array(z.object({ bar: z.number().int().min(1), bpm: z.number() })).nullable(),
  bar_lines_s: z.array(z.number()).min(2),
  sections: z.array(z.object({ name: z.string().min(1).max(32), gb_bar: z.number().int(), bars: z.number().int() })).nullable().default(null),
  gb: z.array(z.object({ bar: z.number().int(), chords: z.array(z.string().nullable()) })),
});
const Note = z.object({ bar: z.number().int().min(1), step: z.number().int().min(0).max(15), len: z.number().int().min(1), pitch: z.number().int().min(0).max(127) });
const Hit = z.object({ bar: z.number().int().min(1), step: z.number().int().min(0).max(15), strength: z.number().min(0).max(1) });
const TranscriptionOut = z.object({
  bass: z.array(Note), bass_source: z.enum(["bass"]).nullable(), lead: z.array(Note), lead_source: z.enum(["vocals", "other"]).nullable(),
  drums: z.object({ kick: z.array(Hit), snare: z.array(Hit), hat: z.array(Hit) }),
});

/** Anything at this name — a file, a folder, a link — counts: never write through it. */
function occupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Render + swing + humanize + levels + expression: the performance the MIDI file and the draft audio are made from. */
export function perform(song: Song): { ok: true; smf: SmfSong } | { ok: false; message: string } {
  const rendered = renderSong(song);
  if (!rendered.ok) return { ok: false, message: `${rendered.error.path}: ${rendered.error.message}` };
  const placed = rendered.value.tracks.map((t, i) => ({ ...t, role: song.tracks[i]!.role, ...(song.tracks[i]!.glide ? { glide: true } : {}) }));
  const roleTracks = song.swing ? applySwing(placed, { percent: song.swing, unit: song.swingUnit, ppq: PPQ }) : placed;
  const groove = song.groove && song.timeSignature[0] === 4 ? { groove: grooveFeel(song.groove) } : {};
  const performed = humanize(roleTracks, { feel: song.humanize, seed: song.seed, tempoBpm: song.tempo, ppq: PPQ, ...groove });
  const levels = Object.fromEntries(song.tracks.filter((t) => t.level !== undefined).map((t) => [t.name, t.level!]));
  const leveled = applyTrackLevels(performed.map(({ role: _role, glide: _glide, ...t }) => t), levels);
  // M11: expression becomes messages last, on the performed notes (bends follow their notes after swing and humanize)
  const { tracks, ...conductor } = applyExpression(song, leveled, PPQ);
  return { ok: true, smf: { ...rendered.value, ...conductor, tracks } };
}

function summarize(song: Song) {
  const bars = song.sections.reduce((sum, s) => sum + s.bars, 0);
  const rendered = renderSong({ ...song, humanize: "off" });
  const tracks = rendered.ok
    ? rendered.value.tracks.map((t) => ({ name: t.name, channel: t.channel, program: t.program, patch: t.program === undefined ? undefined : patchFor(t.program, t.channel), notes: t.notes.length }))
    : [];
  const times = sectionTimes(song); // through the tempo map (section tempi, tempoTo ramps, tempoMap)
  const durationSec = Math.round((times[times.length - 1]?.end_s ?? 0) * 100) / 100;
  return { bars, durationSec, tempo: song.tempo, style: song.style ?? null, humanize: song.humanize, tracks };
}

export function createGbSong(deps: GbSongDeps) {
  const workspace = resolve(deps.workspaceDir);

  /** M13.14: gb_analyze map, then the transcription model on the map's bars, then the draft (pure). */
  async function transcribe(cmd: Extract<GbSongInput, { command: "transcribe" }>): Promise<Envelope> {
    const op = "gb_song.transcribe";
    let out: string | undefined;
    if (cmd.filename !== undefined) { // checked before anything runs; songs/ is made only just before the write
      const name = SafeJsonFilename.safeParse(cmd.filename);
      if (!name.success) return failed(op, "PATH_INVALID", `filename: ${name.error.issues[0]!.message}`);
      const dir = workspaceOutputDir(workspace, SONGS_DIR, false);
      if (!dir.ok && dir.error.code !== "FILE_NOT_FOUND") return failed(op, dir.error.code, `${SONGS_DIR}/: ${dir.error.message}`);
      out = join(dir.ok ? dir.value : join(workspace, SONGS_DIR), name.data);
      if (occupied(out)) return failed(op, "FILE_EXISTS", `${SONGS_DIR}/${name.data} already exists; nothing done`, { hint: "choose a new filename (e.g. add -v2); files are never overwritten" });
    }
    const plan = ["gb_analyze map (separates the stems first when they are missing)", "transcribe the stems on the map's bars: bass and lead (pYIN), drums (NMF)",
      "build the draft: sections, chords, bass, lead, drums", ...(out ? [`write ${SONGS_DIR}/${basename(out)}`] : [])];
    if (cmd.dry_run) return verified(op, { dry_run: true, plan, ...(out ? { path: out } : {}) });
    if (!deps.map || !deps.models) return failed(op, "DEPENDENCY_MISSING", "the model sidecar is not set up (models/.venv)", { hint: "install the models: scripts/install.sh --with-models" });

    const mapped = await deps.map({ command: "map", path: cmd.path, melody: false });
    if (mapped.status !== "verified") {
      return mapped.status === "failed" ? failed(op, mapped.error, `gb_analyze.map: ${mapped.message}`, { ...(mapped.hint ? { hint: mapped.hint } : {}), recoverable: mapped.recoverable })
        : failed(op, "ANALYSIS_FAILED", `gb_analyze.map was not confirmed: ${mapped.hint}`);
    }
    const { map: mapPath, stems } = mapped.data as { map: string; stems: Record<string, string> };
    const mapWarnings = (mapped.warnings ?? []).map((w) => `gb_analyze.map: ${w}`); // e.g. no section engine: one section
    const after = { write_attempted: true, safe_to_retry: true }; // the map (and stems) are written; a retry writes new names
    const mapFile = resolveWorkspaceFile(workspace, mapPath, [".json"]);
    if (!mapFile.ok) return failed(op, "ANALYSIS_FAILED", `the map file: ${mapFile.error.message}`, after);
    let map: SongMap;
    try {
      const m = MapFile.safeParse(JSON.parse(readFileSync(mapFile.value, "utf8")));
      if (!m.success) return failed(op, "ANALYSIS_FAILED", `the map file is not a song map (${m.error.issues[0]!.path.join(".")})`, after);
      map = m.data;
    } catch {
      return failed(op, "ANALYSIS_FAILED", "the map file is not JSON", after);
    }
    const heard = await deps.models.run("transcribe", { stems, lines: map.bar_lines_s });
    if (!heard.ok) return failed(op, heard.error.code === "SIDECAR_UNAVAILABLE" ? "DEPENDENCY_MISSING" : "ANALYSIS_FAILED", heard.error.message, after);
    const t = TranscriptionOut.safeParse(heard.value);
    if (!t.success) return failed(op, "ANALYSIS_FAILED", `the transcription is malformed (${t.error.issues[0]!.path.join(".")})`, after);
    const title = `${basename(cmd.path, extname(cmd.path)).slice(0, 60)} (draft)`;
    const draft = draftSong(map, t.data as Transcription, { title });
    const parsed = parseSong(draft);
    if (!parsed.ok) return failed(op, "RENDER_FAILED", `the draft is not valid Song JSON: ${parsed.error.path}: ${parsed.error.message}`, after);
    const issues = validateSong(parsed.value);
    const errors = issues.filter((i) => i.severity === "error");
    if (errors.length) return failed(op, "VALIDATION_FAILED", `${errors.length} musical error(s) in the draft; nothing written`, { ...after, context: { issues: errors, song: draft } });
    if (out) {
      const dir = workspaceOutputDir(workspace, SONGS_DIR, true);
      if (!dir.ok) return failed(op, dir.error.code, `${SONGS_DIR}/: ${dir.error.message}`, after);
      out = join(dir.value, basename(out));
      try {
        writeFileSync(out, JSON.stringify(draft, null, 1) + "\n", { flag: "wx" }); // exclusive: never overwrite, never through a link
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EEXIST") return failed(op, "FILE_EXISTS", `${SONGS_DIR}/${basename(out)} appeared meanwhile; nothing written`, { ...after, hint: "choose a new filename" });
        return failed(op, "WRITE_FAILED", `could not write ${SONGS_DIR}/${basename(out)} (${code ?? "unknown error"})`, { write_attempted: true, safe_to_retry: false });
      }
    }
    const warnings = [
      ...mapWarnings,
      ...(t.data.bass_source === null ? ["BASS_FROM_CHORDS: the bass stem is silent (the separation put no bass in it). The Bass track plays the map's chord roots"] : []),
      ...(t.data.lead_source === null ? ["NO_LEAD: the vocal stem is silent. The draft has no lead (gb-mcp does not transcribe an instrumental melody)"] : []),
      ...issues.filter((i) => i.severity === "warning").map((i) => `${i.code} ${i.path}: ${i.message}`),
    ];
    return verified(op, { song: draft, ...(out ? { path: out } : {}), map: mapPath, lead_source: t.data.lead_source, place: map.place }, warnings);
  }

  return async function gbSong(input: unknown): Promise<Envelope> {
    const parsedInput = GbSongInput.safeParse(input);
    if (!parsedInput.success) {
      const issue = parsedInput.error.issues[0]!;
      return failed("gb_song", "INPUT_INVALID", `${issue.path.join(".") || "command"}: ${issue.message}`,
        { hint: `command must be one of: ${GB_SONG_COMMANDS.join(", ")}` });
    }
    const cmd = parsedInput.data;
    const op = `gb_song.${cmd.command}`;

    if (cmd.command === "transcribe") return transcribe(cmd);

    if (cmd.command === "template") {
      const variant = cmd.variant ?? 0;
      const draft = templateSong({ genre: cmd.genre, key: cmd.key, ...(cmd.bpm ? { bpm: cmd.bpm } : {}), ...(cmd.meter ? { meter: cmd.meter } : {}),
        ...(cmd.title ? { title: cmd.title } : {}), variant });
      if (!draft.ok) return failed(op, "INPUT_INVALID", `genre: not a known genre`, { hint: `genres: ${Object.keys(GENRE_TEMPLATES).join(", ")}` });
      const loops = COMMON_LOOPS[cmd.genre]?.[/minor$/.test(cmd.key) ? "minor" : "major"];
      const source = variant === 0 ? "the template's hand-written progressions (variant 1–3: the genre's common loops)"
        : `the ${["most", "second most", "third most"][variant - 1]} common 4-chord loop in verses and choruses of ${loops?.pooled
          ? "songs of all genres (too few songs are tagged with this genre)" : `songs tagged ${cmd.genre}`} — Chordonomicon statistics`;
      return verified(op, { song: draft.value, progressions: { variant, source },
        note: "a genre draft to develop: change the hook, add sections, vary parts — then validate and render" });
    }

    const parsed = parseSong(cmd.song);
    if (!parsed.ok) {
      return failed(op, "SONG_INVALID", `${parsed.error.path}: ${parsed.error.message}`,
        { hint: "fix the field at the given path; read gb://knowledge/song-format for the schema" });
    }
    const song = parsed.value;

    switch (cmd.command) {
      case "validate":
        return verified(op, { issues: validateSong(song, { voiceLeading: cmd.voice_leading === true }), summary: summarize(song) });

      case "band_plan": {
        // read-only: the agent passes `audio` to gb_band build with its donor (gb_song never touches donors)
        const plan = bandPlan(song);
        if (!plan.ok) {
          return failed(op, "NOT_SUPPORTED", plan.error.message, {
            hint: plan.error.code === "NO_AUDIO" ? "a song without audio clips is a MIDI song: render_midi makes it" : "use a 4/4 song",
          });
        }
        return verified(op, plan.value);
      }

      case "infill": {
        if (cmd.candidates > 1 && !cmd.judge) return failed(op, "INPUT_INVALID", "judge: several candidates need a judge text (what the music should be)", { hint: 'e.g. judge: "warm neo-soul keys"' });
        if (!deps.models) return failed(op, "DEPENDENCY_MISSING", "the model sidecar is not set up", { hint: "install the models (models/.venv) to use infill" });
        const sectionIndex = song.sections.findIndex((s) => s.name === cmd.section);
        if (sectionIndex < 0) return failed(op, "INPUT_INVALID", "section: not in the song", { hint: `sections: ${song.sections.map((s) => s.name).join(", ")}` });
        const targets = cmd.tracks.map((name) => song.tracks.findIndex((t) => t.name === name));
        if (targets.some((i) => i < 0)) return failed(op, "INPUT_INVALID", "tracks: a name is not in the song", { hint: `tracks: ${song.tracks.map((t) => t.name).join(", ")}` });
        if (targets.some((i) => song.tracks[i]!.role === "drums")) return failed(op, "INPUT_INVALID", "tracks: drums cannot be infilled (melodic tracks only)");
        const rendered = renderSong({ ...song, humanize: "off" });
        if (!rendered.ok) return failed(op, "RENDER_FAILED", `${rendered.error.path}: ${rendered.error.message}`);
        const programs = targets.map((i) => rendered.value.tracks[i]!.program ?? 0);
        if (new Set(programs).size < programs.length) {
          return failed(op, "INPUT_INVALID", "tracks: two of them use the same instrument, so the model cannot tell their notes apart", { hint: "give each a different program, or infill them one at a time" });
        }
        const smf = writeSmf(rendered.value);
        if (!smf.ok) return failed(op, "RENDER_FAILED", smf.error.message);
        const midi = join(tmpdir(), `gb-mcp-infill-${process.pid}-${Date.now()}.mid`); // the model reads a file; not the workspace
        writeFileSync(midi, smf.value, { flag: "wx" });
        const beats = song.timeSignature[0];
        const barS = (beats * 60) / song.tempo;
        const startS = song.sections.slice(0, sectionIndex).reduce((sum, s) => sum + s.bars, 0) * barS;
        const bars = song.sections[sectionIndex]!.bars;
        const models = deps.models;
        /** one take: the model writes the section with this seed; the caller's own Song JSON comes back with only those parts replaced */
        const take = async (seed: number) => {
          const heard = await models.run("infill", { midi, start_s: startS, end_s: startS + bars * barS, instruments: programs, mode: cmd.mode, seed });
          if (!heard.ok) return heard;
          const { notes, capped } = heard.value as { notes: (InfillNote & { instrument: number })[]; capped?: boolean };
          const parts = targets.map((_, k) => notesToPart(notes.filter((n) => n.instrument === programs[k]), { startS, bpm: song.tempo, beatsPerBar: beats, bars }));
          const raw = cmd.song as { tracks: unknown[] };
          const out = { ...(cmd.song as object), tracks: raw.tracks.map((t, i) => (targets.includes(i) ? { ...(t as object), parts: { ...((t as { parts: object }).parts), [cmd.section]: { notes: parts[targets.indexOf(i)]! } } } : t)) };
          const changed = targets.map((i, k) => ({ track: song.tracks[i]!.name, section: cmd.section, notes: notes.filter((n) => n.instrument === programs[k]).length }));
          return { ok: true as const, value: { seed, song: out, changed, capped: capped === true } };
        };
        const first = cmd.seed ?? song.seed;
        const takes: { seed: number; song: Record<string, unknown>; changed: { track: string; section: string; notes: number }[]; capped: boolean }[] = [];
        for (let k = 0; k < cmd.candidates; k++) {
          const t = await take(first + k);
          if (!t.ok) return failed(op, t.error.code === "SIDECAR_UNAVAILABLE" ? "DEPENDENCY_MISSING" : "RENDER_FAILED", t.error.message);
          takes.push(t.value);
        }
        if (takes.length === 1) {
          const t = takes[0]!;
          return verified(op, { song: t.song, changed: t.changed, mode: cmd.mode, seed: t.seed, ...(t.capped ? { capped: true } : {}),
            note: t.capped ? "the model ran away and was stopped early (capped): try another seed" : "validate, render and listen; infill again with another seed for a different take" });
        }
        // judge: each take as a whole song (MIDI) against the text, by CLaMP 3 — a ranking, not a grade
        const midis = [];
        for (const t of takes) {
          const parsed = parseSong(t.song);
          const r = parsed.ok ? renderSong({ ...parsed.value, humanize: "off" }) : null;
          const bytes = r?.ok ? writeSmf(r.value) : null;
          if (!bytes?.ok) return failed(op, "RENDER_FAILED", `take with seed ${t.seed} does not render`);
          const path = join(tmpdir(), `gb-mcp-take-${process.pid}-${Date.now()}-${t.seed}.mid`);
          writeFileSync(path, bytes.value, { flag: "wx" });
          midis.push(path);
        }
        const judged = await models.run("clamp3", { midis, prompt: cmd.judge });
        if (!judged.ok) return failed(op, judged.error.code === "SIDECAR_UNAVAILABLE" ? "DEPENDENCY_MISSING" : "RENDER_FAILED", judged.error.message);
        const { scores } = judged.value as { scores: number[] };
        // a capped take is a runaway the budget stopped: never the pick while a normal take exists
        const eligible = takes.map((t, k) => k).filter((k) => !takes[k]!.capped);
        const pool = eligible.length > 0 ? eligible : takes.map((_, k) => k);
        const best = pool.reduce((b, k) => (scores[k]! > scores[b]! ? k : b), pool[0]!);
        return verified(op, {
          song: takes[best]!.song, changed: takes[best]!.changed, mode: cmd.mode, seed: takes[best]!.seed, judge: cmd.judge,
          takes: takes.map((t, k) => ({ seed: t.seed, score: scores[k], ...(t.capped ? { capped: true } : {}), ...(k === best ? { best: true } : {}) })),
          note: "CLaMP 3 ranked the takes against `judge` (a ranking, not a grade); any take can be had again with its seed",
        });
      }

      case "preview":
        return verified(op, { grid: previewSong(song, { section: cmd.section, ...(cmd.maxBars ? { maxBars: cmd.maxBars } : {}) }) });

      case "render_midi": {
        const name = SafeMidiFilename.safeParse(cmd.filename);
        if (!name.success) return failed(op, "PATH_INVALID", `filename: ${name.error.issues[0]!.message}`);
        const path = join(workspace, name.data);

        const issues = validateSong(song);
        const errors = issues.filter((i) => i.severity === "error");
        if (errors.length > 0) {
          return failed(op, "VALIDATION_FAILED", `${errors.length} musical error(s); nothing written`, { context: { issues: errors } });
        }
        const warnings = issues.filter((i) => i.severity === "warning").map((i) => `${i.code} ${i.path}: ${i.message}`);
        if (song.tracks.some((t) => t.audio)) warnings.push(AUDIO_LEFT_OUT);
        const summary = summarize(song);
        if (cmd.dry_run) return verified(op, { dry_run: true, path, ...summary }, warnings);

        const performance = perform(song);
        if (!performance.ok) return failed(op, "RENDER_FAILED", performance.message);
        const smf = writeSmf(performance.smf);
        if (!smf.ok) return failed(op, "RENDER_FAILED", smf.error.message);

        try {
          mkdirSync(workspace, { recursive: true });
          writeFileSync(path, smf.value, { flag: "wx" }); // exclusive: never overwrite
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EEXIST") {
            return failed(op, "FILE_EXISTS", `${name.data} already exists in the workspace; nothing written`,
              { hint: "choose a new filename (e.g. add -v2); files are never overwritten" });
          }
          return failed(op, "WRITE_FAILED", `could not write ${name.data} (${code ?? "unknown error"})`, { write_attempted: true, safe_to_retry: false });
        }
        return verified(op, { path, bytes: smf.value.length, ...summary }, warnings);
      }

      case "render_draft": {
        const name = SafeWavFilename.safeParse(cmd.filename);
        if (!name.success) return failed(op, "PATH_INVALID", `filename: ${name.error.issues[0]!.message}`);
        const path = join(workspace, name.data);
        if (!deps.gmRenderer) {
          return failed(op, "DEPENDENCY_MISSING", "the GM draft renderer is not available", { hint: "build it with: npm run build:native" });
        }
        if (existsSync(path)) {
          return failed(op, "FILE_EXISTS", `${name.data} already exists in the workspace; nothing written`, { hint: "choose a new filename" });
        }
        const errors = validateSong(song).filter((i) => i.severity === "error");
        if (errors.length > 0) {
          return failed(op, "VALIDATION_FAILED", `${errors.length} musical error(s); nothing rendered`, { context: { issues: errors } });
        }
        const draftWarnings = song.tracks.some((t) => t.audio) ? [AUDIO_LEFT_OUT] : [];
        if (cmd.dry_run) return verified(op, { dry_run: true, path, draft: true, ...summarize(song) }, draftWarnings);
        const performance = perform(song);
        if (!performance.ok) return failed(op, "RENDER_FAILED", performance.message);
        mkdirSync(workspace, { recursive: true });
        const r = await deps.gmRenderer.render(smfSongToEvents(performance.smf), path);
        if (!r.ok) {
          return failed(op, r.error.code, r.error.message, { write_attempted: r.error.code === "RENDER_FAILED" || r.error.code === "WRITE_FAILED" });
        }
        return verified(op, {
          ...r.value,
          draft: true,
          note: "macOS GM synth draft: good for structure, tempo and section checks; GarageBand patches sound very different (use a GarageBand export for tone decisions)",
        }, draftWarnings);
      }
    }
  };
}
