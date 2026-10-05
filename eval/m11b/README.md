# M11b gate: a gb-mcp MIDI song and an outside stem in one GarageBand project

Live GarageBand, through the MCP tools only — no hand-made donor.

```sh
# 1. the chain: gb_stem prepare → gb_project open_midi → gb_tracks add_audio → gb_project save_copy
#    → gb_band build (slot grafted on the new audio track) → gb_project open_band → gb_export song
models/.venv/bin/python eval/m11b/e2e.py song.mid samples/tabla.wav 132 song
# 2. the measure: stem lag and gain; the export minus the stem against a MIDI-only export (log-mel)
models/.venv/bin/python eval/m11b/measure.py probe-export/song-stems.wav stems/song-stem.wav \
  probe-export/song-midi-only.wav 132 eval/m11b/results-2026-10-05.json
```

Pass: stem lag ≤ 5 ms at every check point; the rest matches the MIDI-only export (log-mel correlation ≥ 0.95, and
higher than against the stem); the rest is within 3 dB of the MIDI-only export in every 8 bars.

Result 2026-10-05 (results-2026-10-05.json): all 7 tool steps verified; GarageBand's re-save had the stem on track 1
at bar 1 and every MIDI region. Stem lag 0.0 ms at 10 / 30 / 60 / 90 s, gain 0.82; rest vs MIDI-only 0.996 (control
vs stem 0.674); every 8-bar section within 1.2 dB. The stem plays 1.7 dB below the source in the export (gain 0.82;
the cause — fader, pan law or a mono track — is not checked yet).
