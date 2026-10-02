// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAuvalList, scanComponentBundles, filterPlugins } from "./plugins.js";

const fixture = (name: string) => fileURLToPath(new URL(`../../test/fixtures/sound/${name}`, import.meta.url));
const auval = readFileSync(fixture("auval-a.txt"), "utf8");

describe("parseAuvalList", () => {
  const units = parseAuvalList(auval);

  it("parses every registered Audio Unit line and ignores the banner", () => {
    expect(units).toHaveLength(58);
  });

  it("decodes type/subtype/manufacturer codes and the readable name", () => {
    expect(units).toContainEqual({ kind: "instrument", type: "aumu", subtype: "dls", manufacturerCode: "appl", manufacturer: "Apple", name: "DLSMusicDevice" });
    expect(units).toContainEqual({ kind: "effect", type: "aufx", subtype: "dely", manufacturerCode: "appl", manufacturer: "Apple", name: "AUDelay" });
    expect(units).toContainEqual({ kind: "generator", type: "augn", subtype: "afpl", manufacturerCode: "appl", manufacturer: "Apple", name: "AUAudioFilePlayer" });
  });

  it("strips control characters from names (untrusted plug-in metadata)", () => {
    expect(parseAuvalList("aumu evil acme  -  Acme: Bad\u001bName\n")[0]!.name).toBe("BadName");
  });
});

describe("scanComponentBundles", () => {
  it("lists installed .component bundles in the plug-in folders", () => {
    expect(scanComponentBundles([fixture("components"), "/nonexistent/Components"])).toEqual([
      { name: "Vital", path: fixture("components/Vital.component") },
    ]);
  });
});

describe("filterPlugins", () => {
  it("filters by kind and name query", () => {
    const units = parseAuvalList(auval);
    expect(filterPlugins(units, { kind: "instrument" }).map((u) => u.name)).toEqual(["DLSMusicDevice", "AUMIDISynth", "AUSampler"]);
    expect(filterPlugins(units, { query: "delay" }).map((u) => u.name)).toContain("AUDelay");
  });
});
