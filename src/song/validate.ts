// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { INSTRUMENT_RANGES } from "../knowledge/instrument-ranges.js";
import { patchFor } from "../knowledge/gm-patch-map.js";
import { bendRangeFor } from "../knowledge/bend-ranges.js";
import { renderSong, PPQ, type ExpressiveNote } from "./render.js";
import { voiceLeading } from "./voice-leading.js";
import type { PartExpression, Song } from "./schema.js";

export type Issue = {
  severity: "error" | "warning";
  code: "OUT_OF_INSTRUMENT_RANGE" | "RENDER_FAILED" | "ROLE_REGISTER" | "EMPTY_SECTION" | "HUMANIZE_OFF"
    | "BEND_RANGE" | "BEND_NEEDS_MONO" | "BEND_RANGE_UNMEASURED" | "NO_PITCH_BEND" | "BRIGHTNESS_SYNTH_ONLY"
    | "PARALLEL_FIFTHS" | "PARALLEL_OCTAVES" | "LARGE_LEAP" | "VOICE_CROSSING";
  path: string;
  message: string;
};

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const noteName = (midi: number) => `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
const MAX_LISTED = 6;

/** Where each role should live in a mix (warnings only). Bass: E1–G3 keeps the low end clean. */
const ROLE_REGISTER: Partial<Record<Song["tracks"][number]["role"], [number, number]>> = {
  bass: [28, 55],
  lead: [60, 108],
  "lead-high": [72, 115],
};

/** Musical checks on a parsed song. Structural validity is parseSong's job; this finds what would sound wrong. */
export type ValidateOptions = { /** M13.4: the classical voice-leading checks (opt-in) */ voiceLeading?: boolean };

export function validateSong(song: Song, opts: ValidateOptions = {}): Issue[] {
  const rendered = renderSong({ ...song, humanize: "off" });
  if (!rendered.ok) {
    return [{ severity: "error", code: "RENDER_FAILED", path: rendered.error.path, message: rendered.error.message }];
  }
  const issues: Issue[] = [];
  if (song.humanize === "off") {
    issues.push({ severity: "warning", code: "HUMANIZE_OFF", path: "humanize",
      message: 'humanize is "off": every note is on the grid at fixed velocity and will sound mechanical. Use "natural" unless you want a machine feel.' });
  }
  for (const s of song.sections) {
    if (!song.tracks.some((t) => s.name in t.parts)) {
      issues.push({ severity: "warning", code: "EMPTY_SECTION", path: `sections.${s.name}`,
        message: `section "${s.name}" (${s.bars} bars) has no parts: silence. Add parts or remove the section.` });
    }
  }
  for (const [i, track] of rendered.value.tracks.entries()) {
    const register = ROLE_REGISTER[song.tracks[i]!.role];
    if (register && track.notes.length > 0) {
      const pitches = track.notes.map((n) => n.pitch);
      const lo = Math.min(...pitches), hi = Math.max(...pitches);
      if (lo < register[0] || hi > register[1]) {
        issues.push({ severity: "warning", code: "ROLE_REGISTER", path: `tracks.${track.name}`,
          message: `${song.tracks[i]!.role} spans ${noteName(lo)}–${noteName(hi)}; it usually sits in ${noteName(register[0])}–${noteName(register[1])}. Check the octave.` });
      }
    }
  }
  for (const track of rendered.value.tracks) {
    const range = track.program === undefined || track.channel === 10 ? undefined : INSTRUMENT_RANGES[track.program];
    if (!range) continue;
    const outside = [...new Set(track.notes.map((n) => n.pitch).filter((p) => p < range.low || p > range.high))].sort((a, b) => a - b);
    if (outside.length === 0) continue;
    const listed = outside.slice(0, MAX_LISTED).map(noteName).join(", ") + (outside.length > MAX_LISTED ? ", …" : "");
    issues.push({
      severity: "error",
      code: "OUT_OF_INSTRUMENT_RANGE",
      path: `tracks.${track.name}`,
      message: `${range.patch} (program ${track.program}) plays ${noteName(range.low)}–${noteName(range.high)}; ` +
        `${outside.length} note${outside.length === 1 ? "" : "s"} out of range: ${listed}. ` +
        `Transpose the part, or move it to an instrument that reaches it (e.g. role "lead-high").`,
    });
  }
  issues.push(...expressionIssues(song, rendered.value.tracks));
  // M13.4: each lead line against each bass line — opt-in warnings (classical rules; pop and EDM double on purpose)
  if (!opts.voiceLeading) return issues;
  const ticksPerBar = PPQ * song.timeSignature[0];
  const byRole = (roles: readonly string[]) => rendered.value.tracks.filter((_, i) => roles.includes(song.tracks[i]!.role));
  for (const lead of byRole(["lead", "lead-high"])) {
    for (const bass of byRole(["bass"])) {
      for (const v of voiceLeading(lead, bass, ticksPerBar, PPQ)) issues.push({ severity: "warning", ...v });
    }
  }
  return issues;
}

/** GM synth programs (synth bass, leads, pads, fx): CC74 brightness was measured on one of them (Soft Saw Lead). */
const isSynth = (program: number) => program === 38 || program === 39 || (program >= 80 && program <= 103);

/** M11: bends and controllers against what the GarageBand patch does (eval/m11/MESSAGES.md). */
function expressionIssues(song: Song, tracks: { name: string; channel: number; program?: number | undefined; notes: ExpressiveNote[] }[]): Issue[] {
  const issues: Issue[] = [];
  song.tracks.forEach((t, i) => {
    const track = tracks[i]!;
    if (t.role === "drums" || track.program === undefined) return;
    const patch = patchFor(track.program, track.channel) ?? `program ${track.program}`;
    const range = bendRangeFor(patchFor(track.program, track.channel));
    const path = `tracks.${t.name}`;
    const bent = track.notes.filter((n) => n.slide?.length || n.cents !== undefined);
    if (bent.length) {
      const chords = track.notes.some((n, k) => track.notes.some((m, j) => j !== k && m.startTick === n.startTick))
        || Object.values(t.parts).some((p) => "chords" in p);
      if (chords) {
        issues.push({ severity: "error", code: "BEND_NEEDS_MONO", path,
          message: "slides and cent offsets need a single-note line: a pitch bend moves every note sounding on the channel. Move the chords to another track." });
      }
      const widest = Math.max(...bent.flatMap((n) => [Math.abs((n.cents ?? 0) / 100), ...(n.slide ?? []).map((s) => Math.abs(s.semitones))]));
      if (range.semitones === 0) {
        issues.push({ severity: "error", code: "BEND_RANGE", path, message: `${patch} does not respond to pitch bend: slides and cent offsets would not sound. Use another instrument for this line.` });
      } else if (widest > range.semitones + 1e-9) {
        issues.push({ severity: "error", code: "BEND_RANGE", path,
          message: `${patch} bends ±${range.semitones} semitones; this part bends ${Math.round(widest * 100) / 100}. ` +
            `Split the slide into notes, or use Flute Solo (program 73: ±12).` });
      }
      if (!range.measured) {
        issues.push({ severity: "warning", code: "BEND_RANGE_UNMEASURED", path,
          message: `${patch}'s bend range has not been measured; gb-mcp assumes ±2 semitones. Listen to the slides.` });
      }
    }
    if (t.vibrato !== undefined && t.vibrato !== "off" && range.semitones === 0) {
      issues.push({ severity: "warning", code: "NO_PITCH_BEND", path, message: `${patch} does not respond to pitch bend: vibrato "${t.vibrato}" has no effect.` });
    }
    const bright = Object.values(t.parts).some((p) => (p as PartExpression).brightness !== undefined);
    if (bright && !isSynth(track.program)) {
      issues.push({ severity: "warning", code: "BRIGHTNESS_SYNTH_ONLY", path,
        message: `brightness (CC74) moves a synth's filter; ${patch} is a sampled instrument and may ignore it.` });
    }
  });
  return issues;
}
