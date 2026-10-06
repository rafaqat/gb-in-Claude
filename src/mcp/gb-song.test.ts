// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGbSong } from "./gb-song.js";
import { verified, failed, type Envelope } from "./envelope.js";

const song = {
  title: "Ascent", tempo: 132, style: "orbit-ambient",
  sections: [{ name: "intro", bars: 2 }, { name: "drop", bars: 2 }],
  tracks: [
    { name: "Drums", role: "drums", parts: { drop: { grid: { kick: "x...x...x...x..." } } } },
    { name: "Strings", role: "pad", parts: { intro: { chords: "Fm | Db", style: "sustain" }, drop: { chords: "Ab | Eb", style: "sustain" } } },
    { name: "Lead", role: "lead", parts: { drop: { notes: "f5@2 ab5 c6 | eb6@3 c6" } } },
  ],
};

let workspace: string;
let gbSong: ReturnType<typeof createGbSong>;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "gbmcp-"));
  gbSong = createGbSong({ workspaceDir: workspace });
});

describe("gb_song validate", () => {
  it("returns failed SONG_INVALID with the offending path for a malformed song", async () => {
    const r = await gbSong({ command: "validate", song: { ...song, tempo: 999 } });
    expect(r).toMatchObject({ status: "failed", op: "gb_song.validate", error: "SONG_INVALID", write_attempted: false, recoverable: true });
    expect(r.status === "failed" && r.message).toContain("tempo");
  });

  it("returns verified with musical issues and a summary for a valid song", async () => {
    const r = await gbSong({ command: "validate", song });
    expect(r.status).toBe("verified");
    if (r.status !== "verified") return;
    expect(r.data).toMatchObject({
      issues: [],
      summary: { bars: 4, durationSec: 7.27, tracks: [
        { name: "Drums", program: 24, patch: "Boutique 808" },
        { name: "Strings", program: 48, patch: "String Ensemble" },
        { name: "Lead", program: 81, patch: "Soft Saw Lead" },
      ] },
    });
  });
});

describe("gb_song preview", () => {
  it("returns the ASCII grid for a section", async () => {
    const r = await gbSong({ command: "preview", song, section: "drop", maxBars: 1 });
    expect(r.status).toBe("verified");
    if (r.status === "verified") expect((r.data as { grid: string }).grid.split("\n")[1]).toBe("Drums kick       |x...x...x...x...|");
  });
});

describe("gb_song render_midi", () => {
  it("writes a humanized SMF into the workspace and reports what GarageBand will load", async () => {
    const r = await gbSong({ command: "render_midi", song, filename: "ascent.mid" });
    expect(r.status).toBe("verified");
    const path = join(workspace, "ascent.mid");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).subarray(0, 4).toString()).toBe("MThd");
    if (r.status === "verified") expect(r.data).toMatchObject({ path, tracks: [{ name: "Drums", patch: "Boutique 808" }, {}, {}] });
  });

  it("dry_run writes nothing and returns the plan", async () => {
    const r = await gbSong({ command: "render_midi", song, filename: "ascent.mid", dry_run: true });
    expect(r).toMatchObject({ status: "verified", data: { dry_run: true, path: join(workspace, "ascent.mid") } });
    expect(readdirSync(workspace)).toEqual([]);
  });

  it("never overwrites: an existing file fails with FILE_EXISTS and is left untouched", async () => {
    writeFileSync(join(workspace, "ascent.mid"), "keep me");
    const r = await gbSong({ command: "render_midi", song, filename: "ascent.mid" });
    expect(r).toMatchObject({ status: "failed", error: "FILE_EXISTS", write_attempted: false, safe_to_retry: true });
    expect(readFileSync(join(workspace, "ascent.mid"), "utf8")).toBe("keep me");
  });

  it.each(["../escape.mid", "/etc/x.mid", "a/b.mid", "song.txt", "%2e%2e.mid", "x?.mid", "with\nnewline.mid", ".hidden.mid"])(
    "rejects unsafe filename %j with PATH_INVALID",
    async (filename) => {
      const r = await gbSong({ command: "render_midi", song, filename });
      expect(r).toMatchObject({ status: "failed", error: "PATH_INVALID", write_attempted: false });
      expect(readdirSync(workspace)).toEqual([]);
    },
  );

  it("refuses to render a song with musical errors, returning the issues", async () => {
    const flute = { ...song, style: "acoustic", tracks: [{ name: "Lead", role: "lead", parts: { drop: { notes: "f7" } } }] };
    const r = await gbSong({ command: "render_midi", song: flute, filename: "flute.mid" });
    expect(r).toMatchObject({ status: "failed", error: "VALIDATION_FAILED", write_attempted: false });
    expect(readdirSync(workspace)).toEqual([]);
  });
});

