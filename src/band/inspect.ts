// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/** A read-only summary of a GarageBand project: what a donor offers, or what a build produced. */
import { join } from "node:path";
import { err, ok, type Result } from "../result.js";
import { parseProjectData } from "./projectdata.js";
import { audioPlacements, MAX_PLACEMENTS, readAudioFile, regionIndex } from "./audio.js";
import { midiRegions } from "./midi.js";
import { projectTempo, songLength } from "./song.js";
import { FileRefused, readRegular } from "./files.js";

const TICKS_PER_BEAT = 960;
const BEATS_PER_BAR = 4; // 4/4 donors (see handler.ts)
/** The same limit as the builder: a GarageBand song's ProjectData is a few MB. */
const MAX_PROJECTDATA_BYTES = 16 * 1024 * 1024;

export type BandSummary = {
  tempo: number | null;
  bars: number;
  audio: { track: number; bar: number; beat: number; file: string; seconds: number }[];
  midi: { region: string; notes: number; bars: number }[];
};
export type InspectError = { code: "NOT_PROJECTDATA"; message: string };

/** Never throws: a damaged or unknown project is an error Result. */
export function inspectBand(dir: string): Result<BandSummary, InspectError> {
  let bytes: Uint8Array;
  try {
    bytes = readRegular(join(dir, "Alternatives", "000", "ProjectData"), MAX_PROJECTDATA_BYTES);
  } catch (e) {
    return err({ code: "NOT_PROJECTDATA", message: `the project's ProjectData cannot be read: ${e instanceof FileRefused ? e.message : "missing or unreadable"}` });
  }
  return summarizeProjectData(bytes);
}

/** The summary of ProjectData bytes. Never throws. */
export function summarizeProjectData(bytes: Uint8Array): Result<BandSummary, InspectError> {
  const pd = parseProjectData(bytes);
  if (!pd.ok) return err({ code: "NOT_PROJECTDATA", message: pd.error.message });
  try {
    const records = regionIndex(pd.value);
    const placements = audioPlacements(pd.value);
    if (placements.length > MAX_PLACEMENTS) return err({ code: "NOT_PROJECTDATA", message: `the project holds more than ${MAX_PLACEMENTS} audio regions; gb_band handles small projects` });
    const audio = placements.map((p) => {
      const at = records(p.region);
      const file = at.file >= 0 ? readAudioFile(pd.value.records[at.file]!.payload) : undefined;
      const beats = p.tick / TICKS_PER_BEAT;
      return {
        track: p.track, bar: Math.floor(beats / BEATS_PER_BAR) + 1, beat: (beats % BEATS_PER_BAR) + 1,
        file: file?.ok ? file.value.filename : "",
        seconds: file?.ok && file.value.rate > 0 ? Math.round((file.value.frames / file.value.rate) * 1000) / 1000 : 0,
      };
    });
    const bar = (ticks: number) => Math.round((ticks / (TICKS_PER_BEAT * BEATS_PER_BAR)) * 1000) / 1000;
    return ok({
      tempo: projectTempo(pd.value),
      bars: bar(songLength(pd.value)),
      audio,
      midi: midiRegions(pd.value).map((m) => ({ region: m.name, notes: m.notes.length, bars: bar(m.length) })),
    });
  } catch {
    return err({ code: "NOT_PROJECTDATA", message: "the project's data is damaged or uses records this version does not understand" });
  }
}

/** What differs between two summaries, in any order (GarageBand may write records in another order). */
export function bandDifferences(expected: BandSummary, actual: BandSummary): string[] {
  const out: string[] = [];
  if (expected.tempo !== actual.tempo) out.push(`tempo: ${expected.tempo} in the file, ${actual.tempo} in GarageBand's copy`);
  if (expected.bars !== actual.bars) out.push(`bars: ${expected.bars} in the file, ${actual.bars} in GarageBand's copy`);
  const audio = (a: BandSummary["audio"][number]) => `${a.file} on track ${a.track} at bar ${a.bar} beat ${a.beat} (${a.seconds} s)`;
  const midi = (m: BandSummary["midi"][number]) => `${m.region}: ${m.notes} notes over ${m.bars} bars`;
  return [...out, ...unmatched("audio", expected.audio.map(audio), actual.audio.map(audio)), ...unmatched("midi", expected.midi.map(midi), actual.midi.map(midi))];
}

function unmatched(label: string, want: string[], got: string[]): string[] {
  const left = [...got];
  const out: string[] = [];
  for (const w of want) {
    const i = left.indexOf(w);
    if (i >= 0) left.splice(i, 1);
    else out.push(`${label} missing in GarageBand's copy: ${w}`);
  }
  return [...out, ...left.map((g) => `${label} only in GarageBand's copy: ${g}`)];
}
