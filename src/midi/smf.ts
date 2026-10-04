// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { z } from "zod";
import { ok, err, type Result } from "../result.js";

const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const SmfNoteSchema = z.object({
  pitch: int(0, 127),
  startTick: int(0, 0x0fffffff),
  durationTicks: int(1, 0x0fffffff),
  velocity: int(1, 127), // 0 would be a note-off
});

export const SmfControllerSchema = z.object({
  tick: int(0, 0x0fffffff),
  controller: int(0, 127),
  value: int(0, 127),
});

/** Pitch bend: −8192..8191 around the centre (0 = no bend); the range in semitones is the patch's (bendRange). */
export const SmfBendSchema = z.object({
  tick: int(0, 0x0fffffff),
  value: z.number().int().min(-8192).max(8191),
});

export const SmfTrackSchema = z.object({
  /** Becomes the GarageBand region name. Printable ASCII only: it is written raw into the file. */
  name: z.string().min(1).max(64).regex(/^[\x20-\x7e]+$/, "printable ASCII only"),
  /** 1..16 as musicians count; 10 = GM drums. */
  channel: int(1, 16),
  /** GM program 0..127; GarageBand maps it to a patch on open. */
  program: int(0, 127).optional(),
  notes: z.array(SmfNoteSchema),
  /** Continuous controllers, e.g. CC1 mod wheel (vibrato), CC11 expression, CC64 sustain. */
  controllers: z.array(SmfControllerSchema).optional(),
  /** Pitch bends (M11): meend slides, vibrato, microtones. GarageBand honours them (probe 2026-10-04). */
  bends: z.array(SmfBendSchema).optional(),
  /** Channel pressure (aftertouch): synth patches turn it into vibrato/brightness; samplers ignore it. */
  pressure: z.array(z.object({ tick: int(0, 0x0fffffff), value: int(0, 127) })).optional(),
  /** Pitch-bend range in semitones, sent as RPN 0 at the start. Only some patches honour it (Flute Solo does). */
  bendRange: int(1, 24).optional(),
});

export const SmfSongSchema = z.object({
  ppq: int(24, 960),
  tempoBpm: z.number().min(20).max(300),
  timeSignature: z.tuple([int(1, 32), z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16), z.literal(32)])]),
  tracks: z.array(SmfTrackSchema).max(254),
  /** Tempo changes after the start (M11): ritardando, accelerando, a new tempo per section. */
  tempoMap: z.array(z.object({ tick: int(0, 0x0fffffff), bpm: z.number().min(20).max(300) })).optional(),
  /** Key signature meta event: sharps (+) or flats (−), and minor. No audio effect; DAWs show it. */
  keySignature: z.object({ accidentals: int(-7, 7), minor: z.boolean() }).optional(),
  /** Marker meta events (section names). Printable ASCII, written raw. */
  markers: z.array(z.object({ tick: int(0, 0x0fffffff), text: z.string().min(1).max(64).regex(/^[\x20-\x7e]+$/) })).optional(),
});

export type SmfNote = z.infer<typeof SmfNoteSchema>;
export type SmfTrack = z.infer<typeof SmfTrackSchema>;
export type SmfController = z.infer<typeof SmfControllerSchema>;
export type SmfBend = z.infer<typeof SmfBendSchema>;
export type SmfSong = z.infer<typeof SmfSongSchema>;
export type SmfError = { code: "INVALID_SMF_INPUT"; message: string };

const END_OF_TRACK = [0x00, 0xff, 0x2f, 0x00];

const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
const chunk = (kind: string, body: number[]): number[] => [...ascii(kind), ...u32(body.length), ...body];

const tempoBytes = (bpm: number) => {
  const us = Math.round(60_000_000 / bpm);
  return [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff];
};

function conductorTrack(song: SmfSong): number[] {
  const [num, den] = song.timeSignature;
  const timed: { tick: number; data: number[] }[] = [
    { tick: 0, data: tempoBytes(song.tempoBpm) },
    { tick: 0, data: [0xff, 0x58, 0x04, num, Math.log2(den), 0x18, 0x08] },
    ...(song.keySignature ? [{ tick: 0, data: [0xff, 0x59, 0x02, song.keySignature.accidentals & 0xff, song.keySignature.minor ? 1 : 0] }] : []),
    ...(song.markers ?? []).map((m) => ({ tick: m.tick, data: [0xff, 0x06, ...vlq(m.text.length), ...ascii(m.text)] })),
    ...(song.tempoMap ?? []).map((t) => ({ tick: t.tick, data: tempoBytes(t.bpm) })),
  ];
  timed.sort((a, b) => a.tick - b.tick); // stable: the start's tempo and meter stay first
  let last = 0;
  const body = timed.flatMap((e) => {
    const delta = vlq(e.tick - last);
    last = e.tick;
    return [...delta, ...e.data];
  });
  return chunk("MTrk", [...body, ...END_OF_TRACK]);
}

