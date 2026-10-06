// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * MCP prompts (M13): gb-mcp's common workflows as slash commands in Claude Code (/mcp__gb-mcp__<name>). Each prompt is
 * the user's request plus the steps that the tools and skills already document — no new behaviour, only a start.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Prompt = { name: string; title: string; description: string; arg: { name: string; description: string }; steps: (value: string) => string };

export const PROMPTS: readonly Prompt[] = [
  {
    name: "new-track", title: "Make a new track",
    description: "Compose a new track in GarageBand from a brief (Song JSON → MIDI → GarageBand → export → analysis).",
    arg: { name: "brief", description: "what to make, e.g. a dreamy ambient track in D minor at 100 BPM, about 3 minutes" },
    steps: (brief) => [
      `Make a new track in GarageBand: ${brief}`,
      "",
      "1. Read gb://knowledge/song-format. Start from gb_song template {genre, key, bpm}, then make the parts your own.",
      "2. gb_song validate; fix every error and read every warning.",
      "3. gb_song render_midi → gb_project open_midi → gb_export song → gb_analyze against_song (with the spectrogram).",
      "4. Report what you made, where the files are, the 2–3 most useful metrics, and every flag with what you would change.",
    ].join("\n"),
  },
  {
    name: "song-with-vocals", title: "Write a song with vocals",
    description: "A sung song from a brief with gb_generate (ACE-Step): caption and lyrics in the style of ACE-Step's own examples, then the WAV.",
    arg: { name: "brief", description: "the song, e.g. a warm folk song with a female voice about an old lighthouse keeper" },
    steps: (brief) => [
      `Write a song with vocals: ${brief}`,
      "",
      "1. gb_generate examples {query: the brief} — read the examples that fit, then write a new caption (one paragraph:",
      "   genre and mood, instruments, voice, arrangement, production) and new lyrics ([Section] tags, one per line).",
      "2. gb_generate start {engine: \"ace_step\", task: \"text\", caption, lyrics, bpm, key, duration, filename, dry_run: true},",
      "   then without dry_run; poll gb_generate status {job} until done. Report the measured tempo and key.",
      "3. If the user wants a GarageBand project: gb_stem separate the result, then place the stems with gb_band",
      "   (gb://knowledge/generate, steps). Show the user the caption and the lyrics you used.",
    ].join("\n"),
  },
  {
    name: "stems-into-song", title: "Put outside audio into the open song",
    description: "Separate or align a recording and place it on audio tracks next to the MIDI song open in GarageBand.",
    arg: { name: "audio", description: "the recording in the workspace and where it goes, e.g. exports/demo.wav — the vocals from bar 5" },
    steps: (audio) => [
      `Put this audio into the song that is open in GarageBand: ${audio}`,
      "",
      "1. gb_stem inspect the file. gb_stem separate it if only some parts are wanted; gb_stem prepare each part to the song's tempo.",
      "2. gb_tracks add_audio {count} → gb_project save_copy {filename: \"<slug>-donor.band\"} (it lists the audio tracks).",
      "3. gb_band build {donor, filename, audio: [{wav, bar, beat, track}], dry_run: true}, then without dry_run.",
      "4. gb_project open_band → gb_export song → gb_analyze audio. Report where each part sits.",
    ].join("\n"),
  },
  {
    name: "revise", title: "Revise the last track",
    description: "Turn feedback on a gb-mcp track into Song JSON changes, re-render, export and compare before/after.",
    arg: { name: "feedback", description: "what to change, e.g. the drums are too loud in the intro" },
    steps: (feedback) => [
      `Revise the last track: ${feedback}`,
      "",
      "1. Find the last version (songs/<slug>-vN.song.json and its export). Map the feedback to Song JSON changes.",
      "2. Save the new version as -vN+1 (never overwrite); gb_song validate → render_midi → gb_project open_midi → gb_export song.",
      "3. gb_analyze compare {before, after}; say honestly what improved and what did not, and ask the user to listen.",
    ].join("\n"),
  },
];

export function registerPrompts(server: McpServer): void {
  for (const p of PROMPTS) {
    server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema: { [p.arg.name]: z.string().describe(p.arg.description) } },
      (args: Record<string, string>) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: p.steps(args[p.arg.name] ?? "") } }] }));
  }
}
