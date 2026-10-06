// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { ok, err, type Result } from "../result.js";
import type { SmfSong, SmfTrack, SmfNote } from "../midi/smf.js";
import type { NoteEvent, BassStyle } from "../composition/bass-patterns.js";
import { renderBassBar } from "../composition/bass-patterns.js";
import { voiceChord, renderPadSpan, type PadStyle } from "../composition/pad-patterns.js";
import { renderArpSpan, type ArpStyle } from "../composition/arp-patterns.js";
import { parseProgression } from "../composition/progression.js";
import { parseGrid } from "../composition/drum-grid.js";
import { parseNotes, type Slide } from "../composition/mini-notation.js";
import { DRUM_VOICES, type DrumVoice } from "../composition/drums.js";
import { resolveProgram } from "./styles.js";
import { scaleVelocity } from "./levels.js";
import type { Role, Song } from "./schema.js";

export const PPQ = 480;
const DRUM_CHANNEL = 10;
const DRUM_HIT_BEATS = 0.25;
const MELODY_VELOCITY = 96;

export type RenderError = { code: "RENDER_FAILED"; path: string; message: string };
/** A note with its expression (M11): turned into pitch bends after swing and humanize (song/expression.ts). */
export type ExpressiveNote = SmfNote & { slide?: Slide[]; cents?: number };
const ACCENT_DB = { accent: 4, soft: -8 } as const;

type Part = Song["tracks"][number]["parts"][string];
/** A rendered pattern: notes in beats relative to its start, and how many bars it spans before looping. */
type PatternNote = NoteEvent & { slide?: Slide[]; cents?: number };
type Pattern = { bars: number; notes: PatternNote[] };

function renderChords(role: Role, part: Extract<Part, { chords: string }>, beatsPerBar: number): Result<Pattern, string> {
  const prog = parseProgression(part.chords, beatsPerBar);
  if (!prog.ok) return err(prog.error.message);
  const notes: NoteEvent[] = [];
  let previous: number[] | undefined;
  for (const { chord, startBeat, durationBeats } of prog.value.chords) {
    let span: NoteEvent[];
    if (role === "bass") {
      span = renderBassBar(part.style as BassStyle, chord, part.octave!, durationBeats);
    } else {
      previous = voiceChord(chord, part.octave!, previous);
      span = role === "pad"
        ? renderPadSpan(part.style as PadStyle, previous, durationBeats)
        : renderArpSpan(part.style as ArpStyle, previous, durationBeats);
    }
    notes.push(...span.map((n) => ({ ...n, startBeat: n.startBeat + startBeat })));
  }
  return ok({ bars: prog.value.bars, notes });
}

/** Each drum voice is its own pattern, so a 1-bar kick can loop under a 2-bar hat line. */
function renderGrid(grid: Record<string, string>, beatsPerBar: number, levels: Record<string, number> = {}): Result<Pattern[], string> {
  const patterns: Pattern[] = [];
  for (const [voice, line] of Object.entries(grid)) {
    const parsed = parseGrid(line, beatsPerBar);
    if (!parsed.ok) return err(`${voice}: ${parsed.error.message}`);
    const pitch = DRUM_VOICES[voice as DrumVoice];
    patterns.push({
      bars: parsed.value.bars,
      notes: parsed.value.hits.map((h) => ({
        pitch, startBeat: h.startBeat, durationBeats: DRUM_HIT_BEATS, velocity: scaleVelocity(h.velocity, levels[voice] ?? 0),
      })),
    });
  }
  return ok(patterns);
}

function renderMelody(notes: string, beatsPerBar: number): Result<Pattern, string> {
  const parsed = parseNotes(notes, beatsPerBar);
  if (!parsed.ok) return err(parsed.error.message);
  return ok({
    bars: parsed.value.bars,
    notes: parsed.value.events.flatMap((e) =>
      e.pitches.map((pitch) => ({
        pitch, startBeat: e.startBeat, durationBeats: e.durationBeats,
        velocity: e.accent ? scaleVelocity(MELODY_VELOCITY, ACCENT_DB[e.accent]) : MELODY_VELOCITY,
        ...(e.slide ? { slide: e.slide } : {}), ...(e.cents !== undefined ? { cents: e.cents } : {}),
      }))),
  });
}

