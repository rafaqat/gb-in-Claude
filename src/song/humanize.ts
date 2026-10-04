// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import type { SmfNote, SmfTrack } from "../midi/smf.js";
import type { Role } from "./schema.js";
import { HUMANIZE_FEELS } from "./schema.js";
import type { GrooveFeel } from "./grooves.js";

export type Feel = (typeof HUMANIZE_FEELS)[number];
/** glide: notes run legato into the next (mono synths slide, e.g. a trap 808); leads always do. */
export type RoleTrack = SmfTrack & { role: Role; glide?: boolean };
/** groove: a mined genre groove (grooves.ts) — the drums it covers take its timing and accents (4/4, 16 steps). */
export type HumanizeOptions = { feel: Feel; seed: number; tempoBpm: number; ppq: number; groove?: GrooveFeel };

/**
 * Per-role feel, tuned by ear.
 * walk: timing random-walk sd (ms) · pocket: constant push(-)/lag(+) (ms) · accent: metric accent depth
 * gate: note-length range scaled by velocity · arc: 4-bar phrase swell depth · roll: chord strum (ms per voice)
 */
type RoleFeel = { walk: number; pocket: number; accent: number; arc: number; gate?: [number, number]; roll?: [number, number] };
const ROLE_FEEL: Record<Role, RoleFeel> = {
  drums: { walk: 3.0, pocket: 0.0, accent: 14, arc: 6 },
  bass: { walk: 2.5, pocket: 6.0, accent: 10, arc: 4, gate: [0.8, 1.0] },
  pad: { walk: 4.0, pocket: 0.0, accent: 0, arc: 8, roll: [6, 18] },
  arp: { walk: 2.0, pocket: 0.0, accent: 16, arc: 10, gate: [0.55, 1.0] },
  lead: { walk: 6.0, pocket: 3.0, accent: 8, arc: 12 },
  "lead-high": { walk: 6.0, pocket: 5.0, accent: 8, arc: 12 },
  fx: { walk: 1.0, pocket: 0.0, accent: 0, arc: 0 },
};
/** GM drum pockets (ms): kick anchored, snare/clap a touch late, hats loose. */
const DRUM_POCKET: Record<number, number> = { 35: 0, 36: 0, 38: 4, 40: 4, 39: 5, 42: -2, 44: -2, 46: 2 };
const KICKS = new Set([35, 36]);
const FEEL_SCALE: Record<Exclude<Feel, "off">, number> = { tight: 0.5, natural: 1, loose: 1.6 };
const MAX_SHIFT_MS = 30;
const LEAD_ROLES = new Set<Role>(["lead", "lead-high"]);
const GLIDE_OVERLAP_MS = 12;
const WALK_MEMORY = 0.85;

