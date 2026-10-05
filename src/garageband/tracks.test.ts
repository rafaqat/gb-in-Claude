// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeEach } from "vitest";
import { createGbTracks } from "./tracks.js";
import { FakeHelper } from "../ax/fake-helper.js";
import { findAll, type TreeNode } from "../ax/selector.js";
import { ok } from "../result.js";
import type { PatchEntry } from "../sound/patches.js";

let fake: FakeHelper;
const patch = (name: string, content: PatchEntry["content"] = "base", kind: PatchEntry["kind"] = "instrument"): PatchEntry =>
  ({ name, category: "Bass", kind, source: "factory", packs: [], content, gmPrograms: [], gmDrumKits: [], path: `/x/${name}.patch` });
let catalog: PatchEntry[];
const deps = (over = {}) => ({
  helper: fake, sleep: async () => {}, pollMs: 1, patchCatalog: async () => ok(catalog),
  screenLocked: async () => false, // hermetic: never read the real machine's lock state
  ...over,
});
const MUTATING = ["ax.press", "ax.set", "ax.converge", "ax.click", "ax.perform", "ax.menu", "app.activate"];
const mutated = () => fake.calls.some((c) => MUTATING.includes(c.op));

beforeEach(() => {
  fake = new FakeHelper();
  catalog = [patch("Liverpool Bass"), patch("Taureg Moon Bass"), patch("Supersaw Lead", "no_receipt_match")];
});

/**
 * GarageBand's Library as observed live: the search field takes a value + AXConfirm; results are
 * AXRow ▸ AXCell ▸ AXStaticText(name); a real click on a result loads it onto the SELECTED track (header renamed).
 */
function installLibrary(names: string[]) {
  const main = fake.app.windows[0]!;
  const lib = findAll(main, { role: "AXGroup", description: "Library" }).matches[0]!.node;
  const field = findAll(lib, { subrole: "AXSearchField" }).matches[0]!.node;
  const browser = findAll(lib, { role: "AXBrowser" }).matches[0]!.node;
  const toggle = findAll(main, { role: "AXCheckBox", title: "Library" }).matches[0]!.node;
  const categories = browser.children ?? []; // the fixture's category list (… ▸ AXList ▸ AXStaticText, incl. “downloadable Synthesizer”)
  /** An empty search shows the categories; a query shows `results(query)` (GarageBand behaviour). */
  const onSearch = (results: (q: string) => TreeNode[]) => fake.on(field, { onAction: (f) => {
    const q = String(f.value ?? "");
    browser.children = q === "" ? categories : results(q);
  } });
  onSearch((query) => {
    const q = query.toLowerCase();
    return names.filter((n) => n.toLowerCase().includes(q)).map((n): TreeNode => {
      const text: TreeNode = { role: "AXStaticText", value: n };
      fake.on(text, { onClick: () => {
        const header = findAll(main, { role: "AXLayoutItem", ancestors: [{ role: "AXGroup", description: "Tracks header" }] }).matches.map((m) => m.node).find((h) => h.selected)!;
        header.desc = String(header.desc).replace(/“.+”/, `“${n}”`);
      } });
      return { role: "AXRow", subrole: "AXTableRow", children: [
        { role: "AXCell", children: [text] }, { role: "AXCell", children: [{ role: "AXStaticText", value: "21 Apr 2026 at 00:44" }] }] };
    });
  });
  return { field, toggle, browser, onSearch };
}

