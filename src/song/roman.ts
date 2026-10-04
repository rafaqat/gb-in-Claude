// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * Roman-numeral progressions → chord symbols in a key (M9 genre templates are written in Roman numerals, so one
 * template serves every key). Upper case is major, lower case minor; suffixes: 7, maj7, 9, ø (half-diminished),
 * ° (diminished), sus2, sus4; a b or # prefix lowers or raises the degree ("bVII"). Bars are separated by "|".
 * The output uses Song JSON's chord syntax (which has no dominant 9: upper-case 9 becomes add9).
 */
const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const PC: Record<string, number> = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const DEGREE: Record<string, number> = { i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6 };
/** Keys spelled with flats (their scales use flats); the rest use sharps. */
const FLAT_KEYS = new Set(["F major", "Bb major", "Eb major", "Ab major", "Db major", "Gb major", "D minor", "G minor", "C minor", "F minor", "Bb minor", "Eb minor"]);

export function parseKey(key: string): { tonic: number; minor: boolean; flats: boolean } {
  const [name, mode] = key.split(" ");
  return { tonic: PC[name!]!, minor: mode === "minor", flats: FLAT_KEYS.has(key) || name!.includes("b") };
}

function chordOf(numeral: string, key: string): string {
  const m = /^([b#]?)(vii|iii|iv|vi|ii|v|i|VII|III|IV|VI|II|V|I)(maj7|m7b5|7|9|ø|°|sus2|sus4)?$/.exec(numeral);
  if (!m) throw new Error(`not a Roman numeral: ${numeral}`);
  const [, accidental, deg, suffix] = m;
  const k = parseKey(key);
  const pc = (k.tonic + (k.minor ? MINOR : MAJOR)[DEGREE[deg!.toLowerCase()]!]! + (accidental === "b" ? -1 : accidental === "#" ? 1 : 0) + 12) % 12;
  const root = (k.flats || accidental === "b" ? FLAT_NAMES : SHARP_NAMES)[pc]!;
  const lower = deg === deg!.toLowerCase();
  const quality = suffix === "maj7" ? "maj7"
    : suffix === "ø" || suffix === "m7b5" ? "m7b5"
    : suffix === "°" ? "dim"
    : suffix === "7" ? (lower ? "m7" : "7")
    : suffix === "9" ? (lower ? "m9" : "add9")
    : suffix === "sus2" || suffix === "sus4" ? suffix
    : lower ? "m" : "";
  return root + quality;
}

/** "i | VI | III | VII" in "F minor" → "Fm | Db | Ab | Eb" (chords sharing a bar stay space-separated). */
export function romanToChords(progression: string, key: string): string {
  return progression.split("|").map((bar) => bar.trim().split(/\s+/).map((n) => chordOf(n, key)).join(" ")).join(" | ");
}

const INTERVALS: Record<string, number[]> = {
  "": [0, 4, 7], m: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7], "7": [0, 4, 7, 10],
  maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], m7b5: [0, 3, 6, 10], add9: [0, 4, 7, 14], m9: [0, 3, 7, 10, 14],
};

/** The tones of a chord symbol as lower-case note names (Song JSON note syntax), root first: "Fm7" → f ab c eb. */
export function chordTones(symbol: string): string[] {
  const m = /^([A-G][#b]?)(.*?)(\/.*)?$/.exec(symbol);
  if (!m) throw new Error(`not a chord: ${symbol}`);
  const root = PC[m[1]!]!;
  const flats = m[1]!.includes("b") || ["F"].includes(m[1]!) || (m[2]!.startsWith("m") && ["D", "G", "C", "F"].includes(m[1]!));
  return (INTERVALS[m[2]!] ?? INTERVALS[""]!).map((i) => (flats ? FLAT_NAMES : SHARP_NAMES)[(root + i) % 12]!.toLowerCase());
}
