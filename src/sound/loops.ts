// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { existsSync } from "node:fs";
import { ok, err, type Result } from "../result.js";
import { cleanText } from "./text.js";

export type LoopScale = "major" | "minor" | "neither" | "both";
export type LoopEntry = {
  id: string;
  name: string;
  pack: string | null;
  key: string | null;
  scale: LoopScale | null;
  tempo: number | null;
  beats: number;
  lengthSec: number;
  timeSignature: string;
  hasMidi: boolean;
  instrument: string | null;
  subInstrument: string | null;
  genre: string | null;
  descriptors: string[];
  path: string;
  fileExists: boolean;
};
export const LOOP_FIELDS = [
  "id", "name", "pack", "key", "scale", "tempo", "beats", "lengthSec", "timeSignature", "hasMidi",
  "instrument", "subInstrument", "genre", "descriptors", "path", "fileExists",
] as const;

export type LoopFilter = {
  query?: string | undefined;
  key?: string | undefined;
  tempoMin?: number | undefined;
  tempoMax?: number | undefined;
  genre?: string | undefined;
  instrument?: string | undefined;
  descriptors?: string[] | undefined;
  hasMidi?: boolean | undefined;
  pack?: string | undefined;
  /** Only loops whose audio file exists on disk (not-downloaded packs are listed in the index too). */
  installedOnly?: boolean | undefined;
};

/** Upper bound on rows checked against the disk for installedOnly (the whole Apple index is ~17k). */
const MAX_INSTALLED_SCAN = 25_000;
export type LoopPage = { limit: number; offset: number };
export type LoopsDb = {
  query(filter: LoopFilter, page: LoopPage, opts?: { exists?: (path: string) => boolean }): Result<{ total: number; items: LoopEntry[] }, string>;
  /** Distinct genre values in the index (for zero-result guidance). */
  genres(): string[];
  close(): void;
};

/** Root note names for display; the DB stores the key root as a MIDI note (48–59) plus keyType. */
const ROOTS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const SCALES: Record<number, LoopScale> = { 1: "major", 2: "minor", 3: "neither", 4: "both" };

/** LIKE pattern for a user substring: escape the wildcards so they match literally. */
const likeContains = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const SELECT = `
  SELECT l.id, l.fileURL, l.fileName, l.title, l.key, l.keyType, l.tempo, l.numberOfBeats, l.lengthInSeconds,
         l.timeSignatureTop, l.timeSignatureBottom, l.hasMidi,
         k.instrumentType, k.instrumentSubType, k.genre, k.descriptors,
         MIN(j.jamPackName) AS pack
  FROM Loops l
  LEFT JOIN LoopsKeywords k ON k.loopId = l.id
  LEFT JOIN JamPackLoopRelation r ON r.loopId = l.id
  LEFT JOIN JamPacks j ON j.identifier = r.jamPackId`;

