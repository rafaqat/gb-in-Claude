// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * M11 expression: turns a song's expression (note slides and cent offsets, vibrato, part dynamics, pedal, pan,
 * brightness, volume, section tempi) into the MIDI messages GarageBand honours — measured live, see
 * eval/m11/MESSAGES.md. Runs last, on the performed notes (after swing and humanize), so every
 * bend follows the note it belongs to.
 */
import type { SmfBend, SmfController, SmfSong, SmfTrack } from "../midi/smf.js";
import { patchFor } from "../knowledge/gm-patch-map.js";
import { bendRangeFor } from "../knowledge/bend-ranges.js";
import type { ExpressiveNote } from "./render.js";
import type { PartExpression, Song } from "./schema.js";

export type ExpressionResult = Pick<SmfSong, "tempoMap" | "keySignature" | "markers"> & { tracks: SmfTrack[] };
type InTrack = Omit<SmfTrack, "notes"> & { notes: ExpressiveNote[] };

/** Vibrato depth in cents per setting; 5.5 Hz, blooming after the first third of notes a beat or longer. */
const VIBRATO_CENTS = { off: 0, light: 12, normal: 25, wide: 45 } as const;
const VIBRATO_HZ = 5.5;
const VIBRATO_FADE_S = 0.3;
const STEP_MS = 10;
const LEAD_ROLES = new Set(["lead", "lead-high"]);

const clampBend = (v: number) => Math.max(-8192, Math.min(8191, Math.round(v)));

/** One note's bend curve (semitones from its written pitch) → events; the caller resets before the next note. */
function noteBends(n: ExpressiveNote, range: number, vibratoCents: number, ppq: number, ticksPerMs: number): SmfBend[] {
  const units = (semitones: number) => clampBend((semitones / range) * 8192);
  const step = Math.max(4, Math.round(STEP_MS * ticksPerMs));
  const base = (n.cents ?? 0) / 100;
  const out: SmfBend[] = [];
  if (n.slide?.length) {
    out.push({ tick: n.startTick, value: units(base) });
    let from = base;
    let segmentStart = n.startTick;
    for (const point of n.slide) {
      const arrive = n.startTick + Math.round(point.at * n.durationTicks);
      // glide over the last 35 % of the held segment (at least 30 ms, at most ¾ beat), landing on time
      const glide = Math.min(Math.max(Math.round(0.35 * (arrive - segmentStart)), Math.round(30 * ticksPerMs)), Math.round(0.75 * ppq), arrive - segmentStart);
      const begin = arrive - glide;
      for (let t = begin; t < arrive; t += step) {
        const x = (t - begin) / glide;
        out.push({ tick: t, value: units(from + ((point.semitones - from) * (1 - Math.cos(Math.PI * x))) / 2) });
      }
      out.push({ tick: arrive, value: units(point.semitones) });
      from = point.semitones;
      segmentStart = arrive;
    }
    return out;
  }
  if (base !== 0) out.push({ tick: n.startTick, value: units(base) });
  if (vibratoCents > 0 && n.durationTicks >= ppq) {
    const t0 = n.startTick + Math.ceil(n.durationTicks / 3);
    const end = n.startTick + n.durationTicks;
    if (base === 0) out.push({ tick: n.startTick, value: 0 });
    for (let t = t0; t < end; t += step) {
      const seconds = (t - t0) / ticksPerMs / 1000;
      const depth = Math.min(1, seconds / VIBRATO_FADE_S) * (vibratoCents / 100);
      out.push({ tick: t, value: units(base + depth * Math.sin(2 * Math.PI * VIBRATO_HZ * seconds)) });
    }
  }
  return out;
}

/** A single-note line's bends (slides, cent offsets, vibrato), each note reset before the next note-on. */
export function bendsForLine(notes: readonly ExpressiveNote[], range: number, vibratoCents: number, ppq: number, tempo: number): SmfBend[] {
  if (range === 0) return [];
  const ticksPerMs = (ppq * tempo) / 60000;
  const sorted = [...notes].sort((a, b) => a.startTick - b.startTick);
  const bends: SmfBend[] = [];
  sorted.forEach((n, i) => {
    const own = noteBends(n, range, vibratoCents, ppq, ticksPerMs);
    if (own.length === 0) return;
    bends.push(...own);
    const next = sorted.slice(i + 1).find((m) => m.startTick > n.startTick);
    bends.push({ tick: next ? next.startTick : n.startTick + n.durationTicks + ppq, value: 0 }); // reset before the next note-on
  });
  // a later note's own start event replaces a reset at the same tick
  const byTick = new Map<number, SmfBend>();
  for (const b of bends) if (!byTick.has(b.tick) || b.value !== 0) byTick.set(b.tick, b);
  return [...byTick.values()].sort((a, b) => a.tick - b.tick);
}

/** RPN 0 (pitch-bend sensitivity) as controller events at tick 0, then RPN null. */
export const rpnBendRange = (semitones: number): SmfController[] =>
  ([[101, 0], [100, 0], [6, semitones], [38, 0], [101, 127], [100, 127]] as const).map(([controller, value]) => ({ tick: 0, controller, value }));

