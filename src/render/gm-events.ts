// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import type { SmfSong } from "../midi/smf.js";

/** One raw MIDI message at an absolute time in seconds. */
export type TimedMidi = { t: number; bytes: number[] };
export type GmEventList = { duration_s: number; events: TimedMidi[] };

const ORDER = { program: 0, off: 1, controller: 2, on: 3 } as const;

/** Flatten an SMF description into a time-sorted MIDI event list for the offline GM renderer. */
export function smfSongToEvents(song: SmfSong): GmEventList {
  const secondsPerTick = 60 / (song.tempoBpm * song.ppq);
  const timed: (TimedMidi & { order: number; seq: number })[] = [];
  let seq = 0;
  const push = (tick: number, order: number, bytes: number[]) =>
    timed.push({ t: tick * secondsPerTick, order, seq: seq++, bytes });
  for (const track of song.tracks) {
    const ch = track.channel - 1;
    if (track.program !== undefined) push(0, ORDER.program, [0xc0 | ch, track.program]);
    for (const n of track.notes) {
      push(n.startTick, ORDER.on, [0x90 | ch, n.pitch, n.velocity]);
      push(n.startTick + n.durationTicks, ORDER.off, [0x80 | ch, n.pitch, 0]);
    }
    for (const c of track.controllers ?? []) push(c.tick, ORDER.controller, [0xb0 | ch, c.controller, c.value]);
  }
  timed.sort((a, b) => a.t - b.t || a.order - b.order || a.seq - b.seq);
  return {
    duration_s: timed.length ? timed[timed.length - 1]!.t : 0,
    events: timed.map(({ t, bytes }) => ({ t, bytes })),
  };
}
