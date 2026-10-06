// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * M13.14: a recording → a Song JSON draft that plays like it. The song map (gb_analyze map) gives the tempo (and the
 * tempo map of a take that drifts), the key, the GarageBand bar lines, the sections and the chords per half bar; the
 * transcription (models/gbmodels/transcribe.py) gives the bass and lead notes and the drum hits on the same bars, in
 * 16th steps. Pure: the caller validates and writes.
 */
import { slotsToPart, type SlotNote } from "./infill.js";
import { INSTRUMENT_RANGES } from "../knowledge/instrument-ranges.js";

/** One note on the map's bars: GarageBand bar (1-based), 16th step in it (0–15), length in 16ths, MIDI pitch. */
export type GridNote = { bar: number; step: number; len: number; pitch: number };
export type GridHit = { bar: number; step: number; strength: number };
/** bass_source / lead_source: the stem each line came from; null when that stem is silent (no line in it). */
export type Transcription = {
  bass: GridNote[]; bass_source: "bass" | null; lead: GridNote[]; lead_source: "vocals" | "other" | null;
  drums: { kick: GridHit[]; snare: GridHit[]; hat: GridHit[] };
};
/** The parts of analysis/<name>-map.json the draft uses (models/gbmodels/songmap.py). */
export type SongMap = {
  key: string | null;
  place: { guide_bpm: number; bar: number; beat: number; offset_s: number };
  tempo_map: { bar: number; bpm: number }[] | null;
  bar_lines_s: number[];
  sections: { name: string; gb_bar: number; bars: number }[] | null;
  gb: { bar: number; chords: (string | null)[] }[];
};

