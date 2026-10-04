// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * Builds a GarageBand project (.band) from a GarageBand-made donor: the donor's records are kept (their identities
 * matter to GarageBand) and only the decoded leaf values are rewritten — file name, format, length, position.
 * Two phases: plan (read + check everything, build the new ProjectData in memory), then write. Nothing is written
 * unless the plan succeeds. Never overwrites, never throws: every failure is a BuildBandResult.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { basename, join } from "node:path";
import { err, ok } from "../result.js";
import { copyDonor, donorProblem, FileRefused, readRegular } from "./files.js";
import { parseProjectData, serializeProjectData } from "./projectdata.js";
import { audioPlacements, MAX_PLACEMENTS, regionRecords, withoutRegionsFrom, withPlacement, writeAudioFile, writeAudioRegion } from "./audio.js";
import { wavInfo, withOverview, type WavInfo } from "./wav.js";
import { midiRegions, withMidiNotes } from "./midi.js";
import { patchFor } from "../knowledge/gm-patch-map.js";
import { bendRangeFor } from "../knowledge/bend-ranges.js";
import { bendsForLine, rpnBendRange } from "../song/expression.js";
import { projectTempo, songLength, withSongLength } from "./song.js";
import { BuildBandInput, type BuildBandError, type BuildBandResult, type BuildBandSpec } from "./spec.js";

const PROJECT_DATA = ["Alternatives", "000", "ProjectData"] as const;
const META_DATA = ["Alternatives", "000", "MetaData.plist"] as const;
const AUDIO_FOLDER = "Audio Files";
const TICKS_PER_BEAT = 960;
/** 4/4 (the donors' meter; reading the donor's time signature is a follow-up). */
const TICKS_PER_BAR = 4 * TICKS_PER_BEAT;
/** Not copied from the donor: its autosaves, its samples, and the ProjectData this build writes new. */
const SKIPPED = new Set([join("Alternatives", "000", "Autosave"), join("Media", AUDIO_FOLDER), join(...PROJECT_DATA)]);
/** The latest song end the 32-bit song length can hold, with room for its 38400-tick origin. */
const MAX_SONG_TICKS = 2_000_000_000;
/** A GarageBand donor's ProjectData is a few hundred KB; a big song a few MB. */
const MAX_PROJECTDATA_BYTES = 16 * 1024 * 1024;

const plutil = (args: string[]) =>
  new Promise<void>((resolve, reject) => execFile("plutil", args, { timeout: 10_000 }, (e) => (e ? reject(e) : resolve())));

const fail = (code: BuildBandError["code"], message: string, recoverable = true, extra: { written?: boolean; detail?: string } = {}): BuildBandResult =>
  err({ code, message, recoverable, ...extra });

/** A planned sample: its name in the project and its WAV (with overview) as it will be written. */
type Sample = { source: string; file: string; size: number; info: WavInfo };

/** Size limits. A 10-minute 24-bit stereo stem at 48 kHz is about 165 MB. */
export type BuildBandLimits = { maxWavBytes?: number; maxTotalWavBytes?: number };
const MAX_WAV_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_WAV_BYTES = 1024 * 1024 * 1024;

/** The WAV at `path` with GarageBand's overview chunk added, read without following a link and refused above `max`. */
function sampleBytes(path: string, max: number): { ok: true; bytes: Uint8Array } | { ok: false; message: string } {
  let raw: Uint8Array;
  try {
    raw = readRegular(path, max);
  } catch (e) {
    return { ok: false, message: e instanceof FileRefused ? e.message : "unreadable" };
  }
  const wav = withOverview(raw);
  return wav.ok ? { ok: true, bytes: wav.value } : { ok: false, message: wav.error.message };
}

/** `name.wav`, or GarageBand's `name_1.wav`, `name_2.wav`… when that name is already used in this project. */
function uniqueName(file: string, taken: Set<string>): string {
  const stem = file.replace(/\.wav$/i, "");
  let name = file;
  for (let n = 1; taken.has(name.toLowerCase()); n++) name = `${stem}_${n}.wav`;
  taken.add(name.toLowerCase());
  return name;
}

export class BuildBandHandler implements BuildBandSpec {
  constructor(private readonly limits: BuildBandLimits = {}) {}

