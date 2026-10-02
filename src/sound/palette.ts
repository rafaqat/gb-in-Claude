// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { ROLES, type Role } from "../song/schema.js";
import { STYLES, STYLE_NAMES, type StyleName } from "../song/styles.js";
import { GM_PATCH_MAP, GM_DRUM_KIT_MAP } from "../knowledge/gm-patch-map.js";
import type { ContentEvidence, PatchEntry } from "./patches.js";

/** How to get a sound: a GM program in the rendered MIDI (GarageBand loads it on open, no UI) or a Library pick (UI). */
export type PaletteChoice =
  | { patch: string; via: "gm_program"; program: number; channel: "melodic" | "drums"; inLibrary: boolean; recommended: boolean }
  | { patch: string; via: "ui_patch"; category: string; content: ContentEvidence; recommended: false };
export type PaletteEntry = { style: StyleName; role: Role; choices: PaletteChoice[] };

/** GM program families that suit each role (alternatives reachable with no UI). */
const ROLE_PROGRAMS: Record<Exclude<Role, "drums">, number[]> = {
  bass: [32, 33, 34, 35, 36, 37, 38, 39],
  pad: [88, 89, 90, 91, 92, 93, 94, 95, 48, 49, 50, 51, 52, 53, 54],
  arp: [80, 81, 84, 87, 98, 8, 11, 12, 4, 5],
  lead: [80, 81, 82, 83, 84, 85, 86, 87],
  "lead-high": [80, 81, 84, 87, 9, 54, 85],
  fx: [96, 97, 98, 99, 100, 101, 102, 103, 122],
};
/** Library categories that suit each role (alternatives that need the Library UI). */
const ROLE_CATEGORIES: Record<Exclude<Role, "drums">, string[]> = {
  bass: ["Synthesizer > Bass", "Synthesizer > EDM Bass", "Bass", "Arpeggiator > Synth Bass"],
  pad: ["Synthesizer > Pad", "Synthesizer > Strings", "Orchestral > Strings", "Synthesizer > Soundscape"],
  arp: ["Arpeggiator", "Synthesizer > Plucked", "Synthesizer > Rhythmic", "Synthesizer > Bell"],
  lead: ["Synthesizer > Lead", "Synthesizer > Classics"],
  "lead-high": ["Synthesizer > Lead", "Synthesizer > Bell", "Mallet"],
  fx: ["Synthesizer > Sound Effects", "Synthesizer > Soundscape"],
};
const MAX_UI_CHOICES = 8;
const CONTENT_RANK: Record<ContentEvidence, number> = { base: 0, receipt_found: 1, unknown: 2, no_receipt_match: 3 };

const gmPatch = (role: Role, program: number): string | undefined =>
  role === "drums" ? GM_DRUM_KIT_MAP[program] : GM_PATCH_MAP[program]?.patch;

function gmChoices(style: StyleName, role: Role, onDisk: Set<string>): PaletteChoice[] {
  const primary = STYLES[style].programs[role];
  const family = role === "drums" ? Object.keys(GM_DRUM_KIT_MAP).map(Number) : ROLE_PROGRAMS[role];
  const seen = new Set<string>();
  const choices: PaletteChoice[] = [];
  for (const program of [primary, ...family]) {
    const patch = gmPatch(role, program);
    if (!patch || seen.has(patch)) continue;
    seen.add(patch);
    choices.push({
      patch, via: "gm_program", program, channel: role === "drums" ? "drums" : "melodic",
      inLibrary: onDisk.has(patch), recommended: program === primary,
    });
  }
  return choices;
}

function uiChoices(role: Role, patches: readonly PatchEntry[], exclude: Set<string>): PaletteChoice[] {
  const fits = (p: PatchEntry) =>
    role === "drums" ? p.kind === "drum_kit" : ROLE_CATEGORIES[role].some((c) => p.category === c || p.category.startsWith(`${c} > `));
  return patches
    .filter((p) => fits(p) && !exclude.has(p.name))
    .sort((a, b) => CONTENT_RANK[a.content] - CONTENT_RANK[b.content] || a.name.localeCompare(b.name))
    .slice(0, MAX_UI_CHOICES)
    .map((p) => ({ patch: p.name, via: "ui_patch" as const, category: p.category, content: p.content, recommended: false as const }));
}

/** Per style × role: the style's GM pick first, then GM alternatives, then catalog patches that need the Library UI. */
export function buildPalette(patches: readonly PatchEntry[], f: { style?: StyleName | undefined; role?: Role | undefined }): PaletteEntry[] {
  const onDisk = new Set(patches.map((p) => p.name));
  const styles = f.style ? [f.style] : STYLE_NAMES;
  const roles = f.role ? [f.role] : ROLES;
  return styles.flatMap((style) =>
    roles.map((role) => {
      const gm = gmChoices(style, role, onDisk);
      return { style, role, choices: [...gm, ...uiChoices(role, patches, new Set(gm.map((c) => c.patch)))] };
    }));
}
