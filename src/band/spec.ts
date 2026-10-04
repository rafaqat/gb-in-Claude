// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * Contract for building a GarageBand project (.band) from a GarageBand-made donor plus WAV regions.
 * Paths arrive already resolved inside the workspace (the tool layer checks them); this contract only parses shape.
 */
import { z } from "zod";
import type { Result } from "../result.js";

/** A WAV basename that can live in Media/Audio Files as-is: letters, digits, space, dot, dash, underscore. */
const WAV_BASENAME = /(?:^|\/)[A-Za-z0-9 ._-]{1,64}\.wav$/i;
/** GarageBand stores region names as ASCII in a ~38-character slot. */
const REGION_NAME = /^[\x20-\x7e]{1,38}$/;

export const BandRegion = z.object({
  wav: z.string().min(1).regex(WAV_BASENAME, "a .wav file whose name uses letters, digits, space, . - _"),
  tick: z.number().int().min(0).max(2_000_000_000).describe("start, in ticks from the song start (960 per quarter note)"),
  track: z.number().int().min(1).max(255).describe("1-based audio track of the donor"),
  name: z.string().regex(REGION_NAME, "printable ASCII, at most 38 characters").optional().describe("region name; default: the file name"),
}).strict();
export type BandRegion = z.infer<typeof BandRegion>;

export const BandNote = z.object({
  tick: z.number().int().min(0).max(2_000_000_000).describe("start, in ticks from the region start (960 per quarter note)"),
  pitch: z.number().int().min(0).max(127),
  velocity: z.number().int().min(1).max(127),
  length: z.number().int().min(1).max(2_000_000_000),
  /** M11: the note bends to `semitones` arriving at `at` (0–1 of its length) — meend; cents: a fixed offset. */
  slide: z.array(z.object({ at: z.number().min(0).max(1), semitones: z.number().min(-24).max(24) }).strict()).max(16).optional(),
  cents: z.number().min(-99).max(99).optional(),
}).strict();

export const BandMidi = z.object({
  region: z.string().regex(REGION_NAME).describe("the name of a MIDI region in the donor (its MIDI track name)"),
  notes: z.array(BandNote).max(20_000),
  length: z.number().int().min(1).max(2_000_000_000).describe("region length in ticks"),
  program: z.number().int().min(0).max(127).optional().describe("GM program written in the region; default: the donor's"),
}).strict();
export type BandMidi = z.infer<typeof BandMidi>;

export const BuildBandInput = z.object({
  donor: z.string().min(1).describe("a .band that GarageBand itself saved, with at least as many audio regions"),
  out: z.string().min(1).describe("the new .band (must not exist)"),
  regions: z.array(BandRegion).min(1).max(64),
  midi: z.array(BandMidi).max(64).optional().describe("new notes for the donor's MIDI regions, by region name")
    .refine((m) => !m || new Set(m.map((x) => x.region)).size === m.length, { message: "each MIDI region may be named once" }),
}).strict();
export type BuildBandInput = z.infer<typeof BuildBandInput>;

/** gb_band build's limits for one audio item list (4/4 donors); gb_song band_plan plans only within them. */
export const BAND_AUDIO_LIMITS = { maxItems: 64, maxBar: 9999, maxBeat: 4.999 } as const;

export const BuildBandErrorCode = z.enum(["INPUT_INVALID", "OUT_EXISTS", "DONOR_INVALID", "WAV_INVALID", "REGION_COUNT", "TRACK_NOT_IN_DONOR", "MIDI_REGION_NOT_IN_DONOR", "BEND_RANGE", "WRITE_FAILED", "UNKNOWN_ERROR"]);
export type BuildBandError = {
  code: z.infer<typeof BuildBandErrorCode>; message: string; recoverable: boolean; suggestion?: string;
  /** true when the build had begun to write: a partial project exists under the output name. */
  written?: boolean;
  /** Raw detail (a donor-relative path, an OS error): donor text — for context only, never a message. */
  detail?: string;
};

export type BuiltRegion = { track: number; tick: number; file: string; frames: number };
export type BuildBandResult = Result<{ out: string; regions: BuiltRegion[] }, BuildBandError>;

export interface BuildBandSpec {
  execute(input: BuildBandInput): Promise<BuildBandResult>;
}