function trackBends(track: InTrack, songTrack: Song["tracks"][number], tempo: number, ppq: number): { bends: SmfBend[]; bendRange?: number } {
  if (songTrack.role === "drums" || track.program === undefined) return { bends: [] };
  const range = bendRangeFor(patchFor(track.program, track.channel));
  const vibrato = VIBRATO_CENTS[songTrack.vibrato ?? (LEAD_ROLES.has(songTrack.role) ? "normal" : "off")];
  const bends = bendsForLine(track.notes, range.semitones, vibrato, ppq, tempo);
  return bends.length && range.rpn ? { bends, bendRange: range.semitones } : { bends };
}

/** CC11 per dynamic mark. */
const DYNAMIC_VALUE: Readonly<Record<string, number>> = { ppp: 20, pp: 35, p: 50, mp: 65, mf: 80, f: 100, ff: 115, fff: 127 };
const NEUTRAL = { 11: 127, 10: 64, 74: 64, 7: 100 } as const;
type Span = { start: number; end: number };

/** Points across a span (every ¼ beat, the last one at its end) for a curve over x ∈ [0, 1]. */
function curve(span: Span, controller: number, ppq: number, value: (x: number) => number): SmfController[] {
  const steps = Math.max(1, Math.ceil((span.end - span.start) / (ppq / 4)));
  return Array.from({ length: steps + 1 }, (_, k) => ({
    tick: span.start + Math.round((k * (span.end - 1 - span.start)) / steps),
    controller,
    value: Math.max(0, Math.min(127, Math.round(value(k / steps)))),
  }));
}

const ramp = (r: number | { from: number; to: number }, x: number) => (typeof r === "number" ? r : r.from + (r.to - r.from) * x);

function dynamicsCurve(marks: string, span: Span, ppq: number): SmfController[] {
  const stages = marks.split(/[<>]/).map((m) => DYNAMIC_VALUE[m]!);
  if (stages.length === 1) return [{ tick: span.start, controller: 11, value: stages[0]! }];
  return curve(span, 11, ppq, (x) => {
    const pos = x * (stages.length - 1);
    const j = Math.min(stages.length - 2, Math.floor(pos));
    return stages[j]! + (stages[j + 1]! - stages[j]!) * (pos - j);
  });
}

function panCurve(pan: NonNullable<PartExpression["pan"]>, span: Span, ppq: number, beatsPerBar: number): SmfController[] {
  const cc = (x: number) => 64 + 63 * Math.max(-1, Math.min(1, x));
  if (typeof pan === "number") return [{ tick: span.start, controller: 10, value: Math.round(cc(pan)) }];
  if ("from" in pan) return curve(span, 10, ppq, (x) => cc(pan.from + (pan.to - pan.from) * x));
  const cycleTicks = pan.cycle * beatsPerBar * ppq;
  return curve(span, 10, ppq, (x) => cc((pan.center ?? 0) + pan.depth * Math.sin((2 * Math.PI * x * (span.end - span.start)) / cycleTicks)));
}

function pedalEvents(unit: "bar" | "half" | "beat", span: Span, ppq: number, beatsPerBar: number): SmfController[] {
  const length = unit === "bar" ? beatsPerBar * ppq : unit === "half" ? (beatsPerBar * ppq) / 2 : ppq;
  const lag = ppq / 16; // down just after the attack, up just before the next one: a clean re-pedal
  const out: SmfController[] = [];
  for (let u = span.start; u < span.end; u += length) {
    out.push({ tick: u + lag, controller: 64, value: 127 }, { tick: Math.min(u + length, span.end) - lag, controller: 64, value: 0 });
  }
  return out;
}

function trackControllers(song: Song, songTrack: Song["tracks"][number], ppq: number): SmfController[] {
  const beatsPerBar = song.timeSignature[0];
  const parts = Object.values(songTrack.parts) as PartExpression[];
  const uses = (field: keyof PartExpression) => parts.some((p) => p[field] !== undefined);
  const out: SmfController[] = [];
  let cursor = 0;
  for (const section of song.sections) {
    const span = { start: cursor, end: cursor + section.bars * beatsPerBar * ppq };
    cursor = span.end;
    const part = songTrack.parts[section.name] as PartExpression | undefined;
    if (!part) continue;
    const neutral = (controller: 11 | 10 | 74 | 7) => out.push({ tick: span.start, controller, value: NEUTRAL[controller] });
    if (uses("dynamics")) part.dynamics ? out.push(...dynamicsCurve(part.dynamics, span, ppq)) : neutral(11);
    if (part.pedal) out.push(...pedalEvents(part.pedal, span, ppq, beatsPerBar));
    if (uses("pan")) part.pan !== undefined ? out.push(...panCurve(part.pan, span, ppq, beatsPerBar)) : neutral(10);
    if (uses("brightness")) part.brightness !== undefined ? out.push(...curve(span, 74, ppq, (x) => 127 * ramp(part.brightness!, x))) : neutral(74);
    if (uses("volume")) part.volume !== undefined ? out.push(...curve(span, 7, ppq, (x) => 100 * ramp(part.volume!, x))) : neutral(7);
  }
  // drop repeats: a controller that does not change sends nothing
  const last = new Map<number, number>();
  return out.sort((a, b) => a.tick - b.tick).filter((c) => {
    if (last.get(c.controller) === c.value) return false;
    last.set(c.controller, c.value);
    return true;
  });
}

