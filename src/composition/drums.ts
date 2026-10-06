// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/** Drum voice names agents write in grids → General MIDI percussion notes (channel 10). */
export const DRUM_VOICES = {
  kick: 36,
  rim: 37,
  snare: 38,
  clap: 39,
  hat: 42,
  "pedal-hat": 44,
  "open-hat": 46,
  "tom-low": 45,
  "tom-mid": 47,
  "tom-high": 50,
  crash: 49,
  ride: 51,
  shaker: 70,
  // M14: Latin and world percussion (GM notes) — which GarageBand kits play them: knowledge/song-format
  tambourine: 54,
  cowbell: 56,
  "bongo-high": 60,
  "bongo-low": 61,
  "conga-mute": 62,
  "conga-high": 63,
  "conga-low": 64,
  "timbale-high": 65,
  "timbale-low": 66,
  "agogo-high": 67,
  "agogo-low": 68,
  cabasa: 69,
  "guiro-short": 73,
  "guiro-long": 74,
  claves: 75,
  "woodblock-high": 76,
  "woodblock-low": 77,
  "triangle-mute": 80,
  triangle: 81,
} as const;

export type DrumVoice = keyof typeof DRUM_VOICES;

/** Voices only GarageBand's Orchestral Kit (GM kit 40/48) plays as their own sounds — M14 live probe: SoCal, Retro Rock
 * and Roots are silent on them; Boutique 808 plays one pitched 808 boom across them and Electro one pitched click.
 * Tambourine, cowbell and claves sound on every kit. */
export const ORCHESTRAL_KIT_ONLY: ReadonlySet<DrumVoice> = new Set<DrumVoice>(["bongo-high", "bongo-low", "conga-mute",
  "conga-high", "conga-low", "timbale-high", "timbale-low", "agogo-high", "agogo-low", "cabasa", "guiro-short", "guiro-long",
  "woodblock-high", "woodblock-low", "triangle-mute", "triangle"]);
export const DRUM_VOICE_NAMES = Object.keys(DRUM_VOICES) as [DrumVoice, ...DrumVoice[]];
