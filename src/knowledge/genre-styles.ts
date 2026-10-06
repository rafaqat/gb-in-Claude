// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * Genre styles (M14): per genre, the words a gb_generate caption needs — the instruments and how they play, the usual
 * voice, the production — a usual tempo range, and what a GarageBand draft from `gb_song template` cannot play (GM
 * reaches no sitar, oud, banjo, pedal steel or accordion: GarageBand plays GM sitar and banjo as Acoustic Guitar).
 * Write the caption in your own words around these: genre and mood, instruments, voice, arrangement, production.
 */
export type GenreStyle = { sound: string; voice: string; production: string; bpm: [number, number]; gm?: string };

export const GENRE_STYLES: Record<string, GenreStyle> = {
  // ── the M8 twenty
  "lo-fi hip-hop": { sound: "dusty swung boom-bap drums, warm Rhodes and jazzy seventh chords, muffled upright or electric bass, vinyl crackle", voice: "usually instrumental; soft spoken samples", production: "lo-fi, tape saturation, low-passed, relaxed", bpm: [70, 95] },
  "R&B": { sound: "smooth 808 or live drums with crisp snaps, lush electric piano and ninth chords, round sub bass, subtle guitar licks", voice: "silky lead vocal with runs and stacked harmonies", production: "polished, warm, intimate late-night mix", bpm: [60, 100] },
  ambient: { sound: "slowly evolving synth pads, soft piano fragments, drones and textures, no steady beat", voice: "instrumental, or wordless airy vocal", production: "spacious, long reverbs, gentle and immersive", bpm: [50, 90] },
  "jazz ballad": { sound: "brushed drums, walking upright bass, piano comping with extended chords, tender saxophone or trumpet melody", voice: "warm crooning vocal, or instrumental", production: "live small-room jazz club sound", bpm: [55, 90] },
  reggaeton: { sound: "the dembow drum pattern, deep sub bass, synth plucks, Latin guitar, perreo groove", voice: "Spanish rap and melodic hooks with autotune", production: "loud, punchy modern urbano mix", bpm: [85, 100] },
  synthwave: { sound: "gated reverb drums, arpeggiated analog synth bass, bright saw leads, lush pads", voice: "instrumental, or reverb-drenched 80s vocal", production: "retro 1980s neon sheen, wide stereo", bpm: [80, 118] },
  pop: { sound: "punchy drums, bright synths and guitars, catchy hook, big chorus", voice: "clear confident lead vocal with doubled harmonies", production: "modern radio-ready polish", bpm: [90, 128] },
  afrobeats: { sound: "syncopated percussion with shakers and log-drum-like toms, rubbery bass, palm-muted guitar licks, warm keys", voice: "smooth melodic vocal mixing English and Pidgin", production: "bouncy, warm Lagos sound", bpm: [95, 115] },
  funk: { sound: "tight syncopated drums, slap bass, choppy wah rhythm guitar, horn stabs, clavinet", voice: "energetic soulful vocal with call-and-response", production: "dry, punchy 1970s groove", bpm: [95, 120] },
  "indie rock": { sound: "driving live drums, jangly and fuzzy electric guitars, melodic bass", voice: "earnest lead vocal, gang vocals in the chorus", production: "raw, roomy band recording", bpm: [100, 150] },
  "deep house": { sound: "four-on-the-floor kick, open hats, warm deep bassline, jazzy chord stabs and pads", voice: "soulful vocal snippets", production: "smooth, warm club mix", bpm: [118, 126] },
  techno: { sound: "pounding kick, hypnotic synth sequences, metallic percussion, rumbling bass", voice: "instrumental", production: "dark, driving warehouse sound", bpm: [125, 140] },
  "UK garage": { sound: "shuffled two-step drums, skippy hats, warm sub bass, organ and piano stabs", voice: "chopped soulful vocal hooks", production: "crisp late-90s London garage sound", bpm: [128, 136] },
  trap: { sound: "booming 808 bass with glides, rolling hi-hat triplets, half-time snare, dark synths and bells", voice: "rap verses and melodic autotuned hooks", production: "heavy low end, modern Atlanta mix", bpm: [130, 160] },
  "drum and bass": { sound: "fast breakbeats, rolling reese or liquid bass, atmospheric pads", voice: "instrumental or soulful vocal snippets", production: "energetic, wide, sub-heavy", bpm: [160, 178] },
  "EDM (big room)": { sound: "massive kick, build-ups with snare rolls, huge supersaw lead drop", voice: "anthemic vocal hook", production: "festival-loud, side-chained", bpm: [124, 130] },
  "classical/pop crossover": { sound: "piano, string section and soft percussion under a pop melody", voice: "operatic or lyrical pop voice", production: "cinematic and polished", bpm: [70, 110] },
  "ambient trance (William Orbit style)": { sound: "four-on-the-floor kick, plucked arpeggios, washes of pads, gentle trance lead", voice: "ethereal breathy vocal", production: "dreamy, spacious, euphoric", bpm: [120, 136] },
  "Levantine ethereal strings (Fairuz style)": { sound: "lush string orchestra, oud, qanun, ney flute and soft riq", voice: "pure, serene female vocal in Arabic", production: "warm, classic 1970s Beirut orchestral sound", bpm: [70, 100] },
  "epic orchestral (Hans Zimmer style)": { sound: "ostinato strings, low brass swells, taiko and timpani, organ, rising layers", voice: "instrumental, or a wordless choir", production: "huge cinematic film score", bpm: [60, 120] },
  // ── M14: Latin
  "Latin trap": { sound: "booming 808 bass with glides, rolling hi-hat triplets, half-time snare, moody minor synth pluck or nylon guitar", voice: "Spanish rap with melodic autotuned hooks", production: "dark, heavy low end, modern Puerto Rican street sound", bpm: [120, 150] },
  dembow: { sound: "relentless syncopated dembow drum pattern, stuttering snare and claps, short looping synth stab, timbale fills", voice: "fast Spanish rap with hype ad-lib chants", production: "raw, loud Dominican street party mix", bpm: [110, 130] },
  bachata: { sound: "requinto lead guitar with bright arpeggios, rhythm guitar, syncopated electric bass, bongos in martillo, metal güira", voice: "romantic tenor vocal in Spanish, heartfelt", production: "smooth, clean modern Dominican sound", bpm: [120, 140], gm: "the güira is a GM guiro; bongos and güira on the Latin percussion voices" },
  salsa: { sound: "piano montuno ostinato, tumbao bass, congas, timbales with cáscara, bongo bell, son clave, trumpet and trombone mambo riffs", voice: "sonero lead vocal with a call-and-response coro", production: "hot, live New York or Puerto Rican salsa band", bpm: [85, 105] },
  cumbia: { sound: "güiro scraping every eighth, accordion melody, bouncy bass on one and three, congas and timbal accents", voice: "cheerful Spanish vocal, group shouts", production: "warm, festive, slightly vintage Colombian or Mexican sound", bpm: [85, 105], gm: "no accordion in GM on GarageBand (it plays an organ): the draft uses a flute, as the gaita in old cumbia" },
  "bossa nova": { sound: "nylon-string guitar playing the syncopated bossa pattern with jazz chords, soft brushes and rim clicks, upright bass, quiet flute", voice: "soft, intimate, almost whispered Portuguese vocal", production: "relaxed, close, warm Rio de Janeiro sound", bpm: [110, 140] },
  "corridos tumbados": { sound: "requinto guitar with fast melodic runs, twelve-string guitar strumming, deep tuba bass lines, no drums", voice: "raspy, laid-back young male vocal in Spanish", production: "raw acoustic Mexican regional sound with a trap attitude", bpm: [100, 150] },
  "Latin pop": { sound: "acoustic guitar, light reggaeton-tinged beat, warm synth pads, catchy synth or guitar hook", voice: "bright romantic lead vocal in Spanish", production: "polished, summery, radio-ready", bpm: [90, 110] },
  "Brazilian funk": { sound: "the tamborzão beat, heavy distorted 808 kicks, atabaque slaps, vocal shouts chopped as percussion, a minimal looping synth", voice: "MC chants in Portuguese", production: "raw baile funk energy from Rio's favelas", bpm: [125, 135] },
  merengue: { sound: "driving tambora drum, metal güira scraping, accordion riffs, saxophone section lines, bright piano", voice: "joyful Spanish lead vocal with coros", production: "fast, bright Dominican dance band", bpm: [130, 160], gm: "no accordion in GM on GarageBand: the draft gives the riffs to saxophone" },
  // ── M14: Arabic, Maghreb, Levant
  "Arabic pop": { sound: "oud and qanun melodies in maqam Hijaz, darbuka and riq in a maqsum rhythm, a string section answering the phrases, synth bass", voice: "emotive Arabic vocal with melismas", production: "polished Cairo and Beirut studio sound", bpm: [85, 115], gm: "no oud or qanun in GM on GarageBand: strings and harp; darbuka on the congas" },
  Khaleeji: { sound: "oud lead, the lilting Khaleeji rhythm with hand claps, frame drums and mirwas hand drums, string swells", voice: "Gulf Arabic male vocal, group hand-clap chorus", production: "warm Arabian Gulf pop", bpm: [90, 110], gm: "no oud in GM on GarageBand: an acoustic guitar plays its part" },
  mahraganat: { sound: "loud electro-shaabi beat, fast darbuka loops, distorted synth leads playing maqam riffs, heavy kicks", voice: "heavily autotuned shouted Egyptian Arabic vocals", production: "raw, chaotic Cairo street party", bpm: [120, 140] },
  "raï": { sound: "synth accordion and gasba-like flute riffs, darbuka with a drum machine, wah electric guitar, North African bass", voice: "passionate, raw Algerian Arabic vocal", production: "1990s Oran raï sound", bpm: [95, 125] },
  gnawa: { sound: "guembri bass lute playing hypnotic repeating riffs, metal qraqeb castanets in a triplet clack, hand claps", voice: "call-and-response chants led by the maalem", production: "deep, spiritual, repetitive trance", bpm: [80, 130], gm: "no guembri or qraqeb in GM: a bass line and hats in triplets" },
  "Moroccan chaabi": { sound: "violin and banjo playing fast Arabic lines, bendir frame drum and darbuka in 6/8, hand claps", voice: "festive Moroccan Arabic vocal with a group chorus", production: "lively wedding-band sound", bpm: [100, 140], gm: "no banjo in GM on GarageBand: acoustic guitar" },
  dabke: { sound: "mijwiz reed pipe playing piercing repeated melodies, the tabl pounding the dabke rhythm, darbuka fills, hand claps", voice: "Levantine Arabic folk vocal, shouts from the line of dancers", production: "festive village wedding energy", bpm: [110, 135], gm: "no mijwiz in GM: a clarinet plays its lines; the tabl is a low tom" },
  // ── M14: other
  country: { sound: "bright acoustic guitar strumming, pedal steel swells, fiddle fills, twangy electric guitar (Telecaster), solid drums with a big backbeat", voice: "sincere country vocal with a light Southern twang", production: "polished modern Nashville radio country", bpm: [75, 120], gm: "no pedal steel or solo fiddle installed: clean electric lead, string pad" },
  Americana: { sound: "fingerpicked acoustic guitar, banjo rolls, mandolin, upright bass, brushed snare, harmonica, warm organ", voice: "weathered, earthy storytelling vocal, close harmonies", production: "recorded live in a wooden room, nostalgic", bpm: [70, 110], gm: "no banjo, mandolin or harmonica in GM on GarageBand: guitars and organ" },
  "Bollywood (filmi)": { sound: "lush Indian film string section, sitar and bansuri melodies, tabla and dholak in keherwa, harmonium", voice: "expressive Hindi vocal with ornaments, or a male–female duet", production: "big emotional cinematic Hindi film sound", bpm: [80, 130], gm: "no sitar or tabla in GM on GarageBand: flute and strings; tabla strokes on congas and bongo" },
  gospel: { sound: "Hammond B3 organ with swells and runs, gospel piano with rich chords, hand claps on two and four, tambourine", voice: "powerful lead vocal over a full choir", production: "joyful live church energy", bpm: [60, 130] },
  soul: { sound: "warm Rhodes and organ, tight backbeat drums, melodic bass guitar, clean rhythm guitar, horn section, string pads", voice: "gritty, heartfelt soul vocal with backing singers", production: "warm 1960s Memphis and Motown sound", bpm: [70, 110] },
  blues: { sound: "overdriven electric guitar with bends and vibrato, shuffle drums, walking bass, barrelhouse piano, harmonica", voice: "raw, gritty blues vocal", production: "smoky Chicago club sound", bpm: [60, 120], gm: "no harmonica in GM on GarageBand" },
  "Celtic folk": { sound: "fiddle and tin whistle playing jigs and reels, uilleann pipes, bodhrán, bouzouki and guitar strumming", voice: "clear folk vocal, sometimes in Irish or Scots Gaelic", production: "Irish and Scottish pub-session warmth", bpm: [90, 130], gm: "no fiddle or pipes in GM on GarageBand: a whistle (flute) plays the tune; the bodhrán is toms" },
  lullaby: { sound: "music box melody, soft celesta and glockenspiel, felt piano, quiet harp arpeggios, soft strings", voice: "gentle, hushed female voice", production: "tender, slow, dreamy, very soft", bpm: [50, 80] },
  "K-pop": { sound: "punchy modern drums, bright synth leads, deep bass drops, brass stabs, a dramatic pre-chorus build and a dance break", voice: "polished idol group vocals, rap verses and a high-note chorus", production: "glossy, maximal Seoul production", bpm: [100, 140] },
  amapiano: { sound: "deep log drum bass slides, shuffling shakers and hi-hats, sparse kick, airy jazzy piano chords and pads", voice: "soft vocal chants and spoken phrases", production: "laid-back South African house groove", bpm: [108, 116] },
};

