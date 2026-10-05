// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseProjectData } from "./projectdata.js";
import { visibleTracks } from "./tracks.js";

const load = (band: string) => {
  const pd = parseProjectData(new Uint8Array(readFileSync(fileURLToPath(new URL(`../../test/fixtures/band/${band}/Alternatives/000/ProjectData`, import.meta.url)))));
  if (!pd.ok) throw new Error(pd.error.message);
  return pd.value;
};

describe("visibleTracks (M11b; GarageBand-saved projects)", () => {
  it("donor-av: two audio tracks, then two instrument tracks — numbers, channel-strip ids, kinds and names", () => {
    expect(visibleTracks(load("donor-av.band")).map(({ number, strip, kind }) => ({ number, strip, kind }))).toEqual([
      { number: 1, strip: 0xac, kind: "audio" }, { number: 2, strip: 0xb8, kind: "audio" },
      { number: 3, strip: 0xa4, kind: "instrument" }, { number: 4, strip: 0xa8, kind: "instrument" },
    ]);
  });
  it("a MIDI import plus an empty audio track made with Track ▸ New Tracks…: Audio 1 is track 1", () => {
    expect(visibleTracks(load("midi-plus-empty-audio.band"))).toEqual([
      { number: 1, strip: 0xa8, kind: "audio", name: "Audio 1" },
      { number: 2, strip: 0xa4, kind: "instrument", name: "Steinway Grand Piano" },
    ]);
  });
});
