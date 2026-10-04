# M11 gate — expression reaches GarageBand

`gate.song.json` uses every expression feature, one per section. Run:

1. `gb_song render_midi {song: gate.song.json, filename: "m11-gate.mid"}` → `gb_project open_midi` → `gb_export song`
2. `models/.venv/bin/python eval/m11/measure.py <export.wav>` — prints PASS/FAIL per feature; exit 1 on any failure.

Result on GarageBand 10.4.14 (2026-10-04, `results-2026-10-04.json`): 9/9 pass — meend D5→E5 (72 frames between),
shruti −33¢ (target −30), vibrato wobble 18¢, hairpin +14.3 dB, pedal +10.2 dB between notes, pan L−R +10.7 dB,
brightness centroid 5769 → 838 Hz, fade −34.2 dB, ritardando beat 0.50 → 0.82 s.
The pedal window was moved to 0.55–0.95 s after the notes (from 0.8–1.4 s) after the first run: the unpedalled
Steinway gets louder again ~0.8 s after key-off (release/room sound), which masked the pedal's sustain.

`.band` path (gb_band build): whole-step slides written into the av donor's Keys (Steinway Grand Piano) and Bass
(Fingerstyle Bass) regions; GarageBand kept the bends in its own save and the isolated exports bend +207¢ / +198¢
(target +200), unbent bar +7¢ / +8¢.
