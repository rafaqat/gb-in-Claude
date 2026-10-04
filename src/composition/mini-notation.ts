// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { ok, err, type Result } from "../result.js";
import { parsePitch } from "./pitch.js";

/** slide: the note bends to `semitones` (from its written pitch) arriving at `at` (0–1 of its length) — meend.
 * cents: a fixed offset from the written pitch (shruti). accent: "accent" (!) or "soft" (?). Mono lines only. */
export type Slide = { at: number; semitones: number };
export type NoteSpan = { startBeat: number; durationBeats: number; pitches: number[]; slide?: Slide[]; cents?: number; accent?: "accent" | "soft" };
export type ParsedNotes = { bars: number; events: NoteSpan[] };
export type NotesError = { code: "INVALID_NOTES"; input: string; message: string };

/** One point: rest `~`, a pitch with an optional cent offset (`e5-20c`), or a chord `[p,p,...]`, weighted `@n`.
 * A token is one point, or pitches joined by `>` (one note bending through them), then optionally `!` or `?`.
 * Data only — never evaluated. */
const POINT = /^(~|\[[^\][]+\]|[A-Ga-g][#b]?-?\d)(?:([+-]\d{1,2})c)?(?:@(\d+))?$/;

type Token = { pitches: number[] | null; weight: number; slide?: Slide[]; cents?: number; accent?: "accent" | "soft" };
type Point = { pitches: number[] | null; cents: number; weight: number };

function parsePoint(raw: string, token: string): Result<Point, string> {
  const m = POINT.exec(raw);
  if (!m) return err(`bad token "${token}"`);
  const [, body, centsText, weightText] = m;
  const weight = weightText === undefined ? 1 : Number(weightText);
  if (weight < 1) return err(`weight must be ≥ 1 in "${token}"`);
  if (body === "~") return centsText ? err(`a rest has no pitch to offset in "${token}"`) : ok({ pitches: null, cents: 0, weight });
  const names = body!.startsWith("[") ? body!.slice(1, -1).split(",") : [body!];
  const pitches: number[] = [];
  for (const name of names) {
    const p = parsePitch(name.trim());
    if (!p.ok) return err(`bad pitch "${name}" in "${token}"`);
    pitches.push(p.value);
  }
  return ok({ pitches, cents: centsText ? Number(centsText) : 0, weight });
}

function parseToken(raw: string): Result<Token, string> {
  const accent = raw.endsWith("!") ? "accent" : raw.endsWith("?") ? "soft" : undefined;
  const body = accent ? raw.slice(0, -1) : raw;
  const points: Point[] = [];
  for (const part of body.split(">")) {
    const p = parsePoint(part, raw);
    if (!p.ok) return p;
    points.push(p.value);
  }
  const first = points[0]!;
  if (points.length > 1 && points.some((p) => p.pitches === null || p.pitches.length !== 1)) {
    return err(`a slide joins single pitches, not rests or chords: "${raw}"`);
  }
  if (first.pitches === null && accent) return err(`a rest cannot be accented: "${raw}"`);
  const weight = points.reduce((sum, p) => sum + p.weight, 0);
  const token: Token = { pitches: first.pitches, weight };
  if (points.length > 1) {
    let cumulative = 0;
    token.slide = points.slice(1).map((p, i) => {
      cumulative += points[i]!.weight;
      return { at: cumulative / weight, semitones: p.pitches![0]! - first.pitches![0]! + p.cents / 100 };
    });
  }
  if (first.cents !== 0) token.cents = first.cents;
  if (accent) token.accent = accent;
  return ok(token);
}

/**
 * Parse melody mini-notation. Bars are separated by `|`; within a bar, tokens share
 * the bar in proportion to their weights.  e.g. "f5 ab5 c6 ~ | eb6@2 c6 ~"
 */
export function parseNotes(pattern: string, beatsPerBar: number): Result<ParsedNotes, NotesError> {
  const fail = (message: string) => err({ code: "INVALID_NOTES" as const, input: pattern, message });
  const bars = pattern.split("|").map((b) => b.trim());
  const events: NoteSpan[] = [];
  for (const [barIndex, bar] of bars.entries()) {
    if (bar === "") return fail(`bar ${barIndex + 1} is empty`);
    const tokens: Token[] = [];
    for (const raw of bar.split(/\s+/)) {
      const t = parseToken(raw);
      if (!t.ok) return fail(t.error);
      tokens.push(t.value);
    }
    const unit = beatsPerBar / tokens.reduce((sum, t) => sum + t.weight, 0);
    let cursor = barIndex * beatsPerBar;
    for (const t of tokens) {
      const durationBeats = t.weight * unit;
      if (t.pitches) {
        events.push({ startBeat: cursor, durationBeats, pitches: t.pitches,
          ...(t.slide ? { slide: t.slide } : {}), ...(t.cents !== undefined ? { cents: t.cents } : {}), ...(t.accent ? { accent: t.accent } : {}) });
      }
      cursor += durationBeats;
    }
  }
  return ok({ bars: bars.length, events });
}