describe("gb_tracks list", () => {
  it("lists every track — number, patch, region, mute/solo/selected — read-only", async () => {
    const r = await createGbTracks(deps())({ command: "list" });
    expect(r).toMatchObject({
      status: "verified", op: "gb_tracks.list",
      data: { tracks: [
        { number: 1, patch: "Soft Saw Lead", region: "ProbeLead", muted: false, soloed: false, selected: true },
        { number: 2, patch: "Taureg Moon Bass", region: "ProbeBass", muted: false, soloed: false, selected: false },
      ] },
    });
    expect(mutated()).toBe(false);
  });

  it("reads each track's regions from its own lane (a lane may hold several regions, or none)", async () => {
    const contents = findAll(fake.app.windows[0]!, { role: "AXGroup", description: "Tracks contents" }).matches[0]!.node;
    contents.children = [
      { role: "AXLayoutArea", desc: "Track 1 “Soft Saw Lead”", children: [{ role: "AXLayoutItem", desc: "Hook" }, { role: "AXLayoutItem", desc: "Hook 2" }] },
      { role: "AXLayoutArea", desc: "Track 2 “Taureg Moon Bass”", children: [] },
    ];
    const r = await createGbTracks(deps())({ command: "list" });
    expect(r).toMatchObject({
      status: "verified",
      data: { tracks: [{ number: 1, region: "Hook", audible: true }, { number: 2, region: null, audible: null }] },
    });
  });
});

describe("gb_tracks preconditions (the project chooser is a standard window)", () => {
  it("only the project chooser open → NO_PROJECT_OPEN, touching nothing", async () => {
    fake.app.windows = [{ role: "AXWindow", subrole: "AXStandardWindow", title: "Choose a Project", id: "newProjectDialog", children: [] }];
    const r = await createGbTracks(deps())({ command: "list" });
    expect(r).toMatchObject({ status: "failed", error: "NO_PROJECT_OPEN", write_attempted: false });
    expect(r.status === "failed" && r.hint).toMatch(/open_midi/);
  });

  it("unknown parameters are rejected with the allowed commands (agents hallucinate fields)", async () => {
    expect(await createGbTracks(deps())({ command: "list", verbose: true })).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
  });
});

describe("gb_tracks select (live: only a real click selects a track)", () => {
  it("selects track 2 with a hit-tested click on its header's left strip, verified by AXSelected, focus handed back", async () => {
    const r = await createGbTracks(deps())({ command: "select", track: 2 });
    expect(r).toMatchObject({ status: "verified", op: "gb_tracks.select", data: { track: { number: 2, selected: true }, changed: true } });
    expect(fake.calls.find((c) => c.op === "ax.click")?.params).toMatchObject({ at: { fx: 0.03, fy: 0.5 } });
    expect(fake.app.frontmost).toBe(false);
  });

  it("resolves a track by its exact region (MIDI track) name", async () => {
    expect(await createGbTracks(deps())({ command: "select", track: "ProbeBass" })).toMatchObject({ status: "verified", data: { track: { number: 2 } } });
  });

  it("an already-selected track is verified without activating or clicking anything", async () => {
    expect(await createGbTracks(deps())({ command: "select", track: 1 })).toMatchObject({ status: "verified", data: { changed: false } });
    expect(mutated()).toBe(false);
  });

  it("dry_run resolves and plans, touching nothing", async () => {
    const r = await createGbTracks(deps())({ command: "select", track: 2, dry_run: true });
    expect(r).toMatchObject({ status: "verified", data: { dry_run: true, track: { number: 2, selected: false } } });
    expect(mutated()).toBe(false);
  });

  it("an unknown track fails with the real tracks listed, nothing clicked", async () => {
    const r = await createGbTracks(deps())({ command: "select", track: "Drums" });
    expect(r).toMatchObject({ status: "failed", error: "TARGET_NOT_FOUND", context: { tracks: [{ number: 1 }, { number: 2 }] } });
    expect(mutated()).toBe(false);
  });
});