describe("gb_song input", () => {
  it("rejects an unknown command with the valid list", async () => {
    const r = await gbSong({ command: "delete_everything" });
    expect(r).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
    expect(r.status === "failed" && r.message).toContain("validate");
  });
});

describe("gb_song render_draft (macOS GM synth, no GarageBand)", () => {
  type Ev = { duration_s: number; events: { t: number; bytes: number[] }[] };
  const fakeRenderer = () => {
    const calls: { events: Ev; out: string }[] = [];
    return {
      calls,
      port: { async render(events: Ev, out: string) { calls.push({ events, out }); writeFileSync(out, "RIFF"); return { ok: true as const, value: { path: out, seconds: 9.27, peak: 0.6 } }; } },
    };
  };

  it("renders the humanized song to a WAV in the workspace and labels it a draft", async () => {
    const r1 = fakeRenderer();
    const tool = createGbSong({ workspaceDir: workspace, gmRenderer: r1.port });
    const r = await tool({ command: "render_draft", song, filename: "ascent-draft.wav" });
    expect(r.status).toBe("verified");
    expect(r1.calls[0]!.out).toBe(join(workspace, "ascent-draft.wav"));
    expect(r1.calls[0]!.events.events.some((e) => e.bytes[0] === 0xc9)).toBe(true); // drums program on channel 10
    if (r.status === "verified") expect(r.data).toMatchObject({ path: join(workspace, "ascent-draft.wav"), seconds: 9.27, draft: true });
  });

  it("dry_run validates and plans the draft without rendering or writing anything", async () => {
    const r1 = fakeRenderer();
    const tool = createGbSong({ workspaceDir: workspace, gmRenderer: r1.port });
    const r = await tool({ command: "render_draft", song, filename: "plan-draft.wav", dry_run: true });
    expect(r).toMatchObject({ status: "verified", data: { dry_run: true, path: join(workspace, "plan-draft.wav") } });
    expect(r1.calls).toHaveLength(0);
    expect(existsSync(join(workspace, "plan-draft.wav"))).toBe(false);
  });

  it("only accepts safe .wav names and never overwrites", async () => {
    const r1 = fakeRenderer();
    const tool = createGbSong({ workspaceDir: workspace, gmRenderer: r1.port });
    expect(await tool({ command: "render_draft", song, filename: "../x.wav" })).toMatchObject({ status: "failed", error: "PATH_INVALID" });
    writeFileSync(join(workspace, "taken.wav"), "keep");
    expect(await tool({ command: "render_draft", song, filename: "taken.wav" })).toMatchObject({ status: "failed", error: "FILE_EXISTS" });
    expect(r1.calls).toHaveLength(0);
  });

  it("reports DEPENDENCY_MISSING when the renderer is not available", async () => {
    const r = await createGbSong({ workspaceDir: workspace })({ command: "render_draft", song, filename: "a.wav" });
    expect(r).toMatchObject({ status: "failed", error: "DEPENDENCY_MISSING" });
  });
});

