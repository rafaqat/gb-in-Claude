// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * M13.14 benchmark set: Song JSON songs with known notes, for the closed loop Song JSON → GM render → gb_song
 * transcribe → score. Each song is a gb_song template draft (its drums, chords and bass) with the template's lead
 * replaced by a sung-style line ("Vocal", GM Voice Oohs) in every section but the intro, outro and break, so Demucs
 * finds a voice. One song drifts (a tempo map) like a live take. Run once; the files are the frozen truth.
 *   npx tsx eval/m13-transcribe/make-songs.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { templateSong } from "../../src/song/genres.js";
import { parseProgression } from "../../src/composition/progression.js";
import { parseSong } from "../../src/song/schema.js";
import { validateSong } from "../../src/song/validate.js";

const OUT = join(import.meta.dirname, "songs");

/** mulberry32: same seed, same melody. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 16 steps: x starts a note, - holds it, . rests. Sung phrases: 8ths, quarters, a held note, pickups. */
const RHYTHMS = [
  "x-x-x---x-x-x---", "x---x---x-x-x---", "x-----x-x---x---", "x-------x-------", "..x-x-x---x-x-x-",
  "x-x-x-x-x-------", "x---x-x---x-x---", "....x-x-x---x---",
];
const NAMES = ["c", "c#", "d", "d#", "e", "f", "f#", "g", "g#", "a", "a#", "b"];
const name = (p: number) => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;
const LOW = 60, HIGH = 79; // C4–G5

function scale(key: string): number[] {
  const [tonic, mode] = key.split(" ");
  const t = ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as Record<string, number>)[tonic![0]!]! + (tonic!.includes("b") ? -1 : tonic!.includes("#") ? 1 : 0);
  const steps = mode === "minor" ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  return steps.map((s) => (t + s + 12) % 12);
}

/** A melody for the bars of one section: chord tones on the strong steps, scale steps between, near the last note. */
function melody(chords: string, bars: number, key: string, next: () => number, start: number): { notes: string; last: number } {
  const prog = parseProgression(chords, 4);
  if (!prog.ok) throw new Error(chords);
  const inKey = scale(key);
  const pool = (pcs: number[]) => Array.from({ length: HIGH - LOW + 1 }, (_, i) => LOW + i).filter((p) => pcs.includes(p % 12));
  let last = start;
  const out: string[] = [];
  for (let b = 0; b < bars; b++) {
    const chord = prog.value.chords.find((c) => c.startBeat <= (b % prog.value.bars) * 4 && (b % prog.value.bars) * 4 < c.startBeat + c.durationBeats)!.chord;
    const tones = pool(chord.intervals.slice(0, 3).map((i) => (chord.root + i) % 12));
    const steps = pool(inKey);
    const rhythm = RHYTHMS[Math.floor(next() * RHYTHMS.length)]!;
    const tokens: string[] = [];
    for (let s = 0; s < 16;) {
      if (rhythm[s] === ".") { let n = 0; while (s + n < 16 && rhythm[s + n] === ".") n++; tokens.push(n > 1 ? `~@${n}` : "~"); s += n; continue; }
      let n = 1;
      while (s + n < 16 && rhythm[s + n] === "-") n++;
      const choices = (s % 4 === 0 ? tones : steps).filter((p) => Math.abs(p - last) <= 5 && p !== last);
      const p = choices.length ? choices[Math.floor(next() * choices.length)]! : tones[Math.floor(next() * tones.length)]!;
      tokens.push(n > 1 ? `${name(p)}@${n}` : name(p));
      last = p;
      s += n;
    }
    out.push(tokens.join(" "));
  }
  return { notes: out.join(" | "), last };
}

const SET = [
  { id: "pop-c", genre: "pop", key: "C major", seed: 11 },
  { id: "funk-em", genre: "funk", key: "E minor", seed: 12 },
  { id: "house-am", genre: "deep house", key: "A minor", seed: 13 },
  { id: "rnb-eb", genre: "R&B", key: "Eb major", seed: 14 },
  { id: "drift-g", genre: "indie rock", key: "G major", seed: 15, drift: [[5, 121], [9, 122.5], [13, 124], [17, 125.5]] as [number, number][] },
];

mkdirSync(OUT, { recursive: true });
for (const s of SET) {
  const t = templateSong({ genre: s.genre, key: s.key, variant: 0, title: `transcribe bench ${s.id}` });
  if (!t.ok) throw new Error(s.genre);
  const song = structuredClone(t.value) as unknown as { sections: { name: string; bars: number }[]; tracks: { name: string; role: string; parts: Record<string, { chords?: string }> }[]; tempoMap?: unknown };
  song.tracks = song.tracks.filter((x) => x.role !== "lead" && x.role !== "lead-high");
  const next = rng(s.seed);
  let last = 67;
  const parts: Record<string, { notes: string }> = {};
  for (const sec of song.sections) {
    if (/intro|outro|break/.test(sec.name)) continue;
    const chords = ["pad", "arp", "bass"].map((role) => song.tracks.find((x) => x.role === role && x.parts[sec.name]?.chords)?.parts[sec.name]?.chords).find(Boolean);
    if (!chords) continue;
    const m = melody(chords, sec.bars, s.key, next, last);
    parts[sec.name] = { notes: m.notes };
    last = m.last;
  }
  song.tracks.push({ name: "Vocal", role: "lead", program: 53, parts } as never);
  if (s.drift) song.tempoMap = s.drift.map(([bar, bpm]) => ({ bar, bpm }));
  const parsed = parseSong(song);
  if (!parsed.ok) throw new Error(`${s.id}: ${parsed.error.path} ${parsed.error.message}`);
  const errors = validateSong(parsed.value).filter((i) => i.severity === "error");
  if (errors.length) throw new Error(`${s.id}: ${JSON.stringify(errors)}`);
  writeFileSync(join(OUT, `${s.id}.json`), JSON.stringify(song, null, 1) + "\n", { flag: "wx" });
  console.error(`${s.id}: ${song.sections.reduce((n, x) => n + x.bars, 0)} bars`);
}
