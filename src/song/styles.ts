// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import type { Role } from "./schema.js";

export type StylePreset = {
  description: string;
  /** GM program per role; GarageBand maps these to patches on open (see knowledge/gm-patch-map.json). */
  programs: Record<Role, number>;
  suggestedTempo?: number;
};

/** Presets chosen by ear. */
export const STYLE_NAMES = ["club-trance", "acoustic", "orbit-ambient"] as const;
export type StyleName = (typeof STYLE_NAMES)[number];

export const STYLES: Record<StyleName, StylePreset> = {
  "club-trance": {
    description: "Club trance: Epic Electro kit, Taureg Moon bass, Epic Cloud pad, saw arp, Rising High lead",
    programs: { drums: 16, bass: 39, pad: 90, arp: 81, lead: 127, "lead-high": 84, fx: 96 },
  },
  acoustic: {
    description: "Acoustic band: SoCal kit, fingerstyle bass, string ensemble, Steinway arp, flute lead, glockenspiel",
    programs: { drums: 0, bass: 33, pad: 48, arp: 0, lead: 73, "lead-high": 9, fx: 48 },
  },
  "orbit-ambient": {
    description: "William Orbit-style: real strings with warm synths, soft 808, Dream Voice air, spacious tempo",
    programs: { drums: 24, bass: 39, pad: 48, arp: 98, lead: 81, "lead-high": 54, fx: 99 },
    suggestedTempo: 126,
  },
};
const DEFAULT_STYLE: StyleName = "club-trance";

export function resolveProgram(style: StyleName | undefined, track: { role: Role; program?: number | undefined }): number {
  return track.program ?? STYLES[style ?? DEFAULT_STYLE].programs[track.role];
}
