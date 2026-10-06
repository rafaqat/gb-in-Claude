// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { z } from "zod";
import { ok, err, type Result } from "../result.js";
import { DRUM_VOICE_NAMES } from "../composition/drums.js";
import { STYLE_NAMES } from "./styles.js";
import { GROOVE_NAMES } from "./grooves.js";

export const HUMANIZE_FEELS = ["off", "tight", "natural", "loose"] as const;

export const ROLES = ["drums", "bass", "pad", "arp", "lead", "lead-high", "fx"] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

/** Where a role's chord-driven parts sit by default (scientific octave, C4 = 60). */
const DEFAULT_OCTAVE: Record<Role, number> = {
  drums: 2, bass: 2, pad: 3, arp: 4, lead: 5, "lead-high": 6, fx: 4,
};

/** Which chord-rendering styles each role understands. Roles absent here cannot use `chords`. */
export const CHORD_STYLES: Partial<Record<Role, readonly string[]>> = {
  bass: ["sustain", "offbeat", "rolling", "octave"],
  pad: ["sustain", "stabs"],
  arp: ["up", "down", "updown", "broken", "gated"],
};

/** M11 expression — every field maps to a MIDI message GarageBand honours (eval/m11/MESSAGES.md). */
const DYN = "(ppp|pp|p|mp|mf|f|ff|fff)";
export const DYNAMIC_MARKS = ["ppp", "pp", "p", "mp", "mf", "f", "ff", "fff"] as const;
/** CC11 hairpins across the part's section: "mf", "p<f", "pp<ff>mp" (stages evenly spaced). */
const Dynamics = z.string().regex(new RegExp(`^${DYN}([<>]${DYN})*$`), 'dynamics like "mf", "p<f" or "pp<ff>mp"');
const Unit = z.number().min(0).max(1);
/** A fixed value, or a ramp across the section. */
const Ramp = z.union([Unit, z.object({ from: Unit, to: Unit }).strict()]);
const PanValue = z.number().min(-1).max(1);
/** −1 left … 1 right: fixed, a sweep across the section, or auto-pan (one cycle per `cycle` bars). */
const Pan = z.union([PanValue, z.object({ from: PanValue, to: PanValue }).strict(),
  z.object({ cycle: z.number().min(0.25).max(64), depth: Unit, center: PanValue.optional() }).strict()]);
const Expression = {
  dynamics: Dynamics.optional(),
  /** Sustain pedal (CC64), re-pedalled each bar, half bar or beat. */
  pedal: z.enum(["bar", "half", "beat"]).optional(),
  pan: Pan.optional(),
  /** Filter brightness (CC74), 0–1: synth patches (measured on Soft Saw Lead). */
  brightness: Ramp.optional(),
  /** Channel volume (CC7), 0–1 (1 = GM default 100): fades. */
  volume: Ramp.optional(),
};
export type PartExpression = { dynamics?: string; pedal?: "bar" | "half" | "beat"; pan?: z.infer<typeof Pan>; brightness?: z.infer<typeof Ramp>; volume?: z.infer<typeof Ramp> };

const ChordsPart = z.object({
  chords: z.string().min(1),
  style: z.string().min(1),
  octave: z.number().int().min(0).max(8).optional(),
  ...Expression,
}).strict();

/** Level in dB applied as velocity scaling on the GM curve (dB = 40·log10(v'/v)). */
export const LevelDb = z.number().min(-24).max(6);

const GridPart = z.object({
  grid: z.record(z.enum(DRUM_VOICE_NAMES), z.string().min(1)),
  /** Per-voice level in dB, e.g. { kick: -6 } to tame a thumpy kick without touching the hats. */
  levels: z.record(z.enum(DRUM_VOICE_NAMES), LevelDb).optional(),
  /** Kit volume (CC7) — fades; drums take levels, not dynamics. */
  volume: Ramp.optional(),
}).strict().refine((p) => !p.levels || Object.keys(p.levels).every((v) => v in p.grid),
  { message: "levels may only name voices that are in the grid" });

const NotesPart = z.object({
  notes: z.string().min(1),
  ...Expression,
}).strict();

const Part = z.union([ChordsPart, GridPart, NotesPart]);
type Part = z.infer<typeof Part>;

