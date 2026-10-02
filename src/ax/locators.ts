// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import type { Selector } from "./selector.js";

/**
 * GarageBand UI locators, keyed by GarageBand version. Every entry records its evidence:
 *  - "live": resolved read-only against the running GarageBand 10.4.14 (gb-helper smoke tests)
 *  - "fixture": recorded in test/fixtures/garageband-10.4.14 from the live app
 *  - "inferred": structurally expected but not yet observed — never used without live verification
 * Matching is exact (see selector.ts). Never target by screen position.
 */
export type Evidence = "live" | "fixture" | "inferred";

export type RootSpec = {
  kind: "app" | "main_window" | "dialog" | "sheet" | "menubar" | "window";
  title?: string;
  identifier?: string;
  /** Narrow the root to exactly one element (a panel) inside it. */
  element?: Selector;
};

/** How a control behaves — decides how the AX core verifies an action on it. */
export type ControlKind =
  | "toggle" // checkbox: press flips 0/1, value reads back; a retry after an unconfirmed press could double-toggle
  | "button" // press has no readable state of its own
  | "stepwise_slider" // integer slider: ONE step per AXValue set → converge with read-back
  | "slider" // continuous 0–1 slider: direct set
  | "text"
  | "popup"
  | "radio";

/** Transport state a control only exists in (its identity changes with state). */
export type TransportState = "playing" | "stopped";

export type ControlLocator = {
  root: RootSpec;
  selector: Selector;
  kind: ControlKind;
  description: string;
  evidence: Evidence;
  requiresState?: TransportState;
};
export type PanelLocator = { root: RootSpec; description: string; depth: number; evidence: Evidence };
export type MenuLocator = { path: string[]; description: string; evidence: Evidence };

export type LocatorSet = {
  version: string;
  panels: Record<string, PanelLocator>;
  controls: Record<string, ControlLocator>;
  menus: Record<string, MenuLocator>;
};

/** GarageBand's “Choose a Project” window — an AXStandardWindow that is never the project. */
export const PROJECT_CHOOSER_ID = "newProjectDialog";

const MAIN: RootSpec = { kind: "main_window" };
const CONTROL_BAR: Selector = { role: "AXGroup", description: "Control Bar" };
const EXPORT_PANEL: RootSpec = { kind: "dialog", identifier: "save-panel" };

const transport = (title: string, kind: ControlKind, description: string): ControlLocator => ({
  root: MAIN, kind, description, evidence: "fixture",
  selector: { role: kind === "button" ? "AXButton" : "AXCheckBox", ...(kind === "button" ? { description: title } : { title }), ancestors: [CONTROL_BAR] },
});

const exportControl = (selector: Selector, kind: ControlKind, description: string): ControlLocator =>
  ({ root: EXPORT_PANEL, selector, kind, description, evidence: "fixture" });

