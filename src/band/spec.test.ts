// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { BuildBandInput } from "./spec.js";

const valid = { donor: "/w/donor.band", out: "/w/song.band", regions: [{ wav: "/w/samples/kick.wav", tick: 0, track: 1 }] };

describe("BuildBandInput (contract)", () => {
  it("accepts a donor, an output path and one region", () => {
    expect(BuildBandInput.safeParse(valid).success).toBe(true);
  });

  it.each([
    ["an unknown top-level key (a hallucinated option)", { ...valid, overwrite: true }],
    ["an unknown region key", { ...valid, regions: [{ ...valid.regions[0], gain: 3 }] }],
    ["a negative tick", { ...valid, regions: [{ ...valid.regions[0], tick: -1 }] }],
    ["a fractional tick", { ...valid, regions: [{ ...valid.regions[0], tick: 1.5 }] }],
    ["track 0 (tracks are 1-based)", { ...valid, regions: [{ ...valid.regions[0], track: 0 }] }],
    ["a region name that is not printable ASCII", { ...valid, regions: [{ ...valid.regions[0], name: "kick" + String.fromCodePoint(0x202e) }] }],
    ["a region name longer than the 38-character slot", { ...valid, regions: [{ ...valid.regions[0], name: "x".repeat(39) }] }],
    ["no regions", { ...valid, regions: [] }],
    ["a WAV whose file name could not live in Media/Audio Files", { ...valid, regions: [{ ...valid.regions[0], wav: "/w/samples/bad:name?.wav" }] }],
  ])("refuses %s", (_label, input) => {
    expect(BuildBandInput.safeParse(input).success).toBe(false);
  });
});
