// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGbSound, type GbSoundDeps } from "./gb-sound.js";
import { ok, err } from "../result.js";

const fixture = (p: string) => fileURLToPath(new URL(`../../test/fixtures/sound/${p}`, import.meta.url));
const AUVAL = readFileSync(fixture("auval-a.txt"), "utf8");
const RECEIPTS = "com.apple.pkg.MAContent10_AssetPack_0815_EXS_ElectronicDrumkitsHardwellHeavyIndustry\n";

let workspace: string;
let calls: string[];
let deps: GbSoundDeps;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "gbsound-h-"));
  calls = [];
  deps = {
    workspaceDir: workspace,
    patchRoots: [{ dir: fixture("patches/factory"), source: "factory" }, { dir: fixture("patches/user"), source: "user" }],
    loopsDbPath: fixture("loops-fixture.db"),
    componentDirs: [fixture("components")],
    run: async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "auval") return ok(AUVAL);
      if (cmd === "pkgutil") return ok(RECEIPTS);
      return err(`unexpected command ${cmd}`);
    },
  };
});

describe("gb_sound patches", () => {
  it("returns a verified page with total, honouring the field mask", async () => {
    const r = await createGbSound(deps)({ command: "patches", gmReachable: true, fields: ["name", "gmPrograms", "gmDrumKits"] });
    expect(r).toEqual({ status: "verified", op: "gb_sound.patches", data: {
      total: 3, offset: 0, limit: 25, returned: 3,
      items: [
        { name: "Epic Electro", gmPrograms: [], gmDrumKits: [16] },
        { name: "Taureg Moon Bass", gmPrograms: [39], gmDrumKits: [] },
        { name: "Soft Saw Lead", gmPrograms: [81], gmDrumKits: [] },
      ],
    } });
  });

  it("uses package receipts as content evidence", async () => {
    const r = await createGbSound(deps)({ command: "patches", kind: "drum_kit", fields: ["name", "content"] });
    expect(r.status === "verified" && r.data).toMatchObject({ items: [{ name: "Epic Electro", content: "receipt_found" }] });
  });

  it("fails CATALOG_UNAVAILABLE when no patch library exists", async () => {
    const r = await createGbSound({ ...deps, patchRoots: [{ dir: "/nonexistent", source: "factory" }] })({ command: "patches" });
    expect(r).toMatchObject({ status: "failed", error: "CATALOG_UNAVAILABLE", write_attempted: false });
  });
});

describe("gb_sound plugins", () => {
  it("lists registered Audio Units (auval, cached per process) plus third-party bundles on disk", async () => {
    const gbSound = createGbSound(deps);
    const r = await gbSound({ command: "plugins", kind: "instrument", fields: ["name"] });
    expect(r.status === "verified" && r.data).toMatchObject({
      total: 3, items: [{ name: "DLSMusicDevice" }, { name: "AUMIDISynth" }, { name: "AUSampler" }],
      thirdPartyBundles: [{ name: "Vital" }],
    });
    await gbSound({ command: "plugins" });
    expect(calls.filter((c) => c.startsWith("auval"))).toEqual(["auval -a"]);
  });

  it("fails CATALOG_UNAVAILABLE when auval cannot run", async () => {
    const r = await createGbSound({ ...deps, run: async () => err("spawn auval ENOENT") })({ command: "plugins" });
    expect(r).toMatchObject({ status: "failed", error: "CATALOG_UNAVAILABLE" });
  });
});

describe("gb_sound loops", () => {
  it("queries the loops index read-only with filters and paging", async () => {
    const r = await createGbSound(deps)({ command: "loops", key: "F minor", limit: 1, fields: ["name", "key"] });
    expect(r).toEqual({ status: "verified", op: "gb_sound.loops", data: {
      total: 2, offset: 0, limit: 1, returned: 1, items: [{ name: "Dark's 'Edge' % Bass", key: "F minor" }],
    } });
  });

  it("maps a bad key to INPUT_INVALID with guidance", async () => {
    const r = await createGbSound(deps)({ command: "loops", key: "H lydian" });
    expect(r).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
    expect(r.status === "failed" && r.message).toContain("F minor");
  });

  it("fails CATALOG_UNAVAILABLE (with a hint) when the loops database is missing", async () => {
    const r = await createGbSound({ ...deps, loopsDbPath: "/nonexistent/LoopsDatabaseV10.db" })({ command: "loops" });
    expect(r).toMatchObject({ status: "failed", error: "CATALOG_UNAVAILABLE" });
    expect(r.status === "failed" && r.hint).toContain("GarageBand");
  });
});

