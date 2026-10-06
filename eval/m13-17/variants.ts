// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * M13.17 screen, part 1: genre-template variants rendered as GM-synth drafts through gb_song render_draft's own code
 * (the macOS GM synth — never GarageBand). eval/m13-17/screen.py runs this, then scores the drafts.
 *
 *   node_modules/.bin/tsx eval/m13-17/variants.ts <genre> <key> <bpm> <outDir> <seeds: 1,2,3> <variant>[+<variant>…] …
 *
 * A variant is written in the template's own vocabulary (a GenreTemplate edit), so a winner moves into
 * src/song/genres.ts as it is. "+" stacks variants, left to right. "base" is the current template.
 *   node_modules/.bin/tsx eval/m13-17/variants.ts --song <genre> <key> <bpm> <seed> <variant>   (one Song JSON)
 *   node_modules/.bin/tsx eval/m13-17/variants.ts --list
 * Prints one JSON line: [{ variant, seed, wav, hash, swing?, swingUnit? } | { variant, seed, error }].
 * Each WAV is named by a hash of its Song JSON: an existing file is the same song and is reused; a changed variant
 * gets a new file (files are never overwritten).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { GENRE_TEMPLATES, templateSong, type GenreTemplate } from "../../src/song/genres.js";
import { createGbSong } from "../../src/mcp/gb-song.js";
import { createGmRenderer } from "../../src/render/gm-renderer.js";

type Grid = Record<string, string>;
type Song = Record<string, unknown> & { seed?: number; swing?: number; swingUnit?: string };
type Variant = { about: string; t?: (t: GenreTemplate, genre: string) => GenreTemplate; loop?: number };

/** Replace drum voices in the full grid (null removes a voice). */
const full = (g: Record<string, string | null>) => (t: GenreTemplate): GenreTemplate => {
  const grid: Grid = { ...t.drums!.full };
  for (const [v, p] of Object.entries(g)) if (p === null) delete grid[v]; else grid[v] = p;
  return { ...t, drums: { ...t.drums!, full: grid } };
};
const set = (patch: Partial<GenreTemplate>) => (t: GenreTemplate): GenreTemplate => ({ ...t, ...patch });
const kit = (k: number) => set({ kit: k });
const swing = (percent: number) => set({ swing: { percent, unit: "16th" } });
const bass = (patch: Partial<GenreTemplate["bass"]>) => (t: GenreTemplate): GenreTemplate => ({ ...t, bass: { ...t.bass, ...patch } });
const line = (pattern: string, octave = 2) => (t: GenreTemplate): GenreTemplate => ({ ...t, bass: { ...t.bass, line: { pattern, octave } } });
const hook = (patch: Partial<NonNullable<GenreTemplate["hook"]>>) => (t: GenreTemplate): GenreTemplate => ({ ...t, hook: { ...t.hook!, ...patch } });
const pad = (patch: Partial<NonNullable<GenreTemplate["pad"]>>) => (t: GenreTemplate): GenreTemplate => ({ ...t, pad: { ...t.pad!, ...patch } });
const arp = (a: GenreTemplate["arp"] | undefined) => (t: GenreTemplate): GenreTemplate => {
  const { arp: _old, ...rest } = t;
  return a ? { ...rest, arp: a } : rest;
};
/** Turn a section flag on (or off) in every section that has drums, or in the named sections. */
const flag = (name: "arp" | "pad" | "hook" | "bass", on: boolean, sections?: string[]) => (t: GenreTemplate): GenreTemplate => ({
  ...t, form: t.form.map((s) => (sections ? sections.includes(s.name) : s.drums) ? { ...s, [name]: on } : s),
});

