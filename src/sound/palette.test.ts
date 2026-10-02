// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { buildPalette } from "./palette.js";
import { scanPatchLibrary } from "./patches.js";

const lib = (sub: string) => fileURLToPath(new URL(`../../test/fixtures/sound/patches/${sub}`, import.meta.url));
const scanned = scanPatchLibrary([{ dir: lib("factory"), source: "factory" }], { receipts: [] });
if (!scanned.ok) throw new Error(scanned.error);
const patches = scanned.value;

describe("buildPalette", () => {
  it("leads with the style's GM program for the role (loads on MIDI open, no UI) and says if the patch is on disk", () => {
    const [entry] = buildPalette(patches, { style: "orbit-ambient", role: "bass" });
    expect(entry!.style).toBe("orbit-ambient");
    expect(entry!.role).toBe("bass");
    expect(entry!.choices[0]).toEqual({ patch: "Taureg Moon Bass", via: "gm_program", program: 39, channel: "melodic", inLibrary: true, recommended: true });
  });

  it("uses channel-10 kit programs for drums", () => {
    const [entry] = buildPalette(patches, { style: "club-trance", role: "drums" });
    expect(entry!.choices[0]).toMatchObject({ patch: "Epic Electro", via: "gm_program", program: 16, channel: "drums", inLibrary: true });
    expect(entry!.choices.filter((c) => c.via === "gm_program").map((c) => c.patch)).toContain("SoCal");
  });

  it("offers other GM-reachable patches for the role, deduplicated, before UI-only catalog patches", () => {
    const [entry] = buildPalette(patches, { style: "club-trance", role: "lead" });
    const gm = entry!.choices.filter((c) => c.via === "gm_program").map((c) => c.patch);
    expect(gm[0]).toBe("Rising High Synth Lead");
    expect(gm).toContain("Soft Saw Lead");
    expect(new Set(gm).size).toBe(gm.length);
    const firstUi = entry!.choices.findIndex((c) => c.via === "ui_patch");
    expect(firstUi === -1 || firstUi > gm.length - 1).toBe(true);
  });

  it("lists catalog-only patches for a role as ui_patch with their category and content evidence", () => {
    const [entry] = buildPalette(patches, { style: "club-trance", role: "arp" });
    expect(entry!.choices).toContainEqual({ patch: "Pulse Arp", via: "ui_patch", category: "Arpeggiator > Synth Basics", content: "no_receipt_match", recommended: false });
  });

  it("without filters covers every style × role", () => {
    expect(buildPalette(patches, {})).toHaveLength(3 * 7);
  });
});
