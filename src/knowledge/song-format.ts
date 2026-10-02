// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/** Agent-facing guide to Song JSON, served as gb://knowledge/song-format. Keep in sync with song/schema.ts. */
export const SONG_FORMAT_GUIDE = `# Song JSON (gb-mcp)

Workflow: gb_song validate → preview (per section) → render_midi → open in GarageBand.
Pitches are scientific (C4 = MIDI 60). GarageBand displays MIDI 60 as "C3" — do not adjust for that.

## Top level
title (string) · tempo (20–300) · timeSignature [2–7, 4] (default [4,4]) · seed (int, default 1)
key (optional, e.g. "F minor", "Ab major") — gb_analyze checks the audio against it
style: "club-trance" | "acoustic" | "orbit-ambient" (sets GM programs per role; see gb://knowledge/styles)
humanize: "off" | "tight" | "natural" (default) | "loose"
sections: [{ name, bars }] in play order, names unique
tracks: [{ name (ASCII, becomes the GarageBand region name), role, program? (0–127 override),
           level? (dB, -24…+6: velocity scaling, -6 ≈ half as loud), parts: { <section>: Part } }]
roles: drums · bass · pad · arp · lead · lead-high · fx   (max 15 non-drum tracks)

## Parts (a part loops to fill its section; longer patterns are truncated)
drums only — grid: { <voice>: "x...x...x...x..." }  x hit · X accent · o ghost · . rest · | bar
  voices: kick rim snare clap hat pedal-hat open-hat tom-low tom-mid tom-high crash ride shaker
  steps per bar must be a multiple of the beats (4/4: 8, 12, 16, 32)
  levels: { <voice>: dB } per voice, e.g. { "kick": -6 } tames a thumpy kick without touching the hats
bass/pad/arp — chords: "Fm | Db | Ab | Eb", style, octave?   (chords in one bar share it: "Am F")
  bass styles: sustain · offbeat · rolling · octave      (default octave 2)
  pad styles:  sustain · stabs (voice-led)       (default octave 3)
  arp styles:  up · down · updown · broken · gated      (default octave 4)
  chord symbols: C Cm Cdim Caug Csus2 Csus4 C7 Cmaj7 Cm7 Cm7b5 Cadd9 Cm9, slash chords C/E
any non-drum role — notes: "f5 ab5 c6 ~ | eb6@2 c6 ~"
  tokens share a bar equally · ~ rest · @n = n shares · [c4,e4,g4] chord · | bar

## Common mistakes
1. Real instruments have ranges: render_midi refuses notes a flute/bass/glockenspiel can't play. Move high
   lines to role "lead-high" or transpose.
2. Bass belongs in E1–G3; put the octave on the part, not in every note.
3. humanize "off" sounds mechanical — keep "natural" unless asked for a machine feel.
4. Files are never overwritten; pick a new filename for each version (e.g. -v2).
`;
