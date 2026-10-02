// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import type { HelperPort } from "../native/helper-port.js";
import { callOp, AppStateResult, FindResult } from "../native/protocol.js";
import { parseSavePrompt, type RootSpec } from "../ax/locators.js";

export type DialogState =
  | { kind: "none" }
  | { kind: "busy" } // buttonless window (GarageBand's loading/progress panel): wait it out
  | { kind: "save_prompt"; document: string; texts: string[] }
  | { kind: "other"; texts: string[]; buttons: string[] } // needs a human: never pressed
  | { kind: "not_running" }
  | { kind: "unknown"; message: string };

const DIALOG: RootSpec = { kind: "dialog" };

/** What kind of modal state GarageBand is in — the decision point before any action. */
export async function classifyDialogs(helper: HelperPort): Promise<DialogState> {
  const s = await callOp(helper, "app.state", {}, AppStateResult, { deadlineMs: 4_000 });
  if (!s.ok) return { kind: "unknown", message: s.error.message };
  if (!s.value.running) return { kind: "not_running" };
  if ((s.value.sheet_count ?? 0) > 0) return { kind: "other", texts: [], buttons: ["(sheet)"] };
  if ((s.value.dialog_count ?? 0) === 0) return { kind: "none" };
  const [buttons, texts] = await Promise.all([
    callOp(helper, "ax.find", { root: DIALOG, selector: { role: "AXButton" }, max_results: 32 }, FindResult, { deadlineMs: 4_000 }),
    callOp(helper, "ax.find", { root: DIALOG, selector: { role: "AXStaticText" }, max_results: 32 }, FindResult, { deadlineMs: 4_000 }),
  ]);
  if (!buttons.ok || !texts.ok) return { kind: "other", texts: [], buttons: ["(unreadable or several dialogs)"] };
  const titled = buttons.value.matches.map((n) => n.title ?? "").filter((t) => t !== "");
  const lines = texts.value.matches.map((n) => String(n.value ?? "")).filter((t) => t !== "");
  const document = lines.map(parseSavePrompt).find((d) => d !== undefined);
  if (document !== undefined) return { kind: "save_prompt", document, texts: lines };
  if (titled.length === 0) return { kind: "busy" };
  return { kind: "other", texts: lines, buttons: titled };
}

/** Poll until GarageBand has no modal state, a dialog that needs a human, or the attempts run out (still busy). */
export async function waitUntilIdle(helper: HelperPort, sleep: (ms: number) => Promise<void>, pollMs: number, attempts: number): Promise<DialogState> {
  let d: DialogState = { kind: "busy" };
  for (let i = 0; i < Math.max(1, attempts); i++) {
    d = await classifyDialogs(helper);
    if (d.kind !== "busy") return d;
    await sleep(pollMs);
  }
  return d;
}
