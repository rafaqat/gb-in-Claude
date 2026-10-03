// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { z } from "zod";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSong, type Song } from "../song/schema.js";
import { validateSong } from "../song/validate.js";
import { previewSong } from "../song/preview.js";
import { renderSong, PPQ } from "../song/render.js";
import { humanize } from "../song/humanize.js";
import { writeSmf, type SmfSong } from "../midi/smf.js";
import { smfSongToEvents } from "../render/gm-events.js";
import type { GmRendererPort } from "../render/gm-renderer.js";
import { applyTrackLevels } from "../song/levels.js";
import { patchFor } from "../knowledge/gm-patch-map.js";
import { bandPlan } from "../song/band-plan.js";
import { verified, failed, type Envelope } from "./envelope.js";

/** Safe output names: no paths, no encodings, no hidden files, .mid only. */
const SafeMidiFilename = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}\.mid$/,
  "letters, digits, space, _ or -, ending in .mid (no paths)");
const SafeWavFilename = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}\.wav$/,
  "letters, digits, space, _ or -, ending in .wav (no paths)");

export const GbSongInput = z.discriminatedUnion("command", [
  z.object({ command: z.literal("validate"), song: z.unknown() }).strict(),
  z.object({ command: z.literal("preview"), song: z.unknown(), section: z.string().min(1), maxBars: z.number().int().min(1).max(64).optional() }).strict(),
  z.object({ command: z.literal("render_midi"), song: z.unknown(), filename: z.string(), dry_run: z.boolean().optional() }).strict(),
  z.object({ command: z.literal("render_draft"), song: z.unknown(), filename: z.string(), dry_run: z.boolean().optional() }).strict(),
  z.object({ command: z.literal("band_plan"), song: z.unknown() }).strict(),
]);
export type GbSongInput = z.infer<typeof GbSongInput>;
export const GB_SONG_COMMANDS = ["validate", "preview", "render_midi", "render_draft", "band_plan"] as const;

/** Song JSON audio clips are built by gb_band; the MIDI file and the GM draft leave them out. */
const AUDIO_LEFT_OUT = "AUDIO_LEFT_OUT: MIDI cannot carry the audio clips; gb_song band_plan + gb_band build place them";

export type GbSongDeps = { workspaceDir: string; gmRenderer?: GmRendererPort };

/** Render + humanize: the performance that both the MIDI file and the draft audio are made from. */
function perform(song: Song): { ok: true; smf: SmfSong } | { ok: false; message: string } {
  const rendered = renderSong(song);
  if (!rendered.ok) return { ok: false, message: `${rendered.error.path}: ${rendered.error.message}` };
  const roleTracks = rendered.value.tracks.map((t, i) => ({ ...t, role: song.tracks[i]!.role }));
  const performed = humanize(roleTracks, { feel: song.humanize, seed: song.seed, tempoBpm: song.tempo, ppq: PPQ });
  const levels = Object.fromEntries(song.tracks.filter((t) => t.level !== undefined).map((t) => [t.name, t.level!]));
  const leveled = applyTrackLevels(performed.map(({ role: _role, ...t }) => t), levels);
  return { ok: true, smf: { ...rendered.value, tracks: leveled } };
}

function summarize(song: Song) {
  const bars = song.sections.reduce((sum, s) => sum + s.bars, 0);
  const rendered = renderSong({ ...song, humanize: "off" });
  const tracks = rendered.ok
    ? rendered.value.tracks.map((t) => ({ name: t.name, channel: t.channel, program: t.program, patch: t.program === undefined ? undefined : patchFor(t.program, t.channel), notes: t.notes.length }))
    : [];
  const durationSec = Math.round(((bars * song.timeSignature[0] * 60) / song.tempo) * 100) / 100;
  return { bars, durationSec, tempo: song.tempo, style: song.style ?? null, humanize: song.humanize, tracks };
}

export function createGbSong(deps: GbSongDeps) {
  const workspace = resolve(deps.workspaceDir);

  return async function gbSong(input: unknown): Promise<Envelope> {
    const parsedInput = GbSongInput.safeParse(input);
    if (!parsedInput.success) {
      const issue = parsedInput.error.issues[0]!;
      return failed("gb_song", "INPUT_INVALID", `${issue.path.join(".") || "command"}: ${issue.message}`,
        { hint: `command must be one of: ${GB_SONG_COMMANDS.join(", ")}` });
    }
    const cmd = parsedInput.data;
    const op = `gb_song.${cmd.command}`;

    const parsed = parseSong(cmd.song);
    if (!parsed.ok) {
      return failed(op, "SONG_INVALID", `${parsed.error.path}: ${parsed.error.message}`,
        { hint: "fix the field at the given path; read gb://knowledge/song-format for the schema" });
    }
    const song = parsed.value;

    switch (cmd.command) {
      case "validate":
        return verified(op, { issues: validateSong(song), summary: summarize(song) });

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
