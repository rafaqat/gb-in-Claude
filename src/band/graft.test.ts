// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseProjectData, serializeProjectData, type ProjectData } from "./projectdata.js";
import { audioPlacements, groupOf } from "./audio.js";
import { visibleTracks } from "./tracks.js";
import { graftAudioSlots } from "./graft.js";

const load = (band: string) => {
  const pd = parseProjectData(new Uint8Array(readFileSync(fileURLToPath(new URL(`../../test/fixtures/band/${band}/Alternatives/000/ProjectData`, import.meta.url)))));
  if (!pd.ok) throw new Error(pd.error.message);
  return pd.value;
};
const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, true);
const evaw = (p: Uint8Array) => p.findIndex((_, i) => p[i] === 0x45 && p[i + 1] === 0x56 && p[i + 2] === 0x41 && p[i + 3] === 0x57);
const chain = (pd: ProjectData) => pd.records.filter((r) => r.tag === "AuFl").map((r) => [r.payload[evaw(r.payload) + 0x38], u32(r.payload, evaw(r.payload) + 0x3e)]);
const tagCount = (pd: ProjectData, tag: string) => pd.records.filter((r) => r.tag === tag).length;
const placementsList = (pd: ProjectData) => pd.records.find((r) => r.tag === "EvSq" && groupOf(r.header) === 0x40000 && r.payload[0] === 0x20)!.payload;

describe("graftAudioSlots (M11b): new audio-region slots on a project's audio tracks", () => {
  it("one slot on the empty Audio 1 track of a MIDI import: records, placement with the track's strip, chain, flag", () => {
    const r = graftAudioSlots(load("midi-plus-empty-audio.band"), [1]);
    if (!r.ok) throw new Error(r.error.message);
    const pd = r.value;
    expect([tagCount(pd, "AuFl"), tagCount(pd, "AuRg"), tagCount(pd, "GenM")]).toEqual([1, 1, 2]);
    expect(chain(pd)).toEqual([[1, 0xffffffff]]);
    const list = placementsList(pd);
    const ev = list.subarray(list.length - 16 - 80, list.length - 16);
    expect([ev[0], u32(ev, 0x10), ev[0x14], u32(ev, 0x2c)]).toEqual([0x24, 0xa8, 1, 0]);
    const genm = pd.records.find((x) => x.tag === "GenM" && groupOf(x.header) === 0x40000)!;
    expect(genm.payload[0x0c]).toBe(0);
    const audio1 = pd.records.find((x) => x.tag === "Trak" && groupOf(x.header) === 0x40000 && x.payload.length >= 12 && u32(x.payload, 8) === 0xa8)!;
    expect(u32(audio1.payload, 0)).toBe(0x00140001); // the "holds regions" flag GarageBand writes on save
    expect(audioPlacements(pd)).toHaveLength(1);
  });

  it("three more slots on donor-av (two regions already): numbered on, the file chain relinked, distinct identities", () => {
    const r = graftAudioSlots(load("donor-av.band"), [1, 2, 2]);
    if (!r.ok) throw new Error(r.error.message);
    const pd = r.value;
    expect(chain(pd)).toEqual([[1, 4], [2, 8], [3, 0xc], [4, 0x10], [5, 0xffffffff]]);
    expect(pd.records.filter((x) => x.tag === "AuFl").map((x) => groupOf(x.header))).toEqual([0, 0x40000, 0x80000, 0xc0000, 0x100000]);
    expect(pd.records.filter((x) => x.tag === "GenM" && groupOf(x.header) !== 0).map((x) => x.payload[0x0c])).toEqual([0, 4, 8, 12, 16]);
    const ids = pd.records.filter((x) => x.tag === "AuRg").map((x) => Buffer.from(x.payload.subarray(0x2a, 0x2e)).toString("hex"));
    expect(new Set(ids).size).toBe(5);
    const strips = audioPlacements(pd).map((p) => [p.track]);
    expect(strips).toHaveLength(5);
    const back = parseProjectData(serializeProjectData(pd));
    expect(back.ok && back.value.records.length).toBe(pd.records.length);
  });

  it("refuses an instrument track and a track the project does not have, naming what it has", () => {
    const pd = load("midi-plus-empty-audio.band");
    expect(visibleTracks(pd).map((t) => t.kind)).toEqual(["audio", "instrument"]);
    const instrument = graftAudioSlots(pd, [2]);
    expect(!instrument.ok && instrument.error.code).toBe("NOT_AN_AUDIO_TRACK");
    const missing = graftAudioSlots(pd, [9]);
    expect(!missing.ok && missing.error.message).toContain("1 (Audio 1)");
  });
});

describe("AUDIO_SLOT_TEMPLATE", () => {
  it("still equals region 0 of the GarageBand-saved donor-av fixture (regenerate it if the fixture changes)", async () => {
    const { AUDIO_SLOT_TEMPLATE } = await import("./audio-slot-template.js");
    const pd = load("donor-av.band");
    const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
    const rec = (tag: string, g: number) => pd.records.find((r) => r.tag === tag && groupOf(r.header) === g)!;
    expect(AUDIO_SLOT_TEMPLATE.file.payload).toBe(hex(rec("AuFl", 0).payload));
    expect(AUDIO_SLOT_TEMPLATE.region.payload).toBe(hex(rec("AuRg", 0).payload));
    expect(AUDIO_SLOT_TEMPLATE.meta.payload).toBe(hex(rec("GenM", 0x40000).payload));
  });
});
