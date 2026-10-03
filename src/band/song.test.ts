// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseProjectData, type ProjectData } from "./projectdata.js";
import { projectTempo, songLength, withSongLength } from "./song.js";

const donorProject = (name: string): ProjectData => {
  const r = parseProjectData(new Uint8Array(readFileSync(fileURLToPath(new URL(`../../test/fixtures/band/${name}.band/Alternatives/000/ProjectData`, import.meta.url)))));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

const project = (name: string): ProjectData => {
  const r = parseProjectData(new Uint8Array(readFileSync(fileURLToPath(new URL(`../../test/fixtures/band/${name}.projectdata`, import.meta.url)))));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe("projectTempo", () => {
  it("reads the tempo from the tempo map's first point (BPM x 10000)", () => {
    expect(projectTempo(project("seed-keys-bass"))).toBe(120);
  });
});

describe("songLength", () => {
  it("reads the song length in ticks (Song +0x180 = 38400 + length): 2 bars for a 2-bar MIDI import, 32 for a new project", () => {
    expect(songLength(project("seed-keys-bass"))).toBe(7680);
    expect(songLength(donorProject("donor-five-regions"))).toBe(122880);
  });
});

describe("withSongLength", () => {
  it("sets all three copies (Song +0x180, +0x43C and the song folder's length) and changes nothing else", () => {
    const pd = project("seed-keys-bass");
    const out = withSongLength(pd, 19200);
    expect(songLength(out)).toBe(19200);
    const song = out.records[0]!.payload;
    expect(new DataView(song.buffer, song.byteOffset).getUint32(0x43c, true)).toBe(38400 + 19200);
    const changed = out.records.flatMap((r, i) => (Buffer.from(r.payload).equals(Buffer.from(pd.records[i]!.payload)) ? [] : [i]));
    expect(changed).toEqual([0, 452]);     // the Song record and the song folder (MSeq "Untitled 46", group 0x40000)
    const folder = out.records[452]!.payload;
    expect(new DataView(folder.buffer, folder.byteOffset).getUint32(0x5a, true)).toBe(19200);
  });
});
