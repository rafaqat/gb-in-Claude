// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { z } from "zod";
import type { HelperPort } from "../native/helper-port.js";
import { AxCore, type Target } from "../ax/core.js";
import { ok, err, type Result } from "../result.js";
import { verified, uncertain, failed, type Envelope, type Failed } from "../mcp/envelope.js";
import { GB_10_4_14, parseTrackHeader, trackControlLocator, type RootSpec } from "../ax/locators.js";
import type { PatchEntry } from "../sound/patches.js";
import type { TreeNode } from "../ax/selector.js";
import { classifyDialogs } from "./dialogs.js";
import { callOp, FindResult } from "../native/protocol.js";
import { mutationGate } from "./gate.js";
import { ensureReady, readTracks, publicTrack, pickFields, MAIN, TRACKS_HEADER, type SessionDeps, type Track } from "./session.js";
import { cleanText } from "../sound/text.js";

/** A track by its number (1-based, as GarageBand shows it) or by its exact patch / region name. */
export const TrackRef = z.union([z.number().int().min(1).max(999), z.string().min(1).max(120)]);
export const DryRun = z.boolean().optional().describe("resolve and plan only — touches nothing");

export const TRACK_FIELDS = ["patch", "region", "muted", "soloed", "audible", "selected"] as const;
export const GbTracksInput = z.discriminatedUnion("command", [
  z.object({ command: z.literal("list"), fields: z.array(z.enum(TRACK_FIELDS)).min(1).optional().describe("only these fields per track (number always included)") }).strict(),
  z.object({ command: z.literal("select"), track: TrackRef, dry_run: DryRun }).strict(),
  z.object({ command: z.literal("mute"), track: TrackRef, enabled: z.boolean(), dry_run: DryRun }).strict(),
  z.object({ command: z.literal("solo"), track: TrackRef, enabled: z.boolean(), dry_run: DryRun }).strict(),
  z.object({ command: z.literal("set_instrument"), track: TrackRef, patch: z.string().min(1).max(120), dry_run: DryRun }).strict(),
  z.object({ command: z.literal("add_audio"), count: z.number().int().min(1).max(16).default(1).describe("empty audio tracks to add"), dry_run: DryRun }).strict(),
]);
export const GB_TRACKS_COMMANDS = ["list", "select", "mute", "solo", "set_instrument", "add_audio"] as const;

/** Track ▸ New Tracks… (found live: , GarageBand 10.4.14): a sheet "New Track" with the track kinds as radio buttons. */
const NEW_TRACKS = ["Track", "New Tracks…"];
const NEW_TRACK_SHEET = { role: "AXSheet", description: "New Track" } as const;
const AUDIO_KIND: Target = { root: MAIN, selector: { role: "AXRadioButton", description: "Mic or Line, Audio" }, kind: "radio" };
const CREATE: Target = { root: MAIN, selector: { role: "AXButton", title: "Create" }, kind: "button" };
const CANCEL: Target = { root: MAIN, selector: { role: "AXButton", title: "Cancel" }, kind: "button" };
/** How long a track may take to appear after Create when GarageBand is busy (it answered −25204 live, then made it). */
const NEW_TRACK_WAIT_MS = 6_000;
const PLAY = GB_10_4_14.controls["transport.play"]!;
const playbackRunning = (op: string) => failed(op, "NOT_SUPPORTED", "playback is running: GarageBand disables Track ▸ New Tracks… while it plays; nothing pressed", {
  hint: "stop it with gb_transport stop (it may be the user's playback), then retry",
});
/** Its own interval (not pollMs): counted in pollMs, a 1 ms pollMs made 6,000 track-list reads (as waitEnabled in export.ts). */
const NEW_TRACK_POLL_MS = 250;

export type GbTracksDeps = Omit<SessionDeps, "sleep" | "pollMs"> & {
  helper: HelperPort;
  core?: AxCore;
  /** The installed patch catalog (gb_sound patches): set_instrument only ever loads content that is on disk. */
  patchCatalog: () => Promise<Result<PatchEntry[], string>>;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
};

