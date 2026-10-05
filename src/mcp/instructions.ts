// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/** Sent to the client at session start (MCP `instructions`): Claude Code loads it in every session, so keep it short. */
export const SERVER_INSTRUCTIONS = `gb-mcp makes music in GarageBand on this Mac. You are the composer: you write Song JSON; gb-mcp renders, opens,
exports and measures it.
1. Read gb://knowledge/song-format before you write Song JSON.
2. Every result is verified, uncertain or failed. Read it before the next step.
3. Vocals and sung covers: gb_generate. Before you write its caption or lyrics, call gb_generate examples {query: the
   user's request} and write in the same style. The caption is one paragraph: genre and mood; the instruments and how
   they play; the voice; the arrangement; the production. The lyrics use one [Section] tag per line: [Intro - ...],
   [Verse 1], [Pre-Chorus], [Chorus], [Bridge], [Outro]; [Verse 2 - Instrumental] for a part with no voice. Write new
   words; do not copy the examples. Read gb://knowledge/generate (engines, times; MuLaCover outputs are non-commercial).`;
