// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { parseWireLine, callOp, AppStateResult, FindResult, PermCheckResult, HelloResult, SnapshotResult, MenuResult } from "./protocol.js";
import type { HelperPort } from "./helper-port.js";
import { ok } from "../result.js";

// Real lines captured from the live helper (read-only smoke test).
const LIVE = {
  hello: '{"id":1,"ok":true,"result":{"ax_trusted":true,"pid":66226,"protocol":1,"version":"0.1.0"}}',
  perm: '{"id":2,"ok":true,"result":{"accessibility":true,"automation":{"garageband":"granted","system_events":"not_running"},"screen_recording":true}}',
  app: '{"id":3,"ok":true,"result":{"ax_trusted":true,"bundle_id":"com.apple.garageband10","dialog_count":0,"frontmost":false,"hidden":false,"installed":{"build":"6648","path":"/Applications/GarageBand.app","version":"10.4.14"},"pid":64365,"running":true,"sheet_count":0,"windows":[{"role":"AXWindow","subrole":"AXStandardWindow","title":"Ascent-v4-session.band - Tracks"}]}}',
  find: '{"id":4,"ok":true,"result":{"count":1,"matches":[{"actions":["AXIncrement","AXDecrement"],"desc":"Tempo","max":990,"min":5,"path":"5.0.2","role":"AXSlider","settable":true,"value":132}],"truncated":false,"visited":169}}',
  menu: '{"id":5,"ok":true,"result":{"enabled":true,"mark":null,"path":["Share","Export Song to Disk…"],"pressed":false}}',
  snapshot: '{"id":6,"ok":true,"result":{"node_count":3,"root":{"children":[{"actions":["AXIncrement","AXDecrement"],"desc":"bar","max":129,"min":128,"path":"0","role":"AXSlider","settable":true,"value":129}],"desc":"Playhead Position","path":"","role":"AXGroup"},"truncated":false}}',
  unparseable: '{"error":{"code":"HELPER_PROTOCOL_ERROR","details":{"length":16},"message":"request is not valid JSON-lines protocol"},"id":null,"ok":false}',
};

describe("wire protocol", () => {
  it("parses success and failure lines", () => {
    expect(parseWireLine(LIVE.hello)).toMatchObject({ ok: true, value: { id: 1, ok: true } });
    expect(parseWireLine(LIVE.unparseable)).toMatchObject({ ok: true, value: { id: null, ok: false, error: { code: "HELPER_PROTOCOL_ERROR" } } });
  });

  it("rejects lines that are not protocol responses", () => {
    expect(parseWireLine("[gb-helper] ready").ok).toBe(false);
    expect(parseWireLine('{"id":1}').ok).toBe(false);
    expect(parseWireLine('{"id":1,"ok":true}').ok).toBe(false);
  });

  it.each([
    ["hello", LIVE.hello, HelloResult],
    ["perm.check", LIVE.perm, PermCheckResult],
    ["app.state", LIVE.app, AppStateResult],
    ["ax.find", LIVE.find, FindResult],
    ["ax.menu", LIVE.menu, MenuResult],
    ["ax.snapshot", LIVE.snapshot, SnapshotResult],
  ] as const)("the live %s result satisfies its schema", (_op, line, schema) => {
    const wire = parseWireLine(line);
    expect(wire.ok && wire.value.ok && schema.safeParse(wire.value.result).success).toBe(true);
  });
});

describe("callOp", () => {
  const port = (result: unknown): HelperPort => ({ call: async () => ok(result), close: async () => {} });

  it("returns the parsed result when it matches the op schema", async () => {
    const r = await callOp(port({ version: "0.1.0", protocol: 1, pid: 1, ax_trusted: true }), "hello", {}, HelloResult);
    expect(r).toEqual({ ok: true, value: { version: "0.1.0", protocol: 1, pid: 1, ax_trusted: true } });
  });

  it("turns a result that breaks the schema into HELPER_PROTOCOL_ERROR (never passes garbage up)", async () => {
    const r = await callOp(port({ version: 1 }), "hello", {}, HelloResult);
    expect(r).toMatchObject({ ok: false, error: { code: "HELPER_PROTOCOL_ERROR" } });
  });
});