/** a track header only accepts a click on its left strip (the rest is controls / the name field). */
export const HEADER_STRIP = { fx: 0.03, fy: 0.5 } as const;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const LIBRARY: RootSpec = GB_10_4_14.panels.library!.root;
const LIBRARY_TOGGLE = GB_10_4_14.controls["view.library"]!;
const SEARCH_FIELD = { root: LIBRARY, selector: { role: "AXTextField", subrole: "AXSearchField" } };
/** A Library search result, by its exact name (live: AXRow ▸ AXCell ▸ AXStaticText). */
const result = (name: string) => ({ root: LIBRARY, selector: { role: "AXStaticText", value: name, ancestors: [{ role: "AXRow" }] } });
const INSTALLED = new Set<PatchEntry["content"]>(["base", "receipt_found"]);
/** an installed search result is AXRow ▸ AXCell ▸ AXStaticText (name) + a date cell — nothing else. */
const RESULT_ROW_ROLES = new Set(["AXRow", "AXCell", "AXStaticText"]);

/** The roles inside the Library rows that show `name` (from a compact snapshot), one array per such row. */
function resultRows(root: TreeNode | null | undefined, name: string): string[][] {
  const rows: string[][] = [];
  const roles = (n: TreeNode): string[] => [n.role ?? "", ...(n.children ?? []).flatMap(roles)];
  const shows = (n: TreeNode): boolean => (n.role === "AXStaticText" && n.value === name) || (n.children ?? []).some(shows);
  const walk = (n: TreeNode) => {
    if (n.role === "AXRow") { if (shows(n)) rows.push(roles(n)); return; }
    (n.children ?? []).forEach(walk);
  };
  if (root) walk(root);
  return rows;
}
const flags = (t: Track) => (t.muted ? ", mute" : "") + (t.soloed ? ", solo" : "");
const brief = (t: Track) => ({ number: t.number, patch: t.patch, region: t.region });

/** Carry a `focus_restored: false` note from any focus borrow onto the final result (never silent). */
function withFocusNote(final: Envelope, ...borrows: Envelope[]): Envelope {
  const note = (b: Envelope) => {
    const bag = (b.status === "failed" ? b.context : (b as { data?: unknown }).data) as { focus_restored?: boolean } | undefined;
    return bag?.focus_restored;
  };
  const lost = borrows.some((b) => note(b) === false);
  if (!lost) return final;
  if (final.status === "failed") return { ...final, context: { ...(final.context as Record<string, unknown> | undefined), focus_restored: false } };
  return { ...final, data: { ...((final as { data?: Record<string, unknown> }).data), focus_restored: false } } as Envelope;
}

export const headerTarget = (t: Track): Omit<Target, "kind"> => ({
  root: MAIN, selector: { role: "AXLayoutItem", description: t.description, ancestors: [TRACKS_HEADER] },
});

/** Exactly one track, or a failure listing the tracks (never a guess). */
export function resolveTrack(op: string, tracks: Track[], ref: number | string): Result<Track, Failed> {
  const hits = typeof ref === "number" ? tracks.filter((t) => t.number === ref) : tracks.filter((t) => t.patch === ref || t.region === ref);
  if (hits.length === 1) return ok(hits[0]!);
  if (hits.length === 0) {
    return err(failed(op, "TARGET_NOT_FOUND", `no track ${typeof ref === "number" ? `number ${ref}` : `named “${ref}”`}`, {
      hint: "gb_tracks list shows the tracks; names are exact (patch or region)", context: { tracks: tracks.map(brief) },
    }));
  }
  return err(failed(op, "TARGET_AMBIGUOUS", `${hits.length} tracks are named “${ref}”`, { hint: "use the track number instead", context: { candidates: hits.map(brief) } }));
}

