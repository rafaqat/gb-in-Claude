// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * Playable ranges (scientific pitch, MIDI numbers) for GM programs that GarageBand 10.4.14 maps to
 * real/acoustic instrument patches (patch names from gm-patch-map.json).
 * Programs not listed (synths, pads, FX) are treated as full-keyboard.
 */
export type InstrumentRange = { patch: string; low: number; high: number };

const range = (patch: string, low: number, high: number): InstrumentRange => ({ patch, low, high });

const PIANO = range("Steinway Grand Piano", 21, 108);
const STRINGS = range("String Ensemble", 28, 100);
const FLUTE = range("Flute Solo", 60, 96);
const BASS = (patch: string) => range(patch, 28, 67);
const GUITAR = (patch: string) => range(patch, 40, 88);
const SAX = range("Saxophone", 49, 81);

export const INSTRUMENT_RANGES: Record<number, InstrumentRange> = {
  0: PIANO, 1: PIANO, 2: PIANO, 3: PIANO,
  4: range("Classic Electric Piano", 28, 100),
  9: range("Glockenspiel", 77, 108), 10: range("Glockenspiel", 77, 108),
  11: range("Vibraphone", 53, 89),
  12: range("Marimba", 45, 96),
  24: range("Classical Acoustic Guitar", 40, 83),
  25: range("Acoustic Guitar", 40, 84),
  26: GUITAR("Roots Rock"), 27: GUITAR("Classic Clean"), 28: GUITAR("Classic Clean"),
  29: GUITAR("Hard Rock"), 30: GUITAR("Hard Rock"),
  32: BASS("Upright Studio Bass"), 33: BASS("Fingerstyle Bass"), 34: BASS("Picked Bass"), 35: BASS("Muted Bass"),
  40: STRINGS, 41: STRINGS, 42: STRINGS, 43: STRINGS, 44: STRINGS, 45: STRINGS, 48: STRINGS, 49: STRINGS,
  46: range("Harp", 24, 103),
  52: range("Classical Ensemble", 40, 81), 53: range("Classical Ensemble", 40, 81),
  56: range("Trumpets", 52, 82),
  57: range("Trombones", 40, 72),
  58: range("Tuba", 28, 58),
  60: range("French Horns", 34, 77),
  61: range("Full Brass", 34, 82),
  64: SAX, 65: SAX, 66: SAX, 67: SAX,
  68: range("Oboe", 58, 91),
  69: range("Bassoon Solo", 34, 75), 70: range("Bassoon Solo", 34, 75),
  71: range("Clarinet Solo", 50, 94),
  72: FLUTE, 73: FLUTE, 74: FLUTE, 77: FLUTE, 78: FLUTE, 79: FLUTE,
};