describe("gb_song band_plan (M7: audio clips → gb_band build)", () => {
  const withVox = { ...song, tracks: [...song.tracks, { name: "Vox", role: "lead", parts: {}, donorTrack: 1, audio: [{ wav: "stems/vox.wav", section: "drop", beat: 2 }] }] };
  it("returns gb_band build's audio list (absolute bar and beat) and writes nothing", async () => {
    const r = await gbSong({ command: "band_plan", song: withVox });
    expect(r).toMatchObject({ status: "verified", op: "gb_song.band_plan", data: { audio: [{ wav: "stems/vox.wav", bar: 3, beat: 2, track: 1 }] } });
    expect(readdirSync(workspace)).toEqual([]);
  });
  it("render_midi leaves the audio clips out and says so in warnings", async () => {
    const r = await gbSong({ command: "render_midi", song: withVox, filename: "vox.mid", dry_run: true });
    expect(r).toMatchObject({ status: "verified" });
    expect(r.status === "verified" && r.warnings).toEqual(expect.arrayContaining([expect.stringContaining("band_plan")]));
  });
  it("render_draft leaves the audio clips out and says so in warnings", async () => {
    const port = { async render() { return { ok: true as const, value: { path: "", seconds: 0, peak: 0 } }; } };
    const r = await createGbSong({ workspaceDir: workspace, gmRenderer: port })({ command: "render_draft", song: withVox, filename: "vox.wav", dry_run: true });
    expect(r).toMatchObject({ status: "verified" });
    expect(r.status === "verified" && r.warnings).toEqual(expect.arrayContaining([expect.stringContaining("band_plan")]));
  });
  it("refuses a song without audio clips (NOT_SUPPORTED): it is a MIDI song, render_midi makes it", async () => {
    expect(await gbSong({ command: "band_plan", song })).toMatchObject({ status: "failed", error: "NOT_SUPPORTED" });
  });
});

describe("gb_song template (M9: genre knowledge as rules)", () => {
  it("returns a complete, valid Song JSON draft for a genre in a key and tempo, and writes nothing", async () => {
    const r = await gbSong({ command: "template", genre: "deep house", key: "F minor", bpm: 122 });
    expect(r).toMatchObject({ status: "verified", op: "gb_song.template", data: { song: { tempo: 122, key: "F minor", groove: "dance" } } });
    const v = await gbSong({ command: "validate", song: (r as { data: { song: unknown } }).data.song });
    expect(v).toMatchObject({ status: "verified" });
    expect(readdirSync(workspace)).toEqual([]);
  });

  it("variant 1–3: the genre's common loops, valid, and the result names where they come from (M13.16)", async () => {
    const r = await gbSong({ command: "template", genre: "UK garage", key: "F minor", variant: 2 });
    expect(r).toMatchObject({ status: "verified", data: { progressions: { variant: 2, source: expect.stringContaining("all genres") } } });
    expect(await gbSong({ command: "validate", song: (r as { data: { song: unknown } }).data.song })).toMatchObject({ status: "verified" });
    const own = await gbSong({ command: "template", genre: "pop", key: "C major" });
    expect(own).toMatchObject({ data: { progressions: { variant: 0, source: expect.stringContaining("hand-written") } } });
    expect(await gbSong({ command: "template", genre: "pop", key: "C major", variant: 4 })).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
  });

  it("refuses an unknown genre with the known ones in the hint", async () => {
    const r = await gbSong({ command: "template", genre: "polka", key: "C major" });
    expect(r).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
    expect(JSON.stringify(r)).toContain("drum and bass");
  });
});

