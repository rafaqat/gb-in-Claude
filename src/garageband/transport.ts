// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { z } from "zod";
import type { HelperPort } from "../native/helper-port.js";
import { AxCore } from "../ax/core.js";
import { GB_10_4_14 } from "../ax/locators.js";
import { verified, uncertain, failed, type Envelope } from "../mcp/envelope.js";
import { mutationGate } from "./gate.js";
import { ensureReady, MAIN, type SessionDeps } from "./session.js";

const C = GB_10_4_14.controls;
const COUNT_IN = { 0: ["Record", "Count-in", "None"], 1: ["Record", "Count-in", "1 Bar"], 2: ["Record", "Count-in", "2 Bars"] } as const;
/** How long to wait for a lazily refreshed menu checkmark (12 × 250 ms). */
const MARK_POLLS = 12;
const MARK_POLL_MS = 250;

const DryRun = z.boolean().optional().describe("resolve and plan only — touches nothing");
export const TRANSPORT_FIELDS = ["playing", "tempo", "metronome", "cycle", "count_in_bars", "playhead"] as const;
export const GbTransportInput = z.discriminatedUnion("command", [
  z.object({ command: z.literal("state"), fields: z.array(z.enum(TRANSPORT_FIELDS)).min(1).optional().describe("only these fields (skips the reads they need)") }).strict(),
  z.object({ command: z.literal("play"), dry_run: DryRun }).strict(),
  z.object({ command: z.literal("stop"), dry_run: DryRun }).strict(),
  z.object({ command: z.literal("rewind"), dry_run: DryRun }).strict(),
  z.object({ command: z.literal("set_tempo"), bpm: z.number().int().min(5).max(990), dry_run: DryRun }).strict(),
  z.object({ command: z.literal("set_metronome"), enabled: z.boolean(), dry_run: DryRun }).strict(),
  z.object({ command: z.literal("set_count_in"), bars: z.union([z.literal(0), z.literal(1), z.literal(2)]), dry_run: DryRun }).strict(),
]);
export const GB_TRANSPORT_COMMANDS = ["state", "play", "stop", "rewind", "set_tempo", "set_metronome", "set_count_in"] as const;

