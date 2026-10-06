// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * gb_band — GarageBand projects (.band) written directly, beyond MIDI: audio regions (samples, stems) and MIDI notes
 * placed into a GarageBand-made donor project. Paths stay inside the workspace; nothing is ever overwritten.
 */
import { z } from "zod";
import { scaleVelocity } from "../song/levels.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspaceBand, resolveWorkspaceFile, workspaceOutputDir } from "../workspace/paths.js";
import { inspectBand } from "../band/inspect.js";
import { BuildBandHandler } from "../band/handler.js";
import { parseNotes } from "../composition/mini-notation.js";
import { cleanText } from "../sound/text.js";
import { BAND_AUDIO_LIMITS, type BandMidi, type BuildBandError } from "../band/spec.js";
import { verified, failed, type Envelope, type ErrorCode } from "./envelope.js";

const TICKS_PER_BEAT = 960;
const BEATS_PER_BAR = 4; // 4/4 donors
const BandFilename = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}\.band$/, "letters, digits, space, _ or -, ending in .band (no paths)");
const RegionName = z.string().regex(/^[\x20-\x7e]{1,38}$/, "printable ASCII, at most 38 characters");

/** One WAV placed on one of the donor's audio tracks. */
export const BandAudioItem = z.object({
  wav: z.string().min(1).describe("a 16/24-bit PCM WAV inside the workspace"),
  bar: z.number().int().min(1).max(BAND_AUDIO_LIMITS.maxBar),
  beat: z.number().min(1).max(BAND_AUDIO_LIMITS.maxBeat).optional().describe("1-based beat in the bar (default 1)"),
  track: z.number().int().min(1).max(255).describe("the donor's audio track number"),
  name: RegionName.optional(),
  pair: z.number().int().min(1).max(255).optional()
    .describe("a stereo WAV on two mono tracks: the left channel on track, the right on this track, panned hard left and right"),
}).strict().refine((a) => a.pair === undefined || a.pair !== a.track, { message: "pair must be another track than track", path: ["pair"] });

/** New notes for one of the donor's MIDI regions. */
export const BandMidiItem = z.object({
  region: RegionName.describe("a MIDI region of the donor, by name"),
  notes: z.string().min(1).max(20_000).describe('Song JSON note syntax, e.g. "d4 f#4 a4 d5 | a4@4"'),
  bars: z.number().int().min(1).max(9999).describe("region length in bars"),
  velocity: z.number().int().min(1).max(127).optional(),
  program: z.number().int().min(0).max(127).optional(),
}).strict();

export const GbBandInput = z.discriminatedUnion("command", [
  z.object({ command: z.literal("inspect"), path: z.string().min(1).describe("a .band inside the workspace") }).strict(),
  z.object({
    command: z.literal("build"),
    donor: z.string().min(1).describe("a .band GarageBand saved, inside the workspace (gb_band inspect shows its slots)"),
    filename: BandFilename.describe("written to bands/<filename> in the workspace (never overwritten)"),
    audio: z.array(BandAudioItem).min(1).max(BAND_AUDIO_LIMITS.maxItems),
    midi: z.array(BandMidiItem).max(64).optional()
      .refine((m) => !m || new Set(m.map((x) => x.region)).size === m.length, { message: "each MIDI region may be named once" }),
    dry_run: z.boolean().optional(),
  }).strict(),
]);
export type GbBandInput = z.infer<typeof GbBandInput>;
export const GB_BAND_COMMANDS = ["inspect", "build"] as const;

export type GbBandDeps = { workspaceDir: string };

/** The builder's error codes in the shared result contract. */
const BAND_CODES: Record<BuildBandError["code"], ErrorCode> = {
  INPUT_INVALID: "INPUT_INVALID", OUT_EXISTS: "FILE_EXISTS", DONOR_INVALID: "DONOR_INVALID", WAV_INVALID: "AUDIO_INVALID", REGION_COUNT: "DONOR_TOO_SMALL",
  TRACK_NOT_IN_DONOR: "TRACK_NOT_IN_DONOR", MIDI_REGION_NOT_IN_DONOR: "MIDI_REGION_NOT_IN_DONOR", BEND_RANGE: "VALIDATION_FAILED", WRITE_FAILED: "WRITE_FAILED", UNKNOWN_ERROR: "INTERNAL_ERROR",
};
const ACCENT_DB = { accent: 4, soft: -8 } as const;

/** Song JSON note syntax → the builder's notes (ticks at 960 PPQ), or why not. */
function midiPart(m: z.infer<typeof BandMidiItem>, i: number): { ok: true; value: BandMidi } | { ok: false; message: string } {
  const parsed = parseNotes(m.notes, BEATS_PER_BAR);
  if (!parsed.ok) return { ok: false, message: `midi.${i}: ${parsed.error.message}` };
  if (parsed.value.bars > m.bars) return { ok: false, message: `midi.${i}: the notes span ${parsed.value.bars} bars but the region is ${m.bars}` };
  const notes = parsed.value.events.flatMap((e) => e.pitches.map((pitch) => ({
    tick: Math.round(e.startBeat * TICKS_PER_BEAT), pitch, length: Math.max(1, Math.round(e.durationBeats * TICKS_PER_BEAT)),
    velocity: e.accent ? scaleVelocity(m.velocity ?? 96, ACCENT_DB[e.accent]) : (m.velocity ?? 96),
    ...(e.slide ? { slide: e.slide } : {}), ...(e.cents !== undefined ? { cents: e.cents } : {}), // M11: bends, computed by the builder
  })));
  return { ok: true, value: { region: m.region, notes, length: m.bars * BEATS_PER_BAR * TICKS_PER_BEAT, ...(m.program !== undefined ? { program: m.program } : {}) } };
}

