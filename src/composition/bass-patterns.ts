// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import type { Chord } from "./chord.js";

/** One note in beat time (beat 0 = bar start). Converted to MIDI ticks later. */
export type NoteEvent = { pitch: number; startBeat: number; durationBeats: number; velocity: number };

export type BassStyle = "sustain" | "offbeat" | "rolling" | "octave";

/** MIDI pitch of the chord's bass note in the given octave (C4 = 60 convention). */
export const bassPitch = (chord: Chord, octave: number): number => (octave + 1) * 12 + chord.bass;

/**
 * Render one bar of bass for a chord.
 * `octave` is where the bass sits (trance bass is usually octave 2: F2 = 41).
 */
export function renderBassBar(style: BassStyle, chord: Chord, octave: number, beatsPerBar = 4): NoteEvent[] {
  const root = bassPitch(chord, octave);
  switch (style) {
    case "sustain":
      // Example style: one held root note for the whole bar.
      return [{ pitch: root, startBeat: 0, durationBeats: beatsPerBar, velocity: 96 }];

    case "offbeat":
      return renderOffbeat(root, beatsPerBar);

    case "rolling":
      return renderRolling(root, beatsPerBar);

    case "octave":
      return renderOctave(root, beatsPerBar);
  }
}

/**
 * The classic trance "offbeat" bass: a note on the "and" of every beat
 * (beats 0.5, 1.5, 2.5, 3.5), leaving the downbeats clear for the kick.
 * This is what makes trance bass bounce against the four-on-the-floor kick.
 */
const OFFBEAT_DURATION = 0.3; // punchy: well clear of the next kick
const OFFBEAT_VELOCITY = 92;
const OFFBEAT_ACCENT_VELOCITY = 104; // the "and" of beat 3 leans forward into the bar's second half
const OFFBEAT_ACCENT_BEAT = 2;

function renderOffbeat(root: number, beatsPerBar: number): NoteEvent[] {
  return Array.from({ length: beatsPerBar }, (_, beat) => ({
    pitch: root,
    startBeat: beat + 0.5,
    durationBeats: OFFBEAT_DURATION,
    velocity: beat === OFFBEAT_ACCENT_BEAT ? OFFBEAT_ACCENT_VELOCITY : OFFBEAT_VELOCITY,
  }));
}

const ROLLING_DURATION = 0.2; // just under a 16th: each note re-articulates
const ROLLING_VELOCITIES = [84, 96, 90]; // the middle 16th (the "and") pushes forward

/** Rolling trance bass: the three 16ths after every kick ("x" = kick):  x b b b | x b b b … */
function renderRolling(root: number, beatsPerBar: number): NoteEvent[] {
  return Array.from({ length: beatsPerBar }, (_, beat) =>
    ROLLING_VELOCITIES.map((velocity, i) => ({
      pitch: root,
      startBeat: beat + (i + 1) * 0.25,
      durationBeats: ROLLING_DURATION,
      velocity,
    })),
  ).flat();
}

const OCTAVE_DURATION = 0.4; // each 8th ends before the next
const OCTAVE_LOW_VELOCITY = 96;
const OCTAVE_HIGH_VELOCITY = 88;

/** Octave bass (disco/trance): root on every beat, the octave above on every "and". */
function renderOctave(root: number, beatsPerBar: number): NoteEvent[] {
  return Array.from({ length: beatsPerBar }, (_, beat) => [
    { pitch: root, startBeat: beat, durationBeats: OCTAVE_DURATION, velocity: OCTAVE_LOW_VELOCITY },
    { pitch: root + 12, startBeat: beat + 0.5, durationBeats: OCTAVE_DURATION, velocity: OCTAVE_HIGH_VELOCITY },
  ]).flat();
}
