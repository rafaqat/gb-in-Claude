// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeEach } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGbBand } from "./gb-band.js";
import { bareWav } from "../band/testing.js";

const fixture = (name: string) => fileURLToPath(new URL(`../../test/fixtures/band/${name}`, import.meta.url));
let ws: string;
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "gbmcp-band-ws-")));
  cpSync(fixture("donor-av.band"), join(ws, "donors", "donor-av.band"), { recursive: true });
  mkdirSync(join(ws, "samples"));
  writeFileSync(join(ws, "samples", "vox.wav"), bareWav(44100));
  writeFileSync(join(ws, "samples", "hit.wav"), bareWav(22050));
});

describe("gb_band inspect", () => {
  it("summarises a .band in the workspace — what a donor offers (audio slots, tracks, MIDI regions)", async () => {
    const r = await createGbBand({ workspaceDir: ws })({ command: "inspect", path: "donors/donor-av.band" });
    expect(r).toMatchObject({
      status: "verified", op: "gb_band.inspect",
      data: { tempo: 120, bars: 2, audio: [{ track: 1, bar: 1, file: "smp1.wav" }, { track: 2, bar: 2, file: "smp2.wav" }], midi: [{ region: "Keys" }, { region: "Bass" }] },
    });
  });
});

describe("gb_band build", () => {
  it("writes bands/<filename>: audio placed by bar and beat, MIDI from Song JSON note syntax; reports what it built", async () => {
    const r = await createGbBand({ workspaceDir: ws })({
      command: "build", donor: "donors/donor-av.band", filename: "my song.band",
      audio: [{ wav: "samples/vox.wav", bar: 3, track: 1 }, { wav: "samples/hit.wav", bar: 3, beat: 3, track: 2 }],
      midi: [{ region: "Keys", notes: "d4 f#4 a4 d5 | a4@4", bars: 2 }, { region: "Bass", notes: "d2@4 | a1@4", bars: 2, velocity: 100 }],
    });
    expect(r).toMatchObject({
      status: "verified", op: "gb_band.build",
      data: {
        path: join(ws, "bands", "my song.band"), tempo: 120, bars: 3,
        audio: [{ track: 1, bar: 3, beat: 1, file: "vox.wav", seconds: 1 }, { track: 2, bar: 3, beat: 3, file: "hit.wav", seconds: 0.5 }],
        midi: [{ region: "Keys", notes: 5, bars: 2 }, { region: "Bass", notes: 2, bars: 2 }],
      },
    });
    expect(existsSync(join(ws, "bands", "my song.band", "Media", "Audio Files", "vox.wav"))).toBe(true);
  });

  it("dry_run plans the build (ticks, tracks, note counts) and writes nothing", async () => {
    const r = await createGbBand({ workspaceDir: ws })({
      command: "build", donor: "donors/donor-av.band", filename: "plan.band", dry_run: true,
      audio: [{ wav: "samples/vox.wav", bar: 2, beat: 2.5, track: 1 }],
      midi: [{ region: "Keys", notes: "c4 e4 g4 c5", bars: 1 }],
    });
    expect(r).toMatchObject({
      status: "verified", op: "gb_band.build",
      data: { dry_run: true, path: join(ws, "bands", "plan.band"), audio: [{ tick: 5280, track: 1, wav: join(ws, "samples", "vox.wav") }], midi: [{ region: "Keys", notes: 4 }] },
    });
    expect(existsSync(join(ws, "bands"))).toBe(false);
  });

  it("never overwrites: the same filename again fails with FILE_EXISTS and the first project stays byte-identical", async () => {
    const gbBand = createGbBand({ workspaceDir: ws });
    const build = (wav: string) => gbBand({ command: "build", donor: "donors/donor-av.band", filename: "once.band", audio: [{ wav, bar: 1, track: 1 }] });
    expect(await build("samples/vox.wav")).toMatchObject({ status: "verified" });
    const pd = join(ws, "bands", "once.band", "Alternatives", "000", "ProjectData");
    const before = readFileSync(pd);
    expect(await build("samples/hit.wav")).toMatchObject({ status: "failed", op: "gb_band.build", error: "FILE_EXISTS", write_attempted: false });
    expect(readFileSync(pd).equals(before)).toBe(true);
  });

  it("refuses notes longer than their region (INPUT_INVALID) and writes nothing", async () => {
    const r = await createGbBand({ workspaceDir: ws })({
      command: "build", donor: "donors/donor-av.band", filename: "long.band",
      audio: [{ wav: "samples/vox.wav", bar: 1, track: 1 }], midi: [{ region: "Keys", notes: "c4 | d4 | e4", bars: 2 }],
    });
    expect(r).toMatchObject({ status: "failed", error: "INPUT_INVALID", message: "midi.0: the notes span 3 bars but the region is 2" });
    expect(existsSync(join(ws, "bands"))).toBe(false);
  });

  const base = { command: "build", donor: "donors/donor-av.band", filename: "x.band", audio: [{ wav: "samples/vox.wav", bar: 1, track: 1 }] };
  it.each([
    { why: "note syntax", input: { ...base, midi: [{ region: "Keys", notes: "c4 zz9", bars: 1 }] }, message: /^midi\.0: / },
    { why: "an unknown key", input: { ...base, tempo: 90 }, message: /Unrecognized key/ },
    { why: "a path in filename", input: { ...base, filename: "../x.band" }, message: /^filename: / },
    { why: "beat past the bar", input: { ...base, audio: [{ wav: "samples/vox.wav", bar: 1, beat: 5, track: 1 }] }, message: /^audio\.0\.beat: / },
  ])("refuses $why with INPUT_INVALID and writes nothing", async ({ input, message }) => {
    const r = await createGbBand({ workspaceDir: ws })(input);
    expect(r).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
    expect((r as { message: string }).message).toMatch(message);
    expect(existsSync(join(ws, "bands"))).toBe(false);
  });

  it.each([
    { why: "a donor outside the workspace", input: { ...base, donor: "../../donor-av.band" }, error: "PATH_OUTSIDE_WORKSPACE", message: /^donor: / },
    { why: "a donor that is not a .band", input: { ...base, donor: "samples/vox.wav" }, error: "NOT_SUPPORTED", message: /^donor: / },
    { why: "a missing sample", input: { ...base, audio: [{ wav: "samples/none.wav", bar: 1, track: 1 }] }, error: "FILE_NOT_FOUND", message: /^audio\.0: / },
  ])("refuses $why with its path code", async ({ input, error, message }) => {
    const r = await createGbBand({ workspaceDir: ws })(input);
    expect(r).toMatchObject({ status: "failed", error });
    expect((r as { message: string }).message).toMatch(message);
  });

  it("a missing MIDI region names the donor's regions in context, never in message", async () => {
    const r = await createGbBand({ workspaceDir: ws })({ ...base, midi: [{ region: "Lead", notes: "c4", bars: 1 }] });
    expect(r).toMatchObject({ status: "failed", error: "MIDI_REGION_NOT_IN_DONOR", context: { region: "Lead", donor_regions: ["Keys", "Bass"] } });
    expect((r as { message: string }).message).not.toMatch(/Keys|Bass/);
  });
});

