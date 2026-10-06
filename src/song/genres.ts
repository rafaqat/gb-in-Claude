// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * Genre templates (M9): genre knowledge as rules in code. `templateSong` turns a genre, key and tempo into a complete
 * Song JSON draft — form, a progression per section (Roman numerals, so every key works), GarageBand instruments
 * including the genre's drum kit, a bass style, a hook from chord tones, and drums: the mined groove of the Groove
 * MIDI Dataset where it covers the genre (pattern, timing and accents), genre rules where it does not.
 * The draft is a starting point for Claude to develop, not a finished song.
 */
import { err, ok, type Result } from "../result.js";
import { GROOVES } from "./grooves.js";
import { chordTones, parseKey, romanToChords } from "./roman.js";
import { COMMON_LOOPS } from "./common-loops.js";

/** GarageBand drum kits on GM programs (knowledge/gm-patch-map GM_DRUM_KIT_MAP). GarageBand plays 24 and 25 as
 * Boutique 808; the GM draft synth plays only 25 as a TR-808 (24 is its Electronic kit), so tr808 drafts closer. */
const KIT = { socal: 0, retroRock: 8, electro: 16, boutique808: 24, tr808: 25, roots: 32, orchestral: 40 } as const;
type Grid = Record<string, string>;
type Drums = { full: Grid; light?: Grid; groove?: string };
type Section = { name: string; bars: number; drums?: "full" | "light"; bass?: boolean; hook?: boolean; pad?: boolean; arp?: boolean; prog?: "a" | "b" };

export type GenreTemplate = {
  defaultBpm: number;
  form: Section[];
  /** per mode, progressions "a" (verses, intros) and "b" (choruses, drops) in Roman numerals, 4 bars each */
  progression: { minor: { a: string; b: string }; major: { a: string; b: string } };
  kit?: number;
  drums?: Drums;
  /** line: a written bass part (chord tones, like the hook) instead of a chord style — e.g. a trap 808 — with glide */
  bass: { program: number; style: "sustain" | "offbeat" | "rolling" | "octave"; level?: number; line?: { pattern: string; octave: number; glide?: boolean } };
  /** swing percentage (50 straight … 75 hard) and its unit */
  swing?: { percent: number; unit: "16th" | "8th" };
  pad?: { program: number; style: "sustain" | "stabs"; level?: number };
  arp?: { program: number; style: "up" | "down" | "updown" | "broken" | "gated"; level?: number; octave?: number };
  /** the hook: chord tones per bar (1 root · 3 third · 5 fifth · 7 seventh · 8 octave · ~ rest · @n shares), cycled */
  hook?: { program: number; role: "lead" | "lead-high"; octave: number; pattern: string; level?: number };
  humanize?: "tight" | "natural" | "loose";
};

/** The mined groove's grid for the voices it covers well (non-empty lines). */
const mined = (style: string, voices: string[]): Grid =>
  Object.fromEntries(voices.flatMap((v) => {
    const g = GROOVES[style]?.voices[v as keyof (typeof GROOVES)[string]["voices"]]?.grid;
    return g && /[xXo]/.test(g) ? [[v, g]] : [];
  }));

const FOUR = "x...x...x...x...";
const BACKBEAT = "....x.......x...";
const EIGHTHS = "x.x.x.x.x.x.x.x.";
const OFFBEAT_OPEN = "..x...x...x...x.";
const sec = (name: string, bars: number, extra: Partial<Section> = {}): Section => ({ name, bars, ...extra });
const POP_PROG = { minor: { a: "i | VI | III | VII", b: "VI | VII | i | i" }, major: { a: "I | V | vi | IV", b: "vi | IV | I | V" } };

