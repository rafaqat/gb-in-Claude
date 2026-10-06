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
import { INSTRUMENT_RANGES } from "../knowledge/instrument-ranges.js";
import { parsePitch } from "../composition/pitch.js";
import { ORCHESTRAL_KIT_ONLY, type DrumVoice } from "../composition/drums.js";

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
  // ── M14: 27 more genres. GM can only hint at some signature instruments (GarageBand plays GM sitar/banjo as
  // Acoustic Guitar, accordion as an organ): the drafts carry each genre's rhythm, harmony and form; gb_generate
  // (ACE-Step) gives its real sound. Hand drums use the Latin/world voices (conga for darbuka and tabla).
  "Latin trap": {
    defaultBpm: 140, kit: KIT.boutique808, humanize: "tight",
    form: [sec("intro", 4, { pad: true, hook: true }), sec("verse", 8, { drums: "full", bass: true, pad: true }), sec("hook", 8, { drums: "full", bass: true, pad: true, hook: true, prog: "b" }), sec("outro", 4, { pad: true, drums: "light" })],
    progression: { minor: { a: "i | VI | III | VII", b: "i | iv | VI | V" }, major: { a: "vi | IV | I | V", b: "vi | ii | IV | III" } },
    // trap's half-time kick and snare under a dembow-flavoured rim
    drums: { full: { kick: "x......x..x.....", snare: "........x.......", hat: "x.x.x.x.x.xxx.x.x.x.x.x.xxx.xxxx", rim: "...x..x....x..x." }, light: { hat: EIGHTHS } },
    bass: { program: 38, style: "sustain", line: { pattern: "1@3 8 | 1@2 ~ 5 | 1@3 3 | 1 ~ 5 8", octave: 1, glide: true } }, pad: { program: 91, style: "sustain", level: -6 },
    hook: { program: 24, role: "lead", octave: 4, pattern: "5 3 1 3 | 5@2 ~ 3 | 7 5 3 1 | 3@4" },
  },
  dembow: {
    defaultBpm: 118, kit: KIT.boutique808, humanize: "tight",
    form: [sec("intro", 4, { arp: true }), sec("verse", 8, { drums: "full", bass: true, arp: true }), sec("coro", 8, { drums: "full", bass: true, arp: true, hook: true, prog: "b" }), sec("outro", 4, { drums: "full", arp: true })],
    progression: { minor: { a: "i | VII | VI | VII", b: "i | VI | VII | v" }, major: { a: "vi | V | IV | V", b: "vi | IV | V | iii" } },
    // the Dominican dembow: a relentless stuttering snare over four on the floor
    drums: { full: { kick: FOUR, snare: "...x..x.x..x..x.", clap: "...x.......x....", hat: "xxxxxxxxxxxxxxxx", "timbale-high": "..............xx" } },
    bass: { program: 38, style: "octave" }, arp: { program: 81, style: "gated", level: -3 },
    hook: { program: 80, role: "lead", octave: 5, pattern: "1 1 3 1 | 5@2 3 1 | 1 1 3 5 | 3@4" },
  },
  bachata: {
    defaultBpm: 128, kit: KIT.socal, humanize: "natural",
    form: [sec("intro", 4, { arp: true, hook: true }), sec("verse", 8, { drums: "full", bass: true, arp: true }), sec("chorus", 8, { drums: "full", bass: true, arp: true, hook: true, prog: "b" }), sec("mambo", 8, { drums: "full", bass: true, arp: true, hook: true }), sec("outro", 4, { arp: true })],
    progression: { minor: { a: "i | iv | V7 | i", b: "VI | VII | i | V7" }, major: { a: "I | IV | V7 | I", b: "vi | IV | V7 | I" } },
    // bongos in martillo, the güira scraping 16ths, the bass drum on one and three
    drums: { full: { kick: "x.......x.......", "bongo-high": "x.x.x.x.x.x.x.x.", "bongo-low": "...x.......x....", "guiro-short": "x.xxx.xxx.xxx.xx" } },
    bass: { program: 33, style: "offbeat" }, arp: { program: 24, style: "broken", octave: 3 },
    hook: { program: 24, role: "lead", octave: 5, pattern: "5 3 5 8 7 5 3 5 | 3@2 1@2 | 5 3 5 8 7 5 3 2 | 1@4" },
  },
  salsa: {
    // half-time grid: one 4/4 bar at 95 BPM = one salsa bar of 8 eighths at 190
    defaultBpm: 95, kit: KIT.socal, humanize: "natural",
    form: [sec("intro", 4, { pad: true, drums: "light" }), sec("verso", 8, { drums: "full", bass: true, pad: true }), sec("coro", 8, { drums: "full", bass: true, pad: true, arp: true, prog: "b" }), sec("mambo", 8, { drums: "full", bass: true, pad: true, arp: true, hook: true, prog: "b" })],
    progression: { minor: { a: "i | iv | V7 | i", b: "iv | V7 | i | i" }, major: { a: "I | IV | V7 | IV", b: "ii7 | V7 | I | I" } },
    // 3-2 son clave, cáscara on the timbale shell, conga tumbao (open tones on the "and" of four), bongo bell
    drums: { full: { claves: "x..x..x...x.x...", "timbale-high": "x.x.xx.x.xx.x.x.", "conga-mute": "x...x...x...x...", "conga-high": "......xx......xx", cowbell: "x...x...x...x..." }, light: { claves: "x..x..x...x.x..." } },
    bass: { program: 32, style: "offbeat" }, pad: { program: 0, style: "stabs" }, arp: { program: 0, style: "broken", octave: 4 },
    hook: { program: 61, role: "lead", octave: 4, pattern: "5 5 ~ 3 | 1@2 3 5 | 8 7 5 3 | 5@4" },
  },
  cumbia: {
    defaultBpm: 95, kit: KIT.socal, humanize: "natural",
    form: [sec("intro", 4, { arp: true, drums: "light" }), sec("verse", 8, { drums: "full", bass: true, arp: true }), sec("chorus", 8, { drums: "full", bass: true, arp: true, hook: true, prog: "b" }), sec("outro", 4, { drums: "full", arp: true, hook: true })],
    progression: { minor: { a: "i | VII | VII | i", b: "iv | i | V7 | i" }, major: { a: "I | V7 | V7 | I", b: "IV | I | V7 | I" } },
    // the güiro scrape on every eighth, conga answering on the off-beats, bass drum on one and three
    drums: { full: { kick: "x.......x.......", "guiro-long": "x.x.x.x.x.x.x.x.", "conga-high": "..x...x...x...x.", "conga-low": "......x.......x.", shaker: "xxxxxxxxxxxxxxxx" }, light: { "guiro-long": "x.x.x.x.x.x.x.x." } },
    bass: { program: 33, style: "octave" }, arp: { program: 25, style: "broken", octave: 3 },
    hook: { program: 73, role: "lead", octave: 5, pattern: "5 3 5 3 | 1@2 3@2 | 5 3 2 1 | 5@4" },
  },
  "bossa nova": {
    defaultBpm: 130, kit: KIT.roots, humanize: "loose",
    form: [sec("intro", 4, { pad: true, drums: "light" }), sec("A", 8, { drums: "full", bass: true, pad: true, hook: true }), sec("B", 8, { drums: "full", bass: true, pad: true, hook: true, prog: "b" }), sec("A2", 8, { drums: "full", bass: true, pad: true, hook: true })],
    progression: { minor: { a: "i7 | iv7 | iiø V7 | i7", b: "VImaj7 | iiø V7 | i7 | V7" }, major: { a: "Imaj7 | II7 | ii7 V7 | Imaj7", b: "IVmaj7 | iv7 | iii7 VI7 | ii7 V7" } },
    // the cross-stick bossa clave over two bars, the bass drum on one and the "and" of two, soft eighth hats
    drums: { full: { rim: "x..x..x...x..x.. | ..x..x..x...x...", kick: "x.....x.x.....x.", hat: "x.x.x.x.x.x.x.x." }, light: { rim: "x..x..x...x..x.. | ..x..x..x...x..." } },
    bass: { program: 32, style: "octave" }, pad: { program: 24, style: "stabs" },
    hook: { program: 73, role: "lead", octave: 5, pattern: "5@3 3 | 2@2 1@2 | 3 2 1 7 | 1@4" },
  },
  "corridos tumbados": {
    defaultBpm: 120, humanize: "natural",
    form: [sec("intro", 4, { arp: true, hook: true }), sec("verse", 8, { arp: true, bass: true }), sec("chorus", 8, { arp: true, bass: true, hook: true, prog: "b" }), sec("requinto", 8, { arp: true, bass: true, hook: true }), sec("outro", 4, { arp: true })],
    progression: { minor: { a: "i | iv | V7 | i", b: "VI | VII | i | V7" }, major: { a: "I | IV | V7 | I", b: "vi | IV | V7 | I" } },
    // guitars and tuba only: the tuba holds the roots (its range ends at A#3), the requinto plays fast runs
    bass: { program: 58, style: "sustain" }, arp: { program: 25, style: "broken", octave: 3 },
    hook: { program: 24, role: "lead", octave: 4, pattern: "1 2 3 5 3 2 1 7 | 1@4 | 5 4 3 2 3 2 1 7 | 1@4" },
  },
  "Latin pop": {
    defaultBpm: 100, kit: KIT.boutique808, humanize: "natural",
    form: [sec("intro", 4, { arp: true }), sec("verse", 8, { drums: "light", bass: true, arp: true }), sec("pre", 4, { drums: "full", bass: true, pad: true }), sec("chorus", 8, { drums: "full", bass: true, arp: true, pad: true, hook: true, prog: "b" }), sec("outro", 4, { arp: true })],
    progression: POP_PROG,
    drums: { full: { kick: FOUR, snare: "...x..x....x..x.", hat: EIGHTHS, shaker: "xxxxxxxxxxxxxxxx" }, light: { kick: "x.......x.......", shaker: "xxxxxxxxxxxxxxxx" } },
    bass: { program: 38, style: "octave" }, arp: { program: 24, style: "broken", octave: 3 }, pad: { program: 90, style: "sustain", level: -6 },
    hook: { program: 80, role: "lead", octave: 5, pattern: "3 5 5 3 | 1@2 3 5 | 8 7 5 3 | 5@4" },
  },
  "Brazilian funk": {
    defaultBpm: 130, kit: KIT.boutique808, humanize: "tight",
    form: [sec("intro", 4, { hook: true }), sec("verse", 8, { drums: "full", bass: true }), sec("drop", 8, { drums: "full", bass: true, hook: true, prog: "b" }), sec("outro", 4, { drums: "light" })],
    progression: { minor: { a: "i | i | i | i", b: "i | VI | i | VII" }, major: { a: "vi | vi | vi | vi", b: "vi | IV | vi | V" } },
    // the tamborzão: syncopated kicks with atabaque-like conga slaps and claps
    drums: { full: { kick: "x..x..x...x..x..", clap: "....x..x....x...", "conga-high": "..x...x...x..xx.", "conga-low": "x.......x......." }, light: { kick: "x..x..x...x..x.." } },
    bass: { program: 38, style: "sustain", line: { pattern: "1@2 ~ 1 | ~ 1 ~ 8 | 1@2 ~ 5 | ~ 1 7 5", octave: 1, glide: true } },
    hook: { program: 81, role: "lead", octave: 5, pattern: "1 ~ 1 3 | ~ 5 3 1 | 1 ~ 1 3 | 7@2 5@2" },
  },
  merengue: {
    defaultBpm: 150, kit: KIT.socal, humanize: "natural",
    form: [sec("intro", 4, { pad: true, drums: "full" }), sec("verse", 8, { drums: "full", bass: true, pad: true }), sec("chorus", 8, { drums: "full", bass: true, pad: true, hook: true, prog: "b" }), sec("jaleo", 8, { drums: "full", bass: true, arp: true, hook: true })],
    progression: { minor: { a: "i | V7 | V7 | i", b: "iv | i | V7 | i" }, major: { a: "I | V7 | V7 | I", b: "IV | I | V7 | I" } },
    // tambora (low tom and rim) and the güira's driving scrape
    drums: { full: { "tom-low": "x.......x..x.x..", rim: "....x.......x...", "guiro-short": "x.xxx.xxx.xxx.xx", kick: "x...x...x...x..." } },
    bass: { program: 33, style: "octave" }, pad: { program: 0, style: "stabs" }, arp: { program: 0, style: "broken", octave: 4 },
    hook: { program: 65, role: "lead", octave: 4, pattern: "1 3 5 3 1 3 5 3 | 5@2 3@2 | 5 3 1 3 5 3 2 1 | 1@4" },
  },
  "Arabic pop": {
    defaultBpm: 100, kit: KIT.boutique808, humanize: "natural",
    form: [sec("intro", 4, { pad: true, hook: true }), sec("verse", 8, { drums: "full", bass: true, pad: true, arp: true }), sec("chorus", 8, { drums: "full", bass: true, pad: true, arp: true, hook: true, prog: "b" }), sec("outro", 4, { pad: true, hook: true })],
    // maqam Hijaz in chords: the major tonic and the flat second (D Hijaz: D, Eb, F#, G, A, Bb, C)
    progression: { minor: { a: "I | bII | I | iv", b: "iv | bII | I | I" }, major: { a: "I | bII | I | iv", b: "iv | bII | I | I" } },
    // maqsum on the darbuka (conga: dum low, tek high) over a pop kick
    drums: { full: { kick: "x.......x.......", "conga-low": "x.......x.......", "conga-high": "..x...x.....x...", clap: "....x.......x...", hat: EIGHTHS } },
    bass: { program: 38, style: "sustain" }, pad: { program: 48, style: "sustain" }, arp: { program: 46, style: "broken", octave: 4, level: -3 },
    hook: { program: 48, role: "lead-high", octave: 5, pattern: "1 2 3 4 | 5@2 4 3 | 2 1 2 3 | 1@4" },
  },
  "Khaleeji": {
    defaultBpm: 100, humanize: "natural", kit: KIT.socal,
    form: [sec("intro", 4, { pad: true, hook: true }), sec("verse", 8, { drums: "full", bass: true, arp: true }), sec("chorus", 8, { drums: "full", bass: true, pad: true, arp: true, hook: true, prog: "b" }), sec("outro", 4, { drums: "full", hook: true })],
    progression: { minor: { a: "i | iv | VII | i", b: "VI | VII | i | i" }, major: { a: "vi | ii | V | vi", b: "IV | V | vi | vi" } },
    // the Gulf's lilting triplet groove (12 steps a bar) with hand claps and frame drums
    drums: { full: { "conga-low": "x.....x.x...", "conga-high": "...x.x...x.x", clap: "..x..x..x..x", "tom-low": "x.....x....." } },
    bass: { program: 33, style: "sustain" }, pad: { program: 48, style: "sustain", level: -3 }, arp: { program: 25, style: "broken", octave: 3 },
    hook: { program: 48, role: "lead-high", octave: 5, pattern: "1 2 3 | 2 1 7 | 1@2 3 | 2@3" },
  },
  mahraganat: {
    defaultBpm: 128, kit: KIT.boutique808, humanize: "tight",
    form: [sec("intro", 4, { hook: true, drums: "light" }), sec("verse", 8, { drums: "full", bass: true, hook: true }), sec("drop", 8, { drums: "full", bass: true, hook: true, arp: true, prog: "b" }), sec("outro", 4, { drums: "full" })],
    progression: { minor: { a: "I | bII | I | bII", b: "iv | bII | I | I" }, major: { a: "I | bII | I | bII", b: "iv | bII | I | I" } },
    // electro-shaabi: a pounding syncopated kick under fast darbuka (conga) loops
    drums: { full: { kick: "x..x..x.x..x..x.", clap: "....x.......x...", "conga-high": "x.xxx.x.x.xxx.x.", "conga-low": "x.......x.......", hat: EIGHTHS }, light: { "conga-high": "x.xxx.x.x.xxx.x." } },
    bass: { program: 38, style: "offbeat" }, arp: { program: 81, style: "gated", level: -4 },
    hook: { program: 81, role: "lead", octave: 5, pattern: "1 2 3 2 1 2 3 4 | 5 4 3 2 1@2 ~@2 | 1 2 3 2 1 2 3 4 | 3 2 1 7 1@4" },
  },
  "raï": {
    defaultBpm: 110, kit: KIT.socal, humanize: "natural",
    form: [sec("intro", 4, { hook: true, pad: true }), sec("verse", 8, { drums: "full", bass: true, arp: true }), sec("chorus", 8, { drums: "full", bass: true, arp: true, pad: true, hook: true, prog: "b" }), sec("outro", 4, { drums: "full", hook: true })],
    // the Andalusian cadence, common in raï
    progression: { minor: { a: "i | VII | VI | V", b: "i | iv | V | i" }, major: { a: "vi | V | IV | III", b: "vi | ii | III | vi" } },
    drums: { full: { kick: "x.....x...x.....", snare: BACKBEAT, "conga-high": "..x.x...x.x...xx", "conga-low": "x.......x.......", hat: EIGHTHS } },
    bass: { program: 38, style: "offbeat" }, arp: { program: 27, style: "broken", octave: 3 }, pad: { program: 50, style: "sustain", level: -6 },
    hook: { program: 80, role: "lead", octave: 5, pattern: "1 2 3 2 | 1@2 7 1 | 2 3 4 3 | 2@4" },
  },
  gnawa: {
    defaultBpm: 100, kit: KIT.socal, humanize: "loose",
    form: [sec("call", 8, { drums: "light", bass: true }), sec("trance", 8, { drums: "full", bass: true }), sec("lila", 8, { drums: "full", bass: true, prog: "b" }), sec("release", 4, { drums: "light", bass: true })],
    progression: { minor: { a: "i | i | i | i", b: "i | i | VII | i" }, major: { a: "vi | vi | vi | vi", b: "vi | vi | V | vi" } },
    // the qraqeb castanets' triplet clack (hats and rim, 12 steps a bar) and hand claps; the guembri is the bass line.
    // The kick marks the beat (the guembri's thump): without it, GarageBand's hats led the beat tracker to 1.5× (live M14)
    drums: { full: { kick: "x..x..x..x..", hat: "x.xx.xx.xx.x", rim: "x..x..x..x..", clap: "...x.....x.." }, light: { kick: "x..x..x..x..", hat: "x.xx.xx.xx.x" } },
    bass: { program: 32, style: "sustain", line: { pattern: "1 ~ 3 4 5 ~ | 7 5 4 3 1 ~ | 1 ~ 3 4 5 8 | 7 5 4 3 1 ~", octave: 2 } },
  },
  "Moroccan chaabi": {
    defaultBpm: 120, kit: KIT.socal, humanize: "natural",
    form: [sec("intro", 4, { hook: true, arp: true }), sec("verse", 8, { drums: "full", bass: true, arp: true }), sec("chorus", 8, { drums: "full", bass: true, arp: true, hook: true, prog: "b" }), sec("outro", 4, { drums: "full", hook: true })],
    progression: { minor: { a: "i | VII | VI | V", b: "i | iv | V7 | i" }, major: { a: "vi | V | IV | III", b: "vi | ii | III | vi" } },
    // the 6/8 wedding dance on bendir and darbuka (12 steps a bar), hand claps and a kick on the beat (live M14: grid
    // recall 0.83 → 1.00 with the kick)
    drums: { full: { kick: "x..x..x..x..", "conga-low": "x.....x.....", "conga-high": "..x.xx..x.xx", clap: "x..x..x..x..", "tom-low": "x.....x....." } },
    bass: { program: 33, style: "octave" }, arp: { program: 25, style: "broken", octave: 3 },
    hook: { program: 40, role: "lead-high", octave: 5, pattern: "1 2 3 4 3 2 | 1 7 1 2 1 7 | 1 2 3 4 5 4 | 3 2 1 7 1@2" },
  },
  dabke: {
    defaultBpm: 125, kit: KIT.socal, humanize: "natural",
    form: [sec("intro", 4, { hook: true }), sec("verse", 8, { drums: "full", bass: true, hook: true }), sec("dabke", 8, { drums: "full", bass: true, pad: true, hook: true, prog: "b" }), sec("outro", 4, { drums: "full" })],
    progression: { minor: { a: "i | i | VII | i", b: "iv | i | V | i" }, major: { a: "I | I | V | I", b: "IV | I | V | I" } },
    // the tabl's pounding dabke beat (low tom and rim) with hand claps; the clarinet plays the mijwiz's reed lines
    // a kick on every beat under the tabl: without it the beat tracker split between on- and off-beats (live M14: 0.75 → 0.99)
    drums: { full: { kick: "x...x...x...x...", "tom-low": "x...x.x.x...x.x.", rim: "..x.....x.....x.", clap: "....x.......x...", "conga-high": "..x.x...x.x...x." } },
    bass: { program: 33, style: "octave" }, pad: { program: 48, style: "sustain", level: -6 },
    hook: { program: 71, role: "lead", octave: 5, pattern: "5 5 4 3 4 4 3 2 | 3 3 2 1 2@2 ~@2 | 5 5 4 3 4 4 3 2 | 3 2 1 7 1@4" },
  },
  country: {
    defaultBpm: 96, kit: KIT.roots, humanize: "natural",
    form: [sec("intro", 4, { arp: true, hook: true }), sec("verse", 8, { drums: "light", bass: true, arp: true }), sec("chorus", 8, { drums: "full", bass: true, arp: true, pad: true, hook: true, prog: "b" }), sec("bridge", 4, { drums: "light", bass: true, arp: true }), sec("chorus2", 8, { drums: "full", bass: true, arp: true, pad: true, hook: true, prog: "b" })],
    progression: { minor: { a: "i | VI | III | VII", b: "VI | VII | i | III" }, major: { a: "I | IV | I | V", b: "IV | I | V | vi" } },
    drums: { groove: "country", full: { kick: "x.......x.x.....", snare: BACKBEAT, hat: EIGHTHS, tambourine: "....x.......x..." }, light: { kick: "x.......x.......", rim: BACKBEAT, hat: EIGHTHS } },
    bass: { program: 33, style: "octave" }, arp: { program: 25, style: "broken", octave: 3 }, pad: { program: 48, style: "sustain", level: -6 },
    hook: { program: 27, role: "lead", octave: 4, pattern: "3 5 5 6 | 5@2 3 1 | 2 3 5 3 | 1@4" },
  },
  "Americana": {
    defaultBpm: 88, kit: KIT.roots, humanize: "loose",
    form: [sec("intro", 4, { arp: true }), sec("verse", 8, { drums: "light", bass: true, arp: true, hook: true }), sec("chorus", 8, { drums: "full", bass: true, arp: true, pad: true, hook: true, prog: "b" }), sec("outro", 4, { arp: true, pad: true })],
    progression: { minor: { a: "i | VII | VI | VII", b: "III | VII | i | i" }, major: { a: "I | IV | I | V", b: "vi | IV | I | V" } },
    // a cross-stick and brushed-hat feel, the upright bass on root and fifth, fingerpicked guitar
    drums: { full: { kick: "x.......x.......", snare: BACKBEAT, hat: EIGHTHS }, light: { kick: "x.......x.......", rim: BACKBEAT, hat: EIGHTHS } },
    bass: { program: 32, style: "octave" }, arp: { program: 25, style: "broken", octave: 3 }, pad: { program: 16, style: "sustain", level: -8 },
    hook: { program: 25, role: "lead", octave: 4, pattern: "5 3 2 1 | 3@3 2 | 1 2 3 5 | 3@2 2@2" },
  },
  "Bollywood (filmi)": {
    defaultBpm: 100, kit: KIT.socal, humanize: "natural",
    form: [sec("intro", 4, { pad: true, hook: true }), sec("mukhda", 8, { drums: "full", bass: true, pad: true, hook: true }), sec("interlude", 4, { pad: true, arp: true, drums: "light" }), sec("antara", 8, { drums: "full", bass: true, pad: true, arp: true, prog: "b" }), sec("mukhda2", 8, { drums: "full", bass: true, pad: true, hook: true })],
    progression: { minor: { a: "i | VI | VII | i", b: "iv | VII | III | i" }, major: { a: "I | vi | IV | V", b: "IV | V | iii | vi" } },
    // keherwa (8 beats) on tabla, played by the congas (bayan low, dayan high) and a high bongo for the "tin" strokes
    drums: { full: { "conga-low": "x.x.......x.....", "conga-high": "x.......x.......", "bongo-high": "....x.x.x...x.x.", kick: "x.......x......." }, light: { "conga-high": "x.......x.......", "bongo-high": "....x.x.x...x.x." } },
    bass: { program: 33, style: "sustain" }, pad: { program: 48, style: "sustain" }, arp: { program: 46, style: "broken", octave: 4, level: -3 },
    hook: { program: 73, role: "lead", octave: 5, pattern: "5 3 2 1 | 2@2 3 5 | 6 5 3 2 | 1@4" },
  },
  gospel: {
    defaultBpm: 76, kit: KIT.roots, humanize: "natural", swing: { percent: 58, unit: "16th" },
    form: [sec("intro", 4, { pad: true, arp: true }), sec("verse", 8, { drums: "light", bass: true, pad: true, arp: true }), sec("chorus", 8, { drums: "full", bass: true, pad: true, arp: true, hook: true, prog: "b" }), sec("vamp", 8, { drums: "full", bass: true, pad: true, hook: true, prog: "b" })],
    // gospel's colours: the tonic seventh into IV, the minor four, the ii–V turnaround
    progression: { minor: { a: "i | iv | VII | III", b: "VI | iv | V7 | i" }, major: { a: "I | I7 | IV | iv", b: "ii7 | V7 | iii7 vi7 | ii7 V7" } },
    drums: { groove: "gospel", full: { kick: "x.....x.x.......", snare: BACKBEAT, clap: BACKBEAT, hat: EIGHTHS, tambourine: "x.x.x.x.x.x.x.x." }, light: { kick: "x.......x.......", clap: BACKBEAT } },
    bass: { program: 33, style: "rolling" }, pad: { program: 16, style: "sustain" }, arp: { program: 0, style: "broken", octave: 3 },
    hook: { program: 52, role: "lead", octave: 4, pattern: "1@2 3 5 | 6@3 5 | 3 5 6 8 | 5@4" },
  },
  soul: {
    defaultBpm: 92, kit: KIT.roots, humanize: "natural", swing: { percent: 54, unit: "16th" },
    form: [sec("intro", 4, { pad: true, drums: "light" }), sec("verse", 8, { drums: "full", bass: true, pad: true, arp: true }), sec("chorus", 8, { drums: "full", bass: true, pad: true, arp: true, hook: true, prog: "b" }), sec("outro", 4, { drums: "full", bass: true, pad: true, hook: true, prog: "b" })],
    progression: { minor: { a: "i7 | iv7 | i7 | V7", b: "VImaj7 | V7 | i7 | i7" }, major: { a: "I | vi | IV | V", b: "IV | V | iii7 | vi7" } },
    drums: { groove: "soul", full: { ...mined("soul", ["kick", "snare", "hat"]), tambourine: BACKBEAT }, light: { kick: "x.......x.......", hat: EIGHTHS } },
    bass: { program: 33, style: "rolling" }, pad: { program: 16, style: "sustain", level: -4 }, arp: { program: 4, style: "broken", octave: 3 },
    hook: { program: 61, role: "lead", octave: 4, pattern: "5 ~ 5 3 | 5@2 8@2 | 7 5 3 5 | 1@4" },
  },
  blues: {
    defaultBpm: 80, kit: KIT.roots, humanize: "loose", swing: { percent: 66, unit: "8th" },
    // the twelve-bar blues: one chorus per section
    form: [sec("head", 12, { drums: "full", bass: true, pad: true, hook: true }), sec("solo", 12, { drums: "full", bass: true, pad: true, arp: true, prog: "b" }), sec("out", 12, { drums: "full", bass: true, pad: true, hook: true })],
    progression: { minor: { a: "i7 | iv7 | i7 | i7 | iv7 | iv7 | i7 | i7 | VI7 | V7 | i7 | V7", b: "i7 | iv7 | i7 | i7 | iv7 | iv7 | i7 | i7 | VI7 | V7 | i7 | V7" }, major: { a: "I7 | IV7 | I7 | I7 | IV7 | IV7 | I7 | I7 | V7 | IV7 | I7 | V7", b: "I7 | IV7 | I7 | I7 | IV7 | IV7 | I7 | I7 | V7 | IV7 | I7 | V7" } },
    drums: { groove: "blues", full: { kick: "x.......x.......", snare: BACKBEAT, ride: EIGHTHS } },
    bass: { program: 33, style: "rolling" }, pad: { program: 16, style: "sustain", level: -6 }, arp: { program: 0, style: "broken", octave: 3, level: -3 },
    hook: { program: 29, role: "lead", octave: 4, pattern: "8 7 5 3 | 1@3 ~ | 3 4 5 7 | 8@2 ~@2" },
  },
  "Celtic folk": {
    defaultBpm: 110, kit: KIT.socal, humanize: "natural",
    form: [sec("intro", 4, { arp: true, drums: "light" }), sec("A", 8, { drums: "full", bass: true, arp: true, hook: true }), sec("B", 8, { drums: "full", bass: true, arp: true, hook: true, prog: "b" }), sec("A2", 8, { drums: "full", bass: true, arp: true, hook: true })],
    // the mixolydian flat seven (major) and the dorian major four (minor)
    progression: { minor: { a: "i | VII | i | IV", b: "i | IV | VII | i" }, major: { a: "I | bVII | I | V", b: "IV | I | bVII | I" } },
    // a jig's triplet drive (12 steps a bar) on the bodhrán (low and mid toms)
    drums: { full: { "tom-low": "x..x..x..x..", "tom-mid": ".x..x..x..x." }, light: { "tom-low": "x.....x....." } },
    bass: { program: 32, style: "octave" }, arp: { program: 25, style: "broken", octave: 3 },
    hook: { program: 78, role: "lead", octave: 5, pattern: "1 3 5 8 5 3 | 2 3 4 5 4 3 | 1 3 5 3 2 1 | 5 3 2 1@3" },
  },
  lullaby: {
    defaultBpm: 60, humanize: "loose",
    form: [sec("intro", 4, { arp: true }), sec("verse", 8, { arp: true, pad: true, hook: true, bass: true }), sec("verse2", 8, { arp: true, pad: true, hook: true, bass: true, prog: "b" }), sec("outro", 4, { arp: true, pad: true })],
    progression: { minor: { a: "i | iv | i | V", b: "iv | i | V | i" }, major: { a: "I | IV | I | V", b: "IV | I | V | I" } },
    bass: { program: 43, style: "sustain", level: -8 }, pad: { program: 48, style: "sustain", level: -9 }, arp: { program: 46, style: "broken", octave: 3, level: -4 },
    hook: { program: 10, role: "lead-high", octave: 6, pattern: "5@2 3@2 | 1@4 | 3 5 3 2 | 1@4" },
  },
  "K-pop": {
    defaultBpm: 120, kit: KIT.electro, humanize: "tight",
    form: [sec("intro", 4, { arp: true }), sec("verse", 8, { drums: "light", bass: true, arp: true }), sec("pre", 4, { drums: "light", bass: true, pad: true, arp: true }), sec("chorus", 8, { drums: "full", bass: true, pad: true, arp: true, hook: true, prog: "b" }), sec("dance break", 8, { drums: "full", bass: true, arp: true, hook: true })],
    progression: { minor: { a: "i | VI | III | VII", b: "VI | VII | v | i" }, major: { a: "vi | IV | I | V", b: "IV | V | iii | vi" } },
    drums: { full: { kick: FOUR, clap: BACKBEAT, hat: "x.xxx.xxx.xxx.xx", "open-hat": OFFBEAT_OPEN }, light: { kick: "x.......x.......", hat: EIGHTHS } },
    bass: { program: 38, style: "octave" }, pad: { program: 90, style: "stabs", level: -3 }, arp: { program: 81, style: "gated", level: -4 },
    hook: { program: 81, role: "lead", octave: 5, pattern: "1 1 3 5 | 8@2 7 5 | 3 3 5 3 | 1@4" },
  },
  amapiano: {
    defaultBpm: 112, kit: KIT.boutique808, humanize: "natural", swing: { percent: 56, unit: "16th" },
    form: [sec("intro", 8, { pad: true, drums: "light" }), sec("groove", 8, { drums: "full", bass: true, pad: true }), sec("lift", 8, { drums: "full", bass: true, pad: true, hook: true, prog: "b" }), sec("outro", 8, { drums: "light", pad: true })],
    progression: { minor: { a: "i7 | iv7 | VIImaj7 | IIImaj7", b: "VImaj7 | v7 | i7 | i7" }, major: { a: "Imaj7 | vi7 | ii7 | V7", b: "IVmaj7 | iii7 | ii7 | V7" } },
    // shuffling shakers, sparse kicks and the log drum (the bass line, sliding)
    drums: { full: { kick: "x.......x.......", shaker: "xxxxxxxxxxxxxxxx", hat: "..x...x...x...x.", rim: "....x.......x..x", cabasa: "x.x.x.x.x.x.x.x." }, light: { shaker: "xxxxxxxxxxxxxxxx", hat: "..x...x...x...x." } },
    bass: { program: 38, style: "sustain", line: { pattern: "1 ~ ~ 1 ~ ~ 5 ~ | 1 ~ ~ 8 ~ 5 ~ ~ | 1 ~ ~ 1 ~ ~ 5 ~ | ~ ~ 1 ~ 7 ~ 5 ~", octave: 1, glide: true } },
    pad: { program: 4, style: "sustain" },
    hook: { program: 4, role: "lead", octave: 5, pattern: "5 ~ 3 ~ | 1 ~ ~ ~ | 5 ~ 7 ~ | 8@4" },
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

/** The written octave, or the nearest one (down first) that keeps every note in the program's range: a hook written at
 * a fixed octave left the range in high keys (M14: lo-fi's vibraphone reached G6 in C major; Vibraphone plays F3–F6). */
function fitOctave(build: (octave: number) => string, program: number, octave: number): string {
  const range = INSTRUMENT_RANGES[program];
  if (!range) return build(octave);
  for (const o of [octave, octave - 1, octave + 1, octave - 2]) {
    const notes = build(o);
    const pitches = notes.split(/[\s|]+/).filter((t) => t && !t.startsWith("~")).map((t) => parsePitch(t.split("@")[0]!));
    if (pitches.every((p) => p.ok && p.value >= range.low && p.value <= range.high)) return notes;
  }
  return build(octave);
}

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
    // hand percussion (congas, timbales, güiro …) sounds only on the Orchestral Kit: its own track there, unless the kit is it
    const own = t.kit === KIT.orchestral;
    const pick = (grid: Grid, perc: boolean) => Object.fromEntries(Object.entries(grid).filter(([v]) => own || ORCHESTRAL_KIT_ONLY.has(v as DrumVoice) === perc));
    const partsOf = (perc: boolean) => Object.fromEntries(t.form.filter((s) => s.drums)
      .map((s) => [s.name, { grid: pick(s.drums === "light" ? t.drums!.light ?? t.drums!.full : t.drums!.full, perc) }])
      .filter(([, p]) => Object.keys((p as { grid: Grid }).grid).length > 0));
    const kit = partsOf(false), perc = own ? {} : partsOf(true);
    if (Object.keys(kit).length > 0) tracks.push({ name: "Drums", role: "drums", ...(t.kit !== undefined ? { program: t.kit } : {}), parts: kit });
    if (Object.keys(perc).length > 0) tracks.push({ name: "Percussion", role: "drums", program: KIT.orchestral, parts: perc });
  }
  if (t.pad) tracks.push({ name: "Chords", role: "pad", program: t.pad.program, ...(t.pad.level ? { level: t.pad.level } : {}), parts: each("pad", (s) => ({ chords: of(s), style: t.pad!.style })) });
  if (t.arp) tracks.push({ name: "Arp", role: "arp", program: t.arp.program, ...(t.arp.level ? { level: t.arp.level } : {}), parts: each("arp", (s) => ({ chords: of(s), style: t.arp!.style, ...(t.arp!.octave ? { octave: t.arp!.octave } : {}) })) });
  const line = t.bass.line;
  tracks.push({ name: "Bass", role: "bass", program: t.bass.program, ...(t.bass.level ? { level: t.bass.level } : {}), ...(line?.glide ? { glide: true } : {}),
    parts: each("bass", (s) => line
      ? { notes: fitOctave((o) => of(s).split("|").map((bar, i) => { const bars = line.pattern.split("|"); return hookBar(bars[i % bars.length]!, bar.trim().split(/\s+/)[0]!, o); }).join(" | "), t.bass.program, line.octave) }
      : { chords: of(s), style: t.bass.style }) });
  if (t.hook) {
    const bars = t.hook.pattern.split("|");
    tracks.push({ name: "Hook", role: t.hook.role, program: t.hook.program, ...(t.hook.level ? { level: t.hook.level } : {}),
      parts: each("hook", (s) => ({ notes: fitOctave((o) => of(s).split("|").map((bar, i) => hookBar(bars[i % bars.length]!, bar.trim().split(/\s+/)[0]!, o)).join(" | "), t.hook!.program, t.hook!.octave) })) });
  }
  const groove = meter === 4 && t.drums?.groove ? { groove: t.drums.groove } : {};
  return ok({
    title: req.title ?? `${req.genre} draft`, tempo: req.bpm ?? t.defaultBpm, key: req.key, timeSignature: [meter, 4], seed: req.seed ?? 1,
    humanize: t.humanize ?? "natural", ...groove, ...(meter === 4 && t.swing ? { swing: t.swing.percent, swingUnit: t.swing.unit } : {}),
    sections: t.form.map((s) => ({ name: s.name, bars: s.bars })),
    tracks: tracks.filter((tr) => Object.keys(tr.parts as object).length > 0),
  });
}
