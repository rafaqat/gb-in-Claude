// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { z } from "zod";
import type { HelperPort } from "../native/helper-port.js";
import { AxCore } from "../ax/core.js";
import { parseTrackHeader, trackControlLocator } from "../ax/locators.js";
import { verified, failed, type Envelope } from "../mcp/envelope.js";
import { mutationGate } from "./gate.js";
import { ensureReady, readTracks, pickFields, type SessionDeps, type Track } from "./session.js";
import { TrackRef, DryRun, resolveTrack } from "./tracks.js";
import { rawToDb, dbToRaw, VOLUME_TAPER } from "./volume-taper.js";

/** Track fader: AX slider 0–233, 173 = unity (no dB attribute). Pan: 0–127, 64 = centre (“0 Pan”). */
export const VOLUME_UNITY_RAW = 173;
export const PAN_CENTRE_RAW = 64;

export const MIX_FIELDS = ["patch", "region", "volume", "pan", "muted", "soloed"] as const;
export const GbMixInput = z.discriminatedUnion("command", [
  z.object({ command: z.literal("get"), fields: z.array(z.enum(MIX_FIELDS)).min(1).optional().describe("only these fields per track (number always included)") }).strict(),
  z.object({ command: z.literal("set_pan"), track: TrackRef, pan: z.number().int().min(-64).max(63).describe("−64 hard left … 0 centre … +63 hard right"), dry_run: DryRun }).strict(),
  z.object({
    command: z.literal("set_volume"), track: TrackRef,
    raw: z.number().int().min(0).max(233).optional().describe("fader position 0–233 (173 = unity)"),
    db: z.number().min(VOLUME_TAPER[0]![1]).max(VOLUME_TAPER[VOLUME_TAPER.length - 1]![1]).optional()
      .describe("gain re unity from the measured fader taper (−18.2 … +6 dB; quieter: use raw)"),
    dry_run: DryRun,
  }).strict(),
]);
export const GB_MIX_COMMANDS = ["get", "set_pan", "set_volume"] as const;

export type GbMixDeps = Omit<SessionDeps, "sleep" | "pollMs"> & {
  helper: HelperPort;
  core?: AxCore;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const showVolume = (raw: number | null) => ({ raw, db: raw === null ? null : rawToDb(raw) });

export function createGbMix(deps: GbMixDeps) {
  const core = deps.core ?? new AxCore(deps.helper);
  const session: SessionDeps = { helper: deps.helper, sleep: deps.sleep ?? realSleep, pollMs: deps.pollMs ?? 500, ...(deps.screenLocked ? { screenLocked: deps.screenLocked } : {}) };

  const read = async (op: string, t: Track, control: "volume" | "pan"): Promise<number | null> => {
    const r = await core.read(op, trackControlLocator(parseTrackHeader(t.description)!, control));
    const v = r.status === "verified" ? (r.data as { value: unknown }).value : null;
    return typeof v === "number" ? v : null;
  };

  const strip = async (op: string, t: Track) => {
    const [volume, pan] = await Promise.all([read(op, t, "volume"), read(op, t, "pan")]);
    return {
      number: t.number, patch: t.patch, region: t.region, muted: t.muted, soloed: t.soloed,
      volume: showVolume(volume), pan: pan === null ? null : pan - PAN_CENTRE_RAW,
    };
  };

  async function get(op: string, fields?: readonly string[]): Promise<Envelope> {
    const ready = await ensureReady(op, session);
    if (!ready.ok) return ready.error;
    const tracks = await readTracks(op, deps.helper);
    if (!tracks.ok) return tracks.error;
    const strips = [];
    for (const t of tracks.value) strips.push(pickFields(await strip(op, t), fields, ["number"]));
    return verified(op, { tracks: strips });
  }

  /** Converge one track's stepwise slider (one step per set) to a raw value, reading back. */
  async function setControl(op: string, ref: number | string, control: "volume" | "pan", raw: number, show: (raw: number | null) => unknown, dryRun: boolean): Promise<Envelope> {
    const ready = await ensureReady(op, session);
    if (!ready.ok) return ready.error;
    const tracks = await readTracks(op, deps.helper);
    if (!tracks.ok) return tracks.error;
    const track = resolveTrack(op, tracks.value, ref);
    if (!track.ok) return track.error;
    const t = track.value;
    const from = await read(op, t, control);
    if (from === raw) return verified(op, { track: t.number, [control]: show(raw), from: show(from), changed: false });
    if (dryRun) return verified(op, { dry_run: true, track: t.number, [control]: show(from), to: show(raw), plan: [`converge track ${t.number}'s ${control} slider raw ${String(from)} → ${raw}, reading back`] });
    return mutationGate.run(op, async () => {
      const r = await core.set(op, trackControlLocator(parseTrackHeader(t.description)!, control), raw);
      if (r.status !== "verified") return r;
      const after = (r.data as { after: unknown }).after;
      return verified(op, { track: t.number, [control]: show(typeof after === "number" ? after : null), from: show(from), changed: true });
    });
  }

  return async function gbMix(input: unknown): Promise<Envelope> {
    const parsed = GbMixInput.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return failed("gb_mix", "INPUT_INVALID", `${issue.path.join(".") || "command"}: ${issue.message}`, { hint: `commands: ${GB_MIX_COMMANDS.join(", ")}` });
    }
    const a = parsed.data;
    const op = `gb_mix.${a.command}`;
    switch (a.command) {
      case "get": return get(op, a.fields);
      case "set_pan": return setControl(op, a.track, "pan", a.pan + PAN_CENTRE_RAW, (raw) => (raw === null ? null : raw - PAN_CENTRE_RAW), a.dry_run === true);
      case "set_volume": {
        if ((a.raw === undefined) === (a.db === undefined)) return failed(op, "INPUT_INVALID", "give exactly one of raw (0–233) or db", { hint: "gb_mix get shows the current raw and dB values" });
        const raw = a.raw ?? dbToRaw(a.db!);
        if (raw === null) {
          return failed(op, "NOT_SUPPORTED", VOLUME_TAPER.length < 2 ? "the fader's dB taper has not been measured yet: use raw (173 = unity)" : `${a.db} dB is outside the measured fader range`, {
            hint: "set_volume with raw instead",
          });
        }
        return setControl(op, a.track, "volume", raw, showVolume, a.dry_run === true);
      }
    }
  };
}
