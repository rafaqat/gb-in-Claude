// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * gb_project from_audio (M13.8): a recording → a GarageBand project in one call. It chains steps that each verify
 * themselves — gb_analyze map, a muted guide Song JSON at the map's tempo (with its tempo map when the take drifts),
 * gb_song render_midi, gb_project open_midi, gb_tracks add_audio + mute, gb_transport metronome off, gb_project
 * save_copy, gb_band build (the four stems at the map's bar and beat, each on a hard-panned pair of mono tracks),
 * gb_project open_band — and stops at the first step that is not verified, naming it. Every output name is checked
 * before anything runs: nothing is overwritten.
 */
import { z } from "zod";
import { lstatSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { verified, failed, type Envelope } from "./envelope.js";
import { keyAndChord } from "../song/draft.js";

export type Step = (input: unknown) => Promise<Envelope>;
export type FromAudioSteps = { analyze: Step; song: Step; project: Step; tracks: Step; transport: Step; band: Step };

export const FromAudioInput = z.object({
  command: z.literal("from_audio"),
  path: z.string().min(1),
  filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,70}\.band$/, "a .band file name such as song-v1.band (no folders)"),
  dry_run: z.boolean().optional(),
}).strict();

const STEMS = [["vocals", "Vocals"], ["drums", "Drums"], ["bass", "Bass"], ["other", "Instruments"]] as const;
const AUDIO_TRACKS = STEMS.length * 2; // M13.18: audio tracks are mono here — each stereo stem takes a hard-panned pair
const GUIDE = "Guide";

type MapSummary = {
  map: string; steady: boolean; key: string | null; gb_bars: number;
  place: { guide_bpm: number; bar: number; beat: number }; tempo_map: { bar: number; bpm: number }[] | null;
};

const taken = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

export function createFromAudio(steps: FromAudioSteps, workspaceDir: string) {
  return async function fromAudio(input: unknown): Promise<Envelope> {
    const op = "gb_project.from_audio";
    const parsed = FromAudioInput.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return failed(op, "INPUT_INVALID", `${issue.path.join(".") || "command"}: ${issue.message}`);
    }
    const { path, filename } = parsed.data;
    const slug = filename.slice(0, -".band".length);
    const base = basename(path, extname(path));
    const guide = `${slug}-guide.mid`, donor = `${slug}-donor.band`;
    for (const rel of [guide, join("donors", donor), join("bands", filename)]) {
      if (taken(join(workspaceDir, rel))) return failed(op, "FILE_EXISTS", `${rel} already exists; nothing done`, { hint: "choose a new filename (e.g. add -v2)" });
    }
    const plan = ["gb_analyze map", `gb_song render_midi ${guide} (muted guide at the map's tempo)`, "gb_project open_midi",
      `gb_tracks add_audio {count: ${AUDIO_TRACKS}} + mute the guide`, "gb_transport set_metronome off", `gb_project save_copy ${donor}`,
      `gb_band build ${filename} (the 4 stems at the map's bar and beat, each on a left and right track)`, "gb_project open_band"];
    if (parsed.data.dry_run) return verified(op, { dry_run: true, plan });

    const done: string[] = [];
    const run = async (step: Step, call: Record<string, unknown>, name: string) => {
      const r = await step(call);
      if (r.status !== "verified") return { ok: false as const, envelope: stopped(r, name) };
      done.push(name);
      return { ok: true as const, data: r.data as Record<string, unknown> };
    };
    const stopped = (r: Exclude<Envelope, { status: "verified" }>, name: string): Envelope => r.status === "failed"
      ? failed(op, r.error, `${name}: ${r.message}`, { write_attempted: done.length > 1, safe_to_retry: false, context: { step: name, done }, ...(r.hint ? { hint: r.hint } : {}) })
      : { ...r, op, hint: `${name} was not confirmed (${r.hint}); steps done: ${done.join(", ")}` };

    const mapped = await run(steps.analyze, { command: "map", path, melody: false }, "gb_analyze.map");
    if (!mapped.ok) return mapped.envelope;
    const map = mapped.data as unknown as MapSummary;
    const { key, chord } = keyAndChord(map.key);
    const tm = map.tempo_map;
    const song = {
      title: `${slug} (guide)`, tempo: tm ? tm[0]!.bpm : map.place.guide_bpm, ...(key ? { key } : {}), humanize: "natural",
      ...(tm && tm.length > 1 ? { tempoMap: tm.slice(1) } : {}),
      sections: [{ name: "song", bars: map.gb_bars + 2 }],
      tracks: [{ name: GUIDE, role: "pad", program: 89, level: -24, parts: { song: { chords: chord, style: "sustain" } } }],
    };
    const chain: [Step, Record<string, unknown>, string][] = [
      [steps.song, { command: "render_midi", filename: guide, song }, "gb_song.render_midi"],
      [steps.project, { command: "open_midi", path: guide }, "gb_project.open_midi"],
      [steps.tracks, { command: "add_audio", count: AUDIO_TRACKS }, "gb_tracks.add_audio"],
      [steps.tracks, { command: "mute", track: GUIDE, enabled: true }, "gb_tracks.mute"],
      [steps.transport, { command: "set_metronome", enabled: false }, "gb_transport.set_metronome"],
    ];
    for (const [step, call, name] of chain) {
      const r = await run(step, call, name);
      if (!r.ok) return r.envelope;
    }
    const saved = await run(steps.project, { command: "save_copy", filename: donor }, "gb_project.save_copy");
    if (!saved.ok) return saved.envelope;
    const audioTracks = ((saved.data.tracks ?? []) as { number: number; kind: string }[]).filter((t) => t.kind === "audio").map((t) => t.number);
    if (audioTracks.length < AUDIO_TRACKS) return failed(op, "READBACK_MISMATCH", `the donor has ${audioTracks.length} audio tracks, ${AUDIO_TRACKS} needed`, { context: { step: "gb_project.save_copy", done } });
    const audio = STEMS.map(([stem, name], i) => ({
      wav: `stems/${base}-${stem}.wav`, bar: map.place.bar, beat: map.place.beat, track: audioTracks[2 * i]!, pair: audioTracks[2 * i + 1]!, name,
    }));
    const built = await run(steps.band, { command: "build", donor: `donors/${donor}`, filename, audio }, "gb_band.build");
    if (!built.ok) return built.envelope;
    const opened = await run(steps.project, { command: "open_band", path: `bands/${filename}` }, "gb_project.open_band");
    if (!opened.ok) return opened.envelope;
    return verified(op, {
      band: join(workspaceDir, "bands", filename), map: map.map, guide, donor, steady: map.steady, tempo_map: tm !== null && tm !== undefined,
      place: map.place, key: key ?? null, tracks: opened.data.tracks ?? null, steps: done,
    });
  };
}
