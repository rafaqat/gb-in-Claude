// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { z } from "zod";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, err, type Result } from "../result.js";
import { verified, failed, type Envelope } from "./envelope.js";
import { guarded } from "./tool-result.js";
import { ROLES } from "../song/schema.js";
import { STYLE_NAMES } from "../song/styles.js";
import { PRODUCTION_RUBRIC } from "../knowledge/production.js";
import { scanPatchLibrary, filterPatches, PATCH_FIELDS, type PatchEntry, type PatchRoot } from "../sound/patches.js";
import { parseAuvalList, scanComponentBundles, filterPlugins, PLUGIN_FIELDS, type PluginEntry } from "../sound/plugins.js";
import { openLoopsDb, LOOP_FIELDS, type LoopsDb } from "../sound/loops.js";
import { listSamples, SAMPLE_FIELDS } from "../sound/samples.js";
import { buildPalette } from "../sound/palette.js";
import { paginate, projectFields, clampLimit, clampOffset, MAX_LIMIT } from "../sound/page.js";

// ---------- Spec ----------

/** Agent-supplied text: bounded, no control characters. */
const Text = z.string().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]*$/, "no control characters");
const Page = {
  fields: z.array(z.string().max(40)).max(20).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).max(1_000_000).optional(),
};

export const GbSoundInput = z.discriminatedUnion("command", [
  z.object({ command: z.literal("patches"), query: Text.optional(), category: Text.optional(),
    kind: z.enum(["instrument", "drum_kit", "audio", "aux", "output", "other"]).optional(),
    source: z.enum(["factory", "user"]).optional(), gmReachable: z.boolean().optional(), ...Page }).strict(),
  z.object({ command: z.literal("plugins"), query: Text.optional(),
    kind: z.enum(["instrument", "effect", "midi_effect", "generator", "other"]).optional(),
    manufacturer: Text.optional(), ...Page }).strict(),
  z.object({ command: z.literal("loops"), query: Text.optional(), key: Text.optional(),
    tempoMin: z.number().int().min(1).max(999).optional(), tempoMax: z.number().int().min(1).max(999).optional(),
    genre: Text.optional(), instrument: Text.optional(), descriptors: z.array(Text).max(6).optional(),
    hasMidi: z.boolean().optional(), pack: Text.optional(), installedOnly: z.boolean().optional(), ...Page }).strict(),
  z.object({ command: z.literal("samples"), query: Text.optional(), ...Page }).strict(),
  z.object({ command: z.literal("palette"), style: z.enum(STYLE_NAMES).optional(), role: z.enum(ROLES).optional(), ...Page }).strict(),
]);
export type GbSoundInput = z.infer<typeof GbSoundInput>;
export const GB_SOUND_COMMANDS = ["patches", "plugins", "loops", "samples", "palette"] as const;

/** Only these binaries can be run, by absolute path, with argv (no shell). */
const ALLOWED_COMMANDS: Record<string, string> = { auval: "/usr/bin/auval", pkgutil: "/usr/sbin/pkgutil" };
export type CommandRunner = (cmd: "auval" | "pkgutil", args: string[], timeoutMs: number) => Promise<Result<string, string>>;

export type GbSoundDeps = {
  /** Share one catalog with gb_tracks set_instrument (it only loads installed content). */
  patchCatalog?: () => Promise<Result<PatchEntry[], string>>;
  workspaceDir: string;
  patchRoots?: PatchRoot[];
  loopsDbPath?: string;
  componentDirs?: string[];
  run?: CommandRunner;
};

export const defaultSoundPaths = () => ({
  patchRoots: [
    { dir: "/Applications/GarageBand.app/Contents/Resources/Patches", source: "factory" as const },
    { dir: join(homedir(), "Music/Audio Music Apps/Patches"), source: "user" as const },
  ],
  loopsDbPath: join(homedir(), "Music/Audio Music Apps/Databases/LoopsDatabaseV10.db"),
  componentDirs: ["/Library/Audio/Plug-Ins/Components", join(homedir(), "Library/Audio/Plug-Ins/Components")],
});

const execRunner: CommandRunner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    const bin = ALLOWED_COMMANDS[cmd];
    if (!bin) return resolve(err(`command not allowed: ${cmd}`));
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (e, stdout) =>
      resolve(e ? err(`${cmd} failed: ${e.message.split("\n")[0]}`) : ok(stdout)));
  });

