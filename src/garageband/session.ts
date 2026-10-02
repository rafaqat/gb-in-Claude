// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import type { HelperPort } from "../native/helper-port.js";
import { callOp, AppStateResult, FindResult, type AppStateResult as AppState } from "../native/protocol.js";
import { PROJECT_CHOOSER_ID, parseTrackHeader, type RootSpec } from "../ax/locators.js";
import type { Selector, TreeNode } from "../ax/selector.js";
import { ok, err, type Result } from "../result.js";
import { failed, type Failed } from "../mcp/envelope.js";
import { cleanText } from "../sound/text.js";
import { isScreenLocked } from "./screen.js";
import { waitUntilIdle } from "./dialogs.js";

export const MAIN: RootSpec = { kind: "main_window" };
export const TRACKS_HEADER: Selector = { role: "AXGroup", description: "Tracks header" };
const HEADERS: Selector = { role: "AXLayoutItem", ancestors: [TRACKS_HEADER] };
const REGIONS: Selector = { role: "AXLayoutItem", ancestors: [{ role: "AXGroup", description: "Tracks contents" }] };
const NOT_REGIONS = /^(cycle region|Note at )/;
/** a region reads “<name>, muted” while its track is silent (muted, or another track soloed). */
const SILENT = /, muted$/;
export const regionName = (desc: string) => desc.replace(SILENT, "");

export type SessionDeps = {
  helper: HelperPort;
  /** Defaults to reading the console session's lock flag. */
  screenLocked?: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
};

/** The project window (never the project chooser), if one is open. */
export const projectWindow = (s: AppState) => s.windows?.find((w) => w.subrole === "AXStandardWindow" && w.id !== PROJECT_CHOOSER_ID);

/**
 * Preconditions shared by every GarageBand command: screen unlocked, GarageBand running with a project open, and no
 * modal state (a dialog may be the user's: nothing is pressed). Read-only.
 */
export async function ensureReady(op: string, deps: SessionDeps): Promise<Result<AppState, Failed>> {
  if (await (deps.screenLocked ?? isScreenLocked)()) {
    return err(failed(op, "SCREEN_LOCKED", "the Mac's screen is locked: GarageBand has no usable windows", { hint: "unlock the Mac, then retry" }));
  }
  const idle = await waitUntilIdle(deps.helper, deps.sleep, Math.min(deps.pollMs, 500), 20);
  if (idle.kind === "unknown") return err(failed(op, "HELPER_UNAVAILABLE", idle.message, { hint: "run gb_system doctor" }));
  if (idle.kind === "not_running") return err(failed(op, "GB_NOT_RUNNING", "GarageBand is not running", { hint: "open a song first with gb_project open_midi" }));
  if (idle.kind !== "none") {
    return err(failed(op, "DIALOG_UNEXPECTED", idle.kind === "busy" ? "GarageBand is still busy (a progress window stays open)" : "a dialog is open in GarageBand; refusing to act (it may be yours)", {
      hint: "deal with the dialog first (gb_system ui_snapshot panel=dialog shows it)",
      ...(idle.kind === "save_prompt" || idle.kind === "other" ? { context: { dialog: idle.texts.map((t) => cleanText(t)) } } : {}),
    }));
  }
  const s = await callOp(deps.helper, "app.state", {}, AppStateResult, { deadlineMs: 4_000 });
  if (!s.ok) return err(failed(op, "HELPER_UNAVAILABLE", s.error.message, { hint: "run gb_system doctor" }));
  if (!projectWindow(s.value)) {
    return err(failed(op, "NO_PROJECT_OPEN", "no GarageBand project is open (only the project chooser)", { hint: "open a song with gb_project open_midi" }));
  }
  return ok(s.value);
}

export type Track = {
  number: number;
  /** The patch GarageBand shows in the track header (UI text, cleaned). */
  patch: string;
  /** The region's name — the MIDI track name for imported songs (UI text, cleaned); null when lanes don't map 1:1. */
  region: string | null;
  muted: boolean;
  soloed: boolean;
  /** false while the track is silent in the mix — muted, or another track is soloed (from the region); null if unknown. */
  audible: boolean | null;
  selected: boolean;
  /** The header's exact AX description: the selector key for its controls (raw, never shown to agents). */
  description: string;
};

/** Read the track headers and regions (read-only). */
export async function readTracks(op: string, helper: HelperPort): Promise<Result<Track[], Failed>> {
  const find = (selector: Selector) => callOp(helper, "ax.find", { root: MAIN, selector, max_results: 200 }, FindResult, { deadlineMs: 4_000 });
  const [headers, regions] = await Promise.all([find(HEADERS), find(REGIONS)]);
  if (!headers.ok) return err(failed(op, "HELPER_UNAVAILABLE", headers.error.message, { hint: "run gb_system doctor" }));
  const regionDescs = regions.ok ? regions.value.matches.map((n) => n.desc ?? "").filter((d) => d && !NOT_REGIONS.test(d)) : [];
  const parsed = headers.value.matches
    .map((n: TreeNode) => ({ node: n, h: parseTrackHeader(n.desc ?? "") }))
    .filter((x): x is { node: TreeNode; h: NonNullable<ReturnType<typeof parseTrackHeader>> } => x.h !== undefined);
  const oneToOne = regionDescs.length === parsed.length;
  return ok(parsed.map(({ node, h }, i) => ({
    number: h.number, patch: cleanText(h.name), region: oneToOne ? cleanText(regionName(regionDescs[i]!)) : null,
    muted: h.muted, soloed: h.soloed, audible: oneToOne ? !SILENT.test(regionDescs[i]!) : null,
    selected: node.selected === true, description: h.description,
  })));
}

/** What an agent sees of a track (the raw AX description stays internal). */
export const publicTrack = ({ description: _d, ...t }: Track) => t;

/** Field mask (context-window discipline): keep only `fields`, plus the always-present `keep` keys. */
export function pickFields<T extends Record<string, unknown>>(row: T, fields: readonly string[] | undefined, keep: readonly string[] = []): Partial<T> {
  if (!fields) return row;
  return Object.fromEntries(Object.entries(row).filter(([k]) => keep.includes(k) || fields.includes(k))) as Partial<T>;
}