export const GENRE_TEMPLATES: Record<string, GenreTemplate> = {
  "lo-fi hip-hop": {
    defaultBpm: 85, kit: KIT.boutique808, humanize: "loose", swing: { percent: 57, unit: "16th" },
    form: [sec("intro", 4, { pad: true }), sec("loop", 8, { drums: "full", bass: true, pad: true }), sec("variation", 8, { drums: "full", bass: true, pad: true, hook: true, prog: "b" }), sec("outro", 4, { pad: true, drums: "light" })],
    progression: { minor: { a: "i9 | iv9 | VIImaj7 | IIImaj7", b: "VImaj7 | v7 | i9 | i9" }, major: { a: "Imaj7 | vi7 | ii7 | V7", b: "IVmaj7 | iii7 | vi7 | V7" } },
    drums: { groove: "hiphop", full: { ...mined("hiphop", ["kick", "snare"]), hat: "x.x.x.x.x.x.x.x." }, light: { kick: "x.......x......." } },
    bass: { program: 33, style: "sustain" }, pad: { program: 4, style: "stabs" },
    hook: { program: 11, role: "lead", octave: 5, pattern: "5 ~ 3 1 | 3@2 ~ 5 | 7 ~ 5 3 | 1@4" },
  },
  "R&B": {
    defaultBpm: 75, kit: KIT.boutique808, humanize: "natural", swing: { percent: 55, unit: "16th" },
    form: [sec("intro", 4, { pad: true }), sec("verse", 8, { drums: "full", bass: true, pad: true }), sec("chorus", 8, { drums: "full", bass: true, pad: true, hook: true, prog: "b" }), sec("outro", 4, { pad: true })],
    progression: { minor: { a: "i9 | VImaj7 | iv7 | v7", b: "VImaj7 | VII | i9 | i9" }, major: { a: "Imaj7 | vi9 | ii7 | V7", b: "IVmaj7 | iii7 | ii7 | V7" } },
    drums: { groove: "soul", full: { kick: "x.....x...x.....", clap: BACKBEAT, hat: "x.xxx.x.x.xxx.x." } },
    bass: { program: 39, style: "sustain" }, pad: { program: 4, style: "sustain" },
    hook: { program: 85, role: "lead", octave: 5, pattern: "5@2 3 1 | 7@3 5 | 3 5 7 8 | 5@4", level: -3 },
  },
  ambient: {
    defaultBpm: 70, humanize: "loose",
    form: [sec("drift", 8, { pad: true }), sec("bloom", 8, { pad: true, arp: true, bass: true }), sec("fade", 8, { pad: true, hook: true, bass: true, prog: "b" })],
    progression: { minor: { a: "i | VI | III | VII", b: "iv | VI | i | VII" }, major: { a: "I | vi | IV | V", b: "IVmaj7 | I | vi | V" } },
    bass: { program: 89, style: "sustain", level: -6 }, pad: { program: 92, style: "sustain" },
    arp: { program: 98, style: "updown", level: -6 }, hook: { program: 88, role: "lead-high", octave: 5, pattern: "5@4 | 3@4 | 8@4 | 7@4", level: -6 },
  },
  "jazz ballad": {
    defaultBpm: 80, kit: KIT.roots, humanize: "loose", swing: { percent: 64, unit: "8th" },
    form: [sec("head", 8, { drums: "light", bass: true, pad: true, hook: true }), sec("solo", 8, { drums: "full", bass: true, pad: true, prog: "b" }), sec("head-out", 8, { drums: "light", bass: true, pad: true, hook: true })],
    progression: { minor: { a: "iiø V7 | i7 | iv7 | V7", b: "i7 | VImaj7 | iiø V7 | i7" }, major: { a: "ii7 V7 | Imaj7 | vi7 | ii7 V7", b: "Imaj7 | IVmaj7 | iii7 vi7 | ii7 V7" } },
    drums: { groove: "jazz", full: { ...mined("jazz", ["ride", "kick"]), "pedal-hat": BACKBEAT }, light: { ride: "x..xx..xx..xx..x", "pedal-hat": BACKBEAT } },
    bass: { program: 32, style: "rolling" }, pad: { program: 0, style: "stabs" },
    hook: { program: 66, role: "lead", octave: 4, pattern: "3 5 7 8 | 7@3 5 | 3 5 7 5 | 3@4" },
  },
  reggaeton: {
    defaultBpm: 95, kit: KIT.boutique808, humanize: "tight",
    form: [sec("intro", 4, { arp: true }), sec("verse", 8, { drums: "full", bass: true, arp: true }), sec("chorus", 8, { drums: "full", bass: true, arp: true, hook: true, prog: "b" }), sec("outro", 4, { drums: "full", arp: true })],
    progression: { minor: { a: "i | VI | III | VII", b: "i | VI | VII | v" }, major: { a: "vi | IV | I | V", b: "I | V | vi | IV" } },
    drums: { full: { kick: FOUR, snare: "...x..x....x..x.", hat: EIGHTHS } },
    bass: { program: 38, style: "octave" }, arp: { program: 24, style: "broken", octave: 3 },
    hook: { program: 80, role: "lead", octave: 5, pattern: "5 5 3 1 | 3@2 5 8 | 7 5 3 5 | 1@4" },
  },
  synthwave: {
    defaultBpm: 100, kit: KIT.electro, humanize: "tight",
    form: [sec("intro", 8, { pad: true, arp: true }), sec("verse", 8, { drums: "full", bass: true, pad: true, arp: true }), sec("chorus", 8, { drums: "full", bass: true, pad: true, arp: true, hook: true, prog: "b" }), sec("outro", 4, { pad: true })],
    progression: { minor: { a: "i | VI | III | VII", b: "VI | VII | i | i" }, major: { a: "I | V | vi | IV", b: "IV | V | vi | V" } },
    drums: { full: { kick: FOUR, snare: BACKBEAT, hat: "..x...x...x...x." } },
    bass: { program: 38, style: "octave" }, pad: { program: 90, style: "sustain" }, arp: { program: 81, style: "gated", level: -3 },
    hook: { program: 81, role: "lead", octave: 5, pattern: "5@2 3 1 | 8@4 | 3 5 7 8 | 5@4" },
  },
  pop: {
    defaultBpm: 105, kit: KIT.socal, humanize: "natural",
    form: [sec("verse", 8, { drums: "light", bass: true, pad: true }), sec("pre", 4, { drums: "full", bass: true, pad: true }), sec("chorus", 8, { drums: "full", bass: true, pad: true, hook: true, arp: true, prog: "b" }), sec("bridge", 4, { pad: true, prog: "b" }), sec("chorus2", 8, { drums: "full", bass: true, pad: true, hook: true, arp: true, prog: "b" })],
    progression: POP_PROG,
    drums: { groove: "pop", full: { ...mined("pop", ["kick", "snare", "hat"]) }, light: { kick: "x.......x.x.....", hat: EIGHTHS } },
    bass: { program: 33, style: "offbeat" }, pad: { program: 0, style: "stabs" }, arp: { program: 89, style: "updown", level: -6 },
    hook: { program: 80, role: "lead", octave: 5, pattern: "3 5 5 8 | 5@2 3 1 | 1 3 5 8 | 8@2 5@2" },
  },
  afrobeats: {
    // M13.17 (eval/m13-17): the 808 kit moved afrobeats up in CLAP's genre ranking of GM drafts on every seed, in 5 keys
    defaultBpm: 108, kit: KIT.tr808, humanize: "natural",
    form: [sec("intro", 4, { arp: true }), sec("verse", 8, { drums: "full", bass: true, arp: true }), sec("hook", 8, { drums: "full", bass: true, arp: true, hook: true, pad: true, prog: "b" }), sec("outro", 4, { drums: "full", bass: true, arp: true })],
    progression: { minor: { a: "i | iv | VII | III", b: "VI | VII | i | i" }, major: { a: "I | vi | IV | V", b: "IV | V | I | vi" } },
    // Live renders: GarageBand's "Classic Analog Pad" (89) and a bassless outro moved the beat tracker half a beat off
    // (grid recall 0.56); string pad + outro bass: 0.97. The kick was not the cause.
    drums: { groove: "afrobeat", full: { kick: "x.....x...x.....", rim: "..x..x....x..x..", shaker: "xxxxxxxxxxxxxxxx", clap: BACKBEAT }, light: { shaker: "xxxxxxxxxxxxxxxx", rim: "..x..x....x..x.." } },
    bass: { program: 38, style: "offbeat" }, arp: { program: 27, style: "broken", octave: 3 }, pad: { program: 50, style: "sustain", level: -6 },
    hook: { program: 73, role: "lead", octave: 5, pattern: "3 5 ~ 3 | 8@2 5 3 | 1 3 5 8 | 5@4" },
  },
  funk: {
    defaultBpm: 110, kit: KIT.roots, humanize: "natural", swing: { percent: 54, unit: "16th" },
    form: [sec("groove", 8, { drums: "full", bass: true, pad: true }), sec("break", 4, { drums: "light", bass: true }), sec("groove2", 8, { drums: "full", bass: true, pad: true, hook: true })],
    progression: { minor: { a: "i7 | IV7 | i7 | IV7", b: "i7 | i7 | IV7 | V7" }, major: { a: "I7 | IV7 | I7 | IV7", b: "I7 | I7 | IV7 | V7" } },
    drums: { groove: "funk", full: { ...mined("funk", ["kick", "snare", "hat"]) }, light: { kick: "x...............", snare: "....x..o.o..x..." } },
    bass: { program: 36, style: "rolling" }, pad: { program: 28, style: "stabs" },
    hook: { program: 61, role: "lead", octave: 4, pattern: "1 ~ 3 1 | 7@2 5@2 | 1 ~ 3 5 | 7@4" },
  },
  "indie rock": {
    defaultBpm: 120, kit: KIT.retroRock, humanize: "natural",
    form: [sec("intro", 4, { arp: true }), sec("verse", 8, { drums: "full", bass: true, arp: true }), sec("chorus", 8, { drums: "full", bass: true, arp: true, pad: true, hook: true, prog: "b" }), sec("outro", 4, { drums: "full", arp: true })],
    progression: { minor: { a: "i | VII | VI | VII", b: "III | VII | iv | VI" }, major: { a: "I | V | vi | IV", b: "IV | I | V | vi" } },
    drums: { groove: "rock", full: { ...mined("rock", ["kick", "snare"]), hat: EIGHTHS }, light: { kick: "x.......x.......", hat: EIGHTHS } },
    bass: { program: 34, style: "rolling" }, arp: { program: 29, style: "broken", octave: 3 }, pad: { program: 30, style: "sustain", level: -6 },
    hook: { program: 27, role: "lead", octave: 4, pattern: "3@2 1 5 | 1@4 | 3 5 3 1 | 5@4", level: -3 },
  },
  "deep house": {
    defaultBpm: 122, kit: KIT.electro, humanize: "natural", swing: { percent: 54, unit: "16th" },
    form: [sec("intro", 8, { drums: "light" }), sec("groove", 8, { drums: "full", bass: true, pad: true }), sec("break", 8, { pad: true, prog: "b" }), sec("drop", 8, { drums: "full", bass: true, pad: true, hook: true })],
    progression: { minor: { a: "i7 | VIImaj7 | VImaj7 | v7", b: "iv7 | VIImaj7 | IIImaj7 | VImaj7" }, major: { a: "ii7 | V7 | Imaj7 | vi7", b: "IVmaj7 | iii7 | ii7 | V7" } },
    drums: { groove: "dance", full: { kick: FOUR, clap: BACKBEAT, "open-hat": OFFBEAT_OPEN, hat: "xxxxxxxxxxxxxxxx" }, light: { kick: FOUR } },
    bass: { program: 38, style: "offbeat" }, pad: { program: 17, style: "stabs" },
    hook: { program: 85, role: "lead", octave: 5, pattern: "5 ~ ~ 3 | ~ 1 ~ ~ | 5 ~ 7 ~ | 8@4", level: -4 },
  },
  techno: {
    defaultBpm: 130, kit: KIT.electro, humanize: "tight",
    form: [sec("intro", 8, { drums: "light" }), sec("build", 8, { drums: "full", bass: true, arp: true }), sec("peak", 8, { drums: "full", bass: true, arp: true, pad: true }), sec("outro", 8, { drums: "light", arp: true })],
    progression: { minor: { a: "i | i | i | i", b: "i | i | VI | VII" }, major: { a: "vi | vi | vi | vi", b: "vi | vi | IV | V" } },
    drums: { full: { kick: FOUR, "open-hat": OFFBEAT_OPEN, clap: BACKBEAT, rim: "...x..x...x..x.." }, light: { kick: FOUR, "open-hat": OFFBEAT_OPEN } },
    bass: { program: 38, style: "offbeat" }, arp: { program: 81, style: "gated" }, pad: { program: 95, style: "sustain", level: -6 },
  },
  "UK garage": {
    defaultBpm: 132, kit: KIT.electro, humanize: "natural", swing: { percent: 64, unit: "16th" },
    form: [sec("intro", 4, { pad: true }), sec("verse", 8, { drums: "full", bass: true, pad: true }), sec("chorus", 8, { drums: "full", bass: true, pad: true, hook: true, prog: "b" }), sec("outro", 4, { drums: "full", pad: true })],
    progression: { minor: { a: "i9 | iv9 | VImaj7 | V7", b: "VImaj7 | VIImaj7 | i9 | i9" }, major: { a: "ii9 | V7 | Imaj7 | vi7", b: "IVmaj7 | V7 | iii7 | vi7" } },
    // the two-step: kick on 1 and the "and" of 2, snare on 2 and 4, shuffled hats (gb-mcp's grid is straight: swing comes from humanize).
    // No shaker: a swung 16th shaker read as funk (CLAP rank 9 → 5 on GM drafts, every seed; the best of 27 variants)
    drums: { full: { kick: "x.....x...x.....", snare: BACKBEAT, hat: "..x..xx...x..xx." } },
    bass: { program: 39, style: "offbeat" }, pad: { program: 16, style: "stabs" },
    hook: { program: 85, role: "lead", octave: 5, pattern: "5 ~ 3 5 | 8@2 ~ 5 | 7 5 3 5 | 3@4" },
  },
  trap: {
    defaultBpm: 140, kit: KIT.boutique808, humanize: "tight",
    form: [sec("intro", 4, { pad: true, hook: true }), sec("verse", 8, { drums: "full", bass: true, hook: true }), sec("hook", 8, { drums: "full", bass: true, pad: true, hook: true, prog: "b" }), sec("outro", 4, { pad: true })],
    progression: { minor: { a: "i | VI | iv | V", b: "i | III | VI | V" }, major: { a: "vi | IV | ii | V", b: "vi | I | IV | V" } },
    // half time: one snare per bar on beat 3, rolling hats
    drums: { full: { kick: "x......x..x.....", snare: "........x.......", hat: "x.x.x.x.x.x.xxxxx.x.x.x.xxx.xxxx" } },
    bass: { program: 38, style: "sustain", line: { pattern: "1@3 8 | 1@2 ~ 5 | 1@3 8 | 1 ~ 5 8", octave: 1, glide: true } }, pad: { program: 91, style: "sustain", level: -6 },
    hook: { program: 14, role: "lead-high", octave: 5, pattern: "1 3 5 3 | 2 1 7 5 | 1 3 5 8 | 5@4" },
  },
  "drum and bass": {
    defaultBpm: 174, kit: KIT.electro, humanize: "tight",
    form: [sec("intro", 8, { pad: true }), sec("drop", 8, { drums: "full", bass: true, pad: true }), sec("roller", 8, { drums: "full", bass: true, pad: true, arp: true, prog: "b" }), sec("outro", 8, { pad: true, drums: "light" })],
    progression: { minor: { a: "i9 | VImaj7 | VIImaj7 | v7", b: "iv7 | VImaj7 | i9 | i9" }, major: { a: "Imaj7 | vi7 | IVmaj7 | V7", b: "ii7 | V7 | Imaj7 | vi7" } },
    // the two-step break: kick on 1 and the "and" of 3, snare on 2 and 4
    drums: { full: { kick: "x.........x.....", snare: "....x.......x...", hat: EIGHTHS, ride: "x.x.x.x.x.x.x.x." }, light: { hat: EIGHTHS } },
    bass: { program: 39, style: "rolling" }, pad: { program: 89, style: "sustain" }, arp: { program: 4, style: "up", level: -6 },
  },
  "EDM (big room)": {
    defaultBpm: 128, kit: KIT.electro, humanize: "tight",
    form: [sec("intro", 8, { drums: "full", pad: true }), sec("build", 8, { drums: "light", pad: true }), sec("drop", 8, { drums: "full", bass: true, pad: true, hook: true, prog: "b" }), sec("outro", 8, { drums: "full", bass: true })],
    progression: { minor: { a: "i | VI | III | VII", b: "VI | VII | i | i" }, major: { a: "vi | IV | I | V", b: "IV | V | vi | vi" } },
    drums: { full: { kick: FOUR, clap: BACKBEAT, "open-hat": OFFBEAT_OPEN }, light: { snare: "x.x.x.x.x.x.x.x.", kick: FOUR } },
    bass: { program: 38, style: "offbeat" }, pad: { program: 90, style: "stabs" },
    hook: { program: 81, role: "lead", octave: 5, pattern: "1 1 3 1 | 8@2 7 5 | 1 1 3 5 | 7@4" },
  },
  "classical/pop crossover": {
    defaultBpm: 90, kit: KIT.orchestral, humanize: "natural",
    form: [sec("intro", 4, { arp: true }), sec("verse", 8, { arp: true, pad: true, hook: true }), sec("chorus", 8, { arp: true, pad: true, hook: true, drums: "light", bass: true, prog: "b" }), sec("coda", 4, { arp: true, pad: true })],
    progression: { minor: { a: "i | VI | iv | V", b: "III | VII | VI | V" }, major: { a: "I | V | vi | IV", b: "IV | I | ii7 | V" } },
    drums: { full: {}, light: { "tom-low": "x.......x.......", crash: "x..............." } },
    bass: { program: 43, style: "sustain", level: -3 }, pad: { program: 48, style: "sustain" }, arp: { program: 0, style: "broken", octave: 3 },
    hook: { program: 42, role: "lead", octave: 4, pattern: "3@2 1 7 | 1@4 | 5 3 1 3 | 5@4" },
  },
  "ambient trance (William Orbit style)": {
    defaultBpm: 132, kit: KIT.boutique808, humanize: "natural",
    form: [sec("intro", 8, { pad: true }), sec("build", 8, { drums: "light", pad: true, arp: true }), sec("drop", 8, { drums: "full", bass: true, pad: true, arp: true, hook: true, prog: "b" }), sec("outro", 8, { pad: true, arp: true, bass: true })],
    progression: { minor: { a: "i | VI | III | VII", b: "VI | III | VII | i" }, major: { a: "I | vi | IV | V", b: "IV | I | V | vi" } },
    drums: { groove: "dance", full: { kick: FOUR, "open-hat": OFFBEAT_OPEN, clap: BACKBEAT }, light: { kick: FOUR } },
    bass: { program: 39, style: "offbeat", level: -2 }, pad: { program: 48, style: "sustain" }, arp: { program: 98, style: "updown", level: -3 },
    hook: { program: 85, role: "lead", octave: 5, pattern: "5@2 3 1 | 8@4 | 7 5 3 2 | 1@4", level: -3 },
  },
  "Levantine ethereal strings (Fairuz style)": {
    defaultBpm: 84, humanize: "loose",
    form: [sec("intro", 8, { pad: true }), sec("verse", 8, { pad: true, hook: true, arp: true, bass: true }), sec("refrain", 8, { pad: true, hook: true, arp: true, bass: true, prog: "b" }), sec("coda", 4, { pad: true })],
    progression: { minor: { a: "i | iv | V | i", b: "VI | iv | V | i" }, major: { a: "I | IV | V | I", b: "vi | IV | V | I" } },
    bass: { program: 43, style: "sustain", level: -3 }, pad: { program: 48, style: "sustain" }, arp: { program: 24, style: "broken", level: -6, octave: 3 },
    hook: { program: 40, role: "lead-high", octave: 5, pattern: "5 7 5 | 3 2 1 | 3 2 1 | 2@3" },
  },
  "epic orchestral (Hans Zimmer style)": {
    defaultBpm: 90, kit: KIT.orchestral, humanize: "natural",
    form: [sec("prelude", 8, { arp: true, bass: true }), sec("rise", 8, { arp: true, bass: true, pad: true, drums: "light" }), sec("climax", 8, { arp: true, bass: true, pad: true, drums: "full", hook: true, prog: "b" }), sec("coda", 4, { pad: true, bass: true })],
    progression: { minor: { a: "i | VI | III | VII", b: "i | VII | VI | VII" }, major: { a: "vi | IV | I | V", b: "vi | V | IV | V" } },
    drums: { full: { "tom-low": "x.....x.x.......", "tom-mid": "....x.......x...", crash: "x..............." }, light: { "tom-low": "x.......x......." } },
    bass: { program: 43, style: "sustain" }, pad: { program: 61, style: "sustain" }, arp: { program: 48, style: "gated" },
    hook: { program: 60, role: "lead", octave: 4, pattern: "1@2 3 5 | 6@3 5 | 4 3 2 7 | 1@4" },
  },
};