function roleRuleViolation(role: Role, part: Part): string | undefined {
  if ("grid" in part) return role === "drums" ? undefined : `grid parts are only for drums (role is ${role})`;
  if (role === "drums") return "drums tracks take grid parts";
  if ("chords" in part) {
    const styles = CHORD_STYLES[role];
    if (!styles) return `role ${role} cannot use chords; use notes`;
    if (!styles.includes(part.style)) return `style "${part.style}" is not valid for ${role}; one of: ${styles.join(", ")}`;
  }
  return undefined;
}

/** One WAV placed in a section (bar and beat are 1-based and relative to the section start). Built by gb_band. */
const AudioClip = z.object({
  wav: z.string().min(1).max(512),
  section: z.string().min(1).max(32),
  bar: z.number().int().min(1).max(256).default(1),
  beat: z.number().min(1).max(7.999).default(1),
}).strict();

const Track = z
  .object({
    name: z.string().min(1).max(64).regex(/^[\x20-\x7e]+$/, "printable ASCII only"),
    role: Role,
    /** GM program override; otherwise the style's program for the role. */
    program: z.number().int().min(0).max(127).optional(),
    /** Track level in dB (velocity scaling on the GM curve): -6 ≈ half as loud, +6 ≈ twice. Default 0. */
    level: LevelDb.optional(),
    /** Notes run legato into the next so a mono synth slides (e.g. a trap 808). Leads always glide. */
    glide: z.boolean().optional(),
    /** Pitch-bend vibrato on notes of a beat or longer (M11). Default: "normal" for leads, "off" otherwise. */
    vibrato: z.enum(["off", "light", "normal", "wide"]).optional(),
    parts: z.record(z.string(), Part),
    /** The donor's audio track number that holds this track's clips (gb_band). */
    donorTrack: z.number().int().min(1).max(255).optional(),
    audio: z.array(AudioClip).min(1).max(64).optional(),
  })
  .strict() // a misspelled key is an error, never a silent default
  .superRefine((t, ctx) => {
    for (const [section, part] of Object.entries(t.parts)) {
      const violation = roleRuleViolation(t.role, part);
      if (violation) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["parts", section], message: violation });
    }
  })
  .transform((t) => ({
    ...t,
    parts: Object.fromEntries(
      Object.entries(t.parts).map(([section, p]) => [
        section,
        "chords" in p ? { ...p, octave: p.octave ?? DEFAULT_OCTAVE[t.role] } : p,
      ]),
    ),
  }));

const Tempo = z.number().min(20).max(300);
/** tempo: a new tempo from the section's start; tempoTo: a ramp to it by the section's end (ritardando, accelerando). */
const Section = z.object({ name: z.string().min(1).max(32), bars: z.number().int().min(1).max(256), tempo: Tempo.optional(), tempoTo: Tempo.optional() }).strict();

/** 15 melodic channels (1–16 minus drum channel 10). */
export const MAX_MELODIC_TRACKS = 15;