export const GB_10_4_14: LocatorSet = {
  version: "10.4.14",
  panels: {
    window: { root: MAIN, depth: 2, description: "The project window (top level only)", evidence: "live" },
    "control-bar": { root: { ...MAIN, element: { ...CONTROL_BAR, index: 0 } }, depth: 3, description: "Transport, LCD (tempo, playhead), view toggles", evidence: "live" },
    playhead: { root: { ...MAIN, element: { role: "AXGroup", description: "Playhead Position" } }, depth: 1, description: "LCD bar/beat", evidence: "live" },
    "tracks-header": { root: { ...MAIN, element: { role: "AXGroup", description: "Tracks header" } }, depth: 2, description: "Track headers: Track N “patch”, mute/solo/volume/pan", evidence: "fixture" },
    "tracks-contents": { root: { ...MAIN, element: { role: "AXGroup", description: "Tracks contents" } }, depth: 2, description: "Regions (named after the MIDI track names)", evidence: "fixture" },
    library: { root: { ...MAIN, element: { role: "AXGroup", description: "Library", index: 0 } }, depth: 6, description: "Patch library (shown via view.library)", evidence: "fixture" },
    "smart-controls": { root: { ...MAIN, element: { role: "AXGroup", description: "Smart Controls", index: 0 } }, depth: 4, description: "Smart Controls (knobs are NOT AX-addressable)", evidence: "fixture" },
    "piano-roll": { root: { ...MAIN, element: { role: "AXGroup", description: "Piano Roll", index: 0 } }, depth: 6, description: "Piano roll: notes as “Note at N bars …, C3” (Apple octaves)", evidence: "inferred" },
    "export-dialog": { root: EXPORT_PANEL, depth: 3, description: "Share ▸ Export Song to Disk… save panel (file browser pruned)", evidence: "fixture" },
    dialog: { root: { kind: "dialog" }, depth: 4, description: "The single open dialog (save prompts, project chooser)", evidence: "inferred" },
    menubar: { root: { kind: "menubar" }, depth: 2, description: "Menu bar and top-level menus", evidence: "live" },
  },
  controls: {
    "transport.play": transport("Play", "toggle", "Play/pause (value 1 while playing; pressing again stops)"),
    "transport.record": transport("Record", "toggle", "Record (never pressed by the probes)"),
    "transport.cycle": transport("Cycle", "toggle", "Cycle mode"),
    "transport.count_in": transport("Count In", "toggle", "Count-in before recording"),
    "transport.metronome": transport("Metronome Click", "toggle", "Metronome"),
    // One physical button whose title AND description change with transport state:
    "transport.stop": { ...transport("Stop", "button", "Stop playback — this button reads “Stop” only while playing"), requiresState: "playing" },
    "transport.go_to_beginning": {
      ...transport("Go to Beginning", "button", "Move the playhead to the start — the same button reads “Go to Beginning” while stopped"),
      requiresState: "stopped", evidence: "live",
    },
    "transport.forward": transport("Forward", "button", "Playhead forward one bar"),
    "transport.rewind": transport("Rewind", "button", "Playhead back one bar"),
    "view.library": transport("Library", "toggle", "Show/hide the Library panel"),
    "view.smart_controls": transport("Smart Controls", "toggle", "Show/hide Smart Controls"),
    "view.editors": transport("Editors", "toggle", "Show/hide the editors (piano roll)"),
    "view.loop_browser": transport("Loop Browser", "toggle", "Show/hide the Loop Browser"),
    "view.quick_help": transport("Quick Help", "toggle", "Show/hide Quick Help"),
    "view.notepad": transport("Notepad", "toggle", "Show/hide the Notepad"),
    "lcd.tempo": { root: MAIN, kind: "stepwise_slider", description: "Project tempo (integer BPM 5–990; ONE step per set → converge)", evidence: "live",
      selector: { role: "AXSlider", description: "Tempo", ancestors: [CONTROL_BAR] } },
    "lcd.playhead_bar": { root: MAIN, kind: "stepwise_slider", description: "Playhead bar (min/max are a ±1 window)", evidence: "live",
      selector: { role: "AXSlider", description: "bar", ancestors: [{ role: "AXGroup", description: "Playhead Position" }] } },
    "lcd.playhead_beat": { root: MAIN, kind: "stepwise_slider", description: "Playhead beat", evidence: "live",
      selector: { role: "AXSlider", description: "beat", ancestors: [{ role: "AXGroup", description: "Playhead Position" }] } },
    "lcd.display_mode": { root: MAIN, kind: "popup", description: "Display mode (“Beats & Project”)", evidence: "fixture",
      selector: { role: "AXPopUpButton", description: "Display Mode", ancestors: [CONTROL_BAR] } },
    "lcd.time_signature": { root: MAIN, kind: "popup", description: "Time signature (“4/4”)", evidence: "fixture",
      selector: { role: "AXPopUpButton", description: "Time Signature", ancestors: [CONTROL_BAR] } },
    "lcd.key_signature": { root: MAIN, kind: "popup", description: "Key signature (“C Major”)", evidence: "fixture",
      selector: { role: "AXPopUpButton", description: "Key Signature", ancestors: [CONTROL_BAR] } },
    "master.volume": { root: MAIN, kind: "slider", description: "Master volume (0–1)", evidence: "fixture",
      selector: { role: "AXSlider", description: "Master Volume", ancestors: [CONTROL_BAR] } },
    "export.name": exportControl({ role: "AXTextField", identifier: "saveAsNameTextField" }, "text", "Export file name (set by AX, read back)"),
    "export.where": exportControl({ role: "AXPopUpButton", identifier: "where popup" }, "popup", "Destination folder (reads back the folder name)"),
    "export.format.wave": exportControl({ role: "AXRadioButton", title: "WAVE" }, "radio", "WAVE (quality auto: Uncompressed 16-bit)"),
    "export.format.aiff": exportControl({ role: "AXRadioButton", title: "AIFF" }, "radio", "AIFF"),
    "export.format.mp3": exportControl({ role: "AXRadioButton", title: "MP3" }, "radio", "MP3"),
    "export.format.aac": exportControl({ role: "AXRadioButton", title: "AAC" }, "radio", "AAC"),
    "export.ok": exportControl({ role: "AXButton", identifier: "OKButton" }, "button", "Export (verify by panel closed + file size stable, never by the press)"),
    "export.cancel": exportControl({ role: "AXButton", identifier: "CancelButton" }, "button", "Cancel"),
    "save_prompt.dont_save": { root: { kind: "dialog" }, kind: "button", evidence: "live",
      description: "“Don’t Save” (U+2019) — only for documents gb-mcp opened itself (check parseSavePrompt first)",
      selector: { role: "AXButton", title: "Don’t Save" } },
    "save_prompt.save": { root: { kind: "dialog" }, kind: "button", evidence: "live", description: "Save", selector: { role: "AXButton", title: "Save" } },
    "save_prompt.cancel": { root: { kind: "dialog" }, kind: "button", evidence: "live", description: "Cancel", selector: { role: "AXButton", title: "Cancel" } },
  },
  menus: {
    "share.export_song_to_disk": { path: ["Share", "Export Song to Disk…"], description: "Open the export save panel", evidence: "live" },
    "track.new_tracks": { path: ["Track", "New Tracks…"], description: "New track sheet (plural title in 10.4.14)", evidence: "live" },
    "track.delete_track": { path: ["Track", "Delete Track"], description: "Delete the selected track", evidence: "live" },
    "record.count_in.none": { path: ["Record", "Count-in", "None"], description: "Count-in off (checkmark reads back)", evidence: "live" },
    "record.count_in.1_bar": { path: ["Record", "Count-in", "1 Bar"], description: "Count-in 1 bar", evidence: "live" },
    "record.count_in.2_bars": { path: ["Record", "Count-in", "2 Bars"], description: "Count-in 2 bars", evidence: "live" },
    "view.show_library": { path: ["View", "Show Library"], description: "Show the Library (title flips to Hide when shown)", evidence: "live" },
    "file.new": { path: ["File", "New…"], description: "New project (opens the project chooser)", evidence: "live" },
    "file.open": { path: ["File", "Open…"], description: "Open project", evidence: "live" },
    "file.save": { path: ["File", "Save"], description: "Save (disabled when unmodified)", evidence: "live" },
    "file.close_all": { path: ["File", "Close All"], description: "Close all projects", evidence: "live" },
  },
};