const VARIANTS: Record<string, Variant> = {
  base: { about: "the current template" },
  // the kits before M13.17 (the live m13 exports were made with them): use it to calibrate against those exports
  "pre-m13-17": { about: "afrobeats on kit 32 (GB Roots), UK garage on kit 16 (GB Epic Electro)",
    t: (t, genre) => genre === "afrobeats" ? { ...t, kit: 32 } : genre === "UK garage" ? { ...t, kit: 16 } : t },
  // ---- shared
  "no-groove": { about: "no mined groove (generic humanize timing)", t: (t) => ({ ...t, drums: { ...t.drums!, groove: undefined } } as GenreTemplate) },
  tight: { about: "humanize tight", t: set({ humanize: "tight" }) },
  loose: { about: "humanize loose", t: set({ humanize: "loose" }) },
  straight: { about: "no swing", t: (t) => { const { swing: _s, ...rest } = t; return rest; } },
  swing54: { about: "16th swing 54", t: swing(54) },
  swing56: { about: "16th swing 56", t: swing(56) },
  swing58: { about: "16th swing 58", t: swing(58) },
  swing60: { about: "16th swing 60", t: swing(60) },
  swing68: { about: "16th swing 68", t: swing(68) },
  swing70: { about: "16th swing 70", t: swing(70) },
  "kit-socal": { about: "kit 0 (GB SoCal)", t: kit(0) },
  "kit-electro": { about: "kit 16 (GB Epic Electro)", t: kit(16) },
  "kit-808": { about: "kit 25 (GM TR-808; GB Boutique 808)", t: kit(25) },
  "kit-909": { about: "kit 24 (GM Electronic; GB Boutique 808)", t: kit(24) },
  "kit-roots": { about: "kit 32 (GB Roots)", t: kit(32) },
  loop1: { about: "common loop 1 (template variant 1)", loop: 1 },
  loop2: { about: "common loop 2", loop: 2 },
  loop3: { about: "common loop 3", loop: 3 },
  "bass-38": { about: "bass program 38 (GB Metro Bass)", t: bass({ program: 38 }) },
  "bass-39": { about: "bass program 39 (GB Taureg Moon Bass)", t: bass({ program: 39 }) },
  "bass-octave": { about: "bass style octave", t: bass({ style: "octave" }) },
  "bass-rolling": { about: "bass style rolling", t: bass({ style: "rolling" }) },
  "bass-sustain": { about: "bass style sustain", t: bass({ style: "sustain" }) },
  "bass-332": { about: "bass line 3-3-2 (root, root, fifth)", t: line("1@3 1@3 5@2") },
  "bass-332-oct": { about: "bass line 3-3-2 with an octave jump", t: line("1@3 8@3 1@2") },

  // ---- afrobeats
  "af-kick-tresillo": { about: "kick 3-3-2 twice a bar", t: full({ kick: "x..x..x.x..x..x." }) },
  "af-kick-332bar": { about: "kick 3-3-2 across the bar (6-6-4 16ths)", t: full({ kick: "x.....x.....x..." }) },
  "af-kick-four": { about: "kick on every beat", t: full({ kick: "x...x...x...x..." }) },
  "af-kick-332-4": { about: "kick 1, a-of-1, and-of-2, 3 (afro 3-3-2 feel + beat 3)", t: full({ kick: "x..x..x.x......." }) },
  "af-rim-afro": { about: "rim on a-of-1, and-of-2, a-of-3, and-of-4", t: full({ rim: "...x..x....x..x." }) },
  "af-rim-off": { about: "no rim", t: full({ rim: null }) },
  "af-no-clap": { about: "no clap", t: full({ clap: null }) },
  "af-snare": { about: "snare instead of clap on 2 and 4", t: full({ clap: null, snare: "....x.......x..." }) },
  "af-no-shaker": { about: "no shaker", t: full({ shaker: null }) },
  "af-shaker-acc": { about: "shaker 16ths, 8th offbeats accented", t: full({ shaker: "oxoXoxoXoxoXoxoX" }) },
  "af-shaker-8": { about: "shaker on 8ths", t: full({ shaker: "x.x.x.x.x.x.x.x." }) },
  "af-hat": { about: "closed hat 16ths in place of the shaker", t: full({ shaker: null, hat: "xoxoxoxoxoxoxoxo" }) },
  "af-toms": { about: "tom percussion (talking-drum-ish) on the off-beats", t: full({ "tom-high": "......x.......x.", "tom-mid": ".......x.......x" }) },
  "af-ride-bell": { about: "ride on the 12/8-ish bell figure", t: full({ ride: "x.x.xx.x.x.xx.x." }) },
  "af-gtr-25": { about: "guitar program 25 (GB Acoustic Guitar)", t: (t) => ({ ...t, arp: { ...t.arp!, program: 25 } }) },
  "af-gtr-26": { about: "guitar program 26 (GB Roots Rock)", t: (t) => ({ ...t, arp: { ...t.arp!, program: 26 } }) },
  "af-gtr-24": { about: "guitar program 24 (GB Classical Acoustic Guitar)", t: (t) => ({ ...t, arp: { ...t.arp!, program: 24 } }) },
  "af-gtr-oct4": { about: "guitar an octave up (highlife register)", t: (t) => ({ ...t, arp: { ...t.arp!, octave: 4 } }) },
  "af-gtr-up": { about: "guitar style up", t: (t) => ({ ...t, arp: { ...t.arp!, style: "up" } }) },
  "af-gtr-gated": { about: "guitar style gated (chord skank)", t: (t) => ({ ...t, arp: { ...t.arp!, style: "gated" } }) },
  "af-gtr-quiet": { about: "guitar level -6", t: (t) => ({ ...t, arp: { ...t.arp!, level: -6 } }) },
  "af-rhodes-hook": { about: "pad: Rhodes (4) stabs in the hook (live grid risk: the pad was the grid fix)", t: pad({ program: 4, style: "stabs" }) },
  "af-pad-verse": { about: "string pad (50) also in the verse", t: flag("pad", true, ["verse", "hook"]) },
  "af-lead-12": { about: "hook program 12 (marimba)", t: hook({ program: 12 }) },
  "af-lead-108": { about: "hook program 108 (kalimba; GB Marimba)", t: hook({ program: 108 }) },
  "af-lead-65": { about: "hook program 65 (alto sax; GB Saxophone), octave 4 (its range)", t: hook({ program: 65, octave: 4 }) },
  "af-lead-81": { about: "hook program 81 (saw lead; GB Soft Saw Lead)", t: hook({ program: 81 }) },
  "af-lead-78": { about: "hook program 78 (whistle; GB Flute Solo)", t: hook({ program: 78 }) },
  "af-lead-56": { about: "hook program 56 (trumpet; GB Trumpets)", t: hook({ program: 56 }) },
  "af-hook-call": { about: "hook: call-and-response (a phrase, a rest, an answer)", t: hook({ pattern: "3 5 3 ~ | ~ ~ 5 8 | 3 5 3 ~ | 1@2 ~@2" }) },
  "af-hook-verse": { about: "hook also in the verse", t: flag("hook", true, ["verse", "hook"]) },
  "af-bass-afro": { about: "bass line: syncopated root/fifth/octave in 16ths", t: line("1@3 1@3 ~@2 5@3 8@3 ~@2") },

  // ---- UK garage
  "ug-kick-a": { about: "kick 1 and and-of-3", t: full({ kick: "x.........x....." }) },
  "ug-kick-b": { about: "kick 1, and-of-3, a-of-4", t: full({ kick: "x.........x..x.." }) },
  "ug-kick-c": { about: "kick 1, a-of-2, and-of-3 (skippy)", t: full({ kick: "x......x..x....." }) },
  "ug-kick-2bar": { about: "kick 2-bar: 1 + and-of-3 | 1 + a-of-2 + and-of-3", t: full({ kick: "x.........x.....|x......x..x....." }) },
  "ug-snare-ghost": { about: "snare ghost on the a-of-4", t: full({ snare: "....x.......x..o" }) },
  "ug-rim": { about: "rim shots on swung 16ths", t: full({ rim: ".......x.....x.." }) },
  "ug-clap": { about: "clap with the snare on 2 and 4", t: full({ clap: "....x.......x..." }) },
  "ug-open-hat": { about: "open hat on the 8th off-beats", t: full({ "open-hat": "..x...x...x...x." }) },
  "ug-hat-16": { about: "closed hats on every 16th (swung), accents on the offbeats", t: full({ hat: "oxXxoxXxoxXxoxXx" }) },
  "ug-hat-8off": { about: "closed hats on the 8th off-beats only", t: full({ hat: "..x...x...x...x." }) },
  "ug-organ-17": { about: "organ program 17 (GB Bebop Organ)", t: pad({ program: 17 }) },
  "ug-organ-18": { about: "organ program 18 (GB Classic Rock Organ)", t: pad({ program: 18 }) },
  "ug-pad-ep": { about: "pad program 4 stabs (GB Classic Electric Piano)", t: pad({ program: 4 }) },
  "ug-pad-fm": { about: "pad program 5 stabs (GB FM Piano)", t: pad({ program: 5 }) },
  "ug-pad-sustain": { about: "organ held, not stabbed", t: pad({ style: "sustain" }) },
  "ug-outro-bass": { about: "bass in the outro too", t: flag("bass", true, ["verse", "chorus", "outro"]) },
  "ug-bass-jump": { about: "sub bass line with octave jumps (16ths)", t: line("1@2 ~ 8 ~@2 1@2 ~@2 1 8 ~@2 5@2") },
  "ug-bass-jump2": { about: "sub bass: root, octave on the a-of-2, root on the and-of-3", t: line("1@3 ~@4 8 ~@2 1@2 ~@4") },
  "ug-hook-53": { about: "hook program 53 (Voice Oohs; GB Classical Ensemble)", t: hook({ program: 53 }) },
  "ug-hook-52": { about: "hook program 52 (Choir Aahs; GB Classical Ensemble)", t: hook({ program: 52 }) },
  "ug-hook-54": { about: "hook program 54 (Synth Voice; GB Dream Voice = the same patch as 85)", t: hook({ program: 54 }) },
  "ug-hook-chop": { about: "hook as vocal chops: short repeated 8ths with rests", t: hook({ pattern: "5 ~ 5 ~ ~ 3 ~ 5 | ~ 8 ~ 5 ~ ~ 3 ~ | 5 ~ 5 ~ ~ 3 ~ 5 | ~ 1 ~ 3 ~ ~ 1 ~" }) },
  "ug-hook-chop16": { about: "hook as vocal chops in swung 16ths", t: hook({ pattern: "5 ~ ~ 5 ~ ~ 3 ~ ~ ~ 5 ~ 3 ~ ~ ~ | 8 ~ ~ 8 ~ ~ 5 ~ ~ ~ 3 ~ 5 ~ ~ ~" }) },
  "ug-hook-low": { about: "hook an octave lower (octave 4)", t: hook({ octave: 4 }) },
  "ug-hook-verse": { about: "hook (vocal) also in the verse", t: flag("hook", true, ["verse", "chorus"]) },
  "ug-chops-53": { about: "arp slot: gated chord chops on Voice Oohs (53), verse and chorus", t: (t) => flag("arp", true, ["verse", "chorus"])(arp({ program: 53, style: "gated", octave: 4, level: -3 })(t)) },
  "ug-chops-54": { about: "arp slot: gated chord chops on Synth Voice (54), verse and chorus", t: (t) => flag("arp", true, ["verse", "chorus"])(arp({ program: 54, style: "gated", octave: 4, level: -3 })(t)) },

  // ---- round 2
  "bass-33": { about: "bass program 33 (GB Fingerstyle Bass)", t: bass({ program: 33 }) },
  "af-bass-quiet": { about: "bass level -4", t: bass({ level: -4 }) },
  "af-hook-quiet": { about: "hook level -4", t: hook({ level: -4 }) },
  "af-kick-332-808": { about: "kick 1, and-of-2, 4 (6-6-4) on the 808", t: (t) => kit(25)(full({ kick: "x.....x.....x..." })(t)) },
  "ug-no-pad": { about: "no organ", t: (t) => { const { pad: _p, ...rest } = t; return rest; } },
  "ug-organ-quiet": { about: "organ level -4", t: pad({ level: -4 }) },
  "ug-triads": { about: "triads, not 9ths and 7ths", t: set({ progression: { minor: { a: "i | iv | VI | V", b: "VI | VII | i | i" }, major: { a: "ii | V | I | vi", b: "IV | V | iii | vi" } } }) },
  "ug-m7": { about: "minor 7ths, no 9ths", t: set({ progression: { minor: { a: "i7 | iv7 | VImaj7 | V7", b: "VImaj7 | VII7 | i7 | i7" }, major: { a: "ii7 | V7 | Imaj7 | vi7", b: "IVmaj7 | V7 | iii7 | vi7" } } }) },
  "ug-hook-53-lo": { about: "hook program 53 (Voice Oohs; GB Classical Ensemble), octave 4 (its range)", t: hook({ program: 53, octave: 4 }) },
  "ug-hook-52-lo": { about: "hook program 52 (Choir Aahs; GB Classical Ensemble), octave 4", t: hook({ program: 52, octave: 4 }) },
  "ug-hook-81": { about: "hook program 81 (saw lead; GB Soft Saw Lead)", t: hook({ program: 81 }) },
  // ---- round 3: the guitar an octave up leaves the guitar's range in some keys (F6 in A minor), so: other arp voices
  "af-arp-marimba4": { about: "arp: marimba (12) at octave 4", t: (t) => ({ ...t, arp: { ...t.arp!, program: 12, octave: 4 } }) },
  "af-arp-kalimba4": { about: "arp: kalimba (108; GB Marimba) at octave 4", t: (t) => ({ ...t, arp: { ...t.arp!, program: 108, octave: 4 } }) },
  "af-arp-ep4": { about: "arp: electric piano (4; GB Classic Electric Piano) at octave 4", t: (t) => ({ ...t, arp: { ...t.arp!, program: 4, octave: 4 } }) },
  "af-arp-marimba3": { about: "arp: marimba (12) at octave 3", t: (t) => ({ ...t, arp: { ...t.arp!, program: 12 } }) },
  "af-gtr-updown": { about: "guitar style updown", t: (t) => ({ ...t, arp: { ...t.arp!, style: "updown" } }) },
  "af-gtr-down": { about: "guitar style down", t: (t) => ({ ...t, arp: { ...t.arp!, style: "down" } }) },
  // ---- round 4: UK garage rhythm (rhythm changes should carry from GM drafts to GarageBand better than patch changes)
  "ug-kick-2bar-b": { about: "kick 2-bar: 1 + and-of-3 | 1 + and-of-3 + a-of-4", t: full({ kick: "x.........x.....|x.........x..x.." }) },
  "ug-hat-skip2": { about: "hats on more swung 16ths", t: full({ hat: "..x..x.x..x..x.x" }) },
  "ug-open-hat-end": { about: "an open hat on the and-of-4", t: full({ "open-hat": "..............x." }) },
  // ---- GM-draft proxies of GarageBand kits (calibrate.py): on channel 10 the GM synth plays program 16 as the
  // acoustic "Power" kit and 24 as "Electronic"; GarageBand plays 16 as Epic Electro and both 24 and 25 as Boutique 808
  "proxy-electro": { about: "draft proxy: kit 16 (GB Epic Electro) drafted on GM kit 24 (Electronic)", t: (t) => t.kit === 16 ? { ...t, kit: 24 } : t },
  "proxy-808": { about: "draft proxy: kit 24 (GB Boutique 808) drafted on GM kit 25 (TR-808)", t: (t) => t.kit === 24 ? { ...t, kit: 25 } : t },
  "proxy-kits": { about: "draft proxy: both kit remaps", t: (t) => t.kit === 16 ? { ...t, kit: 24 } : t.kit === 24 ? { ...t, kit: 25 } : t },
  "proxy-roots-0": { about: "draft proxy: kit 32 (GB Roots) drafted on GM kit 0 (Standard)", t: (t) => t.kit === 32 ? { ...t, kit: 0 } : t },
  "proxy-roots-8": { about: "draft proxy: kit 32 (GB Roots) drafted on GM kit 8 (Room)", t: (t) => t.kit === 32 ? { ...t, kit: 8 } : t },
  "proxy-clean": { about: "draft proxy: programs 27/28 (GB Classic Clean) drafted on GM 26 (jazz guitar)", t: (t) => {
    const p = (x: number) => (x === 27 || x === 28 ? 26 : x);
    return { ...t, ...(t.arp ? { arp: { ...t.arp, program: p(t.arp.program) } } : {}), ...(t.pad ? { pad: { ...t.pad, program: p(t.pad.program) } } : {}),
      ...(t.hook ? { hook: { ...t.hook, program: p(t.hook.program) } } : {}) };
  } },
  "ug-chops-53-o3": { about: "arp slot: gated chord chops on Voice Oohs (53) at octave 3 (in range in every key), verse and chorus", t: (t) => flag("arp", true, ["verse", "chorus"])(arp({ program: 53, style: "gated", octave: 3, level: -3 })(t)) },
  // ---- ablations: which part carries the genre for CLAP
  "no-drums": { about: "ablation: no drums", t: (t) => { const { drums: _d, ...rest } = t; return rest; } },
  "no-hook": { about: "ablation: no hook", t: (t) => { const { hook: _h, ...rest } = t; return rest; } },
  "no-bass": { about: "ablation: no bass", t: (t) => ({ ...t, form: t.form.map((s) => ({ ...s, bass: false })) }) },
  "no-chords": { about: "ablation: no pad and no arp", t: (t) => { const { pad: _p, arp: _a, ...rest } = t; return rest; } },
  "drums-only": { about: "ablation: drums only", t: (t) => { const { pad: _p, arp: _a, hook: _h, ...rest } = t; return { ...rest, form: rest.form.map((s) => ({ ...s, bass: false })) }; } },
  "ug-hook-chop-verse": { about: "vocal-chop hook in verse and chorus", t: (t) => flag("hook", true, ["verse", "chorus"])(hook({ pattern: "5 ~ 5 ~ ~ 3 ~ 5 | ~ 8 ~ 5 ~ ~ 3 ~ | 5 ~ 5 ~ ~ 3 ~ 5 | ~ 1 ~ 3 ~ ~ 1 ~" })(t)) },
};