describe("gb_song infill (M10): AMT rewrites chosen tracks of one section", () => {
  const two = {
    title: "Infill", tempo: 120, key: "C major",
    sections: [{ name: "a", bars: 2 }, { name: "b", bars: 2 }],
    tracks: [
      { name: "Drums", role: "drums", parts: { a: { grid: { kick: "x...x...x...x..." } }, b: { grid: { kick: "x...x...x...x..." } } } },
      { name: "Keys", role: "pad", program: 4, parts: { a: { chords: "C | G", style: "sustain" }, b: { chords: "Am | F", style: "sustain" } } },
      { name: "Bass", role: "bass", program: 33, parts: { a: { chords: "C | G", style: "sustain" }, b: { chords: "Am | F", style: "sustain" } } },
    ],
  };
  const sidecar = (notes: unknown[], calls: unknown[] = []) => ({
    calls, async run(model: string, inputs: Record<string, unknown>) { calls.push({ model, inputs }); return { ok: true as const, value: { notes, mode: inputs.mode } }; }, close() {},
  });

  it("asks the sidecar for the section's span and the tracks' instruments, and returns the song with those parts rewritten", async () => {
    const s = sidecar([{ instrument: 4, pitch: 69, start_s: 4.0, dur_s: 1.0 }, { instrument: 4, pitch: 65, start_s: 6.0, dur_s: 2.0 }]);
    const r = await createGbSong({ workspaceDir: workspace, models: s })({ command: "infill", song: two, section: "b", tracks: ["Keys"] });
    expect(s.calls).toEqual([{ model: "infill", inputs: expect.objectContaining({ start_s: 4, end_s: 8, instruments: [4], mode: "exact", seed: 1 }) }]);
    expect(r).toMatchObject({ status: "verified", op: "gb_song.infill", data: { changed: [{ track: "Keys", section: "b" }] } });
    const song = (r as { data: { song: typeof two } }).data.song;
    expect(song.tracks[1]!.parts.b).toEqual({ notes: "a4@8 ~ ~ ~ ~ ~ ~ ~ ~ | f4@16" });
    expect(song.tracks[1]!.parts.a).toEqual(two.tracks[1]!.parts.a); // the other section is untouched
    expect(song.tracks[2]).toEqual(two.tracks[2]);                   // and so are the other tracks
    expect((await gbSong({ command: "validate", song })).status).toBe("verified");
    expect(readdirSync(workspace)).toEqual([]);
  });

  it.each([
    ["a drums track", { section: "b", tracks: ["Drums"] }, "INPUT_INVALID"],
    ["an unknown section", { section: "z", tracks: ["Keys"] }, "INPUT_INVALID"],
    ["an unknown track", { section: "b", tracks: ["Lead"] }, "INPUT_INVALID"],
  ])("refuses %s", async (_why, args, code) => {
    const r = await createGbSong({ workspaceDir: workspace, models: sidecar([]) })({ command: "infill", song: two, ...args });
    expect(r).toMatchObject({ status: "failed", error: code });
  });

  it("refuses two tracks on the same instrument (the model could not tell them apart)", async () => {
    const same = { ...two, tracks: [...two.tracks, { name: "Keys2", role: "pad", program: 4, parts: { b: { chords: "Am", style: "stabs" } } }] };
    const r = await createGbSong({ workspaceDir: workspace, models: sidecar([]) })({ command: "infill", song: same, section: "b", tracks: ["Keys", "Keys2"] });
    expect(r).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
  });

  it("candidates: several takes (seeds seed, seed+1, …), CLaMP 3 judges them against `judge`, the best comes back", async () => {
    const calls: { model: string; inputs: Record<string, unknown> }[] = [];
    const models = {
      async run(model: string, inputs: Record<string, unknown>) {
        calls.push({ model, inputs });
        if (model === "infill") return { ok: true as const, value: { notes: [{ instrument: 4, pitch: 60 + Number(inputs.seed), start_s: 4.0, dur_s: 4.0 }] } };
        return { ok: true as const, value: { scores: [0.11, 0.42, 0.2], best: 1 } };
      },
      close() {},
    };
    const r = await createGbSong({ workspaceDir: workspace, models })({ command: "infill", song: two, section: "b", tracks: ["Keys"], seed: 5, candidates: 3, judge: "warm neo-soul keys" });
    expect(calls.filter((c) => c.model === "infill").map((c) => c.inputs.seed)).toEqual([5, 6, 7]);
    const judged = calls.find((c) => c.model === "clamp3")!;
    expect(judged.inputs.prompt).toBe("warm neo-soul keys");
    expect((judged.inputs.midis as string[]).length).toBe(3);
    expect(r).toMatchObject({ status: "verified", data: { takes: [{ seed: 5, score: 0.11 }, { seed: 6, score: 0.42, best: true }, { seed: 7, score: 0.2 }] } });
    const song = (r as { data: { song: typeof two } }).data.song;
    expect(song.tracks[1]!.parts.b).toEqual({ notes: "f#4@16 | f#4@16" }); // seed 6 → pitch 66, the judged best
    expect(readdirSync(workspace)).toEqual([]);
  });

  it("never picks a runaway take the model's budget cut short (capped), even with the best score", async () => {
    const models = {
      async run(model: string, inputs: Record<string, unknown>) {
        if (model === "infill") return { ok: true as const, value: { notes: [{ instrument: 4, pitch: 60 + Number(inputs.seed), start_s: 4.0, dur_s: 4.0 }], capped: inputs.seed === 1 } };
        return { ok: true as const, value: { scores: [0.9, 0.3], best: 0 } };
      },
      close() {},
    };
    const r = await createGbSong({ workspaceDir: workspace, models })({ command: "infill", song: two, section: "b", tracks: ["Keys"], seed: 1, candidates: 2, judge: "warm keys" });
    expect(r).toMatchObject({ status: "verified", data: { seed: 2, takes: [{ seed: 1, score: 0.9, capped: true }, { seed: 2, score: 0.3, best: true }] } });
  });

  it("several candidates need a judge text (INPUT_INVALID otherwise)", async () => {
    const r = await createGbSong({ workspaceDir: workspace, models: sidecar([]) })({ command: "infill", song: two, section: "b", tracks: ["Keys"], candidates: 2 });
    expect(r).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
  });

  it("without the model sidecar: DEPENDENCY_MISSING", async () => {
    const r = await gbSong({ command: "infill", song: two, section: "b", tracks: ["Keys"] });
    expect(r).toMatchObject({ status: "failed", error: "DEPENDENCY_MISSING" });
  });
});