export const LOCATORS: Readonly<Record<string, LocatorSet>> = { "10.4.14": GB_10_4_14 };
export const SUPPORTED_GARAGEBAND_VERSIONS = Object.keys(LOCATORS);

export function locatorsFor(version: string | null | undefined): LocatorSet | undefined {
  return version ? LOCATORS[version] : undefined;
}

// ------------------------------------------------------------------------------------------------ parsers

export type TrackHeader = { number: number; name: string; muted: boolean; soloed: boolean; description: string };

const TRACK_HEADER = /^Track (\d+) “(.+)”((?:, (?:mute|solo))*)$/;

/** `Track 2 “Taureg Moon Bass”, mute` → { number: 2, name, muted: true }. Never exact-match the whole string. */
export function parseTrackHeader(description: string): TrackHeader | undefined {
  const m = TRACK_HEADER.exec(description);
  if (!m) return undefined;
  const flags = m[3] ?? "";
  return { number: Number(m[1]), name: m[2]!, muted: flags.includes(", mute"), soloed: flags.includes(", solo"), description };
}

export type TrackControl = "mute" | "solo" | "input_monitoring" | "volume" | "pan";

const TRACK_CONTROL_SELECTORS: Record<TrackControl, { selector: Selector; kind: ControlKind }> = {
  mute: { selector: { role: "AXCheckBox", description: "Mute" }, kind: "toggle" },
  solo: { selector: { role: "AXCheckBox", description: "Solo" }, kind: "toggle" },
  input_monitoring: { selector: { role: "AXCheckBox", description: "Input Monitoring" }, kind: "toggle" },
  volume: { selector: { role: "AXSlider", description: "Volume" }, kind: "stepwise_slider" }, // 0–233, 173 ≈ 0 dB
  pan: { selector: { role: "AXSlider", description: "" }, kind: "stepwise_slider" }, // 0–127, 64 = centre; NO description
};