export type GbTransportDeps = Omit<SessionDeps, "sleep" | "pollMs"> & {
  helper: HelperPort;
  core?: AxCore;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createGbTransport(deps: GbTransportDeps) {
  const core = deps.core ?? new AxCore(deps.helper);
  const session: SessionDeps = { helper: deps.helper, sleep: deps.sleep ?? realSleep, pollMs: deps.pollMs ?? 500, ...(deps.screenLocked ? { screenLocked: deps.screenLocked } : {}) };

  const value = async (op: string, key: string): Promise<unknown> => {
    const r = await core.read(op, C[key]!);
    return r.status === "verified" ? (r.data as { value: unknown }).value : null;
  };
  /** A toggle's state: true/false, or null when it cannot be read — unknown is never treated as "off". */
  const flag = async (op: string, key: string): Promise<boolean | null> => {
    const v = await value(op, key);
    return v === 1 ? true : v === 0 ? false : null;
  };
  const unreadable = (op: string, what: string) => failed(op, "TARGET_NOT_FOUND", `the ${what} cannot be read, so its state is unknown; nothing pressed`, {
    hint: "the Control Bar may be customised or GarageBand busy — gb_system ui_snapshot panel=control-bar",
  });
  /** Press a toggle towards `want`, re-reading inside the gate and proving the ABSOLUTE state afterwards. */
  const pressTo = async (op: string, key: string, want: boolean, press: () => Promise<Envelope>): Promise<Envelope> => {
    const fresh = await flag(op, key); // the state may have changed since the pre-read (outside the gate)
    if (fresh === null) return unreadable(op, C[key]!.description);
    if (fresh === want) return verified(op, { changed: false });
    const r = await press();
    if (r.status === "failed") return r;
    const after = await flag(op, key);
    if (after !== want) {
      return uncertain(op, "readback_timeout", { write_attempted: true, safe_to_retry: false, hint: "pressed, but the control does not show the requested state — read gb_transport state before retrying", data: { state: after } });
    }
    return verified(op, { changed: true });
  };

  /** The checked Record ▸ Count-in item (menus are read with dry runs: nothing is pressed). */
  async function countInBars(op: string): Promise<number | null> {
    for (const [bars, path] of Object.entries(COUNT_IN)) {
      const m = await core.menu(op, [...path], { dryRun: true });
      if (m.status === "verified" && (m.data as { mark: string | null }).mark) return Number(bars);
    }
    return null;
  }

  /** Read only what is asked for (count-in alone costs three menu reads). */
  async function readState(op: string, fields: readonly string[] = TRANSPORT_FIELDS) {
    const want = (f: string) => fields.includes(f);
    const out: Record<string, unknown> = {};
    if (want("playing")) out.playing = await flag(op, "transport.play");
    if (want("tempo")) { const t = await value(op, "lcd.tempo"); out.tempo = typeof t === "number" ? t : null; }
    if (want("metronome")) out.metronome = await flag(op, "transport.metronome");
    if (want("cycle")) out.cycle = await flag(op, "transport.cycle");
    if (want("count_in_bars")) out.count_in_bars = await countInBars(op);
    if (want("playhead")) {
      const [bar, beat] = await Promise.all(["lcd.playhead_bar", "lcd.playhead_beat"].map((k) => value(op, k)));
      out.playhead = { bar: bar ?? null, beat: beat ?? null };
    }
    return out;
  }

  async function state(op: string, fields?: readonly string[]): Promise<Envelope> {
    const ready = await ensureReady(op, session);
    if (!ready.ok) return ready.error;
    return verified(op, await readState(op, fields));
  }

  /** Play/stop to an explicit state. Play is a toggle (read back); Stop is a button (proven by Play reading 0). */
  async function setPlaying(op: string, playing: boolean, dryRun: boolean): Promise<Envelope> {
    const ready = await ensureReady(op, session);
    if (!ready.ok) return ready.error;
    const now = await flag(op, "transport.play");
    if (now === null) return unreadable(op, "Play button");
    if (now === playing) return verified(op, { playing, changed: false });
    if (dryRun) return verified(op, { dry_run: true, playing: now, plan: [playing ? "press Play (toggle, read back)" : "press Stop, then read Play back as 0"] });
    return mutationGate.run(op, async () => {
      const r = await pressTo(op, "transport.play", playing, () => playing
        ? core.press(op, C["transport.play"]!)
        : core.press(op, C["transport.stop"]!, { postCondition: { root: MAIN, selector: { ...C["transport.play"]!.selector, value: 0 }, condition: "present" } }));
      return r.status === "verified" ? verified(op, { playing, changed: (r.data as { changed: boolean }).changed }) : r;
    });
  }

  /** Go to the beginning. One physical button: “Go to Beginning” while stopped, “Stop” while playing (live). */
  async function rewind(op: string, dryRun: boolean): Promise<Envelope> {
    const ready = await ensureReady(op, session);
    if (!ready.ok) return ready.error;
    const playing = await flag(op, "transport.play");
    if (playing === null) return unreadable(op, "Play button");
    if (playing) {
      return failed(op, "NOT_SUPPORTED", "playback is running: that button would stop playback instead of rewinding", { hint: "gb_transport stop first, then rewind" });
    }
    const [bar, beat] = await Promise.all([value(op, "lcd.playhead_bar"), value(op, "lcd.playhead_beat")]);
    if (bar === 1 && beat === 1) return verified(op, { playhead: { bar, beat }, changed: false });
    if (dryRun) return verified(op, { dry_run: true, playhead: { bar, beat }, plan: ["press Go to Beginning", "read the playhead back as bar 1 beat 1"] });
    return mutationGate.run(op, async () => {
      const r = await core.press(op, C["transport.go_to_beginning"]!, {
        idempotent: true, postCondition: { root: MAIN, selector: { ...C["lcd.playhead_bar"]!.selector, value: 1 }, condition: "present" },
      });
      if (r.status !== "verified") return r;
      return verified(op, { playhead: { bar: await value(op, "lcd.playhead_bar"), beat: await value(op, "lcd.playhead_beat") }, changed: true });
    });
  }

  /** Tempo is an integer slider that moves ONE step per set: converged with read-back. */
  async function setTempo(op: string, bpm: number, dryRun: boolean): Promise<Envelope> {
    const ready = await ensureReady(op, session);
    if (!ready.ok) return ready.error;
    const from = await value(op, "lcd.tempo");
    if (from === bpm) return verified(op, { tempo: bpm, from, changed: false });
    if (dryRun) return verified(op, { dry_run: true, tempo: from, to: bpm, plan: [`converge the tempo slider ${String(from)} → ${bpm} (one step per set), reading back`] });
    return mutationGate.run(op, async () => {
      const r = await core.set(op, C["lcd.tempo"]!, bpm);
      if (r.status !== "verified") return r;
      return verified(op, { tempo: (r.data as { after: unknown }).after, from, changed: true });
    });
  }

  async function setMetronome(op: string, enabled: boolean, dryRun: boolean): Promise<Envelope> {
    const ready = await ensureReady(op, session);
    if (!ready.ok) return ready.error;
    const now = await flag(op, "transport.metronome");
    if (now === null) return unreadable(op, "Metronome button");
    if (now === enabled) return verified(op, { metronome: enabled, changed: false });
    if (dryRun) return verified(op, { dry_run: true, metronome: now, plan: ["press Metronome Click (toggle, read back)"] });
    return mutationGate.run(op, async () => {
      const r = await pressTo(op, "transport.metronome", enabled, () => core.press(op, C["transport.metronome"]!));
      return r.status === "verified" ? verified(op, { metronome: enabled, changed: (r.data as { changed: boolean }).changed }) : r;
    });
  }

  /**
   * Count-in length via Record ▸ Count-in. GarageBand refreshes the menu checkmark lazily, so a mark
   * read right after a change can be stale. Choosing an item is idempotent, so it is ALWAYS chosen (never skipped on
   * the strength of a possibly-stale mark), then the mark is polled until it shows the choice.
   */
  async function setCountIn(op: string, bars: 0 | 1 | 2, dryRun: boolean): Promise<Envelope> {
    const ready = await ensureReady(op, session);
    if (!ready.ok) return ready.error;
    const before = await countInBars(op); // informational: the checkmark may lag a recent change
    if (dryRun) return verified(op, { dry_run: true, count_in_bars: before, plan: [`choose ${COUNT_IN[bars].join(" ▸ ")} (idempotent)`, "poll the checkmark until it shows the choice"] });
    return mutationGate.run(op, async () => {
      const r = await core.menu(op, [...COUNT_IN[bars]], { idempotent: true });
      if (r.status === "failed") return r;
      let now = await countInBars(op);
      for (let i = 0; i < MARK_POLLS && now !== bars; i++) {
        await session.sleep(MARK_POLL_MS);
        now = await countInBars(op);
      }
      if (now !== bars) {
        return uncertain(op, "readback_timeout", { write_attempted: true, safe_to_retry: true, hint: "chosen, but the checkmark has not moved yet (GarageBand refreshes it lazily); read gb_transport state shortly", data: { count_in_bars: now } });
      }
      return verified(op, { count_in_bars: bars, before });
    });
  }

  return async function gbTransport(input: unknown): Promise<Envelope> {
    const parsed = GbTransportInput.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return failed("gb_transport", "INPUT_INVALID", `${issue.path.join(".") || "command"}: ${issue.message}`, { hint: `commands: ${GB_TRANSPORT_COMMANDS.join(", ")}` });
    }
    const a = parsed.data;
    const op = `gb_transport.${a.command}`;
    switch (a.command) {
      case "state": return state(op, a.fields);
      case "play":
      case "stop": return setPlaying(op, a.command === "play", a.dry_run === true);
      case "rewind": return rewind(op, a.dry_run === true);
      case "set_tempo": return setTempo(op, a.bpm, a.dry_run === true);
      case "set_metronome": return setMetronome(op, a.enabled, a.dry_run === true);
      case "set_count_in": return setCountIn(op, a.bars, a.dry_run === true);
    }
  };
}