const section = (genre: string, s: GenreStyle) => [
  `### ${genre}`,
  `- sound: ${s.sound}`,
  `- voice: ${s.voice}`,
  `- production: ${s.production}`,
  `- tempo: ${s.bpm[0]}–${s.bpm[1]} BPM`,
  ...(s.gm ? [`- GarageBand draft: ${s.gm}`] : []),
].join("\n");

export const GENRES_GUIDE = `# Genres (M14)

gb-mcp knows ${Object.keys(GENRE_STYLES).length} genres. Each one has:
- a GarageBand draft: \`gb_song template {genre, key, bpm?}\` (form, chords, the genre's rhythm, bass, a hook);
- a label CLAP ranks a recording against (\`gb_analyze audio\` → ml.genre: a ranking, never a grade);
- the words below for a gb_generate caption. Write the caption in your own words around them, one paragraph: genre and
  mood; the instruments and how they play; the voice; the arrangement; the production. Call \`gb_generate examples\` first.

GM cannot reach some signature instruments on GarageBand (sitar, oud, banjo, pedal steel, accordion): the draft carries
the genre's rhythm and harmony; gb_generate gives its real sound (a cover of the draft, or text).

${Object.entries(GENRE_STYLES).map(([g, s]) => section(g, s)).join("\n\n")}
`;
