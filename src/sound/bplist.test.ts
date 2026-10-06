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

// security review 2026-10-06 (C2): the depth limit does not bound the work — shared references are expanded again for
// every reference. 13 arrays of 4 references to the next one are 121 bytes and 4^13 (67 million) objects: Node ran
// out of memory on gb_sound patches.
function fanOutPlist(levels: number, fan: number): Uint8Array {
  const objects: number[][] = [];
  for (let i = 0; i < levels; i++) objects.push([0xa0 | fan, ...Array(fan).fill(i + 1)]);
  objects.push([0x10, 0x00]); // the leaf: int 0
  const body: number[] = [...new TextEncoder().encode("bplist00")];
  const offsets: number[] = [];
  for (const o of objects) { offsets.push(body.length); body.push(...o); }
  const tableAt = body.length;
  body.push(...offsets);
  const u64 = (n: number) => [0, 0, 0, 0, 0, 0, 0, n];
  body.push(0, 0, 0, 0, 0, 0, 1, 1, ...u64(objects.length), ...u64(0), ...u64(tableAt));
  return Uint8Array.from(body);
}

describe("parseBinaryPlist work limit", () => {
  it("a small plist of shared references cannot expand into millions of objects", () => {
    const out = parseBinaryPlist(fanOutPlist(13, 4));
    expect(out.ok).toBe(false);
  });

  it("an ordinary shared reference still reads (a small fan-out)", () => {
    expect(parseBinaryPlist(fanOutPlist(3, 2))).toEqual({ ok: true, value: [[[0, 0], [0, 0]], [[0, 0], [0, 0]]] });
  });
});

// commit security review: the object budget does not bound decoded BYTES — a large string referenced many
// times was decoded again for every reference (a 1 MB string × 64 references = 64 MB, and the object cap allows 200 000)
function sharedStringPlist(refs: number, chars: number): Uint8Array {
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const head = [...new TextEncoder().encode("bplist00")];
  const arr = [0xaf, 0x10, refs, ...Array(refs).fill(1)]; // an array of `refs` references to object 1
  const str = [0x5f, 0x12, ...u32(chars)]; // object 1: an ASCII string of `chars` characters
  const body = new Uint8Array(head.length + arr.length + str.length + chars + 8 + 32);
  let at = 0;
  const put = (xs: number[]) => { body.set(xs, at); at += xs.length; };
  put(head);
  const o0 = at; put(arr);
  const o1 = at; put(str); body.fill(0x61, at, at + chars); at += chars;
  const table = at; put([...u32(o0), ...u32(o1)]);
  const u64 = (n: number) => [0, 0, 0, 0, ...u32(n)];
  put([0, 0, 0, 0, 0, 0, 4, 1, ...u64(2), ...u64(0), ...u64(table)]);
  return body.subarray(0, at);
}

describe("parseBinaryPlist byte budget", () => {
  it("refuses a large string decoded again for every reference (64 × 1 MB)", () => {
    expect(parseBinaryPlist(sharedStringPlist(64, 1_000_000)).ok).toBe(false);
  });

  it("still reads a shared short string", () => {
    expect(parseBinaryPlist(sharedStringPlist(3, 4))).toEqual({ ok: true, value: ["aaaa", "aaaa", "aaaa"] });
  });
});
