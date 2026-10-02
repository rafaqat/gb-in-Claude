// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { INSTRUMENT_RANGES } from "../knowledge/instrument-ranges.js";
import { renderSong } from "./render.js";
import type { Song } from "./schema.js";

export type Issue = {
  severity: "error" | "warning";
  code: "OUT_OF_INSTRUMENT_RANGE" | "RENDER_FAILED" | "ROLE_REGISTER" | "EMPTY_SECTION" | "HUMANIZE_OFF";
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
export function validateSong(song: Song): Issue[] {
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
  return issues;
}
