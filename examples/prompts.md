# Sample prompts for Claude Code

Type these in Claude Code with gb-mcp connected. Change the words to fit your song. Claude Code chooses the tools;
every result is `verified`, `uncertain` or `failed`, and nothing is ever overwritten (each version gets `-v2`, `-v3`).

## Compose

- *Make a dreamy ambient track in D minor at 100 BPM, about 3 minutes, and open it in GarageBand.*
- *Draft a lo-fi hip-hop beat in F minor at 82 BPM: a jazzy electric piano, soft drums and a warm bass.*
- *Write a 32-bar jazz ballad in Bb major with brushes, upright bass, piano comping and a muted trumpet melody.*
- *Start from the deep house template in A minor at 122 BPM, then replace the hook with one of your own.*
- *The second chorus is flat. Let the AI rewrite the keys and the lead in that section and keep the best of three takes.*

## Revise and mix

- *The drums are too loud in the intro. Fix it and compare with the last version.*
- *Make the bridge quieter, then build into the last chorus with a crescendo.*
- *Slow the last 4 bars down to 70 BPM for a ritardando ending.*
- *Turn the strings down 3 dB and pan the horns a little to the left.*
- *Put an installed electric piano patch on the keys track.*

## Listen and check

- *Export it and tell me how it sounds: loudness, balance, and what you would change.*
- *Compare this export with the previous one. What got better, and what got worse?*
- *Run the gb-mcp doctor.*

## Your own audio

- *Split exports/demo.wav into vocals, drums, bass and other, and put the vocals and the drums next to my MIDI song from bar 5.*
- *This drum loop is at 96 BPM. Fit it to my song at 120 BPM and place it from bar 1.*

## Songs with vocals (gb_generate)

Claude Code first reads ACE-Step's own example songs that fit your request (`gb_generate examples`), then writes the
caption and the lyrics in their style. A song takes a few minutes; it runs as a background job.

- *Write a warm acoustic folk song with a female voice about an old lighthouse keeper, about 3 minutes. Make it a WAV
  and also a GarageBand project made from its stems.*
- *Write a gospel soul song with a choir about coming home after a long winter, at 90 BPM.*
- *Write a 90s Britpop song with jangly guitars and a sing-along chorus about a seaside town in the rain.*
- *Export my song and make an ACE-Step cover that keeps its shape, sung by a male voice, with these lyrics: …*
- *Use MuLaCover to sing these lyrics on the melody track of my song, from bar 9 for 16 bars.* (MuLaCover outputs are
  non-commercial.)
- *Make another take with a different seed, and tell me how the two takes differ in tempo and key.*

## After a generated song

- *Separate the song into stems and build a GarageBand project from them at its measured tempo.*
- *Add a soft organ pad in the song's key next to the stems, from the first verse to the end.*
- *Change the song: faster, with more strings and a longer outro. Keep the lyrics.*

## Good to know

- Exports never contain the metronome: `gb_export` switches it off for the export and back on after it.
- GarageBand projects that gb-mcp writes are in 4/4. A generated song can have a short bar of 2 beats; ask Claude Code to
  check the downbeats before it adds MIDI parts to such a song.
- Ask *is the song ready?* while a generation runs; Claude Code reads the job's status.
