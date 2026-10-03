// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectBand, summarizeProjectData } from "./inspect.js";
import { parseProjectData, serializeProjectData, type ProjectData } from "./projectdata.js";

const band = (name: string) => fileURLToPath(new URL(`../../test/fixtures/band/${name}.band`, import.meta.url));

describe("inspectBand", () => {
  it("summarises a GarageBand project: tempo, length, each audio region (track, bar, beat, file, seconds), each MIDI region", () => {
    expect(inspectBand(band("donor-av"))).toEqual({
      ok: true,
      value: {
        tempo: 120, bars: 2,
        audio: [
          { track: 1, bar: 1, beat: 1, file: "smp1.wav", seconds: 1 },
          { track: 2, bar: 2, beat: 1, file: "smp2.wav", seconds: 1.5 },
        ],
        midi: [{ region: "Keys", notes: 6, bars: 2 }, { region: "Bass", notes: 2, bars: 2 }],
      },
    });
  });
});

describe("inspectBand never throws on a damaged project", () => {
  const donor = (() => {
    const pd = parseProjectData(new Uint8Array(readFileSync(join(band("donor-av"), "Alternatives", "000", "ProjectData"))));
    if (!pd.ok) throw new Error(pd.error.message);
    return pd.value;
  })();
  const asBand = (pd: ProjectData) => {
    const dir = mkdtempSync(join(tmpdir(), "gbmcp-damaged-"));
    mkdirSync(join(dir, "Alternatives", "000"), { recursive: true });
    writeFileSync(join(dir, "Alternatives", "000", "ProjectData"), serializeProjectData(pd));
    return dir;
  };
  const answers = (dir: string) => {
    const r = inspectBand(dir); // must return, not throw
    return typeof r.ok === "boolean";
  };

  it.each([
    { damage: "no records at all", pd: { ...donor, records: [] } },
    { damage: "placements whose file records are gone", pd: { ...donor, records: donor.records.filter((r) => r.tag !== "AuFl") } },
    { damage: "placements whose region records are gone", pd: { ...donor, records: donor.records.filter((r) => r.tag !== "AuRg") } },
  ])("answers with a Result for $damage", ({ pd }) => {
    expect(answers(asBand(pd))).toBe(true);
  });

  it("answers with a Result when any one record's payload is cut to 1 byte", () => {
    for (let i = 0; i < donor.records.length; i++) {
      const records = donor.records.slice();
      records[i] = { ...records[i]!, payload: records[i]!.payload.subarray(0, 1) };
      const r = summarizeProjectData(serializeProjectData({ ...donor, records })); // must return, not throw
      expect(typeof r.ok, `record ${i} (${records[i]!.tag})`).toBe("boolean");
    }
  }, 30_000); // one parse per record of the fixture: heavy by nature, so it gets its own budget
});