describe("gb_tracks mute / solo — explicit enabled, never a blind toggle", () => {
  it("mutes track 2 with an AX press (no click, no focus change), verified by the checkbox and the header", async () => {
    const r = await createGbTracks(deps())({ command: "mute", track: 2, enabled: true });
    expect(r).toMatchObject({ status: "verified", op: "gb_tracks.mute", data: { track: { number: 2, muted: true, soloed: false }, changed: true } });
    expect(fake.calls.some((c) => c.op === "app.activate" || c.op === "ax.click")).toBe(false);
  });

  it("already in the requested state: verified, nothing pressed", async () => {
    expect(await createGbTracks(deps())({ command: "mute", track: 1, enabled: false })).toMatchObject({ status: "verified", data: { changed: false } });
    expect(mutated()).toBe(false);
  });

  it("solos by name; the header gains “, solo”", async () => {
    expect(await createGbTracks(deps())({ command: "solo", track: "Soft Saw Lead", enabled: true }))
      .toMatchObject({ status: "verified", data: { track: { number: 1, soloed: true, muted: false }, changed: true } });
  });

  it("a button that flips while the header never shows it is uncertain, and not safe to retry blindly", async () => {
    const box = findAll(fake.app.windows[0]!, { role: "AXCheckBox", description: "Mute", ancestors: [{ role: "AXLayoutItem", description: "Track 2 “Taureg Moon Bass”" }] }).matches[0]!.node;
    fake.on(box, { onPress: (n) => { n.value = 1; } });
    expect(await createGbTracks(deps())({ command: "mute", track: 2, enabled: true }))
      .toMatchObject({ status: "uncertain", write_attempted: true, safe_to_retry: false });
  });
});

describe("gb_tracks set_instrument — the Library, driven like a person would", () => {
  it("loads an installed patch onto track 2: select header, search, click the one exact result; verified by the header", async () => {
    const lib = installLibrary(["Liverpool Bass", "Liverpool Bass Synth"]);
    const header2 = findAll(fake.app.windows[0]!, { role: "AXLayoutItem", description: "Track 2 “Taureg Moon Bass”" }).matches[0]!.node;
    const r = await createGbTracks(deps())({ command: "set_instrument", track: 2, patch: "Liverpool Bass" });
    expect(r).toMatchObject({ status: "verified", op: "gb_tracks.set_instrument", data: { track: { number: 2, patch: "Liverpool Bass" }, from: "Taureg Moon Bass", changed: true } });
    expect(fake.clicks).toHaveLength(2);
    expect(fake.clicks[0]).toBe(header2); // the header first (the Library loads onto the SELECTED track)…
    expect(fake.clicks[1]!.value).toBe("Liverpool Bass"); // …then the one exact result
    expect(lib.field.value).toBe(""); // the search is cleared again: the Library is left as it was found
    expect(lib.toggle.value).toBe(0); // the Library was hidden before: hidden again
    expect(fake.app.frontmost).toBe(false);
  });

  it("never loads content that is not installed (downloads are the user's decision) — touches nothing", async () => {
    installLibrary(["Supersaw Lead"]);
    const r = await createGbTracks(deps())({ command: "set_instrument", track: 1, patch: "Supersaw Lead" });
    expect(r).toMatchObject({ status: "failed", error: "CONTENT_NOT_INSTALLED", write_attempted: false });
    expect(fake.calls).toHaveLength(0);
  });

  it("a name that is not an installed patch fails with similar names, touching nothing", async () => {
    const r = await createGbTracks(deps())({ command: "set_instrument", track: 1, patch: "Liverpool" });
    expect(r).toMatchObject({ status: "failed", error: "TARGET_NOT_FOUND", context: { similar: ["Liverpool Bass"] } });
    expect(fake.calls).toHaveLength(0);
  });

  it("two results with exactly that name: refuses to guess — no result clicked, Library and focus put back", async () => {
    const lib = installLibrary(["Liverpool Bass", "Liverpool Bass"]);
    const r = await createGbTracks(deps())({ command: "set_instrument", track: 2, patch: "Liverpool Bass" });
    expect(r).toMatchObject({ status: "failed", error: "TARGET_AMBIGUOUS" });
    expect(fake.clicks.map((n) => n.role)).toEqual(["AXLayoutItem"]); // the header only
    expect(lib.toggle.value).toBe(0);
    expect(fake.app.frontmost).toBe(false);
  });

  it("a dialog raised while loading is reported, never pressed", async () => {
    const lib = installLibrary(["Liverpool Bass"]);
    lib.onSearch(() => {
      const text: TreeNode = { role: "AXStaticText", value: "Liverpool Bass" };
      fake.on(text, { onClick: () => { fake.app.windows.push({ role: "AXWindow", subrole: "AXDialog", title: "", children: [
        { role: "AXStaticText", value: "Additional content is required." }, { role: "AXButton", title: "Download", actions: ["AXPress"] }] }); } });
      return [{ role: "AXRow", subrole: "AXTableRow", children: [{ role: "AXCell", children: [text] }] }];
    });
    const r = await createGbTracks(deps())({ command: "set_instrument", track: 2, patch: "Liverpool Bass" });
    expect(r).toMatchObject({ status: "failed", error: "DIALOG_UNEXPECTED", write_attempted: true, safe_to_retry: false });
    expect(fake.calls.filter((c) => c.op === "ax.press").every((c) => JSON.stringify(c.params).includes("Library"))).toBe(true);
  });

  it("dry_run plans the whole flow and touches nothing; the same patch again is a verified no-op", async () => {
    installLibrary(["Liverpool Bass"]);
    expect(await createGbTracks(deps())({ command: "set_instrument", track: 2, patch: "Liverpool Bass", dry_run: true }))
      .toMatchObject({ status: "verified", data: { dry_run: true, to: "Liverpool Bass" } });
    expect(await createGbTracks(deps())({ command: "set_instrument", track: 2, patch: "Taureg Moon Bass" }))
      .toMatchObject({ status: "verified", data: { changed: false } });
    expect(mutated()).toBe(false);
  });

  it("if the track cannot be selected, it stops before searching — the patch would land on the wrong track", async () => {
    installLibrary(["Liverpool Bass"]);
    fake.coveredBy = { role: "AXPopover" };
    const r = await createGbTracks(deps())({ command: "set_instrument", track: 2, patch: "Liverpool Bass" });
    expect(r).toMatchObject({ status: "failed", error: "HIT_TEST_MISMATCH", write_attempted: false });
    expect(fake.calls.some((c) => c.op === "ax.set" || c.op === "ax.perform")).toBe(false);
  });
});

