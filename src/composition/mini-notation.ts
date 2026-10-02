// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { ok, err, type Result } from "../result.js";
import { parsePitch } from "./pitch.js";

export type NoteSpan = { startBeat: number; durationBeats: number; pitches: number[] };
export type ParsedNotes = { bars: number; events: NoteSpan[] };
export type NotesError = { code: "INVALID_NOTES"; input: string; message: string };

/** One token: rest `~`, a pitch, or a chord `[p,p,...]`, optionally weighted `@n`. Data only — never evaluated. */
const TOKEN = /^(~|\[[^\][]+\]|[A-Ga-g][#b]?-?\d)(?:@(\d+))?$/;

type Token = { pitches: number[] | null; weight: number };

function parseToken(raw: string): Result<Token, string> {
  const m = TOKEN.exec(raw);
  if (!m) return err(`bad token "${raw}"`);
  const [, body, weightText] = m;
  const weight = weightText === undefined ? 1 : Number(weightText);
  if (weight < 1) return err(`weight must be ≥ 1 in "${raw}"`);
  if (body === "~") return ok({ pitches: null, weight });
  const names = body!.startsWith("[") ? body!.slice(1, -1).split(",") : [body!];
  const pitches: number[] = [];
  for (const name of names) {
    const p = parsePitch(name.trim());
    if (!p.ok) return err(`bad pitch "${name}" in "${raw}"`);
    pitches.push(p.value);
  }
  return ok({ pitches, weight });
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
      if (t.pitches) events.push({ startBeat: cursor, durationBeats, pitches: t.pitches });
      cursor += durationBeats;
    }
  }
  return ok({ bars: bars.length, events });
}