/** Seeded PRNG (mulberry32) — same seed, same performance. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = (sd: number) => sd * Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  const uniform = (lo: number, hi: number) => lo + (hi - lo) * next();
  return { gauss, uniform };
}

/** 1 on beats, 0.6 on 8ths, 0.25 on 16ths, 0 elsewhere. */
function metricStrength(tick: number, ppq: number): number {
  if (tick % ppq === 0) return 1;
  if (tick % (ppq / 2) === 0) return 0.6;
  if (tick % (ppq / 4) === 0) return 0.25;
  return 0;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Same channel+pitch notes must not overlap, or MIDI swallows one: shorten the earlier note. */
function removeSamePitchOverlaps(notes: SmfNote[]): SmfNote[] {
  const byPitch = new Map<number, SmfNote[]>();
  for (const n of notes) byPitch.set(n.pitch, [...(byPitch.get(n.pitch) ?? []), n]);
  for (const seq of byPitch.values()) {
    seq.sort((a, b) => a.startTick - b.startTick);
    for (let i = 1; i < seq.length; i++) {
      const prev = seq[i - 1]!;
      const next = seq[i]!;
      if (prev.startTick + prev.durationTicks > next.startTick) {
        prev.durationTicks = Math.max(1, next.startTick - prev.startTick);
      }
    }
  }
  return notes;
}

function humanizeTrack(track: RoleTrack, opts: HumanizeOptions, scale: number, random: ReturnType<typeof rng>): RoleTrack {
  const feel = ROLE_FEEL[track.role];
  const ticksPerMs = (opts.ppq * opts.tempoBpm) / 60000;
  const phraseTicks = opts.ppq * 4 * 4; // 4 bars of 4/4
  const sorted = [...track.notes].sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
  let walk = 0;
  let lastStart: number | undefined;
  const out: SmfNote[] = sorted.map((n, i) => {
    if (n.startTick !== lastStart) {
      walk = WALK_MEMORY * walk + random.gauss(feel.walk * scale); // chords move together
      lastStart = n.startTick;
    }
    const sixteenth = opts.ppq / 4;
    const grooved = track.role === "drums" ? opts.groove?.get(n.pitch) : undefined;
    const step = Math.round(n.startTick / sixteenth) % 16;
    let shiftMs: number;
    if (grooved) {
      // the style's measured timing for this voice and step, plus a little of the drummer's own variation
      shiftMs = grooved.offset[step]! * (sixteenth / ticksPerMs) * scale + random.gauss(1.0 * scale);
    } else if (track.role === "drums" && KICKS.has(n.pitch)) {
      shiftMs = random.gauss(0.8 * scale); // the kick is the anchor
    } else {
      const pocket = track.role === "drums" ? (DRUM_POCKET[n.pitch] ?? 0) : feel.pocket;
      shiftMs = walk + pocket * scale;
    }
    if (feel.roll) {
      const rank = sorted.filter((m, j) => j !== i && m.startTick === n.startTick && m.pitch < n.pitch).length;
      shiftMs += (rank * random.uniform(feel.roll[0], feel.roll[1]) * scale) / 2;
    }
    shiftMs = clamp(shiftMs, -MAX_SHIFT_MS, MAX_SHIFT_MS);

    const phrasePos = (n.startTick % phraseTicks) / phraseTicks;
    const arc = Math.sin(phrasePos * Math.PI) * feel.arc * scale - (feel.arc * scale) / 2;
    const accentScale = track.role === "drums" && KICKS.has(n.pitch) ? 0.3 : 1;
    const accent = (metricStrength(n.startTick, opts.ppq) - 0.5) * feel.accent * accentScale;
    const base = grooved ? n.velocity * grooved.accent[step]! : n.velocity + accent; // the style's accents replace the generic ones
    const velocity = Math.round(clamp(base + arc + random.gauss(3 * scale), 1, 127));

    let durationTicks = n.durationTicks;
    if (feel.gate) {
      const [lo, hi] = feel.gate;
      durationTicks = Math.max(opts.ppq / 32, Math.round(n.durationTicks * (lo + ((hi - lo) * velocity) / 127)));
    }
    return { ...n, velocity, durationTicks, startTick: Math.max(0, n.startTick + Math.round(shiftMs * ticksPerMs)) }; // keeps expression (slide, cents)
  });
  if (LEAD_ROLES.has(track.role) || track.glide) addGlide(out, opts.ppq, Math.round(GLIDE_OVERLAP_MS * ticksPerMs));
  const notes = removeSamePitchOverlaps(out).sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
  return { ...track, notes }; // vibrato is a pitch-bend LFO in song/expression.ts (samplers ignore CC1, probe 2026-10-04)
}

/** Legato: a lead note runs slightly into the next different note, so mono synths glide between them. */
function addGlide(notes: SmfNote[], ppq: number, overlapTicks: number): void {
  const mono = [...notes].sort((a, b) => a.startTick - b.startTick);
  for (let i = 1; i < mono.length; i++) {
    const a = mono[i - 1]!;
    const b = mono[i]!;
    const gap = b.startTick - (a.startTick + a.durationTicks);
    if (a.pitch !== b.pitch && gap <= ppq / 4 && b.startTick > a.startTick) {
      a.durationTicks = b.startTick - a.startTick + overlapTicks;
    }
  }
}

/** Musical humanization: correlated micro-timing, per-role pocket, metric accents, phrase arcs. */
export function humanize(tracks: RoleTrack[], opts: HumanizeOptions): RoleTrack[] {
  if (opts.feel === "off") return tracks;
  const random = rng(opts.seed);
  const scale = FEEL_SCALE[opts.feel];
  return tracks.map((t) => humanizeTrack(t, opts, scale, random));
}