export function createGbBand(deps: GbBandDeps) {
  return async function gbBand(input: unknown): Promise<Envelope> {
    const parsed = GbBandInput.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return failed("gb_band", "INPUT_INVALID", `${issue.path.join(".") || "command"}: ${issue.message}`, { hint: `commands: ${GB_BAND_COMMANDS.join(", ")}` });
    }
    const cmd = parsed.data;
    const op = `gb_band.${cmd.command}`;

    if (cmd.command === "inspect") {
      const band = resolveWorkspaceBand(deps.workspaceDir, cmd.path);
      if (!band.ok) return failed(op, band.error.code, band.error.message, { hint: "a .band package inside the workspace, e.g. donors/donor-av.band" });
      const summary = inspectBand(band.value);
      if (!summary.ok) return failed(op, "INPUT_INVALID", summary.error.message);
      return verified(op, summary.value);
    }

    const donor = resolveWorkspaceBand(deps.workspaceDir, cmd.donor);
    if (!donor.ok) return failed(op, donor.error.code, `donor: ${donor.error.message}`, { hint: "gb_band inspect shows what a donor offers" });
    const offers = inspectBand(donor.value);
    if (!offers.ok) return failed(op, "DONOR_INVALID", `donor: ${offers.error.message}`, { hint: "use a .band that GarageBand 10.4.14 saved" });
    const donorRegions = offers.value.midi.map((m) => m.region);
    const unknown = (cmd.midi ?? []).find((m) => !donorRegions.includes(m.region));
    if (unknown) {
      // Region names are text a person typed in GarageBand: data for context, never message text.
      return failed(op, "MIDI_REGION_NOT_IN_DONOR", "the donor has no MIDI region with that name", {
        hint: "gb_band inspect lists the donor's MIDI regions", context: { region: unknown.region, donor_regions: donorRegions.map((r) => cleanText(r)) },
      });
    }
    const regions = [];
    const pans: { track: number; pan: number }[] = [];
    for (const [i, a] of cmd.audio.entries()) {
      const wav = resolveWorkspaceFile(deps.workspaceDir, a.wav, [".wav"]);
      if (!wav.ok) return failed(op, wav.error.code, `audio.${i}: ${wav.error.message}`);
      const tick = Math.round(((a.bar - 1) * BEATS_PER_BAR + ((a.beat ?? 1) - 1)) * TICKS_PER_BEAT);
      if (a.pair === undefined) {
        regions.push({ wav: wav.value, tick, track: a.track, ...(a.name !== undefined ? { name: a.name } : {}) });
        continue;
      }
      // M13.18: GarageBand's Mic or Line tracks are mono here — a stereo stem keeps its image as two hard-panned tracks
      const named = (side: string) => (a.name !== undefined ? { name: `${a.name.slice(0, 36)} ${side}` } : {});
      regions.push({ wav: wav.value, tick, track: a.track, channel: 0 as const, ...named("L") }, { wav: wav.value, tick, track: a.pair, channel: 1 as const, ...named("R") });
      pans.push({ track: a.track, pan: -64 }, { track: a.pair, pan: 63 });
    }
    const panned = new Set<number>();
    for (const p of pans) {
      if (panned.has(p.track)) return failed(op, "INPUT_INVALID", `track ${p.track} is in two stereo pairs`);
      panned.add(p.track);
    }
    const midi: BandMidi[] = [];
    for (const [i, m] of (cmd.midi ?? []).entries()) {
      const part = midiPart(m, i);
      if (!part.ok) return failed(op, "INPUT_INVALID", part.message, { hint: "notes use the Song JSON syntax (gb://knowledge/song-format)" });
      midi.push(part.value);
    }
    const bands = existsSync(join(deps.workspaceDir, "bands")) || !cmd.dry_run ? workspaceOutputDir(deps.workspaceDir, "bands", !cmd.dry_run) : null;
    if (bands && !bands.ok) return failed(op, bands.error.code, `bands/: ${bands.error.message}`, { hint: "bands/ must be a plain folder inside the workspace" });
    const out = join(bands?.value ?? join(deps.workspaceDir, "bands"), cmd.filename);
    if (existsSync(out)) return failed(op, "FILE_EXISTS", `${cmd.filename} already exists in the workspace; nothing written`, { hint: "choose a new filename" });
    if (cmd.dry_run) {
      return verified(op, { dry_run: true, path: out, donor: donor.value, audio: regions.map((r) => ({ tick: r.tick, track: r.track, wav: r.wav, ...("channel" in r ? { channel: r.channel === 0 ? "left" : "right" } : {}) })), midi: midi.map((m) => ({ region: m.region, notes: m.notes.length })), ...(pans.length ? { pans } : {}) });
    }
    const built = await new BuildBandHandler().execute({ donor: donor.value, out, regions, ...(midi.length ? { midi } : {}), ...(pans.length ? { pans } : {}) });
    if (!built.ok) {
      if (built.error.written) {
        // a partial package exists under the new name; gb-mcp never deletes, so the agent must know it is there
        return failed(op, BAND_CODES[built.error.code], built.error.message, {
          hint: "build again under a new filename; the partial project is not usable", context: { written: true, path: out },
        });
      }
      return failed(op, BAND_CODES[built.error.code], built.error.message, {
        hint: "gb_band inspect shows the donor's audio tracks and MIDI regions", ...(built.error.detail ? { context: { detail: cleanText(built.error.detail) } } : {}),
      });
    }
    const summary = inspectBand(out);
    if (!summary.ok) return failed(op, "WRITE_FAILED", `the new project does not read back: ${summary.error.message}`);
    return verified(op, { path: out, ...summary.value, ...(pans.length ? { pans } : {}) });
  };
}