describe("gb_sound loops: zero-result guidance", () => {
  it("warns with the known genres when a genre filter matches nothing", async () => {
    const r = await createGbSound(deps)({ command: "loops", genre: "Electronic", limit: 3 });
    expect(r.status).toBe("verified");
    if (r.status !== "verified") return;
    expect((r.data as { total: number }).total).toBe(0);
    expect(r.warnings?.[0]).toMatch(/no loops matched genre "Electronic"; known genres: .*Electronic\/Dance/);
  });
});

describe("gb_sound samples", () => {
  it("lists workspace samples", async () => {
    mkdirSync(join(workspace, "samples"));
    writeFileSync(join(workspace, "samples", "kick.wav"), "RIFF");
    const r = await createGbSound(deps)({ command: "samples", fields: ["relPath"] });
    expect(r.status === "verified" && r.data).toMatchObject({ total: 1, items: [{ relPath: "kick.wav" }] });
  });

  it("refuses a symlinked samples folder with PATH_OUTSIDE_WORKSPACE", async () => {
    symlinkSync("/tmp", join(workspace, "samples"));
    const r = await createGbSound(deps)({ command: "samples" });
    expect(r).toMatchObject({ status: "failed", error: "PATH_OUTSIDE_WORKSPACE" });
  });
});

describe("gb_sound palette", () => {
  it("returns style × role choices", async () => {
    const r = await createGbSound(deps)({ command: "palette", style: "orbit-ambient", role: "pad" });
    if (r.status !== "verified") throw new Error(JSON.stringify(r));
    const data = r.data as { total: number; items: { style: string; role: string; choices: { patch: string; via: string; program?: number }[] }[] };
    expect(data.total).toBe(1);
    expect(data.items[0]).toMatchObject({ style: "orbit-ambient", role: "pad" });
    expect(data.items[0]!.choices[0]).toMatchObject({ patch: "String Ensemble", via: "gm_program", program: 48 });
  });
});

describe("gb_sound input hardening", () => {
  it.each([
    ["unknown command", { command: "delete_loops" }],
    ["unknown field in mask", { command: "patches", fields: ["name", "secret"] }],
    ["limit above 200", { command: "loops", limit: 500 }],
    ["control characters in query", { command: "loops", query: "bass\u0000" }],
    ["unknown style", { command: "palette", style: "polka" }],
  ])("rejects %s with INPUT_INVALID", async (_label, input) => {
    const r = await createGbSound(deps)(input);
    expect(r).toMatchObject({ status: "failed", error: "INPUT_INVALID", write_attempted: false });
  });
});

describe("registerSoundTools (MCP)", () => {
  it("exposes gb_sound as a read-only tool and serves the production rubric", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { registerSoundTools } = await import("./gb-sound.js");
    const server = new McpServer({ name: "t", version: "0" });
    registerSoundTools(server, deps);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);

    const tool = (await client.listTools()).tools.find((t) => t.name === "gb_sound");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });

    const r = await client.callTool({ name: "gb_sound", arguments: { command: "patches", query: "taureg", fields: ["name"] } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ status: "verified", data: { items: [{ name: "Taureg Moon Bass" }] } });

    const bad = await client.callTool({ name: "gb_sound", arguments: { command: "loops", key: "H lydian" } });
    expect(bad.isError).toBe(true);

    const rubric = await client.readResource({ uri: "gb://knowledge/production" });
    const text = (rubric.contents[0] as { text: string }).text;
    expect(text).toContain("Production rubric");
    expect(text).toContain("no_receipt_match");
    expect(text).toContain("gb_analyze");
  });
});
