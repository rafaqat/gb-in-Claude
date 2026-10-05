// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * ACE-Step 1.5's own text-to-music examples (MIT; examples/text2music in the reviewed checkout, 200 songs in 8
 * languages) as many-shot prompts. For a request, the examples whose captions fit it best — caption, lyrics, bpm, key,
 * length, language — so an agent writes gb_generate's caption and lyrics in the style the model was built around.
 * They are read from the installed engine, never copied into gb-mcp. Ranking: BM25 over the captions (lower case,
 * plural -s folded); language filters; instrumental is a preference (the 200 examples all have lyrics).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../result.js";

export type AceExample = {
  id: string; caption: string; lyrics: string; bpm: number | null; keyscale: string; duration: number | null;
  language: string; timesignature: string; instrumental: boolean;
};
export type RankQuery = { query: string; language?: string; instrumental?: boolean; limit?: number };
export const ATTRIBUTION = "examples from ACE-Step 1.5 — github.com/ace-step/ACE-Step-1.5 — MIT licence, Copyright (c) 2026 ACEStep";
export const DEFAULT_LIMIT = 4;

const STOP = new Set(["a", "an", "the", "and", "or", "with", "of", "for", "in", "on", "to", "by", "is", "it", "its", "that", "this",
  "track", "song", "music", "piece", "feel", "feeling", "style", "like", "some", "very", "make", "me", "my"]);

const words = (text: string) =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .filter((w) => !STOP.has(w));

/** Every non-empty lyrics line is a [section tag] (or the whole text is [Instrumental]). */
const isInstrumental = (lyrics: string) => lyrics.split("\n").map((l) => l.trim()).filter(Boolean).every((l) => /^\[[^\]]*\]$/.test(l));

export function loadExamples(dir: string): Result<AceExample[], { code: "FILE_NOT_FOUND"; message: string }> {
  if (!existsSync(dir)) return err({ code: "FILE_NOT_FOUND", message: `no examples folder at ${dir}` });
  const out: AceExample[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const d = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
      if (typeof d.caption !== "string" || typeof d.lyrics !== "string") continue;
      out.push({
        id: file.slice(0, -5), caption: d.caption, lyrics: d.lyrics, bpm: typeof d.bpm === "number" ? d.bpm : null,
        keyscale: typeof d.keyscale === "string" ? d.keyscale : "", duration: typeof d.duration === "number" ? d.duration : null,
        language: typeof d.language === "string" ? d.language : "", timesignature: typeof d.timesignature === "string" ? d.timesignature : "",
        instrumental: isInstrumental(d.lyrics),
      });
    } catch {
      continue; // a malformed file is skipped, never fatal
    }
  }
  return ok(out);
}

export function rankExamples(all: readonly AceExample[], q: RankQuery): AceExample[] {
  const pool = all.filter((e) => q.language === undefined || e.language === q.language);
  const docs = pool.map((e) => words(e.caption));
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const terms = [...new Set(words(q.query))];
  const k1 = 1.2, b = 0.75, n = docs.length;
  const score = (d: string[]) => terms.reduce((s, t) => {
    const tf = d.filter((w) => w === t).length;
    if (!tf) return s;
    const idf = Math.log((n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5) + 1);
    return s + idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / (avg || 1)));
  }, 0);
  // instrumental is a preference, not a filter: ACE-Step's 200 examples all have lyrics, and their captions still help
  const wanted = (e: AceExample) => (q.instrumental === undefined || e.instrumental === q.instrumental ? 0 : 1);
  return pool.map((e, i) => ({ e, s: score(docs[i]!) }))
    .sort((x, y) => wanted(x.e) - wanted(y.e) || y.s - x.s || x.e.id.localeCompare(y.e.id))
    .slice(0, Math.min(8, Math.max(1, q.limit ?? DEFAULT_LIMIT)))
    .map((x) => x.e);
}
