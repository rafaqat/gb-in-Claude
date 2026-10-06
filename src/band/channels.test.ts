// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseProjectData, type ProjectData } from "./projectdata.js";
import { visibleTracks } from "./tracks.js";
import { audioChannel, withPan } from "./channels.js";

const load = (name: string): ProjectData => {
  const r = parseProjectData(new Uint8Array(readFileSync(join(fileURLToPath(new URL(`../../test/fixtures/band/${name}`, import.meta.url)), "Alternatives", "000", "ProjectData"))));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe("audio channels and pan in ProjectData (M13.18)", () => {
  const pd = load("two-audio-tracks.band");
  const strip = (n: number) => visibleTracks(pd).find((t) => t.number === n)!.strip;

  it("finds each audio track's channel (AuCO) by the name and index its strip carries", () => {
    expect(audioChannel(pd, strip(1))).toMatchObject({ ok: true, value: { name: "Audio 1", pan: 0 } });
    expect(audioChannel(pd, strip(2))).toMatchObject({ ok: true, value: { name: "Audio 2", pan: 0 } });
  });

  it("sets a pan (−64 hard left … +63 hard right) on that channel only", () => {
    const r = withPan(pd, strip(2), 63);
    if (!r.ok) throw new Error(r.error);
    expect(audioChannel(r.value, strip(2))).toMatchObject({ ok: true, value: { pan: 63 } });
    expect(audioChannel(r.value, strip(1))).toMatchObject({ ok: true, value: { pan: 0 } });
    const l = withPan(r.value, strip(1), -64);
    expect(l.ok && audioChannel(l.value, strip(1))).toMatchObject({ ok: true, value: { pan: -64 } });
  });

  it("refuses an instrument track (no audio channel)", () => {
    expect(withPan(pd, strip(3), 10).ok).toBe(false);
  });
});
