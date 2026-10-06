// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * Voice leading (M13.4): classical checks between a lead line and the bass, as warnings — parallel fifths and octaves
 * (both voices move the same way and keep the perfect interval), leaps over an octave in the lead, and the lead
 * below the bass. They are rules of independent parts (choral, classical); rock and EDM use parallels on purpose.
 */
import type { SmfNote } from "../midi/smf.js";

export type VoiceIssue = { code: "PARALLEL_FIFTHS" | "PARALLEL_OCTAVES" | "LARGE_LEAP" | "VOICE_CROSSING"; path: string; message: string };
type Line = { name: string; notes: readonly SmfNote[] };

const MAX_BARS_LISTED = 6;
const OCTAVE = 12;

/** The pitch sounding at `tick`: the highest note of a top line, the lowest of a bass line; undefined when silent. */
function sounding(notes: readonly SmfNote[], tick: number, pick: "top" | "bottom"): number | undefined {
  let best: number | undefined;
  for (const n of notes) {
    if (n.startTick <= tick && tick < n.startTick + n.durationTicks) {
      if (best === undefined || (pick === "top" ? n.pitch > best : n.pitch < best)) best = n.pitch;
    }
  }
  return best;
}

const barsText = (bars: readonly number[]) => {
  const unique = [...new Set(bars)];
  const shown = unique.slice(0, MAX_BARS_LISTED).join(", ") + (unique.length > MAX_BARS_LISTED ? ", …" : "");
  return `${unique.length === 1 ? "bar" : "bars"} ${shown}`;
};

export function voiceLeading(lead: Line, bass: Line, ticksPerBar: number, ticksPerBeat: number): VoiceIssue[] {
  const bar = (tick: number) => Math.floor(tick / ticksPerBar) + 1;
  const times = [...new Set([...lead.notes, ...bass.notes].map((n) => n.startTick))].sort((a, b) => a - b);
  const fifths: number[] = [], octaves: number[] = [], crossings: number[] = [];
  let prev: { l: number; b: number } | undefined;
  for (const t of times) {
    const l = sounding(lead.notes, t, "top"), b = sounding(bass.notes, t, "bottom");
    if (l === undefined || b === undefined) { prev = undefined; continue; }
    if (l < b) crossings.push(bar(t));
    if (prev && l !== prev.l && b !== prev.b && Math.sign(l - prev.l) === Math.sign(b - prev.b)) {
      const before = (((prev.l - prev.b) % OCTAVE) + OCTAVE) % OCTAVE, now = (((l - b) % OCTAVE) + OCTAVE) % OCTAVE;
      if (before === 7 && now === 7) fifths.push(bar(t));
      if (before === 0 && now === 0) octaves.push(bar(t));
    }
    prev = { l, b };
  }
  const leaps: number[] = [];
  const melody = [...lead.notes].sort((a, b) => a.startTick - b.startTick);
  for (let i = 1; i < melody.length; i++) {
    const a = melody[i - 1]!, c = melody[i]!;
    const connected = c.startTick - (a.startTick + a.durationTicks) < ticksPerBeat; // a phrase, not a new entry
    if (connected && Math.abs(c.pitch - a.pitch) > OCTAVE) leaps.push(bar(c.startTick));
  }
  const path = `tracks.${lead.name}`;
  const why = "the two lines lose their independence — avoid it in classical or choral writing; rock and EDM use it on purpose";
  const out: VoiceIssue[] = [];
  if (fifths.length) out.push({ code: "PARALLEL_FIFTHS", path, message: `${lead.name} and ${bass.name} move in parallel fifths at ${barsText(fifths)}: ${why}.` });
  if (octaves.length) out.push({ code: "PARALLEL_OCTAVES", path, message: `${lead.name} and ${bass.name} move in parallel octaves at ${barsText(octaves)}: ${why}.` });
  if (leaps.length) out.push({ code: "LARGE_LEAP", path, message: `${lead.name} leaps more than an octave inside a phrase at ${barsText(leaps)}: hard to sing or play smoothly; fill the leap or move one note by an octave.` });
  if (crossings.length) out.push({ code: "VOICE_CROSSING", path, message: `${lead.name} goes below ${bass.name} at ${barsText(crossings)}: the melody hides under the bass; raise it an octave.` });
  return out;
}