describe("a silent track's region reads “<name>, muted” (muted, or another track soloed)", () => {
  it("keeps the region name clean, reports audible: false, and still resolves the track by its name", async () => {
    const region = findAll(fake.app.windows[0]!, { role: "AXLayoutItem", description: "ProbeBass" }).matches[0]!.node;
    region.desc = "ProbeBass, muted";
    const r = await createGbTracks(deps())({ command: "list" });
    expect(r).toMatchObject({ status: "verified", data: { tracks: [{ region: "ProbeLead", audible: true }, { region: "ProbeBass", audible: false }] } });
    expect(await createGbTracks(deps())({ command: "select", track: "ProbeBass" })).toMatchObject({ status: "verified", data: { track: { number: 2 } } });
  });
});

describe("set_instrument click-time guard (installed results are AXRow ▸ AXCell ▸ AXStaticText + a date cell)", () => {
  it("refuses a result whose row carries anything else (e.g. a download button) — never clicks it", async () => {
    const lib = installLibrary(["Liverpool Bass"]);
    lib.onSearch(() => [{ role: "AXRow", subrole: "AXTableRow", children: [
      { role: "AXCell", children: [{ role: "AXStaticText", value: "Liverpool Bass" }] },
      { role: "AXCell", children: [{ role: "AXButton", desc: "Download", actions: ["AXPress"] }] }] }]);
    const r = await createGbTracks(deps())({ command: "set_instrument", track: 2, patch: "Liverpool Bass" });
    expect(r).toMatchObject({ status: "failed", error: "CONTENT_NOT_INSTALLED" });
    expect(fake.clicks.map((n) => n.role)).toEqual(["AXLayoutItem"]); // the header only
    expect(lib.toggle.value).toBe(0);
  });
});

