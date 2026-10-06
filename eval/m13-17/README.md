# M13.17 screen: afrobeats and UK garage template part work

GM-synth drafts only (gb_song render_draft's code, the macOS GM synth). No GarageBand. The main session confirms the
kept changes in a live GarageBand export.

```sh
# screen variants of the frozen brief (its genre, key, tempo); --key tries another key; "+" stacks variants
models/.venv/bin/python eval/m13-17/screen.py --brief 08-afrobeats --label r1 --seeds 1,2,3 base kit-808 af-gtr-oct4
# how well a draft stands in for a live export: genre profiles of drafts vs the live exports of one eval run
models/.venv/bin/python eval/m13-17/calibrate.py --live m13 --renders <checkout>/eval/results/m13/renders.json \
  pre-m13-17 pre-m13-17+proxy-kits+proxy-clean
# one variant's Song JSON (for a live confirm through gb_song render_midi)
node_modules/.bin/tsx eval/m13-17/variants.ts --song "UK garage" "C minor" 132 1 ug-chops-53-o3
node_modules/.bin/tsx eval/m13-17/variants.ts --list
```

- `variants.ts` writes each variant in the template's own fields, so a winner moves into src/song/genres.ts as it is.
  "base" is the template at the time of the run. Results labelled before the template change (all except
  `final-template`) have the old base: afrobeats on kit 32, UK garage on kit 16. `pre-m13-17` restores those kits.
- WAVs and per-WAV scores go to `out/eval-m13-17/`. A WAV's name is the hash of its Song JSON; the scripts never overwrite.
- Scores are the same as eval/run.py: the CLAP rank of the brief's genre among the 20 "<genre> music" prompts, and the
  beat_this grid. "Margin" is the brief's genre similarity minus the best other genre's (> 0 means rank 1).
- Seeds change only the humanize timing, so seed spread is small. Rank steps of 1 are often two genres at almost the
  same similarity. Tables: `eval/results/m13-17/<brief>-<label>.md`.

## Calibration: the plain GM draft misleads for some kits and patches

The genre profile (CLAP similarity to the 20 prompts) of a draft vs the profile of the live m13 export of the same
brief (Pearson r). The live exports are read only.

| Draft condition | Median r (20 briefs) | Rank Spearman | afrobeats r | UK garage r | trap r | DnB r |
|---|---|---|---|---|---|---|
| plain GM draft | 0.75 | 0.56 | 0.71 | 0.50 | 0.44 | 0.61 |
| proxy-electro: kit 16 drafted on GM kit 24 | 0.77 | 0.65 | 0.71 | 0.82 | 0.44 | 0.78 |
| proxy-808: kit 24 drafted on GM kit 25 | 0.77 | 0.57 | 0.71 | 0.50 | 0.77 | 0.61 |
| proxy-clean: programs 27/28 drafted on GM 26 | 0.78 | 0.61 | 0.91 | 0.50 | 0.44 | 0.61 |
| all three | 0.80 | 0.71 | 0.91 | 0.82 | 0.77 | 0.78 |

Cause: on channel 10 the GM synth plays program 16 as an acoustic kit ("Power"); GarageBand plays it as Epic
Electro. GarageBand plays 24 and 25 as Boutique 808; the GM synth plays 24 as its Electronic kit and only 25 as an 808.
The plain drafts ranked UK garage 4–5 and afrobeats 5; the live exports rank them 12 and 13. With the proxies the
drafts rank them 15 and 11. So this screen judges each genre in both conditions and trusts the proxy condition more.
The proxies were chosen with the same live data that judges them (one export per brief), so this calibration is a
guide, not a proof.

## Results (brief key, rank median over seeds; lower is better)

Afrobeats (G major, 108 BPM; live m13: rank 13, top funk).

| Variant | Plain draft | Guitar proxy | Notes |
|---|---|---|---|
| old base (kit 32, Roots) | 5 (5 5 5 5 5) | 11 (11 12 11 12 11) | top: reggaeton / jazz ballad |
| **kit 25 (Boutique 808) — kept** | **4 (4 4 4 4 4)** | **5 (5 5 5 5 5)** | better in all 5 keys in both conditions (proxy: A minor 12 → 7, Eb 11 → 7, D minor 11 → 7, E 10 → 7) |
| guitar an octave up | 3 (3 6 4 3 3) | – | leaves the guitar's range (E6) in some keys: rejected |
| 808 + held bass (sustain) | 3 (3 3 3 3 3) | 4 (4 6 4) | mixed over keys (Eb: worse than the kit alone) |
| 808 + Rhodes stabs as the hook pad | – | 4 (4 4 4) | changes the pad that fixed the live grid: not kept |
| snare in place of clap / ride bell | 10 / 8 | 12 / 12 | funk rises |
| other single changes (kick 3-3-2, swing, shaker, rim, leads, loops) | 4–11 | 5–12 | none better than the kit; see `08-afrobeats-r1.md`, `-p1.md` |

With the proxy the 808 kit moves other genres (jazz ballad, reggaeton) below afrobeats, but funk stays on top: the
margin to the best other genre does not shrink (−0.09 → −0.08 … −0.09). Live, funk is on top already.

UK garage (C minor, 132 BPM; live m13: rank 12, top deep house).

| Variant | Plain draft | Electro proxy | Notes |
|---|---|---|---|
| old base (kit 16, Epic Electro) | 5 (4 5 5 4 6) | 15 (15 15 15 14 15) | top: funk / deep house |
| **kit 25 (Boutique 808) — kept** | 12 (12 13 10 12 13) | **12 (12 13 10 12 13)** | proxy: better in all 5 keys tried (C min −3, F min −6, G −1, A min −3, Bb −2) |
| Voice Oohs (53) gated chord chops, octave 3, verse + chorus | – | 14 (15 14 14 14 15) | better in all 5 keys (−1 … −3); octave 4 leaves the range (A5) in 9 keys |
| 808 + chops | – | 13 (11 13 13 13 13) | better than the kit alone in 3 of 5 keys, worse in C minor: not kept |
| hook also in the verse | 4 (4 4 4 4 4) | 12 (12 12 12 12 12) | F minor: no change |
| 2-step kick (two bars) | 4 (4 4 4 4 6) | 13 (12 13 13) | a swap with drum and bass at almost equal similarity |
| rock organ (18) | 5 | 14 | raises "UK garage" similarity strongly: likely the word "garage" (garage rock), not the genre |

On the plain draft the UK garage change reads as 5 → 12. That baseline is the acoustic "Power" kit, which GarageBand
never plays; the 808 draft is faithful (proxy-808). The live export of the old template is rank 12, the same as the
808 draft. The evidence for UK garage is weak: confirm it live, and revert it if the live rank does not improve.