/** At equal ticks: setup, note-offs, controllers, note-ons (a repeated pitch re-triggers; CCs land between notes). */
const ORDER = { setup: 0, noteOff: 1, controller: 2, noteOn: 3 } as const;
type TimedEvent = { tick: number; order: number; data: number[] };

function instrumentTrack(track: SmfTrack): number[] {
  const ch = track.channel - 1;
  const name = ascii(track.name);
  const events: TimedEvent[] = [{ tick: 0, order: ORDER.setup, data: [0xff, 0x03, ...vlq(name.length), ...name] }];
  if (track.program !== undefined) events.push({ tick: 0, order: ORDER.setup, data: [0xc0 | ch, track.program] });
  if (track.bendRange !== undefined) {
    for (const [cc, value] of [[101, 0], [100, 0], [6, track.bendRange], [38, 0], [101, 127], [100, 127]] as const) {
      events.push({ tick: 0, order: ORDER.setup, data: [0xb0 | ch, cc, value] });
    }
  }
  for (const n of track.notes) {
    events.push({ tick: n.startTick, order: ORDER.noteOn, data: [0x90 | ch, n.pitch, n.velocity] });
    events.push({ tick: n.startTick + n.durationTicks, order: ORDER.noteOff, data: [0x80 | ch, n.pitch, 0] });
  }
  for (const c of track.controllers ?? []) {
    events.push({ tick: c.tick, order: ORDER.controller, data: [0xb0 | ch, c.controller, c.value] });
  }
  for (const b of track.bends ?? []) {
    const v = b.value + 8192;
    events.push({ tick: b.tick, order: ORDER.controller, data: [0xe0 | ch, v & 0x7f, v >> 7] });
  }
  for (const p of track.pressure ?? []) events.push({ tick: p.tick, order: ORDER.controller, data: [0xd0 | ch, p.value] });
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  let last = 0;
  const body = events.flatMap((e) => {
    const delta = vlq(e.tick - last);
    last = e.tick;
    return [...delta, ...e.data];
  });
  return chunk("MTrk", [...body, ...END_OF_TRACK]);
}

/** Same-pitch notes may touch (off and on at one tick) but never overlap: MIDI would swallow one. */
function findSamePitchOverlap(track: SmfTrack): string | undefined {
  const byPitch = new Map<number, SmfNote[]>();
  for (const n of track.notes) byPitch.set(n.pitch, [...(byPitch.get(n.pitch) ?? []), n]);
  for (const [pitch, notes] of byPitch) {
    const sorted = [...notes].sort((a, b) => a.startTick - b.startTick);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const next = sorted[i]!;
      if (prev.startTick + prev.durationTicks > next.startTick) {
        return `track "${track.name}": overlapping notes on pitch ${pitch} at tick ${next.startTick}`;
      }
    }
  }
  return undefined;
}

/** Render a Type-1 Standard MIDI File: track 0 is the conductor (tempo, time signature). */
export function writeSmf(input: unknown): Result<Uint8Array, SmfError> {
  const parsed = SmfSongSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return err({ code: "INVALID_SMF_INPUT", message: `${issue.path.join(".")}: ${issue.message}` });
  }
  const song = parsed.data;
  for (const track of song.tracks) {
    const overlap = findSamePitchOverlap(track);
    if (overlap) return err({ code: "INVALID_SMF_INPUT", message: overlap });
  }
  const header = chunk("MThd", [...u16(1), ...u16(song.tracks.length + 1), ...u16(song.ppq)]);
  return ok(Uint8Array.from([
    ...header,
    ...conductorTrack(song),
    ...song.tracks.flatMap(instrumentTrack),
  ]));
}

/** Encode a non-negative integer as a MIDI variable-length quantity (7 bits per byte, MSB = continue). */
export function vlq(n: number): number[] {
  const bytes = [n & 0x7f];
  let rest = n >>> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  return bytes;
}