// ---------- Handler ----------

const AUVAL_TIMEOUT_MS = 20_000;
const PKGUTIL_TIMEOUT_MS = 20_000;

export type PatchCatalog = () => Promise<Result<PatchEntry[], string>>;

/** The installed patch catalog, scanned once per process (read-only; changes only when content is installed). */
export function createPatchCatalog(deps: Pick<GbSoundDeps, "patchRoots" | "run"> = {}): PatchCatalog {
  const patchRoots = deps.patchRoots ?? defaultSoundPaths().patchRoots;
  const run = deps.run ?? execRunner;
  let patches: Promise<Result<PatchEntry[], string>> | undefined;
  return () => (patches ??= run("pkgutil", ["--pkgs"], PKGUTIL_TIMEOUT_MS).then((receipts) =>
    scanPatchLibrary(patchRoots, { receipts: receipts.ok ? receipts.value.split("\n").filter(Boolean) : null })));
}

export function createGbSound(deps: GbSoundDeps) {
  const defaults = defaultSoundPaths();
  const patchRoots = deps.patchRoots ?? defaults.patchRoots;
  const loopsDbPath = deps.loopsDbPath ?? defaults.loopsDbPath;
  const componentDirs = deps.componentDirs ?? defaults.componentDirs;
  const run = deps.run ?? execRunner;

  // Per-process caches: the catalog is read-only and changes only when content is installed.
  let plugins: Promise<Result<PluginEntry[], string>> | undefined;
  let loops: Result<LoopsDb, string> | undefined;

  const getPatches = deps.patchCatalog ?? createPatchCatalog({ patchRoots, run });
  const getPlugins = () =>
    (plugins ??= run("auval", ["-a"], AUVAL_TIMEOUT_MS).then((out) => (out.ok ? ok(parseAuvalList(out.value)) : out)));
  const getLoops = () => (loops ??= openLoopsDb(loopsDbPath));

  async function handle(cmd: GbSoundInput): Promise<Envelope> {
    const op = `gb_sound.${cmd.command}`;
    const page = { limit: cmd.limit, offset: cmd.offset, fields: cmd.fields };
    switch (cmd.command) {
      case "patches": {
        const all = await getPatches();
        if (!all.ok) return failed(op, "CATALOG_UNAVAILABLE", all.error, { hint: "is GarageBand installed in /Applications?" });
        const out = paginate(filterPatches(all.value, cmd), page, PATCH_FIELDS);
        return out.ok ? verified(op, out.value) : failed(op, "INPUT_INVALID", out.error);
      }
      case "plugins": {
        const all = await getPlugins();
        if (!all.ok) return failed(op, "CATALOG_UNAVAILABLE", all.error, { hint: "auval lists Audio Units; it ships with macOS" });
        const out = paginate(filterPlugins(all.value, cmd), page, PLUGIN_FIELDS);
        if (!out.ok) return failed(op, "INPUT_INVALID", out.error);
        return verified(op, { ...out.value, thirdPartyBundles: scanComponentBundles(componentDirs) });
      }
      case "loops": {
        const fieldsOk = projectFields([], cmd.fields, LOOP_FIELDS);
        if (!fieldsOk.ok) return failed(op, "INPUT_INVALID", fieldsOk.error);
        const db = getLoops();
        if (!db.ok) {
          return failed(op, "CATALOG_UNAVAILABLE", db.error,
            { hint: "open GarageBand once so it builds its Apple Loops index (~/Music/Audio Music Apps/Databases)" });
        }
        const limit = clampLimit(cmd.limit);
        const offset = clampOffset(cmd.offset);
        const { command: _c, fields: _f, limit: _l, offset: _o, ...filter } = cmd;
        const res = db.value.query(filter, { limit, offset });
        if (!res.ok) return failed(op, res.error.startsWith("key ") ? "INPUT_INVALID" : "CATALOG_UNAVAILABLE", res.error);
        const items = projectFields(res.value.items, cmd.fields, LOOP_FIELDS);
        if (!items.ok) return failed(op, "INPUT_INVALID", items.error);
        const warnings = res.value.total === 0 && cmd.genre
          ? [`no loops matched genre "${cmd.genre}"; known genres: ${db.value.genres().join(", ")}`]
          : undefined;
        return verified(op, { total: res.value.total, offset, limit, returned: items.value.length, items: items.value }, warnings);
      }
      case "samples": {
        const list = listSamples(deps.workspaceDir, cmd);
        if (!list.ok) return failed(op, "PATH_OUTSIDE_WORKSPACE", list.error, { recoverable: false });
        const out = paginate(list.value, page, SAMPLE_FIELDS);
        return out.ok ? verified(op, out.value) : failed(op, "INPUT_INVALID", out.error);
      }
      case "palette": {
        const all = await getPatches();
        const entries = buildPalette(all.ok ? all.value : [], cmd);
        const out = paginate(entries, page, ["style", "role", "choices"] as const);
        if (!out.ok) return failed(op, "INPUT_INVALID", out.error);
        return verified(op, out.value, all.ok ? undefined : [`patch library unavailable (${all.error}); inLibrary is false for every choice`]);
      }
    }
  }

  /** Never throws: invalid input → INPUT_INVALID; unexpected errors → CATALOG_UNAVAILABLE. */
  return async function gbSound(input: unknown): Promise<Envelope> {
    const parsed = GbSoundInput.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return failed("gb_sound", "INPUT_INVALID", `${issue.path.join(".") || "command"}: ${issue.message}`,
        { hint: `command must be one of: ${GB_SOUND_COMMANDS.join(", ")}` });
    }
    try {
      return await handle(parsed.data);
    } catch (e) {
      return failed(`gb_sound.${parsed.data.command}`, "CATALOG_UNAVAILABLE", e instanceof Error ? e.message : String(e));
    }
  };
}