export function createGbTracks(deps: GbTracksDeps) {
  const core = deps.core ?? new AxCore(deps.helper);
  const session: SessionDeps = { helper: deps.helper, sleep: deps.sleep ?? realSleep, pollMs: deps.pollMs ?? 500, ...(deps.screenLocked ? { screenLocked: deps.screenLocked } : {}) };

  /** Preconditions + the current tracks + the one track asked for. */
  async function target(op: string, ref: number | string): Promise<Result<{ tracks: Track[]; track: Track }, Failed>> {
    const ready = await ensureReady(op, session);
    if (!ready.ok) return ready;
    const tracks = await readTracks(op, deps.helper);
    if (!tracks.ok) return tracks;
    const track = resolveTrack(op, tracks.value, ref);
    return track.ok ? ok({ tracks: tracks.value, track: track.value }) : track;
  }

  async function reread(op: string, number: number): Promise<Track | undefined> {
    const tracks = await readTracks(op, deps.helper);
    return tracks.ok ? tracks.value.find((t) => t.number === number) : undefined;
  }

  async function list(op: string, fields?: readonly string[]): Promise<Envelope> {
    const ready = await ensureReady(op, session);
    if (!ready.ok) return ready.error;
    const tracks = await readTracks(op, deps.helper);
    if (!tracks.ok) return tracks.error;
    return verified(op, { tracks: tracks.value.map((t) => pickFields(publicTrack(t), fields, ["number"])) });
  }

  async function select(op: string, ref: number | string, dryRun: boolean): Promise<Envelope> {
    const t = await target(op, ref);
    if (!t.ok) return t.error;
    const { track } = t.value;
    if (track.selected) return verified(op, { track: publicTrack(track), changed: false });
    if (dryRun) {
      return verified(op, { dry_run: true, track: publicTrack(track), plan: [
        "bring GarageBand to the front", `click track ${track.number}'s header (left strip, hit-tested)`, "read AXSelected back", "give focus back",
      ] });
    }
    return mutationGate.run(op, async () => {
      const clicked = await core.withFocus(op, () => core.click(op, headerTarget(track), { at: HEADER_STRIP, expectSelected: true }));
      if (clicked.status !== "verified") return clicked;
      const now = await reread(op, track.number); // read back with the user's app already in front
      return withFocusNote(verified(op, { track: now ? publicTrack(now) : { ...publicTrack(track), selected: true }, changed: true }), clicked);
    });
  }

  /** Mute/solo to an explicit state: read first, press only when it differs, prove it on the checkbox AND the header. */
  async function setFlag(op: string, ref: number | string, flag: "mute" | "solo", enabled: boolean, dryRun: boolean): Promise<Envelope> {
    const t = await target(op, ref);
    if (!t.ok) return t.error;
    const { track } = t.value;
    const state = (x: Track) => (flag === "mute" ? x.muted : x.soloed);
    if (state(track) === enabled) return verified(op, { track: publicTrack(track), changed: false });
    if (dryRun) {
      return verified(op, { dry_run: true, track: publicTrack(track), plan: [`press track ${track.number}'s ${flag} button (AX press — no click, no focus change)`, "read the button and the header back"] });
    }
    return mutationGate.run(op, async () => {
      const pressed = await core.press(op, trackControlLocator(parseTrackHeader(track.description)!, flag));
      if (pressed.status !== "verified") return pressed;
      const now = await reread(op, track.number);
      if (!now || state(now) !== enabled) {
        return uncertain(op, "readback_timeout", {
          write_attempted: true, safe_to_retry: false, hint: "the button flipped but the track header does not show it yet; check gb_tracks list before retrying",
          data: { track: now ? publicTrack(now) : publicTrack(track) },
        });
      }
      return verified(op, { track: publicTrack(now), changed: true });
    });
  }

  /**
   * Load a patch from GarageBand's Library onto a track, the way a person does: select the track (real click on its
   * header), search the Library, click the ONE result with exactly that name. Never a download (the user's decision):
   * every same-name catalog entry must have installed content AND GarageBand's own category list must not mark the
   * patch's category “downloadable” (search rows of such patches look identical). Fail-closed at each
   * step; focus is given back before waiting for the patch to load; proven by the track header naming the patch.
   */
  async function setInstrument(op: string, ref: number | string, patch: string, dryRun: boolean): Promise<Envelope> {
    const catalog = await deps.patchCatalog();
    if (!catalog.ok) return failed(op, "CATALOG_UNAVAILABLE", `the installed patch catalog is unreadable: ${catalog.error}`, { hint: "gb_system doctor" });
    const entries = catalog.value.filter((e) => e.name === patch && (e.kind === "instrument" || e.kind === "drum_kit"));
    if (entries.length === 0) {
      const q = patch.toLowerCase();
      const similar = catalog.value.filter((e) => e.name.toLowerCase().includes(q) || q.includes(e.name.toLowerCase())).slice(0, 8).map((e) => e.name);
      return failed(op, "TARGET_NOT_FOUND", `no installed instrument patch is named exactly “${patch}”`, {
        hint: "gb_sound patches lists installed patches (names are exact)", context: { similar },
      });
    }
    if (!entries.every((e) => INSTALLED.has(e.content))) {
      return failed(op, "CONTENT_NOT_INSTALLED", `“${patch}” needs sound content that is not installed`, {
        recoverable: false, hint: "download it yourself in GarageBand ▸ Sound Library if you want it — gb-mcp never starts downloads",
        context: { packs: [...new Set(entries.flatMap((e) => e.packs))] },
      });
    }
    const categories = [...new Set(entries.map((e) => e.category.split(" > ")[0]!))];
    const t = await target(op, ref);
    if (!t.ok) return t.error;
    const { track } = t.value;
    if (track.patch === patch) return verified(op, { track: publicTrack(track), from: track.patch, changed: false });
    if (dryRun) {
      return verified(op, { dry_run: true, track: publicTrack(track), to: patch, plan: [
        "show the Library if hidden", "bring GarageBand to the front", `click track ${track.number}'s header (selects it)`,
        `check GarageBand does not mark the ${categories.join("/")} category “downloadable”`, `search the Library for “${patch}”`,
        "check the selection is still that track", "click the one result with exactly that name", "give focus back",
        `read track ${track.number}'s header back`, "hide the Library again if it was hidden",
      ] });
    }
    return mutationGate.run(op, async () => {
      const shown = await core.read(op, LIBRARY_TOGGLE);
      if (shown.status !== "verified") return shown;
      const opened = (shown.data as { value: unknown }).value !== 1;
      if (opened) {
        const show = await core.press(op, LIBRARY_TOGGLE);
        if (show.status !== "verified") return show;
      }
      const touched = { search: false };
      try {
        // Focus is borrowed only around each real click: the user's keystrokes can land in
        // GarageBand only while it is in front, so every search / read / wait step runs with the user's app in front.
        const selected = await core.withFocus(op, () => core.click(op, headerTarget(track), { at: HEADER_STRIP, expectSelected: true }));
        if (selected.status !== "verified") return selected;
        touched.search = true;
        const prepared = await prepareResult(op, patch, categories);
        if (prepared.status !== "verified") return prepared;
        const clicked = await core.withFocus(op, () => clickResult(op, track, patch));
        if (clicked.status === "failed") return clicked;
        const loaded = await awaitPatch(op, track, patch);
        return withFocusNote(loaded, selected, clicked);
      } finally {
        if (touched.search) await core.set(op, { ...SEARCH_FIELD, kind: "text" }, ""); // leave the Library as it was found
        if (opened) await core.press(op, LIBRARY_TOGGLE);
      }
    });
  }

  /** With the user's app in front (AX only): category gate, search, exactly one installed-looking result row. */
  async function prepareResult(op: string, patch: string, categories: string[]): Promise<Envelope> {
    // An empty search shows the category list (for the selected track's type): GarageBand's own install flags.
    const cleared = await core.set(op, { ...SEARCH_FIELD, kind: "text" }, "");
    if (cleared.status !== "verified") return cleared;
    await core.perform(op, SEARCH_FIELD, "AXConfirm", { idempotent: true });
    const listed = await callOp(deps.helper, "ax.find", { root: LIBRARY, selector: { role: "AXStaticText", ancestors: [{ role: "AXList" }] }, max_results: 100 }, FindResult, { deadlineMs: 4_000 });
    const shownCategories = listed.ok ? listed.value.matches.map((n) => String(n.value ?? "")) : [];
    const downloadable = categories.filter((c) => shownCategories.includes(`downloadable ${c}`));
    if (downloadable.length > 0) {
      return failed(op, "CONTENT_NOT_INSTALLED", "GarageBand marks this patch's category downloadable: it may need content that is not installed; not clicked", {
        recoverable: false, write_attempted: true, safe_to_retry: false, context: { patch, categories: downloadable },
        hint: "pick a patch from an installed category (gb_sound patches), load it via its GM program, or download the content yourself in GarageBand",
      });
    }
    if (!categories.some((c) => shownCategories.includes(c))) {
      return failed(op, "TARGET_NOT_FOUND", "could not confirm the patch's category is installed for this track (not in the Library's list); not clicked", {
        write_attempted: true, safe_to_retry: true, context: { patch, categories },
        hint: "the track may be a type the patch does not fit (e.g. an audio track) — gb_tracks list",
      });
    }
    const typed = await core.set(op, { ...SEARCH_FIELD, kind: "text" }, patch);
    if (typed.status !== "verified") return typed;
    const listedResult = await core.perform(op, SEARCH_FIELD, "AXConfirm", {
      idempotent: true, postCondition: { ...result(patch), condition: "present", timeoutMs: 4_000 },
    });
    if (listedResult.status !== "verified") {
      return failed(op, "TARGET_NOT_FOUND", "the Library shows no result with exactly that name; nothing loaded", {
        write_attempted: true, safe_to_retry: true, hint: "gb_sound patches for exact names", context: { search: patch },
      });
    }
    // Fail closed: exactly one result row, fully read, shaped like an installed result (no extra controls).
    const snap = await core.snapshot(op, LIBRARY, { depth: 16, maxNodes: 800 });
    const tree = snap.status === "verified" ? (snap.data as { root: TreeNode | null; truncated: boolean }) : null;
    const rows = tree ? resultRows(tree.root, patch) : [];
    const odd = rows.flat().filter((role) => !RESULT_ROW_ROLES.has(role));
    if (!tree || tree.truncated || rows.length !== 1 || odd.length > 0) {
      return failed(op, odd.length > 0 ? "CONTENT_NOT_INSTALLED" : rows.length > 1 ? "TARGET_AMBIGUOUS" : "TARGET_NOT_FOUND",
        odd.length > 0 ? "the Library shows this result with extra controls — possibly a download; not clicked"
          : "expected exactly one fully read result row; not clicked",
        { recoverable: odd.length === 0, write_attempted: true, safe_to_retry: odd.length === 0, hint: "gb_sound patches lists exact, installed names",
          context: { patch, rows: rows.length, truncated: tree?.truncated ?? null, extra_roles: [...new Set(odd)] } });
    }
    return verified(op, { ready: patch });
  }

  /** Inside a short focus borrow: the click loads onto the SELECTED track, so it must still be ours right now. */
  async function clickResult(op: string, track: Track, patch: string): Promise<Envelope> {
    const still = await callOp(deps.helper, "ax.find", { root: MAIN, selector: headerTarget(track).selector, max_results: 2 }, FindResult, { deadlineMs: 4_000 });
    if (!still.ok || still.value.count !== 1 || still.value.matches[0]!.selected !== true) {
      return failed(op, "TARGET_CHANGED", `track ${track.number} is no longer the selected track; not clicked (the patch would replace another track's)`, {
        write_attempted: true, safe_to_retry: true, hint: "retry when nothing else is changing the selection",
      });
    }
    const r = await core.click(op, result(patch));
    return r.status === "failed" ? r : verified(op, { clicked: patch });
  }

  /** After the click, with focus back: wait for the header to name the patch; any dialog stops at once (never pressed). */
  async function awaitPatch(op: string, track: Track, patch: string): Promise<Envelope> {
    const expected = `Track ${track.number} “${patch}”${flags(track)}`;
    for (let i = 0; i < 30; i++) {
      const d = await classifyDialogs(deps.helper);
      if (d.kind === "save_prompt" || d.kind === "other") {
        return failed(op, "DIALOG_UNEXPECTED", "GarageBand opened a dialog while loading the patch; nothing pressed", {
          write_attempted: true, safe_to_retry: false, hint: "answer the dialog in GarageBand yourself", context: { dialog: d.texts.map((t) => cleanText(t)) },
        });
      }
      const w = await core.wait({ root: MAIN, selector: { role: "AXLayoutItem", description: expected, ancestors: [TRACKS_HEADER] }, condition: "present", timeoutMs: 500 });
      if (w.ok && w.value.satisfied) {
        const now = await reread(op, track.number);
        return verified(op, { track: now ? publicTrack(now) : { ...publicTrack(track), patch }, from: track.patch, changed: true });
      }
    }
    return uncertain(op, "readback_timeout", {
      write_attempted: true, safe_to_retry: false, hint: `the result was clicked but track ${track.number}'s header does not name “${patch}” yet; check gb_tracks list before retrying`,
    });
  }

  /**
   * Empty audio tracks (M11b), one at a time: Track ▸ New Tracks… → "Mic or Line, Audio" (pressed only when not chosen)
   * → Create; each is proven by the track list growing by one. A press GarageBand is too busy to answer is judged by
   * the track list, never by the failed step; a sheet left open is cancelled.
   */
  /** Play's state: true/false, or null when it cannot be read. */
  async function playing(op: string): Promise<boolean | null> {
    const r = await core.read(op, PLAY);
    const v = r.status === "verified" ? (r.data as { value: unknown }).value : null;
    return v === 1 ? true : v === 0 ? false : null;
  }

  async function addAudio(op: string, count: number, dryRun: boolean): Promise<Envelope> {
    const ready = await ensureReady(op, session);
    if (!ready.ok) return ready.error;
    if ((await playing(op)) === true) return playbackRunning(op);
    const before = await readTracks(op, deps.helper);
    if (!before.ok) return before.error;
    if (dryRun) {
      return verified(op, { dry_run: true, tracks_before: before.value.length, plan: [
        `${count} × Track ▸ New Tracks… → "Mic or Line, Audio" → Create`, "after each, read the track list: it must grow by one",
      ] });
    }
    return mutationGate.run(op, async () => {
      const added: ReturnType<typeof publicTrack>[] = [];
      const warnings: string[] = [];
      const borrows: Envelope[] = []; // focus borrowed for a header click (at most one per call)
      let known = before.value;
      const sheetOpen = async () => {
        const w = await core.wait({ root: MAIN, selector: NEW_TRACK_SHEET, condition: "present", timeoutMs: 300 });
        return w.ok && w.value.satisfied;
      };
      const closeSheet = async () => { if (await sheetOpen()) await core.press(op, CANCEL); };
      for (let i = 0; i < count; i++) {
        if (i > 0 && (await playing(op)) === true) {
          return withAdded(failed(op, "NOT_SUPPORTED",
            `playback started while add_audio ran — gb-mcp never presses Play (a key typed into GarageBand?); ${i} of ${count} tracks added, nothing more pressed`,
            { write_attempted: true, safe_to_retry: false, hint: `stop it with gb_transport stop, then add_audio {count: ${count - i}}` }), added);
        }
        const openSheet = () => core.menu(op, NEW_TRACKS, { postCondition: { root: MAIN, selector: NEW_TRACK_SHEET, condition: "present", timeoutMs: 5_000 } });
        let opened = await openSheet();
        if (opened.status === "failed" && opened.error === "TARGET_DISABLED" && borrows.length === 0) {
          // a GarageBand in the background can keep a stale, disabled Track menu (all of it). One real
          // click on a track header brings it forward and refreshes the menus; the selected track keeps the selection.
          if ((await playing(op)) === true) return withAdded(playbackRunning(op), added);
          const at = known.find((t) => t.selected) ?? known[known.length - 1];
          if (at) {
            const clicked = await core.withFocus(op, () => core.click(op, headerTarget(at), { at: HEADER_STRIP, expectSelected: true }));
            borrows.push(clicked);
            if (clicked.status === "verified") {
              warnings.push(`Track ▸ New Tracks… read disabled (a stale menu in a background GarageBand); a click on track ${at.number}'s header refreshed it`);
              opened = await openSheet();
            }
          }
        }
        if (opened.status === "failed" && opened.error === "TARGET_DISABLED" && borrows.length > 0) {
          opened = { ...opened, hint: "Track ▸ New Tracks… stays disabled after a click on a track header: look at GarageBand (gb_system ui_snapshot panel=menubar) — a sheet, a recording or an edit field can hold it" };
        }
        if (opened.status !== "verified") { await closeSheet(); return withFocusNote(withAdded(opened, added), ...borrows); }
        const chosenAlready = await core.wait({ root: MAIN, selector: AUDIO_KIND.selector, condition: "value_equals", value: 1, timeoutMs: 200 });
        if (!(chosenAlready.ok && chosenAlready.value.satisfied)) {
          const chosen = await core.press(op, AUDIO_KIND);
          if (chosen.status !== "verified") { await closeSheet(); return withAdded(chosen, added); }
        }
        const created = await core.press(op, CREATE);
        // the evidence decides: the list must grow by one, whatever the press answered
        let now = await readTracks(op, deps.helper);
        for (let waited = 0; (!now.ok || now.value.length <= known.length) && waited < NEW_TRACK_WAIT_MS; waited += NEW_TRACK_POLL_MS) {
          await session.sleep(NEW_TRACK_POLL_MS);
          now = await readTracks(op, deps.helper);
        }
        if (!now.ok || now.value.length !== known.length + 1) {
          await closeSheet();
          return withAdded(failed(op, created.status === "verified" ? "TARGET_NOT_FOUND" : "DEADLINE_EXCEEDED",
            `Create was pressed but no new track appeared (${now.ok ? now.value.length : "?"} tracks, ${known.length} before)`,
            { write_attempted: true, safe_to_retry: false, hint: "check gb_tracks list before retrying" }), added);
        }
        if (created.status !== "verified") warnings.push(`GarageBand was busy and answered Create late (track ${i + 1}); the track list proves the new track`);
        added.push(...newTracks(known, now.value).map(publicTrack));
        known = now.value;
      }
      return withFocusNote(verified(op, { added, tracks: known.map(publicTrack) }, warnings), ...borrows);
    });
  }

  /**
   * The tracks in `now` that were not in `before`. A header's description carries its number ("Track 2 “Audio 2”"), and
   * a track created above others renumbers them, so tracks are counted by patch name instead; among
   * equal names the selected one wins (GarageBand selects the track it creates), else the lowest in the list.
   */
  function newTracks(before: readonly Track[], now: readonly Track[]): Track[] {
    const had = new Map<string, number>();
    for (const t of before) had.set(t.patch, (had.get(t.patch) ?? 0) + 1);
    const out: Track[] = [];
    for (const patch of new Set(now.map((t) => t.patch))) {
      const same = now.filter((t) => t.patch === patch);
      const extra = same.length - (had.get(patch) ?? 0);
      if (extra > 0) out.push(...[...same].sort((a, b) => Number(b.selected) - Number(a.selected) || b.number - a.number).slice(0, extra));
    }
    return out.sort((a, b) => a.number - b.number);
  }

  /** A failure after some tracks were added still names them: they exist in GarageBand. */
  function withAdded(e: Envelope, added: ReturnType<typeof publicTrack>[]): Envelope {
    return added.length && e.status !== "verified" ? { ...e, context: { ...(("context" in e && e.context) || {}), added } } as Envelope : e;
  }

  return async function gbTracks(input: unknown): Promise<Envelope> {
    const parsed = GbTracksInput.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return failed("gb_tracks", "INPUT_INVALID", `${issue.path.join(".") || "command"}: ${issue.message}`, { hint: `commands: ${GB_TRACKS_COMMANDS.join(", ")}` });
    }
    const a = parsed.data;
    const op = `gb_tracks.${a.command}`;
    switch (a.command) {
      case "list": return list(op, a.fields);
      case "select": return select(op, a.track, a.dry_run === true);
      case "mute":
      case "solo": return setFlag(op, a.track, a.command, a.enabled, a.dry_run === true);
      case "set_instrument": return setInstrument(op, a.track, a.patch, a.dry_run === true);
      case "add_audio": return addAudio(op, a.count, a.dry_run === true);
    }
  };
}