/** Section tempo (from its start) and tempoTo (a beat-by-beat ramp arriving on its last beat); a tempo holds until changed. */
function tempoMap(song: Song, ppq: number): NonNullable<SmfSong["tempoMap"]> {
  const beatsPerBar = song.timeSignature[0];
  if (song.tempoMap) return song.tempoMap.map((t) => ({ tick: Math.round(((t.bar - 1) * beatsPerBar + (t.beat - 1)) * ppq), bpm: t.bpm }));
  const map: NonNullable<SmfSong["tempoMap"]> = [];
  let current = song.tempo;
  let cursor = 0;
  for (const section of song.sections) {
    const beats = section.bars * beatsPerBar;
    if (section.tempo !== undefined) {
      map.push({ tick: cursor, bpm: section.tempo });
      current = section.tempo;
    }
    if (section.tempoTo !== undefined) {
      const from = current;
      for (let k = 1; k < beats; k++) map.push({ tick: cursor + k * ppq, bpm: from + ((section.tempoTo - from) * k) / Math.max(1, beats - 1) });
      current = section.tempoTo;
    }
    cursor += beats * ppq;
  }
  return map;
}

/** Each section's real start and end in seconds, through the tempo map (gb_analyze cuts the export with them). */
export function sectionTimes(song: Song, ppq = 480): { name: string; start_s: number; end_s: number }[] {
  const changes = [{ tick: 0, bpm: song.tempo }, ...tempoMap(song, ppq)].sort((a, b) => a.tick - b.tick);
  const seconds = (tick: number) => {
    let total = 0;
    for (let i = 0; i < changes.length && changes[i]!.tick < tick; i++) {
      const until = Math.min(tick, changes[i + 1]?.tick ?? Infinity);
      total += ((until - changes[i]!.tick) * 60) / (changes[i]!.bpm * ppq);
    }
    return total;
  };
  let cursor = 0;
  return song.sections.map((s) => {
    const start = cursor;
    cursor += s.bars * song.timeSignature[0] * ppq;
    return { name: s.name, start_s: seconds(start), end_s: seconds(cursor) };
  });
}

const MAJOR: Readonly<Record<string, number>> = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, "F#": 6, "C#": 7, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7 };
const MINOR: Readonly<Record<string, number>> = { A: 0, E: 1, B: 2, "F#": 3, "C#": 4, "G#": 5, "D#": 6, "A#": 7, D: -1, G: -2, C: -3, F: -4, Bb: -5, Eb: -6, Ab: -7 };
const BY_PITCH_CLASS = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5]; // major key on each pitch class (flats for the black keys but F#)
const PC: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "E minor" → { accidentals: 1, minor: true }: the key signature meta event. */
export function keySignatureOf(key: string): { accidentals: number; minor: boolean } {
  const [tonic, mode] = key.split(" ") as [string, string];
  const minor = mode === "minor";
  const known = (minor ? MINOR : MAJOR)[tonic];
  if (known !== undefined) return { accidentals: known, minor };
  const pc = (PC[tonic[0]!]! + (tonic[1] === "#" ? 1 : tonic[1] === "b" ? -1 : 0) + (minor ? 3 : 0) + 12) % 12;
  return { accidentals: BY_PITCH_CLASS[pc]!, minor };
}

export function applyExpression(song: Song, tracks: InTrack[], ppq: number): ExpressionResult {
  const map = tempoMap(song, ppq);
  let cursor = 0;
  const markers = song.sections.map((section) => {
    const marker = { tick: cursor, text: section.name.replace(/[^\x20-\x7e]/g, "?") };
    cursor += section.bars * song.timeSignature[0] * ppq;
    return marker;
  });
  return {
    ...(map.length ? { tempoMap: map } : {}),
    markers,
    ...(song.key ? { keySignature: keySignatureOf(song.key) } : {}),
    tracks: tracks.map((t, i) => {
      const plain = { ...t, notes: t.notes.map(({ slide: _slide, cents: _cents, ...n }) => n) }; // expression is now messages
      const { bends, bendRange } = trackBends(t, song.tracks[i]!, song.tempo, ppq);
      const controllers = [...(t.controllers ?? []), ...trackControllers(song, song.tracks[i]!, ppq)];
      return { ...plain, ...(controllers.length ? { controllers } : {}), ...(bends.length ? { bends } : {}), ...(bendRange !== undefined ? { bendRange } : {}) };
    }),
  };
}