  async execute(raw: BuildBandInput): Promise<BuildBandResult> {
    // The types vanish at run time: parse, don't trust.
    const parsed = BuildBandInput.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return fail("INPUT_INVALID", `${issue.path.join(".") || "input"}: ${issue.message}`);
    }
    const input = parsed.data;
    const maxWavBytes = this.limits.maxWavBytes ?? MAX_WAV_BYTES;
    const maxTotalWavBytes = this.limits.maxTotalWavBytes ?? MAX_TOTAL_WAV_BYTES;
    let writing = false;
    try {
      // ---- plan: read and check everything; nothing is written yet ----
      if (existsSync(input.out)) return fail("OUT_EXISTS", `${basename(input.out)} already exists; choose a new name (files are never overwritten)`);
      const problem = donorProblem(input.donor);
      if (problem) return fail("DONOR_INVALID", `${problem.reason}; use a .band that GarageBand saved`, true, { detail: problem.entry });
      const donorData = join(input.donor, ...PROJECT_DATA);
      if (!existsSync(donorData) || !existsSync(join(input.donor, ...META_DATA))) {
        return fail("DONOR_INVALID", "the donor has no Alternatives/000/ProjectData or MetaData.plist; use a .band that GarageBand saved");
      }
      let bytes: Uint8Array;
      try {
        bytes = readRegular(donorData, MAX_PROJECTDATA_BYTES);
      } catch (e) {
        return fail("DONOR_INVALID", `the donor's ProjectData cannot be used: ${e instanceof FileRefused ? e.message : "unreadable"}`);
      }
      const pd = parseProjectData(bytes);
      if (!pd.ok) return fail("DONOR_INVALID", `the donor's ProjectData is not readable: ${pd.error.message}`);

      const placements = audioPlacements(pd.value).sort((a, b) => a.region - b.region);
      if (placements.length > MAX_PLACEMENTS) return fail("DONOR_INVALID", `the donor holds more than ${MAX_PLACEMENTS} audio regions; use a small donor`);
      if (input.regions.length > placements.length) {
        return fail("REGION_COUNT", `the donor holds ${placements.length} audio region(s); ${input.regions.length} were asked for`, true);
      }

      // each slot this build fills must own its records, or one sample would silently overwrite another
      const owned = new Set<number>();
      for (const p of placements.slice(0, input.regions.length)) {
        const at = regionRecords(pd.value, p.region);
        if (at.file >= 0 && owned.has(at.file) || at.region >= 0 && owned.has(at.region)) {
          return fail("DONOR_INVALID", "two of the donor's audio regions share their file or region records; use a .band that GarageBand saved");
        }
        owned.add(at.file).add(at.region);
      }

      const donorTracks = new Set(placements.map((p) => p.track));
      const strange = input.regions.find((r) => !donorTracks.has(r.track));
      if (strange) {
        return fail("TRACK_NOT_IN_DONOR", `track ${strange.track} is not an audio track of the donor (it has ${[...donorTracks].sort((a, b) => a - b).join(", ")})`);
      }

      const samples: Sample[] = [];
      const taken = new Set<string>();
      for (const [i, region] of input.regions.entries()) {
        const file = uniqueName(basename(region.wav), taken);
        const wav = sampleBytes(region.wav, maxWavBytes); // read one at a time; written again from the file later
        if (!wav.ok) return fail("WAV_INVALID", `regions.${i}: ${wav.message}`);
        const info = wavInfo(wav.bytes);
        if (!info.ok) return fail("WAV_INVALID", `regions.${i}: ${info.error.message}`);
        samples.push({ source: region.wav, file, size: wav.bytes.length, info: info.value });
        if (samples.reduce((sum, x) => sum + x.size, 0) > maxTotalWavBytes) {
          return fail("WAV_INVALID", `the samples add up to more than ${maxTotalWavBytes} bytes (each slot is its own copy in the project)`);
        }
      }

      // region i fills donor slot i (the donor's region i): its placement (tick, track) and the records it links to;
      // the donor regions not used are trimmed afterwards
      let project = pd.value;
      const claimed = new Set<number>();
      for (const item of input.midi ?? []) {
        const named = midiRegions(project).filter((m) => m.name === item.region);
        const region = named[0];
        // one name → one region → its own records, or one item's notes would silently replace another's
        if (named.length > 1 || region && (claimed.has(region.record) || claimed.has(region.noteRecord))) {
          return fail("DONOR_INVALID", "two of the donor's MIDI regions share a name or a note list; use a .band that GarageBand saved", true, { detail: item.region });
        }
        if (region) claimed.add(region.record).add(region.noteRecord);
        if (!region) {
          const names = midiRegions(project).map((m) => m.name).join(", ") || "none";
          // region names are text a person typed: detail only
          return fail("MIDI_REGION_NOT_IN_DONOR", "the donor has no MIDI region with that name", true, { detail: `${item.region} (the donor has: ${names})` });
        }
        // M11: slides and cent offsets become pitch bends the region's instrument can play (probe 2026-10-04)
        const program = item.program ?? region.program;
        const bent = item.notes.filter((n) => n.slide?.length || n.cents !== undefined);
        let expression = {};
        if (bent.length) {
          const patch = region.channel === 9 ? undefined : patchFor(program, region.channel + 1);
          const range = region.channel === 9 ? { semitones: 0, rpn: false } : bendRangeFor(patch);
          const widest = Math.max(...bent.flatMap((n) => [Math.abs((n.cents ?? 0) / 100), ...(n.slide ?? []).map((x) => Math.abs(x.semitones))]));
          const chords = item.notes.some((n, k) => item.notes.some((m, j) => j !== k && m.tick === n.tick));
          if (chords || widest > range.semitones + 1e-9) {
            return fail("BEND_RANGE", chords ? "slides need a single-note line: a pitch bend moves every note on the channel"
              : `${patch ?? "this instrument"} bends ±${range.semitones} semitones; the notes bend ${Math.round(widest * 100) / 100}`, true, { detail: item.region });
          }
          const line = item.notes.map((n) => ({ startTick: n.tick, durationTicks: n.length, pitch: n.pitch, velocity: n.velocity,
            ...(n.slide ? { slide: n.slide } : {}), ...(n.cents !== undefined ? { cents: n.cents } : {}) }));
          expression = { bends: bendsForLine(line, range.semitones, 0, 960, 120), ...(range.rpn ? { controllers: rpnBendRange(range.semitones) } : {}) };
        }
        project = withMidiNotes(project, region, {
          program, length: item.length, ...expression,
          notes: item.notes.map(({ slide: _slide, cents: _cents, ...n }) => ({ ...n, channel: region.channel })),
        });
      }
      input.regions.forEach((region, i) => {
        project = withPlacement(project, placements[i]!, { tick: region.tick, track: region.track });
      });
      const records = project.records.slice();
      for (const [i, region] of input.regions.entries()) {
        const sample = samples[i]!;
        const at = regionRecords(project, placements[i]!.region);
        if (at.file < 0 || at.region < 0) return fail("DONOR_INVALID", `the donor has no file/region records for region ${placements[i]!.region}`);
        const fileRecord = writeAudioFile(records[at.file]!.payload, {
          filename: sample.file, frames: sample.info.frames, rate: sample.info.rate, channels: sample.info.channels, bits: sample.info.bits,
          fileSize: sample.size, folder: AUDIO_FOLDER,
        });
        if (!fileRecord.ok) return fail("DONOR_INVALID", fileRecord.error.message);
        records[at.file] = { ...records[at.file]!, payload: fileRecord.value };
        records[at.region] = {
          ...records[at.region]!,
          payload: writeAudioRegion(records[at.region]!.payload, { name: region.name ?? sample.file.replace(/\.wav$/i, ""), frames: sample.info.frames }),
        };
      }
      // the song must cover every region, or GarageBand stops playback and export at the donor's old end
      const bpm = projectTempo(project) ?? 120;
      const ends = [
        ...input.regions.map((r, i) => r.tick + Math.ceil((samples[i]!.info.frames / samples[i]!.info.rate) * (bpm / 60) * TICKS_PER_BEAT)),
        ...(input.midi ?? []).map((m) => m.length),
      ];
      const end = Math.ceil(Math.max(...ends) / TICKS_PER_BAR) * TICKS_PER_BAR;
      // the Song record stores 38400 + ticks in 32 bits: past this, setUint32 would wrap silently
      if (!(end <= MAX_SONG_TICKS)) return fail("INPUT_INVALID", `the song would end after ${MAX_SONG_TICKS} ticks; place the regions earlier or use shorter WAVs`);
      const trimmed = withoutRegionsFrom({ ...project, records }, input.regions.length);
      const projectData = serializeProjectData(withSongLength(trimmed, Math.max(songLength(trimmed), end)));

      // ---- write: only after the plan succeeded ----
      writing = true;
      try {
        mkdirSync(input.out); // the claim: a new, empty folder, or another build took the name meanwhile
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          return fail("OUT_EXISTS", "the output name was taken while the build was planned; choose a new name (files are never overwritten)");
        }
        return fail("WRITE_FAILED", "the output folder cannot be made; nothing was written", true, { detail: (e as NodeJS.ErrnoException).code ?? "unknown" });
      }
      try {
        copyDonor(input.donor, input.out, SKIPPED);
        const media = join(input.out, "Media");
        if (!existsSync(media)) mkdirSync(media);
        mkdirSync(join(media, AUDIO_FOLDER));
        for (const s of samples) {
          const wav = sampleBytes(s.source, maxWavBytes);
          if (!wav.ok || wav.bytes.length !== s.size) throw new Error(`${s.file} changed while the build ran`);
          writeFileSync(join(media, AUDIO_FOLDER, s.file), wav.bytes, { flag: "wx" });
        }
        await plutil(["-replace", "AudioFiles", "-json", JSON.stringify(samples.map((s) => `${AUDIO_FOLDER}/${s.file}`)), join(input.out, ...META_DATA)]);
        // last: without ProjectData GarageBand cannot open a half-built package
        writeFileSync(join(input.out, ...PROJECT_DATA), projectData, { flag: "wx" });
      } catch (e) {
        return fail("WRITE_FAILED", "the build stopped while writing; a partial project is left under the new name", false, {
          written: true, detail: e instanceof Error ? e.name : typeof e, // the raw message can hold paths
        });
      }

      return ok({ out: input.out, regions: input.regions.map((r, i) => ({ track: r.track, tick: r.tick, file: samples[i]!.file, frames: samples[i]!.info.frames })) });
    } catch (e) {
      // the raw message can hold paths: only the error's class travels
      const detail = e instanceof Error ? e.name : typeof e;
      // a throw while planning is a donor record shorter or stranger than probed; nothing was written
      if (!writing) return fail("DONOR_INVALID", "the donor's records are damaged or not in the probed layout; use a .band that GarageBand saved", true, { detail });
      return fail("UNKNOWN_ERROR", "the build failed unexpectedly", false, { detail, written: true });
    }
  }
}
