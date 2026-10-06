// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * Scores for the M13.14 transcription benchmark (eval/m13-transcribe): a Song JSON draft made from a recording against
 * the Song JSON the recording was rendered from. Times are in seconds of the recording.
 */
import { parseChord } from "../composition/chord.js";

export type Onset = { t: number; pitch?: number };
export type Match = { truth: number; est: number; matched: number; precision: number; recall: number; f: number };

const round = (x: number) => Math.round(x * 1000) / 1000;

/** Onset F-measure: a pair matches within `tol` seconds (default 50 ms) and, with `pitch`, on the same MIDI pitch.
 * Closest pairs first; each note matches once. Nothing in either list scores 1. */
export function onsetF(truth: readonly Onset[], est: readonly Onset[], opts: { pitch: boolean; tol?: number }): Match {
  const tol = opts.tol ?? 0.05;
  const pairs: [number, number, number][] = [];
  truth.forEach((a, i) => est.forEach((b, j) => {
    const d = Math.abs(a.t - b.t);
    if (d <= tol + 1e-9 && (!opts.pitch || a.pitch === b.pitch)) pairs.push([d, i, j]);
  }));
  pairs.sort((x, y) => x[0] - y[0]);
  const usedT = new Set<number>(), usedE = new Set<number>();
  for (const [, i, j] of pairs) {
    if (usedT.has(i) || usedE.has(j)) continue;
    usedT.add(i);
    usedE.add(j);
  }
  const matched = usedT.size;
  const precision = est.length ? matched / est.length : truth.length ? 0 : 1;
  const recall = truth.length ? matched / truth.length : est.length ? 0 : 1;
  const f = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { truth: truth.length, est: est.length, matched, precision: round(precision), recall: round(recall), f: round(f) };
}

export type Span = { t: number; end: number; pitch: number };

/** The pitch that sounds longest in [a, b), or null. */
function longest(notes: readonly Span[], a: number, b: number): number | null {
  let best: number | null = null, most = 0;
  for (const n of notes) {
    const overlap = Math.min(b, n.end) - Math.max(a, n.t);
    if (overlap > most) [best, most] = [n.pitch, overlap];
  }
  return best;
}

/** Per beat (lines[k] to lines[k+1]) where the truth sounds: the share of beats where the draft's longest note is the
 * same pitch (exact) or the same pitch class (any octave). */
export function beatPitch(truth: readonly Span[], est: readonly Span[], lines: readonly number[]): { beats: number; exact: number; pitch_class: number } {
  let beats = 0, exact = 0, pc = 0;
  for (let k = 0; k + 1 < lines.length; k++) {
    const want = longest(truth, lines[k]!, lines[k + 1]!);
    if (want === null) continue;
    beats++;
    const got = longest(est, lines[k]!, lines[k + 1]!);
    if (got === want) exact++;
    if (got !== null && (got - want) % 12 === 0) pc++;
  }
  return { beats, exact: beats ? round(exact / beats) : 1, pitch_class: beats ? round(pc / beats) : 1 };
}

/** Root pitch class and third ("maj" | "min" | null for sus chords) of a chord symbol, or null if it does not parse. */
function triad(symbol: string): { root: number; third: "maj" | "min" | null } | null {
  const c = parseChord(symbol);
  if (!c.ok) return null;
  const third = c.value.intervals.includes(3) ? "min" : c.value.intervals.includes(4) ? "maj" : null;
  return { root: c.value.root, third };
}

/** [truth, draft] chord per half bar: the share with the right root, and with the right root and third (over the
 * truth chords that have a third). A missing draft chord is wrong. */
export function chordScore(pairs: readonly [string, string | null][]): { halves: number; root: number; majmin: number } {
  let root = 0, third = 0, withThird = 0;
  for (const [want, got] of pairs) {
    const w = triad(want), g = got === null ? null : triad(got);
    if (!w) continue;
    const sameRoot = g !== null && g.root === w.root;
    if (sameRoot) root++;
    if (w.third !== null) {
      withThird++;
      if (sameRoot && g!.third === w.third) third++;
    }
  }
  return { halves: pairs.length, root: pairs.length ? round(root / pairs.length) : 1, majmin: withThird ? round(third / withThird) : 1 };
}

/** "exact" (same tonic and mode, any spelling), "relative" (major ↔ minor with the same notes) or "other". */
export function keyRelation(truth: string, est: string | undefined): "exact" | "relative" | "other" {
  const parse = (k: string | undefined) => {
    const m = /^([A-G][#b]?) (major|minor)$/.exec(k ?? "");
    const c = m ? parseChord(m[1]!) : null;
    return m && c?.ok ? { tonic: c.value.root, minor: m[2] === "minor" } : null;
  };
  const a = parse(truth), b = parse(est);
  if (!a || !b) return "other";
  if (a.tonic === b.tonic && a.minor === b.minor) return "exact";
  const major = (k: { tonic: number; minor: boolean }) => (k.minor ? (k.tonic + 3) % 12 : k.tonic);
  return a.minor !== b.minor && major(a) === major(b) ? "relative" : "other";
}