describe("set_instrument (downloadable categories, selection re-check, focus, fail-closed)", () => {
  it("refuses a patch whose category GarageBand marks “downloadable” (search rows look identical!) — no result click", async () => {
    catalog.push({ ...patch("Alchemy Lead"), category: "Synthesizer > Lead" }); // the disk catalog says "base": wrong for this case
    installLibrary(["Alchemy Lead"]);
    const r = await createGbTracks(deps())({ command: "set_instrument", track: 2, patch: "Alchemy Lead" });
    expect(r).toMatchObject({ status: "failed", error: "CONTENT_NOT_INSTALLED", context: { categories: ["Synthesizer"] } }); // names live in context, never in message
    expect(fake.clicks.map((n) => n.role)).toEqual(["AXLayoutItem"]);
    expect(fake.app.frontmost).toBe(false);
  });

  it("every same-name catalog entry must be installed (not just one)", async () => {
    catalog.push(patch("Liverpool Bass", "no_receipt_match"));
    const r = await createGbTracks(deps())({ command: "set_instrument", track: 2, patch: "Liverpool Bass" });
    expect(r).toMatchObject({ status: "failed", error: "CONTENT_NOT_INSTALLED" });
    expect(fake.calls).toHaveLength(0);
  });

  it("if the selection moves away before the result click, nothing is clicked (the patch would replace another track's)", async () => {
    const lib = installLibrary(["Liverpool Bass"]);
    const headers = () => findAll(fake.app.windows[0]!, { role: "AXLayoutItem", ancestors: [{ role: "AXGroup", description: "Tracks header" }] }).matches.map((m) => m.node);
    lib.onSearch((q) => {
      headers().forEach((h, i) => { h.selected = i === 0; }); // the user clicks track 1 meanwhile
      return [{ role: "AXRow", subrole: "AXTableRow", children: [{ role: "AXCell", children: [{ role: "AXStaticText", value: q }] },
        { role: "AXCell", children: [{ role: "AXStaticText", value: "21 Apr 2026 at 00:44" }] }] }];
    });
    const r = await createGbTracks(deps())({ command: "set_instrument", track: 2, patch: "Liverpool Bass" });
    expect(r).toMatchObject({ status: "failed", error: "TARGET_CHANGED" });
    expect(fake.clicks.map((n) => n.role)).toEqual(["AXLayoutItem"]);
  });

  it("gives focus back before waiting for the patch to load (keystrokes must not land in GarageBand)", async () => {
    installLibrary(["Liverpool Bass"]);
    const r = await createGbTracks(deps())({ command: "set_instrument", track: 2, patch: "Liverpool Bass" });
    expect(r.status).toBe("verified");
    const ops = fake.calls.map((c) => c.op);
    const lastClick = ops.lastIndexOf("ax.click");
    const restore = ops.lastIndexOf("app.restore_focus"); // the borrow around the result click
    expect(restore).toBeGreaterThan(lastClick);
    expect(ops.slice(lastClick + 1, restore).some((o) => o === "ax.wait")).toBe(false);
  });

  it("fails closed when the result rows cannot be read — no click on an unverified row", async () => {
    installLibrary(["Liverpool Bass"]);
    fake.failNext("ax.snapshot", { code: "DEADLINE_EXCEEDED", message: "too slow" });
    const r = await createGbTracks(deps())({ command: "set_instrument", track: 2, patch: "Liverpool Bass" });
    expect(r.status).toBe("failed");
    expect(fake.clicks.map((n) => n.role)).toEqual(["AXLayoutItem"]);
  });

  it("fails closed when GarageBand's category list does not show the patch's category (unreadable or another track type)", async () => {
    const lib = installLibrary(["Liverpool Bass"]);
    fake.on(lib.field, { onAction: (f) => {
      lib.browser.children = String(f.value) === "" ? [] : [{ role: "AXRow", subrole: "AXTableRow", children: [{ role: "AXCell", children: [{ role: "AXStaticText", value: "Liverpool Bass" }] }] }];
    } });
    const r = await createGbTracks(deps())({ command: "set_instrument", track: 2, patch: "Liverpool Bass" });
    expect(r).toMatchObject({ status: "failed", error: "TARGET_NOT_FOUND" });
    expect(fake.clicks.map((n) => n.role)).toEqual(["AXLayoutItem"]);
  });
});