describe("gb_song render_midi: expression reaches the file (M11)", () => {
  it("a slide on the flute writes RPN 12 and pitch bends; a hairpin writes CC11; a section tempo writes a tempo change", async () => {
    const expressive = {
      title: "Meend", tempo: 100, key: "E minor",
      sections: [{ name: "aalap", bars: 1 }, { name: "rit", bars: 1, tempoTo: 80 }],
      tracks: [{ name: "Bansuri", role: "lead", program: 73, parts: { aalap: { notes: "d5@3>e5@1 b4@4", dynamics: "p<f" }, rit: { notes: "e4@4" } } }],
    };
    const r = await gbSong({ command: "render_midi", song: expressive, filename: "meend.mid" });
    expect(r.status).toBe("verified");
    const bytes = Array.from(readFileSync(join(workspace, "meend.mid")));
    const has = (seq: number[]) => bytes.some((_, i) => seq.every((b, k) => bytes[i + k] === b));
    expect(has([0xb0, 101, 0, 0x00, 0xb0, 100, 0, 0x00, 0xb0, 6, 12])).toBe(true); // RPN 0 = 12 on channel 1
    expect(bytes.some((b) => b === 0xe0)).toBe(true); // pitch bend
    expect(has([0xb0, 11])).toBe(true); // expression
    expect(bytes.filter((b, i) => b === 0xff && bytes[i + 1] === 0x51).length).toBeGreaterThan(1); // tempo changes
    expect(has([0xff, 0x59, 0x02, 0x01, 0x01])).toBe(true); // E minor key signature
  });
});

describe("gb_song validate voice_leading (M13.4)", () => {
  const fifths = { title: "T", tempo: 120, sections: [{ name: "a", bars: 2 }], tracks: [
    { name: "Lead", role: "lead", parts: { a: { notes: "g4 | a4" } } },
    { name: "Bass", role: "bass", parts: { a: { chords: "C | D", style: "sustain" } } },
  ] };
  it("adds the voice-leading warnings only when asked", async () => {
    const codes = async (extra: object) => ((await gbSong({ command: "validate", song: fifths, ...extra })) as { data: { issues: { code: string }[] } }).data.issues.map((i) => i.code);
    expect(await codes({})).not.toContain("PARALLEL_FIFTHS");
    expect(await codes({ voice_leading: true })).toContain("PARALLEL_FIFTHS");
  });
});

describe("gb_song summary durationSec (found in M13.7): through the tempo map", () => {
  it("4 bars at 80 then 6 bars at 120 last 24 s, not 30", async () => {
    const r = await gbSong({ command: "validate", song: { title: "T", tempo: 80, sections: [{ name: "slow", bars: 4 }, { name: "fast", bars: 6, tempo: 120 }],
      tracks: [{ name: "Pad", role: "pad", parts: { slow: { chords: "C", style: "sustain" }, fast: { chords: "C", style: "sustain" } } }] } });
    expect((r as { data: { summary: { durationSec: number } } }).data.summary.durationSec).toBe(24);
  });
});

