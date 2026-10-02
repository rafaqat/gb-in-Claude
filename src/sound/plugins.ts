// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cleanText } from "./text.js";

export type PluginKind = "instrument" | "effect" | "midi_effect" | "generator" | "other";
export type PluginEntry = { kind: PluginKind; type: string; subtype: string; manufacturerCode: string; manufacturer: string; name: string };
export const PLUGIN_FIELDS = ["kind", "type", "subtype", "manufacturerCode", "manufacturer", "name"] as const;

const KIND: Record<string, PluginKind> = { aumu: "instrument", aufx: "effect", aumf: "midi_effect", aumi: "midi_effect", augn: "generator" };

/** `auval -a` line: "aumu dls  appl  -  Apple: DLSMusicDevice" (codes are fixed 4-char fields). */
const LINE = /^([a-z]{4}) (.{4}) (.{4})\s+-\s+(.+)$/;

export function parseAuvalList(text: string): PluginEntry[] {
  const units: PluginEntry[] = [];
  for (const line of text.split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    const [, type, subtype, manufacturerCode, label] = m as unknown as [string, string, string, string, string];
    const colon = label.indexOf(": ");
    units.push({
      kind: KIND[type] ?? "other",
      type,
      subtype: cleanText(subtype, 8),
      manufacturerCode: cleanText(manufacturerCode, 8),
      manufacturer: cleanText(colon >= 0 ? label.slice(0, colon) : "", 60),
      name: cleanText(colon >= 0 ? label.slice(colon + 2) : label, 80),
    });
  }
  return units;
}

/** Third-party AU bundles present in the standard plug-in folders (installed ≠ registered; auval is authoritative). */
export function scanComponentBundles(dirs: readonly string[]): { name: string; path: string }[] {
  return dirs.flatMap((dir) =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.isSymbolicLink() && e.name.endsWith(".component"))
          .map((e) => ({ name: cleanText(e.name.slice(0, -".component".length)), path: join(dir, e.name) }))
      : []);
}

export type PluginFilter = { query?: string | undefined; kind?: PluginKind | undefined; manufacturer?: string | undefined };

export function filterPlugins(units: readonly PluginEntry[], f: PluginFilter): PluginEntry[] {
  const q = f.query?.toLowerCase();
  const maker = f.manufacturer?.toLowerCase();
  return units.filter((u) =>
    (q === undefined || u.name.toLowerCase().includes(q)) &&
    (f.kind === undefined || u.kind === f.kind) &&
    (maker === undefined || u.manufacturer.toLowerCase().includes(maker)));
}
