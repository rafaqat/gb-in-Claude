// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * M13.14 benchmark: Song JSON → GM synth render (no GarageBand) → gb_song transcribe (the real handler: gb_analyze map
 * with Demucs stems, the transcribe sidecar) → the draft scored against the performed song (humanize, swing and groove
 * included, so the truth is what the audio plays).
 *   npx tsx eval/m13-transcribe/bench.ts <workspace> [--oracle] [--only pop-c,funk-em] [--out results.json]
 * --dump <dir>: the truth and draft notes per song, for a closer look.
 * --oracle: the true stems (each track group rendered alone from the same performance) instead of Demucs' — the
 * transcription on its own, without separation errors. Renders and stems are reused when they exist in <workspace>.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSong, type Song } from "../../src/song/schema.js";
import { perform, createGbSong } from "../../src/mcp/gb-song.js";
import { createGbAnalyze } from "../../src/mcp/gb-analyze.js";
import { clock, smfSongToEvents } from "../../src/render/gm-events.js";
import { createGmRenderer } from "../../src/render/gm-renderer.js";
import { createModelSidecar } from "../../src/models/sidecar.js";
import { parseProgression } from "../../src/composition/progression.js";
import { PPQ } from "../../src/song/render.js";
import type { SmfSong } from "../../src/midi/smf.js";
import type { AnalyzerPort } from "../../src/analysis/analyzer.js";
import { onsetF, beatPitch, chordScore, keyRelation, type Span } from "../../src/eval/transcription-score.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const SONGS = join(import.meta.dirname, "songs");
const PYTHON = process.env.GB_MCP_MODELS_PYTHON ?? resolve(ROOT, "models", ".venv", "bin", "python");

const args = process.argv.slice(2);
const ws = resolve(args[0] ?? "");
const oracle = args.includes("--oracle");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1]!.split(",") : null;
const outFile = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]!) : null;
const dumpDir = args.includes("--dump") ? resolve(args[args.indexOf("--dump") + 1]!) : null; // truth and draft notes per song
if (!args[0]) throw new Error("usage: bench.ts <workspace> [--oracle] [--only ids] [--out file]");
mkdirSync(join(ws, "stems"), { recursive: true });

const renderer = createGmRenderer({ binary: join(ROOT, "native", "bin", "gm-render"), timeoutMs: 300_000 });
const sidecar = createModelSidecar({ command: PYTHON, args: ["-m", "gbmodels.server"], cwd: join(ROOT, "models"), timeoutMs: 30 * 60_000, startTimeoutMs: 120_000 });
const noAnalyzer: AnalyzerPort = { analyze: async () => ({ ok: false, error: { code: "DEPENDENCY_MISSING", message: "not used by map" } }) };
const map = createGbAnalyze({ workspaceDir: ws, analyzer: noAnalyzer, listener: sidecar });
const gbSong = createGbSong({ workspaceDir: ws, models: sidecar, map });

const STEM_ROLES: Record<string, string[]> = { vocals: ["lead"], bass: ["bass"], drums: ["drums"], other: ["pad", "arp", "fx", "lead-high"] };
const DRUM_CLASS: Record<number, "kick" | "snare" | "hat"> = { 35: "kick", 36: "kick", 37: "snare", 38: "snare", 39: "snare", 40: "snare", 42: "hat", 44: "hat", 46: "hat" };

async function render(smf: SmfSong, path: string) {
  if (existsSync(path)) return;
  const r = await renderer.render(smfSongToEvents(smf), path);
  if (!r.ok) throw new Error(`${path}: ${r.error.message}`);
}

/** Notes of the tracks with these roles (or names), in seconds through the song's own clock. */
function spans(smf: SmfSong, pick: (i: number) => boolean, at: (tick: number) => number): Span[] {
  return smf.tracks.flatMap((t, i) => (pick(i) ? t.notes.map((n) => ({ t: at(n.startTick), end: at(n.startTick + n.durationTicks), pitch: n.pitch })) : []));
}