describe("gb_song transcribe (M13.14): a recording → a Song JSON draft that plays like it", () => {
  const MAP = {
    key: "D Major", place: { guide_bpm: 120, bar: 1, beat: 1, offset_s: 0 }, tempo_map: null, bar_lines_s: [0, 2, 4],
    sections: [{ name: "verse", gb_bar: 1, bars: 2 }], gb: [{ bar: 1, chords: ["D", "D"] }, { bar: 2, chords: ["G", "A"] }],
  };
  const NOTES = {
    bass: [{ bar: 1, step: 0, len: 8, pitch: 38 }], bass_source: "bass", lead: [{ bar: 2, step: 0, len: 4, pitch: 74 }], lead_source: "vocals",
    drums: { kick: [{ bar: 1, step: 0, strength: 1 }], snare: [{ bar: 1, step: 4, strength: 0.6 }], hat: [] },
  };
  const STEMS = { vocals: "stems/take-vocals.wav", drums: "stems/take-drums.wav", bass: "stems/take-bass.wav", other: "stems/take-other.wav" };
  const setup = (over: { map?: (input: Record<string, unknown>) => unknown; notes?: unknown } = {}) => {
    mkdirSync(join(workspace, "gen"), { recursive: true });
    writeFileSync(join(workspace, "gen", "take.wav"), "RIFF");
    const calls: { tool: string; input: Record<string, unknown> }[] = [];
    const map = async (input: unknown) => {
      calls.push({ tool: "gb_analyze", input: input as Record<string, unknown> });
      if (over.map) return over.map(input as Record<string, unknown>) as Envelope;
      mkdirSync(join(workspace, "analysis"), { recursive: true });
      writeFileSync(join(workspace, "analysis", "take-map.json"), JSON.stringify(MAP));
      return verified("gb_analyze.map", { map: join(workspace, "analysis", "take-map.json"), bpm: 120, steady: true, stems: STEMS });
    };
    const models = { async run(model: string, inputs: Record<string, unknown>) { calls.push({ tool: model, input: inputs }); return { ok: true as const, value: over.notes ?? NOTES }; }, close() {} };
    return { calls, gb: createGbSong({ workspaceDir: workspace, map, models }) };
  };

  it("maps the recording, transcribes its stems on the map's bars, and writes a valid draft to songs/ (never overwriting)", async () => {
    const { calls, gb } = setup();
    const r = await gb({ command: "transcribe", path: "gen/take.wav", filename: "take-draft.json" });
    expect(r).toMatchObject({ status: "verified", op: "gb_song.transcribe", data: { path: join(realpathSync(workspace), "songs", "take-draft.json"), lead_source: "vocals" } });
    expect(calls).toEqual([
      { tool: "gb_analyze", input: { command: "map", path: "gen/take.wav", melody: false } },
      { tool: "transcribe", input: { stems: STEMS, lines: [0, 2, 4] } },
    ]);
    const song = (r as { data: { song: { tempo: number; key: string; tracks: { name: string }[] } } }).data.song;
    expect(song).toMatchObject({ tempo: 120, key: "D major" });
    expect(song.tracks.map((t) => t.name)).toEqual(["Drums", "Chords", "Bass", "Lead"]);
    expect(JSON.parse(readFileSync(join(workspace, "songs", "take-draft.json"), "utf8"))).toEqual(song);
    expect((await createGbSong({ workspaceDir: workspace })({ command: "validate", song })).status).toBe("verified");
  });

  it("takes the project's naming (songs/<slug>-vN.song.json, as the skills write it) and refuses paths", async () => {
    const { gb } = setup();
    expect(await gb({ command: "transcribe", path: "gen/take.wav", filename: "take-v1.song.json" })).toMatchObject({ status: "verified", data: { path: join(realpathSync(workspace), "songs", "take-v1.song.json") } });
    for (const filename of ["../take.json", "take.mid", ".take.json", "take.v1.json"]) {
      expect(await gb({ command: "transcribe", path: "gen/take.wav", filename })).toMatchObject({ status: "failed", error: "PATH_INVALID" });
    }
  });

  it("never overwrites: a taken name, even a dangling link, stops it before the map runs", async () => {
    const { calls, gb } = setup();
    mkdirSync(join(workspace, "songs"));
    writeFileSync(join(workspace, "songs", "take-draft.json"), "{}");
    symlinkSync(join(workspace, "nowhere.json"), join(workspace, "songs", "take-link.json"));
    for (const filename of ["take-draft.json", "take-link.json"]) {
      expect(await gb({ command: "transcribe", path: "gen/take.wav", filename })).toMatchObject({ status: "failed", error: "FILE_EXISTS", write_attempted: false });
    }
    expect(calls).toEqual([]);
    expect(readFileSync(join(workspace, "songs", "take-draft.json"), "utf8")).toBe("{}");
  });

  it("dry_run plans and runs nothing; without a filename the draft comes back and songs/ is not made", async () => {
    const { calls, gb } = setup();
    const plan = await gb({ command: "transcribe", path: "gen/take.wav", filename: "take-draft.json", dry_run: true });
    expect(plan).toMatchObject({ status: "verified", data: { dry_run: true, plan: expect.arrayContaining(["write songs/take-draft.json"]) } });
    expect(calls).toEqual([]);
    expect(existsSync(join(workspace, "songs"))).toBe(false);
    const r = await gb({ command: "transcribe", path: "gen/take.wav" });
    expect(r).toMatchObject({ status: "verified", data: { song: { title: "take (draft)" } } });
    expect((r as { data: Record<string, unknown> }).data.path).toBeUndefined();
    expect(existsSync(join(workspace, "songs"))).toBe(false);
  });

  it("a map that fails stops it, named, before the transcription; without the sidecar it says what to install", async () => {
    const { calls, gb } = setup({ map: () => failed("gb_analyze.map", "ANALYSIS_FAILED", "no downbeats found: the map needs a pulse") });
    const r = await gb({ command: "transcribe", path: "gen/take.wav", filename: "take-draft.json" });
    expect(r).toMatchObject({ status: "failed", error: "ANALYSIS_FAILED", message: "gb_analyze.map: no downbeats found: the map needs a pulse" });
    expect(calls.map((c) => c.tool)).toEqual(["gb_analyze"]);
    expect(existsSync(join(workspace, "songs"))).toBe(false); // songs/ is made just before the write
    expect(await gbSong({ command: "transcribe", path: "gen/take.wav" })).toMatchObject({ status: "failed", error: "DEPENDENCY_MISSING" });
  });

  it("passes on the map's warnings (no section engine: the draft is one section)", async () => {
    const { gb } = setup({ map: () => {
      mkdirSync(join(workspace, "analysis"), { recursive: true });
      writeFileSync(join(workspace, "analysis", "take-map.json"), JSON.stringify({ ...MAP, sections: null }));
      return verified("gb_analyze.map", { map: join(workspace, "analysis", "take-map.json"), stems: STEMS }, ["no sections: the section engine is not installed"]);
    } });
    const r = await gb({ command: "transcribe", path: "gen/take.wav" });
    expect(r).toMatchObject({ status: "verified", data: { song: { sections: [{ name: "song", bars: 2 }] } } });
    expect((r as { warnings?: string[] }).warnings).toContain("gb_analyze.map: no sections: the section engine is not installed");
  });

  it("says which lines it could not hear: a silent bass stem gives the chord roots, a silent vocal no lead", async () => {
    const { gb } = setup({ notes: { ...NOTES, bass: [], bass_source: null, lead: [], lead_source: null } });
    const r = await gb({ command: "transcribe", path: "gen/take.wav" });
    expect(r.status).toBe("verified");
    const warnings = (r as { warnings?: string[] }).warnings ?? [];
    expect(warnings.some((w) => w.startsWith("BASS_FROM_CHORDS"))).toBe(true);
    expect(warnings.some((w) => w.startsWith("NO_LEAD"))).toBe(true);
  });
});