/** A hook bar: chord tones of the bar's chord, as Song JSON notes in `octave` (tones above the root go up). */
function hookBar(pattern: string, chord: string, octave: number): string {
  const tones = chordTones(chord.split("/")[0]!);
  const rootPc = NOTE_PC[tones[0]!]!;
  return pattern.trim().split(/\s+/).map((tok) => {
    const [deg, dur] = tok.split("@");
    if (deg === "~") return dur ? `~@${dur}` : "~";
    const d = Number(deg);
    // 1 root · 2 the tone a step above · 3 third · 4 a step above the third · 5 fifth · 6 a step above the fifth ·
    // 7 seventh (or the octave for triads) · 8 octave
    const idx = { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: -1 }[d] ?? 0;
    const name = idx === -1 || tones[idx] === undefined ? tones[0]! : tones[idx]!;
    let pc = NOTE_PC[name]! + (d === 2 || d === 4 || d === 6 ? 2 : 0);
    const name2 = d === 2 || d === 4 || d === 6 ? PC_NAME[pc % 12]! : name;
    const up = (pc % 12) < rootPc || d === 8 || (idx === -1 && d === 7) ? 1 : 0;
    pc %= 12;
    const note = `${name2}${octave + up}`;
    return dur ? `${note}@${dur}` : note;
  }).join(" ");
}
const NOTE_PC: Record<string, number> = { c: 0, "c#": 1, db: 1, d: 2, "d#": 3, eb: 3, e: 4, f: 5, "f#": 6, gb: 6, g: 7, "g#": 8, ab: 8, a: 9, "a#": 10, bb: 10, b: 11 };
const PC_NAME = ["c", "c#", "d", "eb", "e", "f", "f#", "g", "ab", "a", "bb", "b"];

