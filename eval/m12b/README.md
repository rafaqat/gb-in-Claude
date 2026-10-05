# M12b gate: generated vocals next to a song's MIDI, in one GarageBand project

Both gb_generate engines, live, through the MCP tools only.

```sh
# 1. the chain (the config names the song, its tracks, lyrics, tags and caption — see example.json):
#    gb_generate mulacover + ace_step → gb_stem separate / prepare → open_midi → add_audio {count: 2} → save_copy
#    → gb_band build (MuLaCover vocal at its start bar on audio track 1, ACE-Step vocal at bar 1 on track 2)
#    → open_band → gb_export song
models/.venv/bin/python eval/m12b/e2e.py eval/m12b/example.json
# 2. the measure: each vocal's lag at its bar (the other vocal's fitted share removed), and the export minus the
#    vocals against a MIDI-only export of the song (log-mel; control: against the vocals)
models/.venv/bin/python eval/m12b/measure.py probe-export/<name>.wav probe-export/song-midi-only.wav <bpm> out.json \
  stems/<name>-mulacover-vocals-<bpm>.wav@<start bar> stems/<name>-acestep-vocals-<bpm>.wav@1
```

Pass: every vocal lag ≤ 5 ms; the rest matches the MIDI-only export (log-mel ≥ 0.95, and above the control); every 8
bars within 3 dB.

Result 2026-10-05 (results-2026-10-05.json; a 9-track gb-mcp song at 132 BPM, MacBook Air M4): MuLaCover sang 16 bars
in 180 s (it chose 111 BPM; the status warning gave the gb_stem prepare call; re-timed: 131.9 BPM); ACE-Step covered the
116 s export in 120 s. GarageBand's re-save had both vocals at their bars. Both vocals at lag 0.0 ms (4 windows each,
gains 0.80); the export minus the vocals vs the MIDI-only export: log-mel 0.987 (control 0.397), every 8 bars within
0.9 dB.
