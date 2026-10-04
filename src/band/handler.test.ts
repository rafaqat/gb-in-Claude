// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeEach } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuildBandHandler } from "./handler.js";
import { parseProjectData, serializeProjectData } from "./projectdata.js";
import { audioPlacements, linkedAudio, readAudioFile, readAudioRegion } from "./audio.js";
import { midiRegions } from "./midi.js";
import { decodeNoteList } from "./notes.js";
import { songLength } from "./song.js";
import { wavInfo } from "./wav.js";
import { bareWav } from "./testing.js";

const donor = fileURLToPath(new URL("../../test/fixtures/band/donor-one-region.band", import.meta.url));
const fiveRegionDonor = fileURLToPath(new URL("../../test/fixtures/band/donor-five-regions.band", import.meta.url));
const avDonor = fileURLToPath(new URL("../../test/fixtures/band/donor-av.band", import.meta.url));
let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gbmcp-band-")));
});

const metaAudioFiles = (band: string) =>
  JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", join(band, "Alternatives", "000", "MetaData.plist")]).toString()).AudioFiles;

describe("BuildBandHandler", () => {
  it("builds a new .band: the WAV (with overview) in Media/Audio Files, the region at its tick, the records and MetaData updated", async () => {
    const wav = join(dir, "kick 01.wav");
    writeFileSync(wav, bareWav(22050));
    const out = join(dir, "song.band");
    const r = await new BuildBandHandler().execute({ donor, out, regions: [{ wav, tick: 7680, track: 1 }] });
    expect(r).toEqual({ ok: true, value: { out, regions: [{ track: 1, tick: 7680, file: "kick 01.wav", frames: 22050 }] } });

    const media = new Uint8Array(readFileSync(join(out, "Media", "Audio Files", "kick 01.wav")));
    expect(wavInfo(media)).toMatchObject({ ok: true, value: { frames: 22050, hasOverview: true } });
    const pd = parseProjectData(new Uint8Array(readFileSync(join(out, "Alternatives", "000", "ProjectData"))));
    if (!pd.ok) throw new Error(pd.error.message);
    expect(audioPlacements(pd.value).map(({ tick, track }) => ({ tick, track }))).toEqual([{ tick: 7680, track: 1 }]);
    const payload = (tag: string) => pd.value.records.find((rec) => rec.tag === tag)!.payload;
    expect(readAudioFile(payload("AuFl"))).toEqual({
      ok: true,
      value: { filename: "kick 01.wav", frames: 22050, rate: 44100, channels: 2, bits: 16, fileSize: media.length, folder: "Audio Files" },
    });
    expect(readAudioRegion(payload("AuRg"))).toEqual({ name: "kick 01", frames: 22050 });
    expect(metaAudioFiles(out)).toEqual(["Audio Files/kick 01.wav"]);
  });

  it("refuses an output that already exists and leaves it untouched", async () => {
    const wav = join(dir, "kick.wav");
    writeFileSync(wav, bareWav(1000));
    const out = join(dir, "existing.band");
    mkdirSync(out);
    writeFileSync(join(out, "mine.txt"), "keep me");
    const r = await new BuildBandHandler().execute({ donor, out, regions: [{ wav, tick: 0, track: 1 }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("OUT_EXISTS");
    expect(readdirSync(out)).toEqual(["mine.txt"]);
  });

  it("refuses a file that is not a WAV before writing anything (no half-built package)", async () => {
    const wav = join(dir, "notes.wav");
    writeFileSync(wav, "not audio");
    const out = join(dir, "song.band");
    const r = await new BuildBandHandler().execute({ donor, out, regions: [{ wav, tick: 0, track: 1 }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("WAV_INVALID");
    expect(existsSync(out)).toBe(false);
  });

  it("refuses more regions than the donor holds (identities come from the donor) and writes nothing", async () => {
    const a = join(dir, "a.wav"), b = join(dir, "b.wav");
    writeFileSync(a, bareWav(1000));
    writeFileSync(b, bareWav(1000));
    const out = join(dir, "song.band");
    const r = await new BuildBandHandler().execute({ donor, out, regions: [{ wav: a, tick: 0, track: 1 }, { wav: b, tick: 3840, track: 1 }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("REGION_COUNT");
    expect(existsSync(out)).toBe(false);
  });

  it("reports a donor without ProjectData as DONOR_INVALID", async () => {
    const wav = join(dir, "kick.wav");
    writeFileSync(wav, bareWav(1000));
    const emptyDonor = join(dir, "empty.band");
    mkdirSync(emptyDonor);
    const r = await new BuildBandHandler().execute({ donor: emptyDonor, out: join(dir, "song.band"), regions: [{ wav, tick: 0, track: 1 }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("DONOR_INVALID");
  });

  it("refuses a region on a track the donor does not have", async () => {
    const wav = join(dir, "kick.wav");
    writeFileSync(wav, bareWav(1000));
    const out = join(dir, "song.band");
    const r = await new BuildBandHandler().execute({ donor, out, regions: [{ wav, tick: 0, track: 2 }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("TRACK_NOT_IN_DONOR");
    expect(existsSync(out)).toBe(false);
  });

  it("places several regions on several tracks, each patching its OWN linked file and region records", async () => {
    const specs = [["a.wav", 1000], ["b.wav", 2000], ["c.wav", 3000], ["d.wav", 4000], ["e.wav", 5000]] as const;
    for (const [name, frames] of specs) writeFileSync(join(dir, name), bareWav(frames));
    const out = join(dir, "five.band");
    const want = [
      { wav: join(dir, "a.wav"), tick: 3840 * 4, track: 2 },
      { wav: join(dir, "b.wav"), tick: 0, track: 1 },
      { wav: join(dir, "c.wav"), tick: 3840 * 2, track: 4 },
      { wav: join(dir, "d.wav"), tick: 3840, track: 3 },
      { wav: join(dir, "e.wav"), tick: 3840 * 8, track: 1 },
    ];
    const r = await new BuildBandHandler().execute({ donor: fiveRegionDonor, out, regions: want });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const pd = parseProjectData(new Uint8Array(readFileSync(join(out, "Alternatives", "000", "ProjectData"))));
    if (!pd.ok) throw new Error(pd.error.message);
    const placements = audioPlacements(pd.value);
    expect(placements.map(({ tick, track }) => ({ tick, track }))).toEqual(want.map(({ tick, track }) => ({ tick, track })));
    // each placement's own region and file records (found through its link) describe the WAV placed there
    const linked = linkedAudio(pd.value);
    want.forEach((w, i) => {
      const file = w.wav.split("/").pop()!;
      const frames = specs.find(([n]) => n === file)![1];
      expect(linked[i]).toEqual({ filename: file, regionName: file.replace(".wav", ""), frames });
    });
    expect(readdirSync(join(out, "Media", "Audio Files")).sort()).toEqual(["a.wav", "b.wav", "c.wav", "d.wav", "e.wav"]);
    expect(metaAudioFiles(out)).toEqual(want.map((w) => `Audio Files/${w.wav.split("/").pop()}`));
  });

  it("trims the donor regions it does not use (their placements and records), keeping region indexes contiguous", async () => {
    writeFileSync(join(dir, "a.wav"), bareWav(1000));
    writeFileSync(join(dir, "b.wav"), bareWav(2000));
    const out = join(dir, "two.band");
    const want = [{ wav: join(dir, "a.wav"), tick: 0, track: 1 }, { wav: join(dir, "b.wav"), tick: 3840, track: 2 }];
    const r = await new BuildBandHandler().execute({ donor: fiveRegionDonor, out, regions: want });
    expect(r.ok).toBe(true);
    const pd = parseProjectData(new Uint8Array(readFileSync(join(out, "Alternatives", "000", "ProjectData"))));
    if (!pd.ok) throw new Error(pd.error.message);
    expect(audioPlacements(pd.value).map(({ tick, track, region }) => ({ tick, track, region }))).toEqual([
      { tick: 0, track: 1, region: 0 }, { tick: 3840, track: 2, region: 1 },
    ]);
    expect(pd.value.records.filter((rec) => rec.tag === "AuFl")).toHaveLength(2);
    expect(pd.value.records.filter((rec) => rec.tag === "AuRg")).toHaveLength(2);
    expect(linkedAudio(pd.value).map((l) => l.filename)).toEqual(["a.wav", "b.wav"]);
  });

  it("gives a WAV used twice a second copy named like GarageBand does (name_1.wav)", async () => {
    writeFileSync(join(dir, "a.wav"), bareWav(1000));
    const out = join(dir, "twice.band");
    const r = await new BuildBandHandler().execute({
      donor: fiveRegionDonor, out,
      regions: [{ wav: join(dir, "a.wav"), tick: 0, track: 1 }, { wav: join(dir, "a.wav"), tick: 3840, track: 1 }],
    });
    expect(r).toMatchObject({ ok: true, value: { regions: [{ file: "a.wav" }, { file: "a_1.wav" }] } });
    expect(readdirSync(join(out, "Media", "Audio Files")).sort()).toEqual(["a.wav", "a_1.wav"]);
    const pd = parseProjectData(new Uint8Array(readFileSync(join(out, "Alternatives", "000", "ProjectData"))));
    if (!pd.ok) throw new Error(pd.error.message);
    expect(linkedAudio(pd.value).map((l) => [l.filename, l.regionName])).toEqual([["a.wav", "a"], ["a_1.wav", "a_1"]]);
  });

  it("builds audio AND MIDI in one project: samples on the audio tracks, new notes in the donor's MIDI regions", async () => {
    writeFileSync(join(dir, "vox.wav"), bareWav(3000));
    writeFileSync(join(dir, "hit.wav"), bareWav(1500));
    const out = join(dir, "av.band");
    const keys = [{ tick: 0, pitch: 62, velocity: 90, length: 960 }, { tick: 3840, pitch: 66, velocity: 90, length: 1920 }];
    const bass = [{ tick: 0, pitch: 38, velocity: 100, length: 7680 }];
    const r = await new BuildBandHandler().execute({
      donor: avDonor, out,
      regions: [{ wav: join(dir, "vox.wav"), tick: 3840 * 2, track: 1 }, { wav: join(dir, "hit.wav"), tick: 3840 * 3, track: 2 }],
      midi: [{ region: "Keys", notes: keys, length: 7680 }, { region: "Bass", notes: bass, length: 7680 }],
    });
    expect(r.ok).toBe(true);
    const pd = parseProjectData(new Uint8Array(readFileSync(join(out, "Alternatives", "000", "ProjectData"))));
    if (!pd.ok) throw new Error(pd.error.message);
    expect(linkedAudio(pd.value).map((l) => l.filename)).toEqual(["vox.wav", "hit.wav"]);
    expect(audioPlacements(pd.value).map(({ tick, track }) => ({ tick, track }))).toEqual([{ tick: 7680, track: 1 }, { tick: 11520, track: 2 }]);
    const regions = midiRegions(pd.value);
    expect(regions.map((m) => ({ name: m.name, length: m.length, notes: m.notes.map(({ channel: _c, ...n }) => n) }))).toEqual([
      { name: "Keys", length: 7680, notes: keys },
      { name: "Bass", length: 7680, notes: bass },
    ]);
  });

  it("M11: a slide on a Flute Solo region writes RPN 12 and pitch bends into the region's event list", async () => {
    writeFileSync(join(dir, "vox.wav"), bareWav(3000));
    const out = join(dir, "meend.band");
    const r = await new BuildBandHandler().execute({
      donor: avDonor, out, regions: [{ wav: join(dir, "vox.wav"), tick: 0, track: 1 }],
      midi: [{ region: "Keys", program: 73, length: 3840, notes: [{ tick: 0, pitch: 74, velocity: 90, length: 1920, slide: [{ at: 0.75, semitones: 2 }] }] }],
    });
    expect(r.ok).toBe(true);
    const pd = parseProjectData(new Uint8Array(readFileSync(join(out, "Alternatives", "000", "ProjectData"))));
    if (!pd.ok) throw new Error(pd.error.message);
    const keys = midiRegions(pd.value).find((m) => m.name === "Keys")!;
    const events = decodeNoteList(pd.value.records[keys.noteRecord]!.payload);
    expect(events.filter((e) => e.kind === "controller").map((e) => e.kind === "controller" && [e.controller, e.value])).toEqual([[101, 0], [100, 0], [6, 12], [38, 0], [101, 127], [100, 127]]);
    const bends = events.flatMap((e) => (e.kind === "bend" ? [e] : []));
    expect(bends.find((b) => b.tick === 1440)?.value).toBe(Math.round((2 / 12) * 8192)); // arrives at ¾ of 1920 ticks
    expect(bends[bends.length - 1]!.value).toBe(0); // reset after the note
  });

  it("M11: refuses a slide wider than the region's instrument can bend (String Ensemble: ±2)", async () => {
    writeFileSync(join(dir, "vox.wav"), bareWav(3000));
    const r = await new BuildBandHandler().execute({
      donor: avDonor, out: join(dir, "wide.band"), regions: [{ wav: join(dir, "vox.wav"), tick: 0, track: 1 }],
      midi: [{ region: "Keys", program: 48, length: 3840, notes: [{ tick: 0, pitch: 60, velocity: 90, length: 1920, slide: [{ at: 0.5, semitones: 4 }] }] }],
    });
    expect(!r.ok && r.error.code).toBe("BEND_RANGE");
  });

  it("refuses MIDI for a region the donor does not have, naming the regions it does have", async () => {
    writeFileSync(join(dir, "vox.wav"), bareWav(3000));
    const out = join(dir, "av.band");
    const r = await new BuildBandHandler().execute({
      donor: avDonor, out, regions: [{ wav: join(dir, "vox.wav"), tick: 0, track: 1 }],
      midi: [{ region: "Strings", notes: [], length: 3840 }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MIDI_REGION_NOT_IN_DONOR");
    // donor region names are text a person typed: detail only, never the message
    expect(r.error.message).not.toContain("Strings");
    expect(r.error.message).not.toContain("Keys");
    expect(r.error.detail).toContain("Keys, Bass");
    expect(existsSync(out)).toBe(false);
  });

  it("extends the song to cover every region (rounded up to the bar) so GarageBand plays and exports it all", async () => {
    writeFileSync(join(dir, "long.wav"), bareWav(132300));                 // 3 s at 44.1 kHz = 6 beats at 120 BPM
    const out = join(dir, "long.band");
    const r = await new BuildBandHandler().execute({ donor: avDonor, out, regions: [{ wav: join(dir, "long.wav"), tick: 11520, track: 1 }] });
    expect(r.ok).toBe(true);
    const pd = parseProjectData(new Uint8Array(readFileSync(join(out, "Alternatives", "000", "ProjectData"))));
    if (!pd.ok) throw new Error(pd.error.message);
    expect(songLength(pd.value)).toBe(19200);                              // 11520 + 5760 = 17280 -> bar 6 starts at 19200
  });
});

describe("a link inside a donor is never copied or written through", () => {
  // `outside` stands for a real project outside the workspace; the hostile donor links into it.
  it.each([
    { entry: join("Alternatives", "000", "ProjectData"), target: "ProjectData", kind: "file" as const },
    { entry: join("Alternatives", "000", "MetaData.plist"), target: "MetaData.plist", kind: "file" as const },
    { entry: "Media", target: "Media", kind: "dir" as const },
  ])("refuses a donor whose $entry is a link, and leaves the link target untouched", async ({ entry, target, kind }) => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    const real = join(outside, target);
    if (kind === "file") cpSync(join(donor, entry), real);
    else mkdirSync(real);
    const evil = join(dir, "evil.band");
    cpSync(donor, evil, { recursive: true, filter: (src) => src !== join(donor, entry) });
    if (kind === "dir" && existsSync(join(evil, entry))) throw new Error("fixture: the copy kept the entry");
    symlinkSync(real, join(evil, entry));
    const before = kind === "file" ? readFileSync(real) : Buffer.from(readdirSync(real).join("/"));
    const wav = join(dir, "kick.wav");
    writeFileSync(wav, bareWav(1000));

    const r = await new BuildBandHandler().execute({ donor: evil, out: join(dir, "song.band"), regions: [{ wav, tick: 0, track: 1 }] });
    expect(r).toMatchObject({ ok: false, error: { code: "DONOR_INVALID" } });
    expect(kind === "file" ? readFileSync(real).equals(before) : readdirSync(real).join("/") === before.toString()).toBe(true);
    expect(existsSync(join(dir, "song.band"))).toBe(false);
  });
});

describe("a donor cannot make the build run away", () => {
  it("refuses a donor with more audio placements than the limit (DONOR_INVALID), before any copying", async () => {
    const pd = parseProjectData(new Uint8Array(readFileSync(join(avDonor, "Alternatives", "000", "ProjectData"))));
    if (!pd.ok) throw new Error(pd.error.message);
    const host = pd.value.records.findIndex((r) => r.tag === "EvSq" && (r.payload[0] === 0x20 || r.payload[0] === 0x24));
    const payload = pd.value.records[host]!.payload;
    let at = 0;
    while (payload[at] !== 0x24) at += 80;
    const event = payload.subarray(at, at + 80);
    const many = new Uint8Array(payload.length + 5000 * 80);
    for (let i = 0; i < 5000; i++) many.set(event, i * 80);
    many.set(payload, 5000 * 80);
    const records = pd.value.records.slice();
    records[host] = { ...records[host]!, payload: many };
    const crowded = join(dir, "crowded.band");
    cpSync(avDonor, crowded, { recursive: true, filter: (src) => !src.endsWith(join("000", "ProjectData")) });
    writeFileSync(join(crowded, "Alternatives", "000", "ProjectData"), serializeProjectData({ ...pd.value, records }));
    writeFileSync(join(dir, "kick.wav"), bareWav(1000));

    const r = await new BuildBandHandler().execute({ donor: crowded, out: join(dir, "song.band"), regions: [{ wav: join(dir, "kick.wav"), tick: 0, track: 1 }] });
    expect(r).toMatchObject({ ok: false, error: { code: "DONOR_INVALID", message: expect.stringMatching(/more than 4096 audio regions/) } });
    expect(existsSync(join(dir, "song.band"))).toBe(false);
  });

  it("refuses a WAV above the per-file limit (WAV_INVALID) and writes nothing", async () => {
    writeFileSync(join(dir, "big.wav"), bareWav(10_000)); // 40 KB of 16-bit stereo
    const out = join(dir, "song.band");
    const r = await new BuildBandHandler({ maxWavBytes: 20_000 }).execute({ donor, out, regions: [{ wav: join(dir, "big.wav"), tick: 0, track: 1 }] });
    expect(r).toMatchObject({ ok: false, error: { code: "WAV_INVALID", message: expect.stringMatching(/larger than 20000 bytes/) } });
    expect(existsSync(out)).toBe(false);
  });

  it("refuses when the samples add up past the total limit — one WAV used for every slot counts each copy", async () => {
    writeFileSync(join(dir, "hit.wav"), bareWav(2_000)); // 8 KB; each slot gets its own copy in the project
    const out = join(dir, "song.band");
    const regions = [0, 3840, 7680, 11520, 15360].map((tick, i) => ({ wav: join(dir, "hit.wav"), tick, track: i < 3 ? 1 : 2 }));
    const r = await new BuildBandHandler({ maxTotalWavBytes: 30_000 }).execute({ donor: fiveRegionDonor, out, regions });
    expect(r).toMatchObject({ ok: false, error: { code: "WAV_INVALID", message: expect.stringMatching(/more than 30000 bytes/) } });
    expect(existsSync(out)).toBe(false);
  });

  it("maps a damaged donor record (a cut Song record) to DONOR_INVALID with a fixed message, and writes nothing", async () => {
    const bad = join(dir, "cut.band");
    cpSync(donor, bad, { recursive: true });
    const dataPath = join(bad, "Alternatives", "000", "ProjectData");
    const pd = parseProjectData(new Uint8Array(readFileSync(dataPath)));
    if (!pd.ok) throw new Error(pd.error.message);
    const records = pd.value.records.slice();
    records[0] = { ...records[0]!, payload: records[0]!.payload.slice(0, 16) };
    writeFileSync(dataPath, serializeProjectData({ ...pd.value, records }));
    const wav = join(dir, "kick.wav");
    writeFileSync(wav, bareWav(1000));
    const out = join(dir, "song.band");
    const r = await new BuildBandHandler().execute({ donor: bad, out, regions: [{ wav, tick: 0, track: 1 }] });
    expect(r).toMatchObject({ ok: false, error: { code: "DONOR_INVALID" } });
    if (!r.ok) expect(r.error.message).not.toContain(dir);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a song end past the 32-bit song length (it would wrap silently) as INPUT_INVALID, nothing written", async () => {
    const wav = join(dir, "slow.wav");
    writeFileSync(wav, bareWav(1_200_000, 1, 1)); // 1.2 M seconds at 1 Hz
    const out = join(dir, "song.band");
    const r = await new BuildBandHandler().execute({ donor, out, regions: [{ wav, tick: 2_000_000_000, track: 1 }] });
    expect(r).toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
    expect(existsSync(out)).toBe(false);
  });

  it("writes ProjectData last: when MetaData cannot be updated, the partial project has no ProjectData and says written", async () => {
    const bad = join(dir, "badmeta.band");
    cpSync(donor, bad, { recursive: true });
    writeFileSync(join(bad, "Alternatives", "000", "MetaData.plist"), "not a plist");
    const wav = join(dir, "kick.wav");
    writeFileSync(wav, bareWav(1000));
    const out = join(dir, "song.band");
    const r = await new BuildBandHandler().execute({ donor: bad, out, regions: [{ wav, tick: 0, track: 1 }] });
    expect(r).toMatchObject({ ok: false, error: { code: "WRITE_FAILED", written: true } });
    expect(existsSync(join(out, "Alternatives", "000", "ProjectData"))).toBe(false);
  });

  it("reports an output folder that cannot be made (missing parent) as WRITE_FAILED, not OUT_EXISTS", async () => {
    const wav = join(dir, "kick.wav");
    writeFileSync(wav, bareWav(1000));
    const r = await new BuildBandHandler().execute({ donor, out: join(dir, "missing", "song.band"), regions: [{ wav, tick: 0, track: 1 }] });
    expect(r).toMatchObject({ ok: false, error: { code: "WRITE_FAILED" } });
    if (!r.ok) expect(r.error.written).toBeFalsy();
  });

  it("refuses two midi items for the same region (the last would silently win) as INPUT_INVALID", async () => {
    writeFileSync(join(dir, "vox.wav"), bareWav(3000));
    const out = join(dir, "dup.band");
    const r = await new BuildBandHandler().execute({
      donor: avDonor, out, regions: [{ wav: join(dir, "vox.wav"), tick: 0, track: 1 }],
      midi: [{ region: "Keys", notes: [], length: 3840 }, { region: "Keys", notes: [], length: 3840 }],
    });
    expect(r).toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a donor whose audio slots link the same region records (one would overwrite the other) as DONOR_INVALID", async () => {
    const bad = join(dir, "shared.band");
    cpSync(fiveRegionDonor, bad, { recursive: true });
    const dataPath = join(bad, "Alternatives", "000", "ProjectData");
    const pd = parseProjectData(new Uint8Array(readFileSync(dataPath)));
    if (!pd.ok) throw new Error(pd.error.message);
    const [first, second] = audioPlacements(pd.value).sort((a, b) => a.region - b.region);
    const records = pd.value.records.slice();
    const payload = records[second!.record]!.payload.slice();
    new DataView(payload.buffer).setUint32(second!.offset + 0x2c, first!.region * 4, true); // the link (LINK_AT)
    records[second!.record] = { ...records[second!.record]!, payload };
    writeFileSync(dataPath, serializeProjectData({ ...pd.value, records }));
    const a = join(dir, "a.wav"), b = join(dir, "b.wav");
    writeFileSync(a, bareWav(1000));
    writeFileSync(b, bareWav(1000));
    const out = join(dir, "song.band");
    const r = await new BuildBandHandler().execute({ donor: bad, out, regions: [{ wav: a, tick: 0, track: 1 }, { wav: b, tick: 3840, track: 1 }] });
    expect(r).toMatchObject({ ok: false, error: { code: "DONOR_INVALID" } });
    expect(existsSync(out)).toBe(false);
  });

  it("refuses two named MIDI regions that share one note list (one would overwrite the other) as DONOR_INVALID", async () => {
    const bad = join(dir, "shared-notes.band");
    cpSync(avDonor, bad, { recursive: true });
    const dataPath = join(bad, "Alternatives", "000", "ProjectData");
    const pd = parseProjectData(new Uint8Array(readFileSync(dataPath)));
    if (!pd.ok) throw new Error(pd.error.message);
    const [keys, bass] = ["Keys", "Bass"].map((n) => midiRegions(pd.value).find((m) => m.name === n)!);
    const records = pd.value.records.slice();
    const header = records[bass!.record]!.header.slice();
    new DataView(header.buffer, header.byteOffset).setUint32(8, keys!.group, true); // Bass now finds Keys' note list
    records[bass!.record] = { ...records[bass!.record]!, header };
    writeFileSync(dataPath, serializeProjectData({ ...pd.value, records }));
    writeFileSync(join(dir, "vox.wav"), bareWav(3000));
    const out = join(dir, "av.band");
    const r = await new BuildBandHandler().execute({
      donor: bad, out, regions: [{ wav: join(dir, "vox.wav"), tick: 0, track: 1 }],
      midi: [{ region: "Keys", notes: [], length: 3840 }, { region: "Bass", notes: [], length: 3840 }],
    });
    expect(r).toMatchObject({ ok: false, error: { code: "DONOR_INVALID" } });
    expect(existsSync(out)).toBe(false);
  });

  it("checks its own input at run time: a NaN note tick is INPUT_INVALID, nothing written", async () => {
    writeFileSync(join(dir, "vox.wav"), bareWav(3000));
    const out = join(dir, "av.band");
    const r = await new BuildBandHandler().execute({
      donor: avDonor, out, regions: [{ wav: join(dir, "vox.wav"), tick: 0, track: 1 }],
      midi: [{ region: "Keys", notes: [{ tick: Number.NaN, pitch: 60, velocity: 90, length: 480 }], length: 3840 }],
    });
    expect(r).toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
    expect(existsSync(out)).toBe(false);
  });
});