/** variant: 0 (default) the hand-written progressions; 1–3 the genre's common loops (M13.16, common-loops.ts). */
export type TemplateRequest = { genre: string; key: string; bpm?: number; meter?: number; title?: string; seed?: number; variant?: number };

const SEVENTHS: Record<string, string> = { I: "Imaj7", ii: "ii7", iii: "iii7", IV: "IVmaj7", V: "V7", vi: "vi7",
  i: "i7", III: "IIImaj7", iv: "iv7", v: "v7", VI: "VImaj7", VII: "VII7" };

/** A common loop (triads) in the template's colour: sevenths when its own progression has them. */
function coloured(loop: string, own: string): string {
  if (!/\d|maj|ø/.test(own)) return loop;
  return loop.split("|").map((c) => SEVENTHS[c.trim()] ?? c.trim()).join(" | ");
}

/** A complete Song JSON draft for the genre, in the key and at the tempo given. */
export function templateSong(req: TemplateRequest): Result<Record<string, unknown>, string> {
  const t = GENRE_TEMPLATES[req.genre];
  if (!t) return err(`unknown genre "${req.genre}"; genres: ${Object.keys(GENRE_TEMPLATES).join(", ")}`);
  const minor = parseKey(req.key).minor;
  const meter = req.meter ?? 4;
  const own = minor ? t.progression.minor : t.progression.major;
  const common = COMMON_LOOPS[req.genre]?.[minor ? "minor" : "major"];
  const v = req.variant ?? 0;
  const prog = v > 0 && common
    ? { a: coloured(common.verse[v - 1]!, own.a), b: coloured(common.chorus[v - 1]!, own.b) }
    : own;
  const chords = { a: romanToChords(prog.a, req.key), b: romanToChords(prog.b, req.key) };
  const of = (s: Section) => chords[s.prog ?? "a"];
  const each = <T>(flag: keyof Section, part: (s: Section) => T) => Object.fromEntries(t.form.filter((s) => s[flag]).map((s) => [s.name, part(s)]));
  const tracks: Record<string, unknown>[] = [];
  if (t.drums && meter === 4) {
    const parts = Object.fromEntries(t.form.filter((s) => s.drums).map((s) => [s.name, { grid: s.drums === "light" ? t.drums!.light ?? t.drums!.full : t.drums!.full }])
      .filter(([, p]) => Object.keys((p as { grid: Grid }).grid).length > 0));
    if (Object.keys(parts).length > 0) tracks.push({ name: "Drums", role: "drums", ...(t.kit !== undefined ? { program: t.kit } : {}), parts });
  }
  if (t.pad) tracks.push({ name: "Chords", role: "pad", program: t.pad.program, ...(t.pad.level ? { level: t.pad.level } : {}), parts: each("pad", (s) => ({ chords: of(s), style: t.pad!.style })) });
  if (t.arp) tracks.push({ name: "Arp", role: "arp", program: t.arp.program, ...(t.arp.level ? { level: t.arp.level } : {}), parts: each("arp", (s) => ({ chords: of(s), style: t.arp!.style, ...(t.arp!.octave ? { octave: t.arp!.octave } : {}) })) });
  const line = t.bass.line;
  tracks.push({ name: "Bass", role: "bass", program: t.bass.program, ...(t.bass.level ? { level: t.bass.level } : {}), ...(line?.glide ? { glide: true } : {}),
    parts: each("bass", (s) => line
      ? { notes: of(s).split("|").map((bar, i) => { const bars = line.pattern.split("|"); return hookBar(bars[i % bars.length]!, bar.trim().split(/\s+/)[0]!, line.octave); }).join(" | ") }
      : { chords: of(s), style: t.bass.style }) });
  if (t.hook) {
    const bars = t.hook.pattern.split("|");
    tracks.push({ name: "Hook", role: t.hook.role, program: t.hook.program, ...(t.hook.level ? { level: t.hook.level } : {}),
      parts: each("hook", (s) => ({ notes: of(s).split("|").map((bar, i) => hookBar(bars[i % bars.length]!, bar.trim().split(/\s+/)[0]!, t.hook!.octave)).join(" | ") })) });
  }
  const groove = meter === 4 && t.drums?.groove ? { groove: t.drums.groove } : {};
  return ok({
    title: req.title ?? `${req.genre} draft`, tempo: req.bpm ?? t.defaultBpm, key: req.key, timeSignature: [meter, 4], seed: req.seed ?? 1,
    humanize: t.humanize ?? "natural", ...groove, ...(meter === 4 && t.swing ? { swing: t.swing.percent, swingUnit: t.swing.unit } : {}),
    sections: t.form.map((s) => ({ name: s.name, bars: s.bars })),
    tracks: tracks.filter((tr) => Object.keys(tr.parts as object).length > 0),
  });
}