describe("the output folder must stay inside the workspace", () => {
  it("refuses when bands/ is a link to a folder outside the workspace, and writes nothing there", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "gbmcp-outside-")));
    symlinkSync(outside, join(ws, "bands"));
    const r = await createGbBand({ workspaceDir: ws })({
      command: "build", donor: "donors/donor-av.band", filename: "x.band", audio: [{ wav: "samples/vox.wav", bar: 1, track: 1 }],
    });
    expect(r).toMatchObject({ status: "failed", error: "PATH_OUTSIDE_WORKSPACE" });
    expect(readdirSync(outside)).toEqual([]);
  });
});


describe("gb_band build: a write that stops half-way", () => {
  it("says a partial project is left and where, so the agent does not reuse or open it", async () => {
    writeFileSync(join(ws, "donors", "donor-av.band", "Alternatives", "000", "MetaData.plist"), "not a plist");
    const r = await createGbBand({ workspaceDir: ws })({ command: "build", donor: "donors/donor-av.band", filename: "half.band",
      audio: [{ wav: "samples/vox.wav", bar: 1, track: 1 }] });
    expect(r).toMatchObject({ status: "failed", error: "WRITE_FAILED", context: { written: true, path: join(ws, "bands", "half.band") } });
  });
});

describe("gb_band build: a stereo stem on a pair of mono tracks (M13.18)", () => {
  it("pair: the left channel on track, the right on pair, panned hard left and right", async () => {
    cpSync(fixture("two-audio-tracks.band"), join(ws, "donors", "two.band"), { recursive: true });
    const r = await createGbBand({ workspaceDir: ws })({
      command: "build", donor: "donors/two.band", filename: "stereo.band", audio: [{ wav: "samples/vox.wav", bar: 1, track: 1, pair: 2, name: "Vox" }],
    });
    expect(r).toMatchObject({ status: "verified", data: { audio: [{ track: 1, file: "vox-L.wav" }, { track: 2, file: "vox-R.wav" }], pans: [{ track: 1, pan: -64 }, { track: 2, pan: 63 }] } });
  });

  it("pair must be another track", async () => {
    cpSync(fixture("two-audio-tracks.band"), join(ws, "donors", "two.band"), { recursive: true });
    const r = await createGbBand({ workspaceDir: ws })({ command: "build", donor: "donors/two.band", filename: "x.band", audio: [{ wav: "samples/vox.wav", bar: 1, track: 1, pair: 1 }] });
    expect(r).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
  });
});
