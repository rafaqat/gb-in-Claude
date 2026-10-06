// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import type { SmfSong } from "../midi/smf.js";

/** One raw MIDI message at an absolute time in seconds. */
export type TimedMidi = { t: number; bytes: number[] };
export type GmEventList = { duration_s: number; events: TimedMidi[] };

const ORDER = { program: 0, off: 1, controller: 2, on: 3 } as const;

/** Tick → seconds through the song's tempo map (M11: ritardando, accelerando, section tempi). */
export function clock(song: SmfSong): (tick: number) => number {
  const changes = [{ tick: 0, bpm: song.tempoBpm }, ...(song.tempoMap ?? [])].sort((a, b) => a.tick - b.tick);
  const starts: number[] = [0];
  for (let i = 1; i < changes.length; i++) {
    starts.push(starts[i - 1]! + ((changes[i]!.tick - changes[i - 1]!.tick) * 60) / (changes[i - 1]!.bpm * song.ppq));
  }
  return (tick) => {
    let i = changes.length - 1;
    while (i > 0 && changes[i]!.tick > tick) i--;
    return starts[i]! + ((tick - changes[i]!.tick) * 60) / (changes[i]!.bpm * song.ppq);
  };
}

/** Flatten an SMF description into a time-sorted MIDI event list for the offline GM renderer. */
export function smfSongToEvents(song: SmfSong): GmEventList {
  const seconds = clock(song);
  const timed: (TimedMidi & { order: number; seq: number })[] = [];
  let seq = 0;
  const push = (tick: number, order: number, bytes: number[]) => timed.push({ t: seconds(tick), order, seq: seq++, bytes });
  for (const track of song.tracks) {
    const ch = track.channel - 1;
    if (track.program !== undefined) push(0, ORDER.program, [0xc0 | ch, track.program]);
    if (track.bendRange !== undefined) {
      for (const [cc, value] of [[101, 0], [100, 0], [6, track.bendRange], [38, 0], [101, 127], [100, 127]] as const) push(0, ORDER.program, [0xb0 | ch, cc, value]);
    }
    for (const n of track.notes) {
      push(n.startTick, ORDER.on, [0x90 | ch, n.pitch, n.velocity]);
      push(n.startTick + n.durationTicks, ORDER.off, [0x80 | ch, n.pitch, 0]);
    }
    for (const c of track.controllers ?? []) push(c.tick, ORDER.controller, [0xb0 | ch, c.controller, c.value]);
    for (const b of track.bends ?? []) push(b.tick, ORDER.controller, [0xe0 | ch, (b.value + 8192) & 0x7f, (b.value + 8192) >> 7]);
    for (const p of track.pressure ?? []) push(p.tick, ORDER.controller, [0xd0 | ch, p.value]);
  }
  timed.sort((a, b) => a.t - b.t || a.order - b.order || a.seq - b.seq);
  return {
    duration_s: timed.length ? timed[timed.length - 1]!.t : 0,
    events: timed.map(({ t, bytes }) => ({ t, bytes })),
  };
}
