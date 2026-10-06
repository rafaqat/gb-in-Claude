# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
# M14.1 calibration clips: python3 cal_jobs.py → cal-jobs.json (gb_generate start jobs, ACE-Step text, 30 s, seed 1; seed 2 = the same with seed 2)
import json, re
G = [  # label, bpm, key, caption
 ("Latin trap", 140, "A minor", "A dark Latin trap beat: booming 808 sub bass with glides, fast rolling hi-hat triplets, sparse snare on beat three, a moody minor reggaeton-style synth pluck and a haunting vocal chop. Modern Puerto Rican street sound, heavy low end, wide polished mix."),
 ("dembow", 118, "G minor", "A Dominican dembow track: relentless syncopated dembow drum pattern, punchy kick and snare stutter, sharp hi-hats, a short looping synth stab and hype ad-lib chants. Raw, fast, high energy street party sound with loud modern mix."),
 ("bachata", 128, "E minor", "A modern bachata: requinto lead guitar with bright arpeggiated picking, rhythm guitar, round electric bass syncopation, bongos in martillo pattern and metal güira scraping. Romantic, smooth Dominican sound with a clean urban polish."),
 ("salsa", 95, "C minor", "A classic salsa dura band: piano montuno ostinato, tumbao bass, congas, timbales with cáscara, bongos and cowbell, clave rhythm, and a punchy trumpet and trombone horn section playing mambo riffs. Hot, danceable New York Latin sound."),
 ("cumbia", 95, "D minor", "A cumbia: steady güiro scrape and shaker on every beat, accordion melody, bouncy bass on one and three, congas and timbal accents, cheerful Colombian rhythm, warm and festive, slightly vintage sound."),
 ("bossa nova", 130, "D major", "A bossa nova: nylon-string guitar playing the gentle syncopated bossa pattern with jazz chords, soft brushed drums with rim clicks, upright bass, a quiet flute melody and warm Rhodes. Relaxed, intimate Rio de Janeiro sound."),
 ("corridos tumbados", 120, "A minor", "A corridos tumbados track: requinto guitar with fast melodic runs, twelve-string guitar strumming, deep tuba bass lines, Mexican regional sound with a modern trap attitude, sad and confident, raw acoustic production."),
 ("Latin pop", 100, "B minor", "A modern Latin pop song: acoustic guitar, reggaeton-tinged dembow beat, warm synth pads, catchy synth hook, bright pop production, romantic and summery, radio-ready mix."),
 ("Brazilian funk", 130, "F minor", "A Brazilian funk carioca beat: the tamborzão drum pattern, heavy distorted 808 kicks, vocal shouts chopped as percussion, a looping minimal synth and booming bass. Raw baile funk energy from the favelas of Rio."),
 ("merengue", 150, "G major", "A fast merengue: driving tambora drum, metal güira scraping, accordion riffs, saxophone section lines, bright piano, joyful Dominican dance music at a fast tempo."),
 ("Arabic pop", 100, "D minor", "A modern Arabic pop song: oud and qanun melodies in maqam Hijaz, darbuka and riq percussion in a maqsum rhythm, lush string section answering phrases, synth bass and a polished Cairo and Beirut studio sound."),
 ("Khaleeji", 100, "C minor", "A Khaleeji Gulf song: oud lead, the bouncing Khaleeji rhythm with handclaps and frame drums, tabl and mirwas hand drums, string section swells, warm Arabian Gulf pop production."),
 ("mahraganat", 128, "E minor", "An Egyptian mahraganat track: loud electro shaabi beat, fast darbuka loops, distorted synth leads playing Arabic maqam riffs, heavy autotune vocal chops, raw chaotic Cairo street party energy."),
 ("raï", 110, "A minor", "An Algerian raï track: synth accordion and gasba-like flute riffs, darbuka and drum machine groove, wah electric guitar, bass in a North African rhythm, emotional Oran sound from the 1990s."),
 ("gnawa", 100, "D minor", "A Moroccan gnawa trance piece: guembri bass lute playing hypnotic repeating riffs, metal qraqeb castanets clacking a triplet rhythm, handclaps and call-and-response chants. Deep, spiritual, repetitive trance."),
 ("Moroccan chaabi", 120, "G minor", "A Moroccan chaabi song: violin and banjo playing fast Arabic melodic lines, bendir frame drum and darbuka, handclaps, a celebratory wedding dance rhythm, festive North African popular music."),
 ("dabke", 125, "D minor", "A Levantine dabke: mijwiz reed pipe playing piercing melodies, the tabl drum pounding the dabke rhythm, darbuka fills, handclaps and a festive village wedding line-dance energy."),
 ("country", 96, "G major", "A modern Nashville country song: bright acoustic guitar strumming, pedal steel guitar swells, fiddle fills, twangy electric guitar, solid drums with a big backbeat, warm bass, polished radio country production."),
 ("Americana", 88, "D major", "An Americana roots track: fingerpicked acoustic guitar, banjo rolls, mandolin, upright bass, brushed snare, harmonica and a warm organ, earthy and nostalgic, recorded live in a wooden room."),
 ("Bollywood (filmi)", 100, "C minor", "A Bollywood filmi song: lush Indian film string section, sitar and bansuri flute melodies, tabla and dholak rhythm, harmonium, sweeping cinematic orchestration and a big emotional romantic Hindi film sound."),
 ("gospel", 76, "Ab major", "A gospel track: Hammond B3 organ with swells and runs, gospel piano with rich chords, a big choir singing powerful harmonies, handclaps on two and four, tambourine, bass and drums, joyful church energy."),
 ("soul", 92, "F major", "A classic soul track: warm Rhodes and Hammond organ, tight drums with a backbeat, melodic bass guitar, clean rhythm guitar, a horn section of trumpet and saxophones, and string pads. Warm 1960s Memphis soul sound."),
 ("blues", 80, "E major", "A slow twelve-bar blues: expressive overdriven electric guitar with bends and vibrato, shuffle drums, walking bass, barrelhouse piano and harmonica wails. Smoky Chicago blues club sound."),
 ("Celtic folk", 110, "D major", "A Celtic folk tune: fiddle and tin whistle playing a lively jig melody, uilleann pipes, bodhrán frame drum, bouzouki and acoustic guitar strumming. Irish and Scottish traditional pub session sound."),
 ("lullaby", 60, "F major", "A gentle lullaby for a sleeping child: music box melody, soft celesta and glockenspiel, warm felt piano, quiet harp arpeggios and soft strings, slow, tender, dreamy and calm."),
 ("K-pop", 120, "C# minor", "A K-pop dance track: punchy modern drums, bright synth leads, deep bass drops, sharp brass stabs, layered vocal chops, a dramatic pre-chorus build and an explosive dance break, glossy Seoul idol production."),
 ("amapiano", 112, "F minor", "An amapiano track: the deep log drum bass slides, shuffling shakers and hi-hats, sparse kick, airy jazzy piano chords and pads, soft vocal chants, laid-back South African house groove."),
]
slug = lambda s: re.sub(r"[^a-z0-9]+", "-", s.lower().replace("ï", "i")).strip("-")
jobs = [dict(command="start", engine="ace_step", task="text", duration=30, bpm=b, key=k, caption=c, lyrics="[Instrumental]",
             thinking=False, seed=1, filename=f"m14-cal-{slug(g)}.wav") for g, b, k, c in G]
json.dump(jobs, open("cal-jobs.json", "w"), indent=1)
json.dump({slug(g): g for g, *_ in G}, open("cal-labels.json", "w"), indent=1)
print(len(jobs), max(len(c) for *_, c in G))
