// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { DRUM_VOICES } from "../composition/drums.js";
import { renderSong, PPQ } from "./render.js";
import type { Song } from "./schema.js";

const STEP_TICKS = PPQ / 4; // one character = one 16th
const LABEL_WIDTH = 17;
const PITCH_TO_VOICE = new Map<number, string>(Object.entries(DRUM_VOICES).map(([name, pitch]) => [pitch, name]));

export type PreviewOptions = { section: string; maxBars?: number };

type Note = { pitch: number; startTick: number; durationTicks: number };

/** One grid row: x = note onset, - = step fully held by a note, . = silence. */
function row(notes: Note[], fromTick: number, steps: number, beatsPerBar: number): string {
  const cells = Array<string>(steps).fill(".");
  for (const n of notes) {
    const end = n.startTick + n.durationTicks;
    for (let s = 0; s < steps; s++) {
      const stepStart = fromTick + s * STEP_TICKS;
      if (stepStart === n.startTick) cells[s] = "x";
      else if (cells[s] !== "x" && stepStart > n.startTick && stepStart + STEP_TICKS <= end) cells[s] = "-";
    }
  }
  const perBar = beatsPerBar * 4;
  const bars: string[] = [];
  for (let b = 0; b < steps / perBar; b++) bars.push(cells.slice(b * perBar, (b + 1) * perBar).join(""));
  return `|${bars.join("|")}|`;
}

/** ASCII piano-roll of one section (humanize off: shows the written grid, not the performance). */
export function previewSong(song: Song, opts: PreviewOptions): string {
  const beatsPerBar = song.timeSignature[0];
  const index = song.sections.findIndex((s) => s.name === opts.section);
  if (index < 0) return `unknown section "${opts.section}"; sections: ${song.sections.map((s) => s.name).join(", ")}`;
  const section = song.sections[index]!;
  const startBar = song.sections.slice(0, index).reduce((sum, s) => sum + s.bars, 0);
  const bars = Math.min(section.bars, opts.maxBars ?? section.bars);
  const barTicks = beatsPerBar * PPQ;
  const fromTick = startBar * barTicks;
  const toTick = fromTick + bars * barTicks;
  const steps = bars * beatsPerBar * 4;

  const rendered = renderSong({ ...song, humanize: "off" });
  if (!rendered.ok) return `cannot preview: ${rendered.error.path}: ${rendered.error.message}`;

  const label = (s: string) => s.padEnd(LABEL_WIDTH).slice(0, LABEL_WIDTH);
  const beatRuler = Array.from({ length: beatsPerBar }, (_, i) => String(i + 1).padEnd(4)).join("");
  const span = bars === 1 ? `bar ${startBar + 1}` : `bars ${startBar + 1}–${startBar + bars}`;
  const lines = [label(`${section.name} (${span})`) + `|${Array(bars).fill(beatRuler).join("|")}|`];

  for (const [i, track] of rendered.value.tracks.entries()) {
    const inSection = track.notes.filter((n) => n.startTick >= fromTick && n.startTick < toTick);
    if (song.tracks[i]!.role === "drums") {
      const part = song.tracks[i]!.parts[section.name];
      const voices = part && "grid" in part ? Object.keys(part.grid) : [];
      if (voices.length === 0) lines.push(label(track.name) + row([], fromTick, steps, beatsPerBar));
      for (const voice of voices) {
        const hits = inSection.filter((n) => PITCH_TO_VOICE.get(n.pitch) === voice);
        lines.push(label(`${track.name} ${voice}`) + row(hits, fromTick, steps, beatsPerBar));
      }
    } else {
      lines.push(label(track.name) + row(inSection, fromTick, steps, beatsPerBar));
    }
  }
  return lines.join("\n");
}
