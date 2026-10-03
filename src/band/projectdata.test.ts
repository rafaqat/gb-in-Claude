// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseProjectData, serializeProjectData } from "./projectdata.js";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../test/fixtures/band/${name}.projectdata`, import.meta.url))));

describe("parseProjectData", () => {
  it("reads GarageBand's root header and walks every record to the end of the file", () => {
    const r = parseProjectData(fixture("one-region-sample-a"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.records).toHaveLength(488);
    expect(r.value.records[0]!.tag).toBe("Song");
  });

  it("refuses bytes that are not ProjectData (no 23 47 C0 AB magic)", () => {
    const bytes = fixture("one-region-sample-a");
    bytes[0] = 0x00;
    const r = parseProjectData(bytes);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("NOT_PROJECTDATA");
  });

  it("refuses a root length that does not match the file size", () => {
    const bytes = fixture("one-region-sample-a");
    new DataView(bytes.buffer).setUint32(0x10, bytes.length, true);
    const r = parseProjectData(bytes);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("BAD_ROOT_LENGTH");
  });

  it("refuses a file whose last record runs past the end", () => {
    const bytes = fixture("one-region-sample-a").slice(0, -10);
    new DataView(bytes.buffer).setUint32(0x10, bytes.length - 24, true);
    const r = parseProjectData(bytes);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("TRUNCATED_RECORD");
  });

  it("refuses a file that ends inside a record header", () => {
    const whole = fixture("one-region-sample-a");
    const bytes = new Uint8Array(whole.length + 5);
    bytes.set(whole);
    new DataView(bytes.buffer).setUint32(0x10, bytes.length - 24, true);
    const r = parseProjectData(bytes);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("TRUNCATED_RECORD");
  });
});

describe("serializeProjectData", () => {
  it("rebuilds a parsed GarageBand file byte-for-byte", () => {
    const bytes = fixture("one-region-zz-bar9");
    const r = parseProjectData(bytes);
    if (!r.ok) throw new Error(r.error.message);
    expect(Buffer.from(serializeProjectData(r.value)).equals(Buffer.from(bytes))).toBe(true);
  });

  it("keeps the payload sizes and root length in step when a record grows", () => {
    const r = parseProjectData(fixture("one-region-zz-bar9"));
    if (!r.ok) throw new Error(r.error.message);
    const i = r.value.records.findIndex((rec) => rec.tag === "AuRg");
    const grown = new Uint8Array(r.value.records[i]!.payload.length + 2);
    grown.set(r.value.records[i]!.payload);
    r.value.records[i] = { ...r.value.records[i]!, payload: grown };
    const again = parseProjectData(serializeProjectData(r.value));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.records).toHaveLength(488);
    expect(again.value.records[i]!.payload.length).toBe(grown.length);
  });
});
