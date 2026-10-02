// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ok, err, type Result } from "../result.js";
import { GM_PATCH_MAP, GM_DRUM_KIT_MAP } from "../knowledge/gm-patch-map.js";
import { parseBinaryPlist } from "./bplist.js";
import { cleanText } from "./text.js";

export type PatchKind = "instrument" | "drum_kit" | "audio" | "aux" | "output" | "other";
/** Install evidence for a patch's sample content (heuristic: pack name vs installed asset-pack receipts). */
export type ContentEvidence = "base" | "receipt_found" | "no_receipt_match" | "unknown";
export type PatchSource = "factory" | "user";
export type PatchRoot = { dir: string; source: PatchSource };

export type PatchEntry = {
  name: string;
  category: string;
  kind: PatchKind;
  source: PatchSource;
  packs: string[];
  content: ContentEvidence;
  /** GM programs that load this patch when GarageBand opens a MIDI file (no UI needed). */
  gmPrograms: number[];
  /** Channel-10 GM kit programs that load this patch. */
  gmDrumKits: number[];
  path: string;
};

export const PATCH_FIELDS = ["name", "category", "kind", "source", "packs", "content", "gmPrograms", "gmDrumKits", "path"] as const;

/** GarageBand shows "Epic Electro GB.patch" as "Epic Electro": a trailing " GB" is a file suffix, not part of the name. */
export const displayName = (stem: string): string => stem.replace(/ GB$/, "");

/** GarageBand hides "zNN "/"NN " sort prefixes on library folders ("z01 Arpeggiator" → "Arpeggiator", "04 Voice" → "Voice"). */
export const displayCategory = (segments: readonly string[]): string =>
  segments.map((s) => s.replace(/^z?\d{2} /, "")).join(" > ");

const DRUM_CATEGORIES = new Set(["Drum Kit", "Electronic Drum Kit"]);
const MAX_DEPTH = 8;
const METADATA = "com.apple.musicapps.metadata.plist";

function kindOf(top: string, category: string): PatchKind {
  if (top === "Instrument") return DRUM_CATEGORIES.has(category.split(" > ")[0] ?? "") ? "drum_kit" : "instrument";
  if (top === "Audio") return "audio";
  if (top === "Aux") return "aux";
  if (top === "Output") return "output";
  return "other";
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function evidence(packs: string[] | null, receipts: readonly string[] | null): ContentEvidence {
  if (packs === null) return "unknown";
  if (packs.length === 0) return "base";
  if (receipts === null) return "unknown";
  const installed = receipts.map(normalize);
  return packs.every((p) => installed.some((r) => r.includes(normalize(p)))) ? "receipt_found" : "no_receipt_match";
}

function readPacks(patchDir: string): string[] | null {
  const file = join(patchDir, METADATA);
  if (!existsSync(file)) return [];
  const parsed = parseBinaryPlist(readFileSync(file));
  if (!parsed.ok) return null;
  const names = (parsed.value as { PackageNames?: unknown }).PackageNames;
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === "string").map((n) => cleanText(n, 80)) : [];
}

function programsByPatch(): { melodic: Map<string, number[]>; kits: Map<string, number[]> } {
  const melodic = new Map<string, number[]>();
  for (const [program, entry] of Object.entries(GM_PATCH_MAP)) {
    melodic.set(entry.patch, [...(melodic.get(entry.patch) ?? []), Number(program)]);
  }
  const kits = new Map<string, number[]>();
  for (const [program, patch] of Object.entries(GM_DRUM_KIT_MAP)) kits.set(patch, [...(kits.get(patch) ?? []), Number(program)]);
  return { melodic, kits };
}

/** Walk the patch library roots (read-only). Symlinks are never followed. */
/** `receipts: null` = installed-pack receipts couldn't be read: pack-dependent patches get content "unknown". */
export function scanPatchLibrary(roots: readonly PatchRoot[], opts: { receipts: readonly string[] | null }): Result<PatchEntry[], string> {
  const present = roots.filter((r) => existsSync(r.dir));
  if (present.length === 0) return err(`no patch library found at: ${roots.map((r) => r.dir).join(", ")}`);
  const gm = programsByPatch();
  const found: (PatchEntry & { top: string })[] = [];

  const walk = (root: PatchRoot, dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (!entry.name.endsWith(".patch")) {
        walk(root, full, depth + 1);
        continue;
      }
      const segments = relative(root.dir, full).split(sep);
      const top = segments[0] ?? "";
      const category = displayCategory(segments.slice(1, -1));
      const name = cleanText(displayName(entry.name.slice(0, -".patch".length)));
      const packs = readPacks(full);
      found.push({
        top,
        name,
        category,
        kind: kindOf(top, category),
        source: root.source,
        packs: packs ?? [],
        content: evidence(packs, opts.receipts),
        gmPrograms: gm.melodic.get(name) ?? [],
        gmDrumKits: gm.kits.get(name) ?? [],
        path: full,
      });
    }
  };
  for (const root of present) walk(root, root.dir, 0);

  found.sort((a, b) => a.top.localeCompare(b.top) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
  return ok(found.map(({ top: _top, ...entry }) => entry));
}

export type PatchFilter = {
  query?: string | undefined;
  category?: string | undefined;
  kind?: PatchKind | undefined;
  source?: PatchSource | undefined;
  gmReachable?: boolean | undefined;
};

export function filterPatches(entries: readonly PatchEntry[], f: PatchFilter): PatchEntry[] {
  const q = f.query?.toLowerCase();
  const cat = f.category?.toLowerCase();
  return entries.filter((p) =>
    (q === undefined || p.name.toLowerCase().includes(q)) &&
    (cat === undefined || p.category.toLowerCase().startsWith(cat)) &&
    (f.kind === undefined || p.kind === f.kind) &&
    (f.source === undefined || p.source === f.source) &&
    (f.gmReachable === undefined || (p.gmPrograms.length + p.gmDrumKits.length > 0) === f.gmReachable));
}