describe("gb_tracks list fields mask (context-window discipline)", () => {
  it("returns only the requested fields (the track number always stays as the key)", async () => {
    const r = await createGbTracks(deps())({ command: "list", fields: ["patch"] });
    expect(r).toMatchObject({ status: "verified" });
    expect((r as { data: { tracks: unknown[] } }).data.tracks).toEqual([{ number: 1, patch: "Soft Saw Lead" }, { number: 2, patch: "Taureg Moon Bass" }]);
    expect(await createGbTracks(deps())({ command: "list", fields: ["volume"] })).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
  });
});

describe("GarageBand is in front ONLY around each click (keystroke window)", () => {
  it("set_instrument borrows focus twice, briefly: every search / read / wait step runs with the user's app in front", async () => {
    installLibrary(["Liverpool Bass"]);
    const log: { op: string; front: boolean }[] = [];
    const port = {
      call: async (op: string, params?: Record<string, unknown>, opts?: { deadlineMs?: number }) => {
        log.push({ op, front: fake.app.frontmost });
        return fake.call(op, params, opts);
      },
      close: () => fake.close(),
    };
    const r = await createGbTracks(deps({ helper: port }))({ command: "set_instrument", track: 2, patch: "Liverpool Bass" });
    expect(r.status).toBe("verified");
    expect(log.filter((c) => c.op === "app.activate")).toHaveLength(2); // header click, result click
    expect(log.filter((c) => c.op === "ax.click").every((c) => c.front)).toBe(true);
    const unfocused = ["ax.set", "ax.perform", "ax.snapshot", "ax.wait", "ax.press"];
    expect(log.filter((c) => unfocused.includes(c.op) && c.front).map((c) => c.op)).toEqual([]);
  });
});

/**
 * Track ▸ New Tracks… as observed live (M11b): an AXSheet "New Track" with four AXRadioButtons described
 * "MIDI, Software Instrument" / "Drummer, Rock" / "Mic or Line, Audio" / "Guitar or Bass, Audio", and Create / Cancel.
 * Create adds the track ("Audio N") and closes the sheet; GarageBand can be too busy to answer the press in time.
 */
