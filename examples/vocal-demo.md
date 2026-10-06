# Vocal demo

`media/vocal-demo.mp3` — 55 s, made with ACE-Step 1.5 (MIT) through `gb_generate` on a MacBook Air (M4) in about
2 minutes. Claude Code called `gb_generate examples` first and wrote the caption and the lyrics in the style of
ACE-Step's own examples, with new words.

## The call

```json
{
  "command": "start",
  "engine": "ace_step",
  "task": "text",
  "duration": 55,
  "bpm": 116,
  "key": "D major",
  "seed": 7,
  "filename": "readme-demo-v1.wav"
}
```

Measured on the result: 115.98 BPM (asked: 116); the key reads as A major (asked: D major — ACE-Step takes the key as
a hint).

## Caption

A bright and breezy indie pop track driven by a clean, jangly electric guitar riff and a punchy, straightforward drum beat. A solid melodic bassline and soft synth pads support the groove. A clear, warm female lead vocal sings a catchy melody with light reverb; the chorus lifts with doubled vocals and gentle harmonies. The arrangement is short: a guitar intro, one verse, a lifting chorus and a guitar outro that ends on a ringing chord. Polished, modern production with a sunny, hopeful mood.

## Lyrics

```
[Intro - Guitar Riff]

[Verse]
Open the window, let the morning in
Coffee on the table and a song to begin
Four bars of nothing, then a melody
Humming in the hallway, it is coming to me

[Chorus]
Press record, press record
Every little idea finds a chord
Turn it up and play it back
Now the empty page has a track

[Outro - Guitar Riff]
[Final chord rings out]
```

## Checks

1. `gb_stem separate {path: "gen/readme-demo-v1.wav", model: "roformer"}` — the vocal.
2. `gb_analyze lyrics {path: "stems/readme-demo-v1-vocals.wav", lyrics, language: "en"}` — 6 lines sung, 2 partly
   (the first line came out as "Oh, don't let the morning end"; "Press record" is sung once, not twice); word error
   rate 0.14.
3. `gb_analyze master {path: "gen/readme-demo-v1.wav", filename: "readme-demo-v1-master.wav", lufs: -14, peak: -1.5}`
   — −14.00 LUFS, −1.51 dBTP. The MP3 is 160 kbps with no tags.
