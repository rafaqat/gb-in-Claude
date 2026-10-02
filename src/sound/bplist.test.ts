// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseBinaryPlist } from "./bplist.js";

const fixture = (name: string) => readFileSync(new URL(`../../test/fixtures/sound/plists/${name}`, import.meta.url));

describe("parseBinaryPlist", () => {
  it("reads a patch metadata plist: dict of an array of ASCII strings", () => {
    expect(parseBinaryPlist(fixture("metadata.bplist"))).toEqual({ ok: true, value: { PackageNames: ["Hardwell", "Ultimate 808s"] } });
  });

  it("reads ints (1/2/8-byte), reals, booleans, UTF-16 strings and nested containers", () => {
    expect(parseBinaryPlist(fixture("mixed.bplist"))).toEqual({ ok: true, value: {
      name: "Café ♯ Lead", small: 7, big: 40014, negative: -1, ratio: 0.5, on: true, off: false,
      nested: { list: [1, "two"] },
    } });
  });

  it.each([
    ["not a plist", new TextEncoder().encode("hello world, definitely not a bplist trailer padding......")],
    ["truncated", fixture("metadata.bplist").subarray(0, 40)],
    ["empty", new Uint8Array()],
  ])("returns an error (never throws) for %s input", (_label, bytes) => {
    const out = parseBinaryPlist(bytes);
    expect(out.ok).toBe(false);
  });
});
