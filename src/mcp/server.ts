// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodTypeAny } from "zod";
import { createGbSong, GB_SONG_COMMANDS, GbSongInput } from "./gb-song.js";
import { createGbAnalyze, GB_ANALYZE_COMMANDS, ANALYSIS_FIELDS, GbAnalyzeInput } from "./gb-analyze.js";
import type { AnalyzerPort } from "../analysis/analyzer.js";
import type { GmRendererPort } from "../render/gm-renderer.js";
import { ANALYSIS_GUIDE } from "../knowledge/analysis-guide.js";
import { registerSoundTools, GB_SOUND_COMMANDS, GbSoundInput, createPatchCatalog, type PatchCatalog } from "./gb-sound.js";
import { registerSystemTools, GbSystemInput, type GbSystemDeps, type ToolRegistry } from "./gb-system.js";
import { registerGarageBandTools } from "./gb-garageband.js";
import { GB_PROJECT_COMMANDS, GbProjectInput, type ProjectScripts } from "../garageband/project.js";
import { GB_EXPORT_COMMANDS, GbExportInput } from "../garageband/export.js";
import { GB_TRACKS_COMMANDS, GbTracksInput } from "../garageband/tracks.js";
import { GB_TRANSPORT_COMMANDS, GbTransportInput } from "../garageband/transport.js";
import { GB_MIX_COMMANDS, GbMixInput } from "../garageband/mix.js";
import { registerSchemaResources } from "../knowledge/schemas.js";
import { GM_PATCH_MAP, GM_DRUM_KIT_MAP, patchFor } from "../knowledge/gm-patch-map.js";
import { SONG_FORMAT_GUIDE } from "../knowledge/song-format.js";
import { STYLES } from "../song/styles.js";
import { guarded } from "./tool-result.js";

export const SERVER_VERSION = "0.1.0";

const json = (uri: string, value: unknown) => ({ contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }] });

export type GarageBandOptions = {
  scripts: ProjectScripts; openFile: (path: string) => Promise<unknown>; inboxDir: string; defaultExportDir?: string;
  /** Defaults to reading the console session's lock flag (tests pass a constant). */
  screenLocked?: () => Promise<boolean>;
};
export type ServerOptions = {
  workspaceDir: string; analyzer?: AnalyzerPort; gmRenderer?: GmRendererPort; system?: GbSystemDeps; garageband?: GarageBandOptions;
  /** The installed patch catalog shared by gb_sound and gb_tracks set_instrument (default: scan this Mac). */
  patchCatalog?: PatchCatalog;
};

