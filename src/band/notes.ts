// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * A MIDI region's event list (an EvSq payload): 16-byte events (program change, controllers, …) and 32-byte notes,
 * then a 16-byte tail. The marker's high nibble is the MIDI status, the low nibble the channel. Positions are
 * 38400 + ticks from the region start (960 PPQ). Layout checked on GarageBand 10.4.14.
 */

export const NOTE_ORIGIN = 38400;
const TAIL = 16;

export type NoteListEvent =
  | { kind: "note"; channel: number; tick: number; pitch: number; velocity: number; length: number }
  | { kind: "program"; channel: number; tick: number; program: number }
  | { kind: "controller"; channel: number; tick: number; controller: number; value: number }
  | { kind: "bend"; channel: number; tick: number; value: number }
  | { kind: "other"; bytes: Uint8Array };

export function decodeNoteList(p: Uint8Array): NoteListEvent[] {
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const events: NoteListEvent[] = [];
  for (let at = 0; at < p.length - TAIL; ) {
    const marker = p[at]!;
    const status = marker & 0xf0;
    const size = status === 0x90 ? 32 : 16;
    const tick = v.getUint32(at + 4, true) - NOTE_ORIGIN;
    if (status === 0x90) {
      events.push({ kind: "note", channel: marker & 0x0f, tick, pitch: p[at + 0x0c]!, velocity: p[at + 0x0b]!, length: v.getUint32(at + 0x1c, true) });
    } else if (status === 0xc0) {
      events.push({ kind: "program", channel: marker & 0x0f, tick, program: p[at + 0x0b]! });
    } else if (status === 0xb0) {
      events.push({ kind: "controller", channel: marker & 0x0f, tick, controller: p[at + 0x0c]!, value: p[at + 0x0b]! });
    } else if (status === 0xe0) {
      events.push({ kind: "bend", channel: marker & 0x0f, tick, value: ((p[at + 0x0b]! << 7) | p[at + 0x0c]!) - 8192 });
    } else {
      events.push({ kind: "other", bytes: p.slice(at, at + size) });
    }
    at += size;
  }
  return events;
}

export type Note = { channel: number; tick: number; pitch: number; velocity: number; length: number };

/** One 32-byte note event in GarageBand's layout (fine velocity +0x0A left 0; flag +0x0F = 1; +0x17 = 0x89). */
export function encodeNote(n: Note): Uint8Array {
  const e = new Uint8Array(32);
  const v = new DataView(e.buffer);
  e[0] = 0x90 | (n.channel & 0x0f);
  v.setUint32(4, NOTE_ORIGIN + n.tick, true);
  e[0x0b] = n.velocity;
  e[0x0c] = n.pitch;
  e[0x0f] = 0x01;
  e[0x17] = 0x89;
  v.setUint32(0x1c, n.length, true);
  return e;
}

/** Every event list ends with this 16-byte tail. */
const TAIL_BYTES = Uint8Array.of(0xf1, 0, 0, 0, 0xff, 0xff, 0xff, 0x3f, 0, 0, 0, 0, 0, 0, 0, 0);

function encodeProgram(channel: number, program: number): Uint8Array {
  const e = new Uint8Array(16);
  e[0] = 0xc0 | (channel & 0x0f);
  new DataView(e.buffer).setUint32(4, NOTE_ORIGIN, true);
  e[0x0b] = program;
  e[0x0f] = 0x01;
  return e;
}

/**
 * A 16-byte channel event as GarageBand stores it (M11; read from its save of an imported MIDI file): +0x0B holds the
 * MIDI message's second data byte, +0x0C the first; a 127 carries flag 0x20 at +1 and a full-scale fraction at +8.
 */
function channelEvent(status: number, channel: number, tick: number, first: number, second: number): Uint8Array {
  const e = new Uint8Array(16);
  const v = new DataView(e.buffer);
  e[0] = status | (channel & 0x0f);
  v.setUint32(4, NOTE_ORIGIN + tick, true);
  if (second === 127) {
    e[1] = 0x20;
    e[8] = 0xff; e[9] = 0xff; e[10] = 0xff;
  }
  e[0x0b] = second;
  e[0x0c] = first;
  e[0x0f] = 0x01;
  return e;
}

export type ControllerEvent = { tick: number; controller: number; value: number };
export type BendEvent = { tick: number; value: number };

export const encodeController = (c: ControllerEvent & { channel: number }) => channelEvent(0xb0, c.channel, c.tick, c.controller, c.value);
export const encodeBend = (b: BendEvent & { channel: number }) => {
  const v = b.value + 8192;
  return channelEvent(0xe0, b.channel, b.tick, v & 0x7f, v >> 7);
};

/** A region's whole event list: its program change, then notes, controllers and bends in time order, the tail. */
export function encodeNoteList(instrument: { channel: number; program: number }, notes: readonly Note[],
  expression: { controllers?: readonly ControllerEvent[]; bends?: readonly BendEvent[] } = {}): Uint8Array {
  const timed: { tick: number; order: number; pitch: number; bytes: Uint8Array }[] = [
    ...(expression.controllers ?? []).map((c) => ({ tick: c.tick, order: 0, pitch: 0, bytes: encodeController({ ...c, channel: instrument.channel }) })),
    ...(expression.bends ?? []).map((b) => ({ tick: b.tick, order: 0, pitch: 0, bytes: encodeBend({ ...b, channel: instrument.channel }) })),
    ...notes.map((n) => ({ tick: n.tick, order: 1, pitch: n.pitch, bytes: encodeNote(n) })), // at one tick: expression before the note
  ].sort((a, b) => a.tick - b.tick || a.order - b.order || a.pitch - b.pitch);
  const size = timed.reduce((sum, e) => sum + e.bytes.length, 0);
  const out = new Uint8Array(16 + size + TAIL);
  out.set(encodeProgram(instrument.channel, instrument.program), 0);
  let at = 16;
  for (const e of timed) {
    out.set(e.bytes, at);
    at += e.bytes.length;
  }
  out.set(TAIL_BYTES, out.length - TAIL);
  return out;
}