const LETTER_PC: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const KEY = /^([A-Ga-g])([#b♯♭]?)\s*(m|min|minor|maj|major)?$/;

/** "F minor" | "Fm" | "F min" | "Bb major" | "F#" → root pitch class + DB keyType (1 major, 2 minor). */
export function parseLoopKey(input: string): Result<{ pc: number; keyType: 1 | 2 }, string> {
  const m = KEY.exec(input.trim());
  if (!m) return err(`key "${input}" not understood; use e.g. "F minor", "Fm", "Bb major"`);
  const [, letter, accidental = "", scale = ""] = m;
  const shift = accidental === "#" || accidental === "♯" ? 1 : accidental === "b" || accidental === "♭" ? -1 : 0;
  const pc = (LETTER_PC[letter!.toLowerCase()]! + shift + 12) % 12;
  return ok({ pc, keyType: /^m(in(or)?)?$/i.test(scale) ? 2 : 1 });
}

function where(f: LoopFilter): Result<{ sql: string; params: SQLInputValue[] }, string> {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  const add = (sql: string, ...values: SQLInputValue[]) => {
    clauses.push(sql);
    params.push(...values);
  };
  if (f.query) add(`(l.fileName LIKE ? ESCAPE '\\' OR l.title LIKE ? ESCAPE '\\')`, likeContains(f.query), likeContains(f.query));
  if (f.key !== undefined) {
    const key = parseLoopKey(f.key);
    if (!key.ok) return key;
    add("l.keyType = ? AND l.key > 0 AND (l.key % 12) = ?", key.value.keyType, key.value.pc);
  }
  if (f.tempoMin !== undefined || f.tempoMax !== undefined) add("l.tempo > 0");
  if (f.tempoMin !== undefined) add("l.tempo >= ?", f.tempoMin);
  if (f.tempoMax !== undefined) add("l.tempo <= ?", f.tempoMax);
  if (f.genre) add("k.genre = ? COLLATE NOCASE", f.genre);
  if (f.instrument) add("(k.instrumentType = ? COLLATE NOCASE OR k.instrumentSubType = ? COLLATE NOCASE)", f.instrument, f.instrument);
  for (const d of f.descriptors ?? []) {
    add(`(',' || COALESCE(k.descriptors, '') || ',') LIKE ? ESCAPE '\\'`, `%,${d.replace(/[\\%_]/g, (c) => `\\${c}`)},%`);
  }
  if (f.hasMidi !== undefined) add(f.hasMidi ? "l.hasMidi > 0" : "(l.hasMidi IS NULL OR l.hasMidi = 0)");
  if (f.pack) {
    add(`EXISTS (SELECT 1 FROM JamPackLoopRelation r2 JOIN JamPacks j2 ON j2.identifier = r2.jamPackId
                 WHERE r2.loopId = l.id AND j2.jamPackName LIKE ? ESCAPE '\\')`, likeContains(f.pack));
  }
  return ok({ sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params });
}

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown, max = 80): string | null => (typeof v === "string" && v.trim() !== "" ? cleanText(v, max) : null);

function toEntry(r: Row, exists: (p: string) => boolean): LoopEntry {
  const keyNum = num(r.key) ?? 0;
  const scale = SCALES[num(r.keyType) ?? 0] ?? null;
  const tempo = num(r.tempo);
  let path = "";
  try {
    path = decodeURIComponent(new URL(String(r.fileURL)).pathname);
  } catch {
    path = "";
  }
  const fileName = String(r.fileName ?? "");
  return {
    id: String(r.id), // read as BigInt: Apple's ids exceed Number.MAX_SAFE_INTEGER
    name: cleanText(str(r.title) ?? fileName.replace(/\.[A-Za-z0-9]+$/, "")),
    pack: str(r.pack),
    key: scale === "major" || scale === "minor" ? `${ROOTS[keyNum % 12]} ${scale}` : null,
    scale,
    tempo: tempo !== null && tempo > 0 ? tempo : null,
    beats: num(r.numberOfBeats) ?? 0,
    lengthSec: Math.round((num(r.lengthInSeconds) ?? 0) * 100) / 100,
    timeSignature: `${num(r.timeSignatureTop) ?? 4}/${num(r.timeSignatureBottom) ?? 4}`,
    hasMidi: (num(r.hasMidi) ?? 0) > 0,
    instrument: str(r.instrumentType),
    subInstrument: str(r.instrumentSubType),
    genre: str(r.genre),
    descriptors: String(r.descriptors ?? "").split(",").map((d) => cleanText(d, 40)).filter(Boolean),
    path,
    fileExists: path !== "" && exists(path),
  };
}

/** Open Apple's loop index read-only. Queries are parameterized; nothing is ever written. */
export function openLoopsDb(path: string): Result<LoopsDb, string> {
  if (!existsSync(path)) return err(`loops database not found: ${path}`);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (e) {
    return err(`cannot open loops database read-only: ${e instanceof Error ? e.message : String(e)}`);
  }
  return ok({
    genres() {
      try {
        return (db.prepare("SELECT DISTINCT genre FROM LoopsKeywords WHERE genre IS NOT NULL AND genre != '' ORDER BY genre").all() as Row[])
          .map((r) => String(r.genre));
      } catch {
        return [];
      }
    },
    query(filter, page, opts = {}) {
      const exists = opts.exists ?? existsSync;
      const built = where(filter);
      if (!built.ok) return built;
      const w = built.value;
      try {
        if (filter.installedOnly) {
          const stmt = db.prepare(`${SELECT} ${w.sql} GROUP BY l.id ORDER BY l.fileName COLLATE NOCASE, l.id LIMIT ?`);
          stmt.setReadBigInts(true);
          const installed = (stmt.all(...w.params, MAX_INSTALLED_SCAN) as Row[]).map((r) => toEntry(r, exists)).filter((e) => e.fileExists);
          return ok({ total: installed.length, items: installed.slice(page.offset, page.offset + page.limit) });
        }
        const count = db.prepare(`SELECT COUNT(*) AS n FROM (${SELECT} ${w.sql} GROUP BY l.id)`).get(...w.params) as Row;
        const stmt = db.prepare(`${SELECT} ${w.sql} GROUP BY l.id ORDER BY l.fileName COLLATE NOCASE, l.id LIMIT ? OFFSET ?`);
        stmt.setReadBigInts(true);
        const rows = stmt.all(...w.params, page.limit, page.offset) as Row[];
        return ok({ total: Number(count.n), items: rows.map((r) => toEntry(r, exists)) });
      } catch (e) {
        return err(`loops query failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    close: () => db.close(),
  });
}