function installNewTracks(opts: { audioSelected?: boolean } = {}) {
  const main = fake.app.windows[0]!;
  const header = findAll(main, { role: "AXGroup", description: "Tracks header" }).matches[0]!.node;
  const item = findAll(fake.app.menubar, { role: "AXMenuItem", title: "New Tracks…", ancestors: [{ title: "Track" }] }).matches[0]!.node;
  let made = 0;
  const addTrack = () => {
    made += 1;
    const n = (header.children ?? []).filter((c) => c.role === "AXLayoutItem").length + 1;
    header.children = [...(header.children ?? []), { role: "AXLayoutItem", desc: `Track ${n} “Audio ${made}”`, children: [] }];
  };
  const state = { sheet: undefined as TreeNode | undefined, created: () => made };
  fake.on(item, { onPress: () => {
    const radio = (desc: string, value: number): TreeNode => ({ role: "AXRadioButton", desc, value, actions: ["AXPress"] });
    const kinds = [radio("MIDI, Software Instrument", 0), radio("Drummer, Rock", 0), radio("Mic or Line, Audio", opts.audioSelected ? 1 : 0), radio("Guitar or Bass, Audio", 0)];
    for (const k of kinds) fake.on(k, { onPress: () => { for (const o of kinds) o.value = o === k ? 1 : 0; } });
    const create: TreeNode = { role: "AXButton", title: "Create", actions: ["AXPress"] };
    const cancel: TreeNode = { role: "AXButton", title: "Cancel", actions: ["AXPress"] };
    const sheet: TreeNode = { role: "AXSheet", desc: "New Track", children: [{ role: "AXGroup", children: [{ role: "AXRadioGroup", children: kinds }, create, cancel] }] };
    const close = () => { main.children = (main.children ?? []).filter((c) => c !== sheet); };
    fake.on(create, { onPress: () => { if (kinds[2]!.value === 1) addTrack(); close(); } });
    fake.on(cancel, { onPress: close });
    main.children = [...(main.children ?? []), sheet];
    state.sheet = sheet;
  } });
  return { state, addTrack, main };
}

describe("gb_tracks add_audio (M11b)", () => {
  it("dry_run plans without touching GarageBand", async () => {
    installNewTracks();
    const r = await createGbTracks(deps())({ command: "add_audio", count: 2, dry_run: true });
    expect(r).toMatchObject({ status: "verified", data: { dry_run: true } });
    expect(mutated()).toBe(false);
  });

  it("adds audio tracks through Track ▸ New Tracks… → “Mic or Line, Audio” → Create, each proven in the track list", async () => {
    const { state } = installNewTracks();
    const r = await createGbTracks(deps())({ command: "add_audio", count: 2 });
    expect(r.status).toBe("verified");
    expect(state.created()).toBe(2);
    expect((r as { data: { added: { patch: string }[] } }).data.added.map((t) => t.patch)).toEqual(["Audio 1", "Audio 2"]);
    expect(fake.calls.filter((c) => c.op === "ax.menu").map((c) => (c.params as { path: string[] }).path)).toEqual([["Track", "New Tracks…"], ["Track", "New Tracks…"]]);
  });

  it("GarageBand too busy to answer the Create press: the track list decides, and the result says so", async () => {
    const { addTrack, main } = installNewTracks({ audioSelected: true });
    fake.failNext("ax.press", { code: "DEADLINE_EXCEEDED", message: "press failed (AXError -25204)" });
    fake.schedule(200, () => { addTrack(); main.children = (main.children ?? []).filter((c) => c.role !== "AXSheet"); });
    const r = await createGbTracks(deps({ sleep: async (ms: number) => fake.sleep(ms) }))({ command: "add_audio", count: 1 });
    expect(r.status).toBe("verified");
    expect((r as { warnings?: string[] }).warnings?.join(" ")).toContain("busy");
  });

  it("no new track after Create: the sheet is cancelled and nothing is claimed", async () => {
    const { state, main } = installNewTracks({ audioSelected: true });
    fake.failNext("ax.press", { code: "TARGET_NOT_FOUND", message: "Create not found" });
    const r = await createGbTracks(deps({ sleep: async (ms: number) => fake.sleep(ms) }))({ command: "add_audio", count: 1 });
    expect(r.status).not.toBe("verified");
    expect(state.created()).toBe(0);
    expect((main.children ?? []).some((c) => c.role === "AXSheet")).toBe(false);
  });

  it("the wait for the new track has its own interval: a 1 ms pollMs does not make thousands of track-list reads", async () => {
    installNewTracks({ audioSelected: true });
    fake.failNext("ax.press", { code: "TARGET_NOT_FOUND", message: "Create not found" });
    await createGbTracks(deps({ sleep: async (ms: number) => fake.sleep(ms) }))({ command: "add_audio", count: 1 });
    expect(fake.calls.length).toBeLessThan(200);
  });
});