export const SongSchema = z
  .object({
    title: z.string().min(1).max(80),
    tempo: z.number().min(20).max(300),
    // Styles assume quarter-note beats; other meters are a deliberate later extension.
    timeSignature: z.tuple([z.number().int(), z.number().int()]).default([4, 4]),
    seed: z.number().int().default(1),
    /** Declared key, e.g. "F minor" / "Ab major" — gb_analyze checks the audio against it. */
    key: z.string().regex(/^[A-G][#b]? (major|minor)$/, 'like "F minor" or "Ab major"').optional(),
    style: z.enum(STYLE_NAMES).optional(),
    humanize: z.enum(HUMANIZE_FEELS).default("natural"),
    /** A mined genre groove (Groove MIDI Dataset): the drums take its timing and accents. 4/4 songs. */
    groove: z.enum(GROOVE_NAMES).optional(),
    /** Swing: every second 16th (or 8th, swingUnit) is delayed — 50 straight, 58 light, 66 triplet feel, 75 hard. */
    swing: z.number().min(50).max(75).optional(),
    swingUnit: z.enum(["16th", "8th"]).default("16th"),
    sections: z.array(Section).min(1),
    tracks: z.array(Track).min(1),
    /** M13.7: a tempo from a bar (and beat) on, absolute bars from the song's start — a project whose bar lines
     *  follow a recording that drifts (gb_analyze map). Not together with section tempo / tempoTo. */
    tempoMap: z.array(z.object({ bar: z.number().int().min(1), beat: z.number().min(1).max(7.999).default(1), bpm: Tempo }).strict()).min(1).optional(),
  })
  .strict()
  .superRefine((song, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    if (song.tempoMap) {
      const bars = song.sections.reduce((n, x) => n + x.bars, 0);
      if (song.sections.some((x) => x.tempo !== undefined || x.tempoTo !== undefined)) {
        issue(["tempoMap"], "use sections' tempo/tempoTo or tempoMap, not both");
      }
      song.tempoMap.forEach((t, i) => {
        if (t.bar > bars) issue(["tempoMap", i, "bar"], `bar ${t.bar} is past the song's ${bars} bars`);
        if (t.beat > song.timeSignature[0] + 0.999) issue(["tempoMap", i, "beat"], `beat ${t.beat} is past a ${song.timeSignature[0]}-beat bar`);
        const prev = song.tempoMap![i - 1];
        if (prev && (t.bar < prev.bar || (t.bar === prev.bar && t.beat <= prev.beat))) issue(["tempoMap", i], "tempoMap positions must rise");
      });
    }
    const [beats, unit] = song.timeSignature;
    if (unit !== 4 || beats < 2 || beats > 7) {
      issue(["timeSignature"], `only 2/4 to 7/4 are supported (got ${beats}/${unit}); styles assume quarter-note beats`);
    }
    const sectionNames = new Set<string>();
    song.sections.forEach((s, i) => {
      if (sectionNames.has(s.name)) issue(["sections", i, "name"], `duplicate section "${s.name}"`);
      sectionNames.add(s.name);
    });
    const trackNames = new Set<string>();
    song.tracks.forEach((t, i) => {
      if (trackNames.has(t.name)) issue(["tracks", i, "name"], `duplicate track "${t.name}"`);
      trackNames.add(t.name);
      for (const section of Object.keys(t.parts)) {
        if (!sectionNames.has(section)) {
          issue(["tracks", i, "parts", section], `unknown section "${section}"; sections: ${[...sectionNames].join(", ")}`);
        }
      }
    });
    // audio clips: a donor track to hold them, and a place that exists in the song (M7)
    const sectionBars = new Map(song.sections.map((s) => [s.name, s.bars]));
    song.tracks.forEach((t, i) => {
      if (t.audio && t.donorTrack === undefined) issue(["tracks", i, "donorTrack"], "audio clips need donorTrack (the donor's audio track; gb_band inspect lists them)");
      if (!t.audio && t.donorTrack !== undefined) issue(["tracks", i, "audio"], "donorTrack is only for tracks with audio clips");
      t.audio?.forEach((c, k) => {
        const bars = sectionBars.get(c.section);
        if (bars === undefined) issue(["tracks", i, "audio", k, "section"], `unknown section "${c.section}"; sections: ${[...sectionBars.keys()].join(", ")}`);
        else if (c.bar > bars) issue(["tracks", i, "audio", k, "bar"], `bar ${c.bar} is past the end of ${c.section} (${bars} bars)`);
        if (c.beat >= beats + 1) issue(["tracks", i, "audio", k, "beat"], `beat ${c.beat} is past the bar (${beats} beats)`);
      });
    });
    const melodic = song.tracks.filter((t) => t.role !== "drums").length;
    if (melodic > MAX_MELODIC_TRACKS) issue(["tracks"], `${melodic} melodic tracks; at most ${MAX_MELODIC_TRACKS} (MIDI channels)`);
  });

export type Song = z.output<typeof SongSchema>;
export type SongError = { code: "SONG_INVALID"; path: string; message: string };

/** For a part (a union of grid / chords / notes), report the issue of the branch the input is meant to be. */
function specificIssue(issue: z.ZodIssue): z.ZodIssue {
  if (issue.code !== "invalid_union") return issue;
  const branch = issue.unionErrors.find((e) => !e.issues.some((i) => i.code === "invalid_type" && i.received === "undefined"
    && ["grid", "chords", "notes"].includes(String(i.path[i.path.length - 1]))));
  return branch ? specificIssue(branch.issues[0]!) : issue;
}

export function parseSong(input: unknown): Result<Song, SongError> {
  const parsed = SongSchema.safeParse(input);
  if (!parsed.success) {
    const issue = specificIssue(parsed.error.issues[0]!);
    return err({ code: "SONG_INVALID", path: issue.path.join("."), message: issue.message });
  }
  return ok(parsed.data);
}
