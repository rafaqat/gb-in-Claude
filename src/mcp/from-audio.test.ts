// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFromAudio, type FromAudioSteps } from "./from-audio.js";
import { verified, failed, type Envelope } from "./envelope.js";

let ws: string;
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "gbmcp-fa-")));
  mkdirSync(join(ws, "gen"));
  writeFileSync(join(ws, "gen", "song.wav"), "RIFF");
});

const MAP = { map: "analysis/song-map.json", bpm: 86.1, steady: false, key: "D Major", gb_bars: 108,
  place: { guide_bpm: 76.885, bar: 1, beat: 1.2536, offset_s: 0.198 }, tempo_map: [{ bar: 1, bpm: 76.885 }, { bar: 2, bpm: 85.2 }, { bar: 9, bpm: 86.0 }] };

function fakeSteps(failAt?: string) {
  const calls: { tool: string; input: Record<string, unknown> }[] = [];
  const step = (tool: string, reply: (i: Record<string, unknown>) => unknown) => async (input: unknown): Promise<Envelope> => {
    const i = input as Record<string, unknown>;
    calls.push({ tool, input: i });
    if (failAt === `${tool}.${i.command as string}`) return failed(`${tool}.${i.command as string}`, "DIALOG_UNEXPECTED", "a dialog is open");
    return verified(`${tool}.${i.command as string}`, reply(i));
  };
  const steps: FromAudioSteps = {
    analyze: step("gb_analyze", () => MAP),
    song: step("gb_song", (i) => ({ path: join(ws, i.filename as string) })),
    project: step("gb_project", (i) => (i.command === "save_copy"
      ? { tracks: [...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ number: n, kind: "audio", name: `Audio ${n}` })), { number: 9, kind: "instrument", name: "Classic Analog Pad" }] }
      : { document: "x" })),
    tracks: step("gb_tracks", () => ({})),
    transport: step("gb_transport", () => ({ metronome: false })),
    band: step("gb_band", (i) => ({ path: join(ws, "bands", i.filename as string) })),
  };
  return { steps, calls };
}

describe("gb_project from_audio (M13.8): a recording → a GarageBand project in one call", () => {
  it("maps, writes a muted guide that follows the take (tempo map), and places the four stems at the map's beat", async () => {
    const { steps, calls } = fakeSteps();
    const r = await createFromAudio(steps, ws)({ command: "from_audio", path: "gen/song.wav", filename: "song.band" });
    expect(r).toMatchObject({ status: "verified", data: { band: join(ws, "bands", "song.band"), steady: false, tempo_map: true, place: { beat: 1.2536 } } });
    expect(calls.map((c) => `${c.tool}.${c.input.command as string}`)).toEqual([
      "gb_analyze.map", "gb_song.render_midi", "gb_project.open_midi", "gb_tracks.add_audio", "gb_tracks.mute",
      "gb_transport.set_metronome", "gb_project.save_copy", "gb_band.build", "gb_project.open_band",
    ]);
    const song = calls[1]!.input.song as { tempo: number; key: string; tempoMap: unknown[]; tracks: { parts: { song: { chords: string } } }[] };
    expect(song).toMatchObject({ tempo: 76.885, key: "D major", tempoMap: [{ bar: 2, bpm: 85.2 }, { bar: 9, bpm: 86.0 }] });
    expect(song.tracks[0]!.parts.song.chords).toBe("D");
    expect(calls[4]!.input).toMatchObject({ track: "Guide", enabled: true });
    expect(calls[7]!.input).toMatchObject({ donor: "donors/song-donor.band", filename: "song.band" });
    // M13.18: GarageBand's audio tracks are mono here, so each stereo stem takes a hard-panned pair of tracks
    expect(calls[3]!.input).toMatchObject({ command: "add_audio", count: 8 });
    expect((calls[7]!.input.audio as { wav: string; beat: number; track: number; pair: number }[]).map((a) => [a.wav, a.beat, a.track, a.pair])).toEqual([
      ["stems/song-vocals.wav", 1.2536, 1, 2], ["stems/song-drums.wav", 1.2536, 3, 4], ["stems/song-bass.wav", 1.2536, 5, 6], ["stems/song-other.wav", 1.2536, 7, 8],
    ]);
  });

  it("stops at the first step that fails and names it; no later step runs", async () => {
    const { steps, calls } = fakeSteps("gb_project.open_midi");
    const r = await createFromAudio(steps, ws)({ command: "from_audio", path: "gen/song.wav", filename: "song.band" });
    expect(r).toMatchObject({ status: "failed", error: "DIALOG_UNEXPECTED", context: { step: "gb_project.open_midi" } });
    expect(calls.map((c) => c.input.command)).toEqual(["map", "render_midi", "open_midi"]);
  });

  // security review 2026-10-06 (A3): a dot passed the .band name check but not the derived guide .mid name, so the
  // map and the separation ran before the name failed
  it("refuses a name its derived guide and donor files could not use, before any step runs", async () => {
    const { steps, calls } = fakeSteps();
    const r = await createFromAudio(steps, ws)({ command: "from_audio", path: "gen/song.wav", filename: "song.v1.band" });
    expect(r).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
    expect(calls).toHaveLength(0);
  });

  it("never overwrites: a taken guide, donor or band name stops it before the map", async () => {
    const { steps, calls } = fakeSteps();
    mkdirSync(join(ws, "donors"));
    writeFileSync(join(ws, "donors", "song-donor.band"), "x");
    const r = await createFromAudio(steps, ws)({ command: "from_audio", path: "gen/song.wav", filename: "song.band" });
    expect(r).toMatchObject({ status: "failed", error: "FILE_EXISTS" });
    expect(calls).toHaveLength(0);
  });
});
