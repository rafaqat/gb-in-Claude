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
} as const;

export type DrumVoice = keyof typeof DRUM_VOICES;
export const DRUM_VOICE_NAMES = Object.keys(DRUM_VOICES) as [DrumVoice, ...DrumVoice[]];
