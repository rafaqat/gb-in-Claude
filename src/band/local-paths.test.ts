// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { scrubLocalPaths } from "./local-paths.js";

// GarageBand writes the absolute folder of a project's Alchemy samples into ProjectData
// ("DataLoc = /Users/<name>/…/<project>.band/Media/Alchemy Samples"): a donor or a built .band carried the user's name
// and folders (found 2026-10-06 when publishing examples). The value is replaced by a neutral path of the SAME length,
// so every record keeps its size; GarageBand opened such a project and verified it.
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

describe("scrubLocalPaths", () => {
  const before = "Comments = x\nDataLoc = /Users/someone/Documents/projects/donors/song.band/Media/Alchemy Samples\nPrsetLoc = \n";

  it("replaces the local part of DataLoc with a neutral path of the same length, keeping the project's own tail", () => {
    const { bytes, replaced } = scrubLocalPaths(enc(before));
    const after = dec(bytes);
    expect(bytes.length).toBe(enc(before).length);
    expect(replaced).toBe(1);
    expect(after).not.toMatch(/someone|Documents|projects/);
    expect(after).toMatch(/DataLoc = \/Users\/Shared\/gb-mcp-*\/song\.band\/Media\/Alchemy Samples\n/);
    expect(after.startsWith("Comments = x\n")).toBe(true);
    expect(after.endsWith("\nPrsetLoc = \n")).toBe(true);
  });

  it("scrubs every DataLoc, and one with no .band tail entirely", () => {
    const two = "DataLoc = /Users/a/x.band/Media/Alchemy Samples\nDataLoc = /Users/someone/Library/Samples\n";
    const { bytes, replaced } = scrubLocalPaths(enc(two));
    expect(replaced).toBe(2);
    expect(bytes.length).toBe(enc(two).length);
    expect(dec(bytes)).not.toMatch(/someone|\/Users\/a\//);
  });

  it("scrubs an audio file's folder stored as a NUL-terminated field, keeping the project's own tail", () => {
    // seen in donors with audio regions: 12 zero bytes, the folder, then zeros
    const path = "/Users/someone/Documents/projects/donor-av.band/Media/Audio Files";
    const rec = new Uint8Array([...new Uint8Array(12), ...enc(path), 0, 0, 7]);
    const { bytes, replaced } = scrubLocalPaths(rec);
    expect(replaced).toBe(1);
    expect(bytes.length).toBe(rec.length);
    const after = dec(bytes);
    expect(after).not.toMatch(/someone|Documents|projects/);
    expect(after).toMatch(/^\0{12}\/Users\/Shared\/gb-mcp-*\/donor-av\.band\/Media\/Audio Files\0\0\x07$/);
  });

  it("scrubs a whole folder whose user name is not ASCII", () => {
    const line = enc("DataLoc = /Users/José Müller/Music/x.band/Media/Alchemy Samples\nPrsetLoc = \n");
    const { bytes, replaced } = scrubLocalPaths(line);
    expect(replaced).toBe(1);
    expect(bytes.length).toBe(line.length);
    expect(dec(bytes)).not.toMatch(/Jos|ller|Music/);
    expect(new TextDecoder().decode(bytes)).toMatch(/^DataLoc = \/Users\/Shared\/gb-mcp-*\/x\.band\/Media\/Alchemy Samples\nPrsetLoc = \n$/);
  });

  it("leaves bytes without a local DataLoc exactly as they are", () => {
    const plain = enc("DataLoc = \nPrsetLoc = /Library/Application Support/x\n");
    const { bytes, replaced } = scrubLocalPaths(plain);
    expect(replaced).toBe(0);
    expect(bytes).toEqual(plain);
  });
});
