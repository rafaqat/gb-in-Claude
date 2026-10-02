// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { humanize, type RoleTrack } from "./humanize.js";
import { renderSong, PPQ } from "./render.js";
import { parseSong } from "./schema.js";
import { writeSmf } from "../midi/smf.js";

const TEMPO = 132;
const msToTicks = (ms: number) => (ms * PPQ * TEMPO) / 60000;

/** A rendered 8-bar song with every role, as humanize input. */
function fixture(): RoleTrack[] {
  const parsed = parseSong({
    title: "Fixture", tempo: TEMPO, humanize: "off",
    sections: [{ name: "a", bars: 8 }],
    tracks: [
      { name: "Drums", role: "drums", parts: { a: { grid: { kick: "x...x...x...x...", hat: "..x...x...x...x.", clap: "....x.......x..." } } } },
      { name: "Bass", role: "bass", parts: { a: { chords: "Fm | Db", style: "offbeat" } } },
      { name: "Pad", role: "pad", parts: { a: { chords: "Fm | Db", style: "sustain" } } },
      { name: "Arp", role: "arp", parts: { a: { chords: "Fm | Db", style: "up" } } },
      { name: "Lead", role: "lead", parts: { a: { notes: "f5@2 ab5 c6 | eb6@3 c6" } } },
    ],
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  const rendered = renderSong(parsed.value);
  if (!rendered.ok) throw new Error(rendered.error.message);
  return rendered.value.tracks.map((t, i) => ({ ...t, role: parsed.value.tracks[i]!.role }));
}

const opts = { feel: "natural" as const, seed: 7, tempoBpm: TEMPO, ppq: PPQ };

describe("humanize: musical feel (approved by ear as v3)", () => {
  const before = fixture();
  const after = humanize(before, opts);
  const track = (ts: RoleTrack[], name: string) => ts.find((t) => t.name === name)!;
  const shiftsMs = (name: string, pitch?: number) => {
    const b = track(before, name).notes.filter((n) => pitch === undefined || n.pitch === pitch);
    const a = track(after, name).notes.filter((n) => pitch === undefined || n.pitch === pitch);
    const sa = [...a].sort((x, y) => x.startTick - y.startTick || x.pitch - y.pitch);
    return [...b].sort((x, y) => x.startTick - y.startTick || x.pitch - y.pitch)
      .map((n, k) => (sa[k]!.startTick - n.startTick) / msToTicks(1));
  };

  it("keeps the kick anchored (every kick within 3 ms)", () => {
    for (const s of shiftsMs("Drums", 36)) expect(Math.abs(s)).toBeLessThanOrEqual(3);
  });

  it("sits the bass laid back on average (late, not early)", () => {
    const s = shiftsMs("Bass");
    expect(s.reduce((a, b) => a + b, 0) / s.length).toBeGreaterThan(2);
  });

  it("moves most melodic notes off the rigid grid", () => {
    const offGrid = track(after, "Arp").notes.filter((n) => n.startTick % (PPQ / 4) !== 0).length;
    expect(offGrid / track(after, "Arp").notes.length).toBeGreaterThan(0.5);
  });

  it("widens the velocity range (more dynamic than the rendered input)", () => {
    const distinct = (ts: RoleTrack[]) => new Set(track(ts, "Arp").notes.map((n) => n.velocity)).size;
    expect(distinct(after)).toBeGreaterThan(distinct(before) * 3);
  });
});

describe("humanize: lead expression (legato glide + delayed vibrato)", () => {
  const lead = humanize(fixture(), opts).find((t) => t.name === "Lead")!;
  const notes = [...lead.notes].sort((a, b) => a.startTick - b.startTick);

  it("overlaps consecutive different-pitch lead notes slightly (synth glide)", () => {
    const pairs = notes.slice(1).map((b, i) => [notes[i]!, b] as const).filter(([a, b]) => a.pitch !== b.pitch);
    const overlapping = pairs.filter(([a, b]) => a.startTick + a.durationTicks > b.startTick);
    expect(overlapping.length / pairs.length).toBeGreaterThan(0.8);
    for (const [a, b] of overlapping) expect(a.startTick + a.durationTicks - b.startTick).toBeLessThanOrEqual(msToTicks(20));
  });

  it("adds CC1 vibrato on notes of a beat or longer: starts at 0, rises after the first third, resets at note end", () => {
    const cc = lead.controllers ?? [];
    expect(cc.length).toBeGreaterThan(0);
    expect(cc.every((c) => c.controller === 1 && c.value <= 64)).toBe(true);
    const long = notes.find((n) => n.durationTicks >= PPQ)!;
    const inNote = cc.filter((c) => c.tick >= long.startTick && c.tick <= long.startTick + long.durationTicks);
    expect(inNote[0]!.tick).toBeGreaterThanOrEqual(long.startTick + long.durationTicks / 3 - 1);
    expect(inNote.at(-1)!.value).toBe(0);
  });

  it("does not add vibrato or glide to non-lead roles", () => {
    const after = humanize(fixture(), opts);
    for (const t of after.filter((t) => t.role !== "lead" && t.role !== "lead-high")) expect(t.controllers ?? []).toEqual([]);
  });
});

describe("humanize: invariants (same notes in, same notes out)", () => {
  it("feel 'off' returns the tracks unchanged", () => {
    const tracks = fixture();
    expect(humanize(tracks, { ...opts, feel: "off" })).toEqual(tracks);
  });

  it("keeps every note and pitch, shifts each start by at most 35 ms, keeps velocities valid, and stays writable", () => {
    const before = fixture();
    const after = humanize(before, opts);
    for (const [i, t] of before.entries()) {
      const a = after[i]!;
      expect(a.notes).toHaveLength(t.notes.length);
      expect(a.notes.map((n) => n.pitch).sort()).toEqual(t.notes.map((n) => n.pitch).sort());
      // match notes by pitch + order of occurrence to measure each note's shift
      const byPitch = (ns: typeof t.notes) => {
        const m = new Map<number, number[]>();
        for (const n of [...ns].sort((x, y) => x.startTick - y.startTick)) m.set(n.pitch, [...(m.get(n.pitch) ?? []), n.startTick]);
        return m;
      };
      const mb = byPitch(t.notes), ma = byPitch(a.notes);
      for (const [pitch, starts] of mb) {
        starts.forEach((s, k) => expect(Math.abs(ma.get(pitch)![k]! - s)).toBeLessThanOrEqual(msToTicks(35)));
      }
      for (const n of a.notes) {
        expect(n.velocity).toBeGreaterThanOrEqual(1);
        expect(n.velocity).toBeLessThanOrEqual(127);
        expect(n.startTick).toBeGreaterThanOrEqual(0);
        expect(n.durationTicks).toBeGreaterThanOrEqual(1);
      }
    }
    const written = writeSmf({ ppq: PPQ, tempoBpm: TEMPO, timeSignature: [4, 4], tracks: after.map(({ role: _r, ...t }) => t) });
    expect(written.ok).toBe(true);
  });

  it("is deterministic per seed, and different seeds differ", () => {
    expect(humanize(fixture(), opts)).toEqual(humanize(fixture(), opts));
    expect(humanize(fixture(), opts)).not.toEqual(humanize(fixture(), { ...opts, seed: 8 }));
  });
});
