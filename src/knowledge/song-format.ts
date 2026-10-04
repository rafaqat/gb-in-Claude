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

## Genre drafts and grooves (M9)
gb_song template {genre, key, bpm?, meter?} → a complete Song JSON draft for the genre: form, progressions, the
genre's GarageBand drum kit and instruments, bass style, a hook, and drums. Start from it, then make it yours.
  genres: lo-fi hip-hop · R&B · ambient · jazz ballad · reggaeton · synthwave · pop · afrobeats · funk · indie rock ·
  deep house · techno · UK garage · trap · drum and bass · EDM (big room) · classical/pop crossover ·
  ambient trance (William Orbit style) · Levantine ethereal strings (Fairuz style) · epic orchestral (Hans Zimmer style)
swing?: 50 (straight) … 58 light · 66 triplet feel · 75 hard; swingUnit "16th" (default) or "8th" (jazz). Every second
  16th/8th of every track is delayed. UK garage ≈ 64, lo-fi ≈ 57, jazz ≈ 64 on 8ths.
tracks[].glide?: notes run legato into the next so a mono synth slides — a trap 808 line (leads always glide).
groove?: a style mined from real drummers (Groove MIDI Dataset): the drums take its timing and accents (4/4).
  afrobeat · afrocuban · blues · country · dance · funk · gospel · highlife · hiphop · jazz · latin · middleeastern ·
  neworleans · pop · punk · reggae · rock · soul

## Expression (M11) — only messages GarageBand honours (measured: eval/m11/MESSAGES.md)
In notes (single-note lines only — a bend moves every note on the channel):
  meend / slide  "d5@7>e5@2"  one note bends into e5, arriving after 7 of its 9 shares (glide = last 35 % of the held part)
                 "a4@2>c5@2>b4@4"  one breath through several pitches
  shruti         "e5-20c"  20 cents flat for the note's length (also on slide targets: "a4>bb4+30c")
  accent / soft  "a5!" (+4 dB)   "a5?" (−8 dB)
  Bend range is the patch's: Flute Solo ±12 · Soft Saw Lead, String Ensemble, Taureg Moon Bass ±2 · Harp none.
  validate refuses wider slides (BEND_RANGE) and slides on tracks with chords (BEND_NEEDS_MONO).
tracks[].vibrato: "off" | "light" | "normal" | "wide" — pitch-bend vibrato on notes ≥ 1 beat (leads default "normal").
On a notes/chords part:
  dynamics "mf" | "p<f" | "pp<ff>mp" (CC11 hairpins across the section; ppp…fff)
  pedal "bar" | "half" | "beat" (CC64, re-pedalled)
  pan −1…1 | {from, to} | {cycle: bars, depth: 0–1, center?} (CC10: fixed, sweep, auto-pan)
  brightness 0–1 | {from, to} (CC74, synth patches)   volume 0–1 | {from, to} (CC7, fades; 1 = default)
On a drum part: volume (fades). Drums take levels, not dynamics.
sections[].tempo (new tempo from the section) · sections[].tempoTo (ramp to it by the section end: rit./accel.)
Automatic: a key signature from "key", a marker per section. GarageBand ignores CC1 on sampled patches, aftertouch,
portamento, reverb/chorus sends, mid-track program changes and RPN tuning — gb-mcp does not offer them.
gb_band build: notes may carry slides and cent offsets too (bends written into the .band region).

## AI infill (M10, needs the model sidecar)
gb_song infill {song, section, tracks: ["Keys"], mode?: "exact" | "fast", seed?} → the same Song JSON with those
melodic tracks' parts in that section rewritten by the Anticipatory Music Transformer (as "notes", 16th grid), on the
song's own instruments. The model hears the song before and after the section (not the other tracks inside it).
exact ≈ 1–1.5 min per 8 bars, fast ≈ 20 s (shorter context: listen before trusting it). Another seed = another take.
Drums are never infilled. Two tracks on the same instrument cannot be infilled together.
candidates: 2–4 takes (seeds seed, seed+1, …) and judge: "what the music should be" → CLaMP 3 ranks the takes against
that text and returns the best (scores of all takes in "takes": a ranking, not a grade).

## Audio clips (WAVs: stems, vocals, samples) — built by gb_band, not by render_midi
a track may hold audio: { donorTrack: n, audio: [{ wav, section, bar?, beat? }] }
  wav: a 16/24-bit PCM WAV inside the workspace · bar/beat: 1-based, relative to the section start
  donorTrack: the donor's audio track (gb_band inspect lists them) · 4/4 songs only
gb_song band_plan {song} → audio [{wav, bar, beat, track}] → pass it as gb_band build's audio, with a donor.
render_midi and render_draft ignore audio clips (MIDI cannot carry audio).

## Common mistakes
1. Real instruments have ranges: render_midi refuses notes a flute/bass/glockenspiel can't play. Move high
   lines to role "lead-high" or transpose.
2. Bass belongs in E1–G3; put the octave on the part, not in every note.
3. humanize "off" sounds mechanical — keep "natural" unless asked for a machine feel.
4. Files are never overwritten; pick a new filename for each version (e.g. -v2).
`;