function variantSong(genre: string, key: string, bpm: number, name: string, seed: number): Song {
  const original = GENRE_TEMPLATES[genre];
  if (!original) throw new Error(`unknown genre ${genre}`);
  let t: GenreTemplate = original;
  let loop = 0;
  for (const part of name.split("+")) {
    const v = VARIANTS[part];
    if (!v) throw new Error(`unknown variant ${part}; variants: ${Object.keys(VARIANTS).join(" ")}`);
    if (v.t) t = v.t(t, genre);
    if (v.loop) loop = v.loop;
  }
  GENRE_TEMPLATES[genre] = t;
  try {
    const r = templateSong({ genre, key, bpm, meter: 4, title: `m13-17 ${name}`, seed, variant: loop });
    if (!r.ok) throw new Error(r.error);
    return r.value as Song;
  } finally {
    GENRE_TEMPLATES[genre] = original;
  }
}

async function main() {
  if (process.argv[2] === "--list") {
    for (const [n, v] of Object.entries(VARIANTS)) console.log(`${n}\t${v.about}`);
    return;
  }
  if (process.argv[2] === "--song") { // one variant's Song JSON (e.g. for a live GarageBand confirm through gb_song render_midi)
    const [, g, k, b, seed, name] = process.argv.slice(2);
    if (!g || !k || !b || !seed || !name) throw new Error("usage: variants.ts --song <genre> <key> <bpm> <seed> <variant>");
    process.stdout.write(JSON.stringify(variantSong(g, k, Number(b), name, Number(seed))) + "\n");
    return;
  }
  const [genre, key, bpmText, outDir, seedsText, ...names] = process.argv.slice(2);
  if (!genre || !key || !bpmText || !outDir || !seedsText || names.length === 0) {
    throw new Error("usage: variants.ts <genre> <key> <bpm> <outDir> <seeds 1,2,3> <variant>[+<variant>] …  |  --list  |  --song …");
  }
  const out = resolve(outDir);
  const gbSong = createGbSong({ workspaceDir: out,
    gmRenderer: createGmRenderer({ binary: resolve(import.meta.dirname, "../../native/bin/gm-render"), timeoutMs: 300_000 }) });
  const slug = genre.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const manifest: unknown[] = [];
  for (const name of names) {
    for (const seed of seedsText.split(",").map(Number)) {
      const song = variantSong(genre, key, Number(bpmText), name, seed);
      const { title: _title, ...content } = song; // the title does not change the sound
      const hash = createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 12);
      const filename = `${slug}-${hash}.wav`;
      const wav = join(out, filename);
      if (!existsSync(wav)) {
        const r = await gbSong({ command: "render_draft", song, filename }) as { status: string; message?: string; context?: unknown };
        if (r.status !== "verified") {
          manifest.push({ variant: name, seed, error: `${r.message ?? r.status} ${JSON.stringify(r.context ?? "").slice(0, 300)}` });
          continue;
        }
      }
      manifest.push({ variant: name, seed, wav, hash, ...(song.swing ? { swing: song.swing, swingUnit: song.swingUnit ?? "16th" } : {}) });
    }
  }
  process.stdout.write(JSON.stringify(manifest) + "\n");
}

await main();