/** "D Major" (S-KEY) → "D major" and its tonic triad "D"; "F# Minor" → "F# minor", "F#m". No key: a C chord. */
export function keyAndChord(key: string | null): { key?: string; chord: string } {
  const m = /^([A-G][#b]?) (major|minor)$/i.exec(key ?? "");
  if (!m) return { chord: "C" };
  const mode = m[2]!.toLowerCase();
  return { key: `${m[1]} ${mode}`, chord: mode === "minor" ? `${m[1]}m` : m[1]! };
}

const STEPS = 16;
/** GM programs of the draft's tracks (GarageBand patches: gb://knowledge/gm-patch-map). */
const PROGRAM = { drums: 0 /* SoCal kit */, chords: 4 /* Classic Electric Piano */, bass: 33 /* Fingerstyle Bass */,
  sung: 85 /* Dream Voice: a sung line */, played: 81 /* Soft Saw Lead: a played line */ } as const;
type DraftTrack = { name: string; role: string; program: number; parts: Record<string, Record<string, unknown>> };
export type DraftSong = { title: string; tempo: number; key?: string; tempoMap?: { bar: number; bpm: number }[]; humanize: "natural"; sections: { name: string; bars: number }[]; tracks: DraftTrack[] };

/** A pitch the program cannot play, moved by octaves into its range (real instruments only; synths play all). */
function playable(pitch: number, program: number): number {
  const range = INSTRUMENT_RANGES[program];
  let p = pitch;
  while (range && p < range.low) p += 12;
  while (range && p > range.high) p -= 12;
  return p;
}

const TAIL = 4; // steps: a note that runs less than a beat past its bar line ends there (a release tail, not a tie)

function notesPart(notes: readonly GridNote[], program: number, fromBar: number, bars: number): string | undefined {
  const onsets = new Map<number, SlotNote>();
  for (const n of notes) {
    const slot = (n.bar - fromBar) * STEPS + n.step;
    if (slot < 0 || slot >= bars * STEPS) continue;
    const overhang = n.step + n.len - STEPS;
    const len = overhang > 0 && overhang < TAIL ? STEPS - n.step : n.len; // Song JSON strikes a longer one again
    onsets.set(slot, { pitches: new Set([playable(n.pitch, program)]), len });
  }
  return onsets.size ? slotsToPart(onsets, STEPS, bars, { restRuns: true }) : undefined;
}

const ACCENT = 0.85, GHOST = 0.35; // hit strength (0–1 of the voice's loud hits) → X accent, x hit, o ghost
const DRUM_VOICES = ["kick", "snare", "hat"] as const;

/** Per voice with a hit in the section: 16 steps per bar, bars joined with "|". */
function gridPart(drums: Transcription["drums"], fromBar: number, bars: number): Record<string, unknown> | undefined {
  const grid: Record<string, string> = {};
  for (const voice of DRUM_VOICES) {
    const steps = Array.from({ length: bars * STEPS }, () => ".");
    for (const h of drums[voice]) {
      const slot = (h.bar - fromBar) * STEPS + h.step;
      if (slot >= 0 && slot < steps.length) steps[slot] = h.strength >= ACCENT ? "X" : h.strength < GHOST ? "o" : "x";
    }
    if (steps.some((c) => c !== ".")) grid[voice] = Array.from({ length: bars }, (_, b) => steps.slice(b * STEPS, (b + 1) * STEPS).join("")).join(" | ");
  }
  return Object.keys(grid).length ? { grid } : undefined;
}

/** The map's chord per half bar: "G A" where the halves differ, else "G". An unknown half (outside the song's own
 * bars) takes the chord before it, or after it; a section with no chord heard has no chords part. */
function chordsPart(map: SongMap, fromBar: number, bars: number): Record<string, unknown> | undefined {
  const halves = Array.from({ length: bars * 2 }, (_, i) => map.gb[fromBar - 1 + Math.floor(i / 2)]?.chords[i % 2] ?? null);
  if (halves.every((c) => c === null)) return undefined;
  for (let i = 1; i < halves.length; i++) halves[i] ??= halves[i - 1]!;
  for (let i = halves.length - 2; i >= 0; i--) halves[i] ??= halves[i + 1]!;
  const perBar = Array.from({ length: bars }, (_, b) => (halves[2 * b] === halves[2 * b + 1] ? halves[2 * b]! : `${halves[2 * b]} ${halves[2 * b + 1]}`));
  return { chords: perBar.join(" | "), style: "sustain" };
}

/** The map's sections on GarageBand bars (each to the next one's bar); bars before the first are a "lead-in" (not an
 * all-in-one label). Without sections: one section, "song". */
function sectionsOf(map: SongMap): { name: string; bars: number; from: number }[] {
  const gbBars = map.bar_lines_s.length - 1;
  const found = [...(map.sections ?? [])].filter((s) => s.gb_bar >= 1 && s.gb_bar <= gbBars).sort((a, b) => a.gb_bar - b.gb_bar);
  if (!found.length) return [{ name: "song", bars: gbBars, from: 1 }];
  const starts = [...(found[0]!.gb_bar > 1 ? [{ name: "lead-in", gb_bar: 1 }] : []), ...found];
  return starts.map((s, i) => ({ name: s.name, from: s.gb_bar, bars: (starts[i + 1]?.gb_bar ?? gbBars + 1) - s.gb_bar }));
}

export function draftSong(map: SongMap, t: Transcription, opts: { title: string }): DraftSong {
  const sections = sectionsOf(map);
  const tracks: DraftTrack[] = [];
  const add = (name: string, role: string, program: number, part: (from: number, bars: number) => Record<string, unknown> | undefined) => {
    const parts = Object.fromEntries(sections.map((s) => [s.name, part(s.from, s.bars)] as const).filter(([, p]) => p !== undefined));
    if (Object.keys(parts).length) tracks.push({ name, role, program, parts: parts as Record<string, Record<string, unknown>> });
  };
  add("Drums", "drums", PROGRAM.drums, (from, bars) => gridPart(t.drums, from, bars));
  add("Chords", "pad", PROGRAM.chords, (from, bars) => chordsPart(map, from, bars));
  add("Bass", "bass", PROGRAM.bass, (from, bars) => {
    if (t.bass_source === null) return chordsPart(map, from, bars); // no bass stem to hear: the chord roots
    const notes = notesPart(t.bass, PROGRAM.bass, from, bars);
    return notes ? { notes } : undefined;
  });
  const leadProgram = t.lead_source === "vocals" ? PROGRAM.sung : PROGRAM.played;
  add("Lead", "lead", leadProgram, (from, bars) => { const notes = notesPart(t.lead, leadProgram, from, bars); return notes ? { notes } : undefined; });
  const { key } = keyAndChord(map.key);
  const tm = map.tempo_map;
  return {
    title: opts.title, tempo: tm?.length ? tm[0]!.bpm : map.place.guide_bpm, ...(key ? { key } : {}),
    ...(tm && tm.length > 1 ? { tempoMap: tm.slice(1) } : {}), humanize: "natural",
    sections: sections.map(({ name, bars }) => ({ name, bars })), tracks,
  };
}
