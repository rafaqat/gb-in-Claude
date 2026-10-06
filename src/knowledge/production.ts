// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/** Agent-facing production rubric , served as gb://knowledge/production. */
export const PRODUCTION_RUBRIC = `# Production rubric (gb-mcp)

Notes are ~30% of the result; sound choice, expression and mix are the rest. Check every song against this list.

## Sound
1. Every track gets a deliberate sound. Prefer GM programs that load with no UI (gb_sound palette → via "gm_program");
   a track left on piano when its role isn't keys is a mistake.
2. Electronic drums: use an electronic kit (Epic Electro 16, Boutique 808 24 or 25 on channel 10) — a GM acoustic
   kit under a trance arrangement sounds like a demo. A GM draft (render_draft) plays 25 as an 808, but it plays 16 as
   an acoustic kit: judge Epic Electro drums in a GarageBand export, not in a draft.
3. Layer the hook: lead + an octave layer (role "lead-high") on a different patch, a few dB quieter.
4. Check content: catalog patches marked content "no_receipt_match" may not be downloaded — prefer "base"/"receipt_found".
5. Real instruments have ranges (validate reports OUT_OF_INSTRUMENT_RANGE): flute C4–C7, bass E1–G4, glockenspiel F5–C8.

## Expression (anti-robotic)
6. Keep humanize "natural" (or "tight" for machine-precise styles); "off" sounds mechanical.
7. No part should repeat identical velocities for more than 2 bars — accents, ghost notes (grid "o"), phrase arcs.
8. Leads glide (legato overlaps) and get delayed vibrato on long notes; pads strum chords instead of slamming them.

## Arrangement & movement
9. Builds have movement: a riser (role "fx"), a snare roll, or a filter ramp. Drops change something (drums, bass, hook).
10. Breakdowns drop the kick and bass; drops should be clearly louder/denser than breakdowns (gb_analyze checks contrast).
11. Vary every 8 bars: a fill, a crash, a dropped element — identical bars for 32 bars sound looped.

## Mix
12. Low end: bass and kick own 40–120 Hz; keep pads/leads/arps out of it (higher octaves, or a low cut ≥ 120 Hz).
13. Pump in the drop: GarageBand has no sidechain — use volume automation or a 1/4-note Tremolo on pads.
14. Space: reverb/delay on leads and pads, drums drier. Mono low end; wide pads.
15. Masters: aim around -9 to -12 LUFS for club, -14 for streaming; true peak below -1 dBTP.

## Verify
16. After export, run gb_analyze and compare against the previous bounce — never trust a change you haven't measured.
`;
