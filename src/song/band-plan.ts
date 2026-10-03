// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * Song JSON audio clips → the `audio` list of gb_band build (M7). Song JSON places a clip relative to its section,
 * so a clip moves with its section when an earlier section changes length; gb_band wants absolute bars.
 */
import { err, ok, type Result } from "../result.js";
import type { Song } from "./schema.js";
import { BAND_AUDIO_LIMITS } from "../band/spec.js";

export type BandAudio = { wav: string; bar: number; beat: number; track: number };
export type BandPlanError = { code: "NOT_SUPPORTED" | "NO_AUDIO"; message: string };

export function bandPlan(song: Song): Result<{ audio: BandAudio[] }, BandPlanError> {
  if (song.timeSignature[0] !== 4) return err({ code: "NOT_SUPPORTED", message: "gb_band donors are 4/4; this song is not" });
  const startBar = new Map<string, number>();
  song.sections.reduce((bar, s) => (startBar.set(s.name, bar), bar + s.bars), 1);
  const audio = song.tracks.flatMap((t) => (t.audio ?? []).map((c) => ({
    wav: c.wav, bar: startBar.get(c.section)! + c.bar - 1, beat: c.beat, track: t.donorTrack!,
  })));
  if (audio.length === 0) return err({ code: "NO_AUDIO", message: "the song has no audio clips" });
  // a plan gb_band build would refuse is no plan: check its limits here
  const { maxItems, maxBar, maxBeat } = BAND_AUDIO_LIMITS;
  if (audio.length > maxItems) return err({ code: "NOT_SUPPORTED", message: `${audio.length} audio clips; gb_band builds at most ${maxItems}` });
  if (audio.some((a) => a.bar > maxBar)) return err({ code: "NOT_SUPPORTED", message: `a clip starts after bar ${maxBar}, the last bar gb_band places` });
  if (audio.some((a) => a.beat > maxBeat)) return err({ code: "NOT_SUPPORTED", message: `a clip starts after beat ${maxBeat} of its bar` });
  return ok({ audio: audio.sort((a, b) => a.bar - b.bar || a.beat - b.beat || a.track - b.track) });
}
