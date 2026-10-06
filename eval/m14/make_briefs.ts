// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * M14: write eval/briefs-m14 once — for each new genre, its template's draft at a fixed key and the template's tempo —
 * then FROZEN.sha256. Never re-run over an existing set (it refuses): the scores of later milestones compare to these
 * exact files. Run: npx tsx eval/m14/make_briefs.ts
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GENRE_TEMPLATES, templateSong } from "../../src/song/genres.js";
import { BRIEFS_M14_DIR } from "../../src/eval/briefs.js";

const BRIEFS: [string, string, string][] = [ // genre, key, one-line description
  ["Latin trap", "A minor", "Dark Latin trap: 808 glides, rolling hats, half-time snare, a nylon-guitar hook."],
  ["dembow", "G minor", "Dominican dembow: the stuttering dembow snare over four on the floor, a synth stab, timbale fills."],
  ["bachata", "E minor", "Modern bachata: requinto arpeggios, bongos in martillo, güira 16ths, syncopated bass."],
  ["salsa", "C minor", "Salsa dura: 3-2 son clave, cáscara, conga tumbao, piano montuno, a brass mambo line."],
  ["cumbia", "D minor", "Cumbia: güiro on every eighth, congas on the off-beats, bass on one and three, a gaita-like flute."],
  ["bossa nova", "D major", "Bossa nova: the cross-stick bossa clave, nylon guitar comping in sevenths, upright bass, flute."],
  ["corridos tumbados", "A minor", "Corridos tumbados: requinto runs over strummed guitar and tuba, no drums."],
  ["Latin pop", "B minor", "Latin pop: a light reggaeton beat, nylon guitar, warm pad, a bright synth hook."],
  ["Brazilian funk", "F minor", "Brazilian funk: the tamborzão, claps and atabaque slaps, a sliding 808 bass."],
  ["merengue", "G major", "Merengue: tambora and güira at 150 BPM, piano, a saxophone line."],
  ["Arabic pop", "D minor", "Arabic pop: maqam Hijaz in chords, maqsum on the darbuka, strings and harp."],
  ["Khaleeji", "C minor", "Khaleeji: the Gulf's triplet groove with hand claps and frame drums, strings, an oud-like guitar."],
  ["mahraganat", "E minor", "Mahraganat: a pounding electro-shaabi beat, fast darbuka loops, a maqam synth riff."],
  ["raï", "A minor", "Raï: the Andalusian cadence, darbuka and drum machine, wah guitar, a synth lead."],
  ["gnawa", "D minor", "Gnawa: a guembri bass riff in a minor pentatonic, qraqeb triplets, hand claps."],
  ["Moroccan chaabi", "G minor", "Moroccan chaabi: a 6/8 wedding dance on bendir and darbuka, fast violin lines."],
  ["dabke", "D minor", "Dabke: the tabl's dabke beat, hand claps, a reed (clarinet) line in repeated notes."],
  ["country", "G major", "Modern country: a backbeat with tambourine, strummed acoustic guitar, a twangy electric lead."],
  ["Americana", "D major", "Americana: fingerpicked guitar, upright bass on root and fifth, cross-stick, organ."],
  ["Bollywood (filmi)", "C minor", "Bollywood: keherwa on tabla-like congas and bongo, film strings, a bansuri-like flute."],
  ["gospel", "Ab major", "Gospel: organ and piano, I7 to IV and the minor four, claps on two and four, a choir line."],
  ["soul", "F major", "Soul: a mined soul groove with tambourine, organ, electric piano, a horn line."],
  ["blues", "E major", "Blues: three twelve-bar choruses with a shuffle, walking bass, organ, an overdriven guitar."],
  ["Celtic folk", "D major", "Celtic folk: a jig's triplet drive on the bodhrán, mixolydian chords, a tin-whistle tune."],
  ["lullaby", "F major", "Lullaby: music box over harp arpeggios and soft strings, no drums."],
  ["K-pop", "C# minor", "K-pop: four on the floor, a pre-chorus, a big chorus and a dance break, synth leads."],
  ["amapiano", "F minor", "Amapiano: shakers and sparse kicks, a sliding log-drum bass, jazzy electric piano."],
];

if (existsSync(join(BRIEFS_M14_DIR, "FROZEN.sha256"))) throw new Error(`${BRIEFS_M14_DIR} is frozen: add a new set instead`);
mkdirSync(BRIEFS_M14_DIR, { recursive: true });
const slug = (g: string) => g.toLowerCase().replace("ï", "i").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const lines: string[] = [];
BRIEFS.forEach(([genre, key, description], i) => {
  const t = GENRE_TEMPLATES[genre]!;
  const id = `${21 + i}-${slug(genre)}`;
  const song = templateSong({ genre, key, title: `eval ${slug(genre)}` });
  if (!song.ok) throw new Error(`${genre}: ${song.error}`);
  const brief = { id, genre, bpm: t.defaultBpm, key, meter: "4/4", form: t.form.map((s) => `${s.name} ${s.bars}`).join(" · "), description, song: song.value };
  const file = `${id}.json`;
  writeFileSync(join(BRIEFS_M14_DIR, file), JSON.stringify(brief, null, 2) + "\n");
  lines.push(`${createHash("sha256").update(readFileSync(join(BRIEFS_M14_DIR, file))).digest("hex")}  ${file}`);
});
writeFileSync(join(BRIEFS_M14_DIR, "FROZEN.sha256"), lines.join("\n") + "\n");
console.log(`${lines.length} briefs → ${BRIEFS_M14_DIR}`);