// ---------- MCP registration ----------

export function registerSoundTools(server: McpServer, deps: GbSoundDeps): void {
  const gbSound = createGbSound(deps);
  server.registerTool(
    "gb_sound",
    {
      title: "Sound catalog (patches, plug-ins, Apple Loops, samples, palette)",
      description:
        "Read-only catalog of what this Mac can actually play. patches: GarageBand patch library (name, category, kind, " +
        "required content packs + install evidence, GM programs that load it on MIDI open). plugins: Audio Units. loops: " +
        "Apple Loops index (key, tempo, genre, instrument, descriptors, hasMidi). samples: <workspace>/samples. palette: per " +
        "style × role, the sounds to use — GM-program choices first (no UI needed). Every command takes fields + limit " +
        "(default 25, max 200) + offset; results are a page plus total. Read gb://knowledge/production for the rubric.",
      inputSchema: z.object({
        command: z.enum(GB_SOUND_COMMANDS),
        query: z.string().optional().describe("name contains (patches/plugins/loops/samples)"),
        category: z.string().optional().describe("patches: category prefix, e.g. 'Synthesizer > Bass'"),
        kind: z.string().optional().describe("patches: instrument|drum_kit|audio|aux|output; plugins: instrument|effect|midi_effect|generator|other"),
        source: z.enum(["factory", "user"]).optional().describe("patches"),
        gmReachable: z.boolean().optional().describe("patches: only those a GM program loads with no UI"),
        manufacturer: z.string().optional().describe("plugins"),
        key: z.string().optional().describe("loops: e.g. 'F minor', 'Bb major'"),
        tempoMin: z.number().int().optional().describe("loops"),
        tempoMax: z.number().int().optional().describe("loops"),
        genre: z.string().optional().describe("loops: e.g. 'Electronic/Dance', 'Tech House'"),
        instrument: z.string().optional().describe("loops: instrument type or subtype, e.g. 'Drums', 'Synthetic Bass'"),
        descriptors: z.array(z.string()).optional().describe("loops: all must match, e.g. ['Dark','Grooving']"),
        hasMidi: z.boolean().optional().describe("loops: software-instrument (green) loops"),
        pack: z.string().optional().describe("loops: pack name contains"),
        installedOnly: z.boolean().optional().describe("loops: only loops whose audio file is downloaded (recommended)"),
        style: z.string().optional().describe("palette: club-trance | acoustic | orbit-ambient"),
        role: z.string().optional().describe("palette: drums | bass | pad | arp | lead | lead-high | fx"),
        fields: z.array(z.string()).optional().describe("field mask: return only these fields per item"),
        limit: z.number().int().optional().describe("page size, default 25, max 200"),
        offset: z.number().int().optional().describe("page offset"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded("gb_sound", gbSound, false),
  );
  server.registerResource("production", "gb://knowledge/production",
    { description: "Production rubric: sound, expression, arrangement, mix, verify", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: PRODUCTION_RUBRIC }] }));
}