export function createServer(opts: ServerOptions): McpServer {
  const server = new McpServer({ name: "gb-mcp", version: SERVER_VERSION });
  const patchCatalog = opts.patchCatalog ?? createPatchCatalog();
  const live = Boolean(opts.system && opts.garageband);
  const gbSong = createGbSong({ workspaceDir: opts.workspaceDir, ...(opts.gmRenderer ? { gmRenderer: opts.gmRenderer } : {}) });

  server.registerTool(
    "gb_song",
    {
      title: "Compose a song (Song JSON → MIDI)",
      description:
        "Compose for GarageBand without touching it. validate: parse + musical checks + which GarageBand patch each " +
        "track gets. preview: ASCII 16th-note grid of one section. render_midi: humanize and write a Type-1 MIDI file " +
        "into the workspace (never overwrites; dry_run writes nothing). render_draft: quick WAV via the macOS GM synth " +
        "(structure checks only, not tone). Read gb://knowledge/song-format first.",
      inputSchema: z.object({
        command: z.enum(GB_SONG_COMMANDS),
        song: z.any().describe("Song JSON — see gb://knowledge/song-format"),
        section: z.string().optional().describe("preview: section name"),
        maxBars: z.number().int().optional().describe("preview: limit bars shown"),
        filename: z.string().optional().describe("render_midi: e.g. ascent-v2.mid · render_draft: e.g. ascent-draft.wav (no paths)"),
        dry_run: z.boolean().optional().describe("render_midi / render_draft: validate and plan without writing"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded("gb_song", gbSong, true),
  );

  if (opts.analyzer) {
    const gbAnalyze = createGbAnalyze({ workspaceDir: opts.workspaceDir, analyzer: opts.analyzer });
    server.registerTool(
      "gb_analyze",
      {
        title: "Listen to an export (measure, flag, suggest)",
        description:
          "Measure audio in the workspace: loudness/true peak (BS.1770), tonal balance & tilt (tinny?), stereo width, " +
          "tempo, sidechain pump, key, per-section metrics, flags and suggestions pointing at Song JSON paths, plus a " +
          "spectrogram PNG path you can open. audio: a file · against_song: + song for sections/tempo/key intent · " +
          "compare: before vs after. Read gb://knowledge/analysis.",
        inputSchema: z.object({
          command: z.enum(GB_ANALYZE_COMMANDS),
          path: z.string().optional().describe("audio/against_song: WAV/AIFF/FLAC inside the workspace, e.g. exports/ascent.wav"),
          song: z.any().optional().describe("against_song/compare: Song JSON for sections, tempo, key"),
          before: z.string().optional().describe("compare: earlier export"),
          after: z.string().optional().describe("compare: later export"),
          spectrogram: z.boolean().optional().describe("write a spectrogram PNG (default true)"),
          fields: z.array(z.enum(ANALYSIS_FIELDS)).optional().describe("limit the response to these top-level fields"),
        }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      guarded("gb_analyze", gbAnalyze, true),
    );
    server.registerResource("analysis", "gb://knowledge/analysis",
      { description: "How to read gb_analyze metrics and run the listen → change → compare loop", mimeType: "text/markdown" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: ANALYSIS_GUIDE }] }));
  }

  registerSoundTools(server, { workspaceDir: opts.workspaceDir, patchCatalog });

  if (opts.system) {
    const registry: ToolRegistry = {
      gb_song: { description: "compose: Song JSON → validate / preview / MIDI / GM draft", commands: GB_SONG_COMMANDS },
      gb_sound: { description: "read-only catalog: patches, plugins, loops, samples, palette", commands: GB_SOUND_COMMANDS },
      ...(opts.analyzer ? { gb_analyze: { description: "listen: measure, flag and compare exports", commands: GB_ANALYZE_COMMANDS } } : {}),
      ...(opts.garageband ? {
        gb_project: { description: "open a rendered song in GarageBand (safe backups) / read the project", commands: GB_PROJECT_COMMANDS },
        gb_export: { description: "export the open song as WAVE into the workspace", commands: GB_EXPORT_COMMANDS },
        gb_tracks: { description: "tracks: list, select (real click), mute/solo, load an installed Library patch", commands: GB_TRACKS_COMMANDS },
        gb_transport: { description: "transport: state, play/stop/rewind, tempo, metronome, count-in", commands: GB_TRANSPORT_COMMANDS },
        gb_mix: { description: "mix: track faders (raw / measured dB) and pan", commands: GB_MIX_COMMANDS },
      } : {}),
    };
    registerSystemTools(server, { ...opts.system, toolRegistry: { ...registry, ...(opts.system.toolRegistry ?? {}) } });
    if (opts.garageband) {
      registerGarageBandTools(server, { workspaceDir: opts.workspaceDir, helper: opts.system.helper, patchCatalog, ...opts.garageband });
    }
  }

  server.registerResource("song-format", "gb://knowledge/song-format",
    { description: "Song JSON reference, part notation, and common mistakes", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: SONG_FORMAT_GUIDE }] }));

  server.registerResource("styles", "gb://knowledge/styles",
    { description: "Style presets: GM program and GarageBand patch per role", mimeType: "application/json" },
    async (uri) => json(uri.href, Object.fromEntries(Object.entries(STYLES).map(([name, s]) => [name, {
      ...s,
      patches: Object.fromEntries(Object.entries(s.programs).map(([role, p]) => [role, patchFor(p, role === "drums" ? 10 : 1)])),
    }]))));

  server.registerResource("gm-patch-map", "gb://knowledge/gm-patch-map",
    { description: "GM program → GarageBand 10.4.14 patch (probed); drum kits on channel 10", mimeType: "application/json" },
    async (uri) => json(uri.href, { melodic: GM_PATCH_MAP, drumKits: GM_DRUM_KIT_MAP }));

  const schemas: Record<string, ZodTypeAny> = {
    gb_song: GbSongInput, gb_sound: GbSoundInput,
    ...(opts.analyzer ? { gb_analyze: GbAnalyzeInput } : {}),
    ...(opts.system ? { gb_system: GbSystemInput } : {}),
    ...(live ? { gb_project: GbProjectInput, gb_export: GbExportInput, gb_tracks: GbTracksInput, gb_transport: GbTransportInput, gb_mix: GbMixInput } : {}),
  };
  registerSchemaResources(server, { tools: schemas });

  return server;
}