/** Chord spans [a, b) in seconds of a song's chord parts (pad, else arp, else bass per section). */
function chordSpans(song: Song, at: (tick: number) => number, names?: string[]): { a: number; b: number; chord: string }[] {
  const out: { a: number; b: number; chord: string }[] = [];
  let bar = 0;
  for (const s of song.sections) {
    const part = (names ? song.tracks.filter((t) => names.includes(t.name)) : ["pad", "arp", "bass"].flatMap((r) => song.tracks.filter((t) => t.role === r)))
      .map((t) => t.parts[s.name]).find((p) => p && "chords" in p) as { chords: string } | undefined;
    if (part) {
      const prog = parseProgression(part.chords, 4);
      if (prog.ok) {
        for (let b = 0; b < s.bars; b++) {
          for (const c of prog.value.chords.filter((c) => Math.floor(c.startBeat / 4) === b % prog.value.bars)) {
            const start = (bar + b) * 4 + (c.startBeat % 4);
            const symbol = part.chords.split("|")[b % prog.value.bars]!.trim().split(/\s+/)[Math.round((c.startBeat % 4) / c.durationBeats)]!;
            out.push({ a: at(start * PPQ), b: at((start + c.durationBeats) * PPQ), chord: symbol });
          }
        }
      }
    }
    bar += s.bars;
  }
  return out;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const results: Record<string, unknown>[] = [];
for (const file of readdirSync(SONGS).filter((f) => f.endsWith(".json")).sort()) {
  const id = file.replace(/\.json$/, "");
  if (only && !only.includes(id)) continue;
  const parsed = parseSong(JSON.parse(readFileSync(join(SONGS, file), "utf8")));
  if (!parsed.ok) throw new Error(`${id}: ${parsed.error.message}`);
  const song = parsed.value;
  const performed = perform(song);
  if (!performed.ok) throw new Error(performed.message);
  const smf = performed.smf;
  const T = clock(smf);
  const base = oracle ? `${id}-oracle` : id;
  await render(smf, join(ws, `${id}.wav`));
  if (oracle) {
    if (!existsSync(join(ws, `${base}.wav`))) copyFileSync(join(ws, `${id}.wav`), join(ws, `${base}.wav`));
    for (const [stem, roles] of Object.entries(STEM_ROLES)) {
      await render({ ...smf, tracks: smf.tracks.filter((_, i) => roles.includes(song.tracks[i]!.role)) }, join(ws, "stems", `${base}-${stem}.wav`));
    }
  }
  const t0 = Date.now();
  const r = await gbSong({ command: "transcribe", path: `${base}.wav` });
  const seconds = (Date.now() - t0) / 1000;
  if (r.status !== "verified") { results.push({ id, failed: r }); console.error(id, JSON.stringify(r)); continue; }
  const data = r.data as { song: unknown; map: string; lead_source: string | null };
  const draftParsed = parseSong(data.song);
  if (!draftParsed.ok) throw new Error(`${id}: draft does not parse`);
  const draft = draftParsed.value;
  const mapFile = JSON.parse(readFileSync(data.map, "utf8")) as { bar_lines_s: number[]; steady: boolean; bpm: number };
  const dPerf = perform({ ...draft, humanize: "off" });
  if (!dPerf.ok) throw new Error(dPerf.message);
  const D = (tick: number) => clock(dPerf.smf)(tick) + mapFile.bar_lines_s[0]!;
  const role = (s: Song, r: string) => (i: number) => s.tracks[i]!.role === r;

  const totalBeats = song.sections.reduce((n, s) => n + s.bars, 0) * 4;
  const beatLines = Array.from({ length: totalBeats + 1 }, (_, k) => T(k * PPQ));
  const barLines = beatLines.filter((_, k) => k % 4 === 0);
  const barErr = barLines.map((x) => Math.min(...mapFile.bar_lines_s.map((y) => Math.abs(x - y)))).sort((a, b) => a - b);

  const truthChords = chordSpans(song, T);
  const draftChords = chordSpans(draft, D, ["Chords"]);
  const pairs = truthChords.flatMap((c) => {
    const halves = Math.max(1, Math.round((c.b - c.a) / ((beatLines[2]! - beatLines[0]!))));
    return Array.from({ length: halves }, (_, h) => {
      const mid = c.a + ((h + 0.5) * (c.b - c.a)) / halves;
      return [c.chord, draftChords.find((d) => d.a <= mid && mid < d.b)?.chord ?? null] as [string, string | null];
    });
  });

  const tBass = spans(smf, role(song, "bass"), T), dBass = spans(dPerf.smf, role(draft, "bass"), D);
  const tLead = spans(smf, role(song, "lead"), T), dLead = spans(dPerf.smf, role(draft, "lead"), D);
  const hits = (s: SmfSong, isDrums: (i: number) => boolean, at: (tick: number) => number, cls: string) =>
    s.tracks.flatMap((t, i) => (isDrums(i) ? t.notes.filter((n) => DRUM_CLASS[n.pitch] === cls).map((n) => ({ t: at(n.startTick) })) : []));
  const drums = Object.fromEntries((["kick", "snare", "hat"] as const).map((c) => [c, onsetF(hits(smf, role(song, "drums"), T, c), hits(dPerf.smf, role(draft, "drums"), D, c), { pitch: false })]));
  const res = {
    id, seconds, steady: mapFile.steady, lead_source: data.lead_source,
    tempo: { truth: song.tempo, truth_map: song.tempoMap?.length ?? 0, draft: draft.tempo, draft_map: draft.tempoMap?.length ?? 0, map_bpm: mapFile.bpm },
    bar_line_ms: { median: r3(barErr[Math.floor(barErr.length / 2)]! * 1000), p90: r3(barErr[Math.floor(barErr.length * 0.9)]! * 1000) },
    key: { truth: song.key, draft: draft.key ?? null, relation: keyRelation(song.key!, draft.key) },
    chords: chordScore(pairs),
    bass: { per_beat: beatPitch(tBass, dBass, beatLines), notes: onsetF(tBass, dBass, { pitch: true }) },
    lead: { notes: onsetF(tLead, dLead, { pitch: true }), onsets: onsetF(tLead, dLead, { pitch: false }), per_beat: beatPitch(tLead, dLead, beatLines) },
    drums,
  };
  results.push(res);
  console.error(JSON.stringify(res));
  if (dumpDir) {
    mkdirSync(dumpDir, { recursive: true });
    writeFileSync(join(dumpDir, `${base}.json`), JSON.stringify({ tBass, dBass, tLead, dLead, beatLines, pairs,
      drums: Object.fromEntries((["kick", "snare", "hat"] as const).map((c) => [c, { truth: hits(smf, role(song, "drums"), T, c), draft: hits(dPerf.smf, role(draft, "drums"), D, c) }])) }));
  }
}
sidecar.close();

const f = (m: { f: number }) => m.f.toFixed(2);
console.log(`| song | tempo (truth → draft) | bar line ms (med/p90) | key | chords root / maj-min | bass beat exact / pc | bass note F | lead note F (onset+pitch) | lead onset F | kick F | snare F | hat F | s |`);
console.log(`|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
for (const r of results as { id: string; [k: string]: any }[]) {
  if (r.failed) { console.log(`| ${r.id} | failed: ${r.failed.error} ${r.failed.message} |`); continue; }
  console.log(`| ${r.id} | ${r.tempo.truth}${r.tempo.truth_map ? "+map" : ""} → ${r.tempo.draft}${r.tempo.draft_map ? `+map(${r.tempo.draft_map})` : ""} | ${r.bar_line_ms.median}/${r.bar_line_ms.p90} | ${r.key.relation} | ${r.chords.root.toFixed(2)} / ${r.chords.majmin.toFixed(2)} | ${r.bass.per_beat.exact.toFixed(2)} / ${r.bass.per_beat.pitch_class.toFixed(2)} | ${f(r.bass.notes)} | ${f(r.lead.notes)} | ${f(r.lead.onsets)} | ${f(r.drums.kick)} | ${f(r.drums.snare)} | ${f(r.drums.hat)} | ${r.seconds.toFixed(0)} |`);
}
if (outFile) writeFileSync(outFile, JSON.stringify({ oracle, results }, null, 1) + "\n", { flag: "wx" });