/**
 * A control inside ONE track header, scoped by the header's CURRENT exact description. The description changes
 * when the track is muted/soloed, so callers re-read headers after such actions and rebuild the locator.
 */
export function trackControlLocator(header: TrackHeader, control: TrackControl): ControlLocator {
  const c = TRACK_CONTROL_SELECTORS[control];
  return {
    root: MAIN,
    kind: c.kind,
    evidence: "fixture",
    description: `${control} of track ${header.number} (${header.name})`,
    selector: { ...c.selector, ancestors: [{ role: "AXGroup", description: "Tracks header" }, { role: "AXLayoutItem", description: header.description }] },
  };
}

export type PianoRollNote = { bar: number; beat: number; division: number; name: string; midi: number };

const PIANO_ROLL_NOTE = /^Note at (\d+) bars?(?: (\d+) beats?)?(?: (\d+) divisions?)? , ([A-G][♯♭#b]?-?\d+)$/;

/** `Note at 9 bars 2 beats 2 divisions , G♯4` → bar 9, beat 2, division 2, MIDI 80 (omitted parts are 1). */
export function parsePianoRollNote(description: string): PianoRollNote | undefined {
  const m = PIANO_ROLL_NOTE.exec(description);
  if (!m) return undefined;
  const midi = appleNoteToMidi(m[4]!);
  if (midi === undefined) return undefined;
  return { bar: Number(m[1]), beat: m[2] ? Number(m[2]) : 1, division: m[3] ? Number(m[3]) : 1, name: m[4]!, midi };
}

const PITCH_CLASS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Apple/GarageBand naming: MIDI 60 = "C3" (scientific C4). Accepts ♯/# and ♭/b. */
export function appleNoteToMidi(name: string): number | undefined {
  const m = /^([A-G])([♯♭#b]?)(-?\d+)$/.exec(name);
  if (!m) return undefined;
  const shift = m[2] === "♯" || m[2] === "#" ? 1 : m[2] === "♭" || m[2] === "b" ? -1 : 0;
  const midi = (Number(m[3]) + 2) * 12 + PITCH_CLASS[m[1]!]! + shift;
  return midi >= 0 && midi <= 127 ? midi : undefined;
}

/** Untitled: "…save the document “X”?" · saved but modified: "…save the changes made to the document “X”?" */
const SAVE_PROMPT = /^Do you want to save (?:the changes made to )?the document “(.+)”\?$/;

/** The document a "Do you want to save…" prompt is about — the guard before ever pressing Don’t Save. */
export function parseSavePrompt(text: string): string | undefined {
  return SAVE_PROMPT.exec(text)?.[1];
}