function renderPart(role: Role, part: Part, beatsPerBar: number): Result<Pattern[], string> {
  if ("grid" in part) return renderGrid(part.grid, beatsPerBar, part.levels ?? {});
  if ("chords" in part) {
    const r = renderChords(role, part, beatsPerBar);
    return r.ok ? ok([r.value]) : r;
  }
  const r = renderMelody(part.notes, beatsPerBar);
  return r.ok ? ok([r.value]) : r;
}

/** Loop a pattern from `startBeat` to fill `lengthBeats`, truncating (and clipping) at the section end. */
/** The pattern repeated to fill the section, one note at a time: the caller counts and can stop early (MAX_NOTES). */
function* placeLooped(pattern: Pattern, startBeat: number, lengthBeats: number, beatsPerBar: number): Generator<PatternNote> {
  const patternBeats = pattern.bars * beatsPerBar;
  for (let offset = 0; offset < lengthBeats; offset += patternBeats) {
    for (const n of pattern.notes) {
      const local = offset + n.startBeat;
      if (local >= lengthBeats) continue;
      yield { ...n, startBeat: startBeat + local, durationBeats: Math.min(n.durationBeats, lengthBeats - local) };
    }
  }
}

const toTicks = (beats: number) => Math.round(beats * PPQ);

function melodicChannels(): number[] {
  return Array.from({ length: 16 }, (_, i) => i + 1).filter((c) => c !== DRUM_CHANNEL);
}

/** Song (already parsed) → SMF description. Pure and deterministic. */
/** Notes one song may render: a short pattern loops to fill its section, so string limits alone do not bound the work
 * (commit security review 2026-10-06). A dense 70-minute song stays far below. */
export const MAX_NOTES = 200_000;

export function renderSong(song: Song): Result<SmfSong, RenderError> {
  const beatsPerBar = song.timeSignature[0];
  const sectionStart = new Map<string, { startBeat: number; lengthBeats: number }>();
  let cursor = 0;
  for (const s of song.sections) {
    sectionStart.set(s.name, { startBeat: cursor, lengthBeats: s.bars * beatsPerBar });
    cursor += s.bars * beatsPerBar;
  }

  const channels = melodicChannels();
  let rendered = 0;
  const tracks: SmfTrack[] = [];
  for (const track of song.tracks) {
    const channel = track.role === "drums" ? DRUM_CHANNEL : channels.shift()!;
    const notes: ExpressiveNote[] = [];
    for (const [sectionName, part] of Object.entries(track.parts)) {
      const section = sectionStart.get(sectionName)!;
      const patterns = renderPart(track.role, part, beatsPerBar);
      if (!patterns.ok) {
        return err({ code: "RENDER_FAILED", path: `tracks.${track.name}.parts.${sectionName}`, message: patterns.error });
      }
      for (const pattern of patterns.value) {
        for (const n of placeLooped(pattern, section.startBeat, section.lengthBeats, beatsPerBar)) {
          if (++rendered > MAX_NOTES) {
            return err({ code: "RENDER_FAILED", path: `tracks.${track.name}.parts.${sectionName}`, message: `the song renders more than ${MAX_NOTES} notes` });
          }
          notes.push({ pitch: n.pitch, startTick: toTicks(n.startBeat), durationTicks: Math.max(1, toTicks(n.durationBeats)), velocity: n.velocity,
            ...(n.slide ? { slide: n.slide } : {}), ...(n.cents !== undefined ? { cents: n.cents } : {}) });
        }
      }
    }
    notes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
    tracks.push({ name: track.name, channel, program: resolveProgram(song.style, track), notes });
  }
  // parseSong guarantees x/4 meters.
  return ok({ ppq: PPQ, tempoBpm: song.tempo, timeSignature: [beatsPerBar, 4], tracks });
}
