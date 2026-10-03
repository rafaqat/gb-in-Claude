// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseProjectData, serializeProjectData, type ProjectData } from "./projectdata.js";
import { audioPlacements, readAudioFile, readAudioRegion, withPlacementTick, writeAudioFile, writeAudioRegion } from "./audio.js";

const project = (name: string): ProjectData => {
  const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL(`../../test/fixtures/band/${name}.projectdata`, import.meta.url))));
  const r = parseProjectData(bytes);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const payloadOf = (pd: ProjectData, tag: string) => pd.records.find((r) => r.tag === tag)!.payload;

describe("readAudioFile (AuFl)", () => {
  it("reads the file name, format, on-disk size and folder GarageBand stored", () => {
    expect(readAudioFile(payloadOf(project("one-region-sample-a"), "AuFl"))).toEqual({
      ok: true,
      value: { filename: "sample-a.wav", frames: 110250, rate: 44100, channels: 2, bits: 16, fileSize: 441922, folder: "Audio Files" },
    });
  });

  it("refuses a file record without a WAVE descriptor instead of reading garbage", () => {
    const p = payloadOf(project("one-region-sample-a"), "AuFl").slice();
    const at = Buffer.from(p).indexOf("EVAW");
    p.fill(0, at, at + 4);
    const r = readAudioFile(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("NO_WAVE_DESCRIPTOR");
  });
});

describe("writeAudioFile (AuFl)", () => {
  it("writes a new file name (resizing the record) and format, and reads back exactly what it wrote", () => {
    const before = payloadOf(project("one-region-zz-bar9"), "AuFl");
    const file = { filename: "kick_01-long.wav", frames: 48000, rate: 48000, channels: 1, bits: 16, fileSize: 96500, folder: "Audio Files" };
    const after = writeAudioFile(before, file);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.length).toBe(before.length + (16 - 13) * 2);
    expect(readAudioFile(after.value)).toEqual({ ok: true, value: file });
  });

  it("refuses a folder path longer than its slot rather than overwrite the bytes after it", () => {
    const before = payloadOf(project("one-region-zz-bar9"), "AuFl");
    const r = writeAudioFile(before, { filename: "a.wav", frames: 1, rate: 44100, channels: 2, bits: 16, fileSize: 100, folder: "x".repeat(220) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("FOLDER_TOO_LONG");
  });

  it("refuses to write into a file record without a WAVE descriptor", () => {
    const p = payloadOf(project("one-region-zz-bar9"), "AuFl").slice();
    const at = Buffer.from(p).indexOf("EVAW");
    p.fill(0, at, at + 4);
    const r = writeAudioFile(p, { filename: "a.wav", frames: 1, rate: 44100, channels: 2, bits: 16, fileSize: 100, folder: "Audio Files" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("NO_WAVE_DESCRIPTOR");
  });
});

describe("readAudioRegion (AuRg)", () => {
  it("reads the region's display name and its length in frames", () => {
    expect(readAudioRegion(payloadOf(project("one-region-sample-a"), "AuRg"))).toEqual({ name: "sample-a", frames: 110250 });
  });
});

describe("writeAudioRegion (AuRg)", () => {
  it("writes a shorter name (shrinking the record), keeps every byte after the name, and reads back", () => {
    const before = payloadOf(project("one-region-zz-bar9"), "AuRg");
    const after = writeAudioRegion(before, { name: "hit", frames: 12345 });
    // "ZZAUDIOZZ" took 2 + 9 + 1 pad = 12 bytes; "hit" takes 2 + 3 + 1 pad = 6.
    expect(after.length).toBe(before.length - 6);
    expect(Buffer.from(after.subarray(0x4a + 6)).equals(Buffer.from(before.subarray(0x4a + 12)))).toBe(true);
    expect(readAudioRegion(after)).toEqual({ name: "hit", frames: 12345 });
  });
});

describe("audioPlacements", () => {
  it("finds each audio region's placement event: ticks from the song start (960 PPQ) and its 1-based track", () => {
    // bar 3 in 4/4 = 2 bars x 3840 ticks
    expect(audioPlacements(project("one-region-sample-a"))).toEqual([{ record: 451, offset: 0, tick: 7680, track: 1, region: 0 }]);
  });
});

describe("audioPlacements in a project that also has MIDI", () => {
  it("finds the audio placements in the arrange list GarageBand shares with MIDI placements (0x20 events first)", () => {
    expect(audioPlacements(project("donor-av")).map(({ tick, track, region }) => ({ tick, track, region }))).toEqual([
      { tick: 0, track: 1, region: 0 },
      { tick: 3840, track: 2, region: 1 },
    ]);
  });
});

describe("withPlacementTick", () => {
  it("moves a region by changing only the 8 position bytes (flag, id and link stay as GarageBand wrote them)", () => {
    const pd = project("one-region-sample-a");
    const [placement] = audioPlacements(pd);
    const moved = withPlacementTick(pd, placement!, 8 * 3840);
    expect(audioPlacements(moved)).toEqual([{ ...placement!, tick: 8 * 3840 }]);
    const a = serializeProjectData(pd), b = serializeProjectData(moved);
    const changed = [...a].flatMap((byte, i) => (byte === b[i] ? [] : [i]));
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((i) => i >= changed[0]! && i < changed[0]! + 8)).toBe(true);
  });
});
