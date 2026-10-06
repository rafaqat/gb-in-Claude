// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { onsetF, beatPitch, chordScore, keyRelation } from "./transcription-score.js";

describe("transcription scores (M13.14 benchmark): a draft against the song it was rendered from", () => {
  it("onset F-measure: a match is within 50 ms (and the same pitch when asked); each note matches once", () => {
    const truth = [{ t: 0.0, pitch: 60 }, { t: 0.5, pitch: 62 }, { t: 1.0, pitch: 64 }, { t: 1.5, pitch: 65 }];
    const est = [{ t: 0.03, pitch: 60 }, { t: 0.04, pitch: 60 }, { t: 0.56, pitch: 62 }, { t: 1.02, pitch: 63 }];
    expect(onsetF(truth, est, { pitch: false })).toEqual({ truth: 4, est: 4, matched: 2, precision: 0.5, recall: 0.5, f: 0.5 });
    expect(onsetF(truth, est, { pitch: true })).toMatchObject({ matched: 1, f: 0.25 });
    expect(onsetF([], [], { pitch: false })).toMatchObject({ f: 1 });
  });

  it("pitch per beat: the note that sounds longest in each beat where the truth plays, exact and as a pitch class", () => {
    const beats = [0, 0.5, 1.0, 1.5, 2.0];
    const truth = [{ t: 0, end: 1.0, pitch: 38 }, { t: 1.0, end: 2.0, pitch: 43 }];         // beats 1-2 D2, beats 3-4 G2
    const est = [{ t: 0.05, end: 0.5, pitch: 38 }, { t: 0.5, end: 1.0, pitch: 50 }, { t: 1.6, end: 2.0, pitch: 43 }];
    expect(beatPitch(truth, est, beats)).toEqual({ beats: 4, exact: 0.5, pitch_class: 0.75 });
  });

  it("chords per half bar: the root, and major/minor (7ths reduce to their triad; a sus chord counts for the root only)", () => {
    const pairs: [string, string | null][] = [["Am7", "Am"], ["Fmaj7", "F"], ["G7", "Gm"], ["Csus4", "C"], ["Dm", "F"], ["E", null]];
    expect(chordScore(pairs)).toEqual({ halves: 6, root: 0.667, majmin: 0.4 });
  });

  it("key: exact, relative (major ↔ minor on the same notes), or other; enharmonic names are the same key", () => {
    expect(keyRelation("Eb major", "D# major")).toBe("exact");
    expect(keyRelation("A minor", "C major")).toBe("relative");
    expect(keyRelation("A minor", "A major")).toBe("other");
    expect(keyRelation("A minor", undefined)).toBe("other");
  });
});
