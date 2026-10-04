# GarageBand 10.4 — which MIDI messages survive MIDI-file import (measured 2026-10-04)

Method: one probe file (`probes/midi-messages-probe.py`), one test per track, a 4 s window each at 60 BPM; the message changes
at +2 s; the GarageBand export is measured before vs after. Pitch bend was probed separately
on Flute Solo, with pyin pitch tracking.

| Message | Patch | Measured | Verdict |
|---|---|---|---|
| CC7 volume 100→40 | Flute Solo | −12.5 dB | honoured |
| CC11 expression 127→40 | Flute Solo | −12.5 dB | honoured |
| CC10 pan 64→0 | String Ensemble | L−R +0.6 → +11.9 dB | honoured |
| CC64 sustain | Steinway Grand Piano | between-note energy −17.9 → −3.1 dB | honoured |
| CC74 brightness | Soft Saw Lead | centroid 4097 → 1790 Hz | honoured |
| Pitch bend, default range | Flute Solo | +1.97 semitones at full scale | honoured (±2) |
| RPN 0 bend range = 12 | Flute Solo | +11.97 semitones at full scale | honoured |
| Tempo change (conductor) | — | beat spacing 1 s → 0.5 s | honoured |
| CC1 mod wheel | Flute Solo | identical audio | ignored (sampler) — humanize's CC1 vibrato does nothing here |
| Channel pressure, poly aftertouch | Flute Solo | identical audio | ignored |
| RPN 1/2 fine/coarse tuning | Flute Solo | identical pitch | ignored → microtones need pitch bend |
| Program change mid-track | Steinway → (73) | identical | ignored: one patch per track |
| CC93 chorus | String Ensemble | side/mid unchanged | ignored |
| CC73 attack | Soft Saw Lead | 8 → 5 ms | no real effect |
| CC91 reverb | Flute Solo | no added tail | probably ignored ("before" window had bleed) |

Not yet probed: CC1/aftertouch on synth (Alchemy) patches, CC5/65 portamento, CC71/72, time-signature changes,
key-signature/marker/lyric meta events, note-off velocity.
Bend-reset lesson: resetting the bend at note-off makes the release tail jump back; reset just before the next note-on.

## Probe 2 (same day): the rest of the sweep
Method: `probes/midi-messages-probe-2.py` + `probes/midi-messages-analyze-2.py` (6 s windows with 0.5 s of silence first, so no bleed);
raw numbers in `probes/midi-messages-2-results.json`.

| Message | Patch | Measured | Verdict |
|---|---|---|---|
| CC1 mod wheel | Soft Saw Lead | pitch wobble 0.5 → 47 cents | honoured on synths (vibrato) — ignored on Flute Solo |
| CC1 mod wheel | String Ensemble | level −1.4 dB, centroid −214 Hz | weak / unclear |
| Channel pressure | Soft Saw Lead | wobble 0 → 10 cents, centroid +880 Hz | honoured on synths |
| Poly aftertouch | Soft Saw Lead | none | ignored |
| Portamento CC65 + CC5 | Soft Saw Lead | no glide either way | ignored |
| CC71 resonance | Soft Saw Lead | peakiness −1.3 dB | no real effect |
| CC72 release | Soft Saw Lead | tail −17.3 → −16.8 dB | ignored |
| CC91 reverb (clean) | Flute Solo, Soft Saw Lead | tail unchanged | ignored |
| CC93 chorus | Soft Saw Lead | side/mid −2.0 → −1.6 dB | ignored |
| Pitch bend + RPN 0 = 12 | Soft Saw Lead, String Ensemble, Taureg Moon Bass | +2.00 semitones at full scale | bend honoured, **RPN range ignored: ±2 only** |
| Pitch bend + RPN 0 = 12 | Harp | 0.00 | no pitch bend at all |
| Note-off velocity | Steinway Grand Piano | release +1.8 dB | negligible |

Design consequences: bend range is a property of the GarageBand patch (Flute Solo ±12; Soft Saw Lead, String Ensemble,
Taureg Moon Bass ±2; Harp none) — gb-mcp keeps a measured table and refuses wider slides; vibrato goes through pitch
bend (works on every bending patch), not CC1. Time-signature changes, key signature, markers and lyrics have no audio
effect to measure; GarageBand projects keep one time signature.

## .band files (gb_band build), same day
GarageBand stores CC and bend events in a region's EvSq list as 16-byte records: status|channel at +0, tick +38400
at +4 (960 PPQ), the MIDI second data byte at +0x0B, the first at +0x0C; a 127 carries flag 0x20 at +1 and a
full-scale fraction at +8. Read from GarageBand's own save of an imported MIDI file; gb_band now writes them. A built .band with
whole-step slides on Steinway Grand Piano and Fingerstyle Bass: GarageBand kept the bends (79 points in its save) and
the isolated exports bend +207¢ / +198¢ — both patches bend the default ±2.
