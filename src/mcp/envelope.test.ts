// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { verified, failed, uncertain, isErrorEnvelope } from "./envelope.js";

describe("envelope contract", () => {
  it("uncertain: an action was delivered but its effect could not be confirmed", () => {
    expect(uncertain("gb_transport.play", "readback_unavailable", {
      write_attempted: true, safe_to_retry: false, hint: "read gb://state/transport before retrying",
    })).toEqual({
      status: "uncertain", op: "gb_transport.play", reason: "readback_unavailable",
      write_attempted: true, safe_to_retry: false, hint: "read gb://state/transport before retrying",
    });
  });

  it("uncertain can carry the partial data that was observed", () => {
    expect(uncertain("x.y", "noop_unobservable", { write_attempted: true, safe_to_retry: true, hint: "h", data: { value: 120 } }))
      .toMatchObject({ status: "uncertain", data: { value: 120 } });
  });

  it("payload can never overwrite the canonical fields", () => {
    const v = verified("a.b", { status: "failed", op: "evil" });
    expect(v.status).toBe("verified");
    expect(v.op).toBe("a.b");
    const f = failed("a.b", "TARGET_NOT_FOUND", "m", { context: { status: "verified" } });
    expect(f.status).toBe("failed");
  });

  it("only failed envelopes are MCP errors (uncertain is a result the agent must read, not an error)", () => {
    expect(isErrorEnvelope(failed("a", "DEADLINE_EXCEEDED", "m"))).toBe(true);
    expect(isErrorEnvelope(uncertain("a", "readback_unavailable", { write_attempted: true, safe_to_retry: false, hint: "h" }))).toBe(false);
    expect(isErrorEnvelope(verified("a", {}))).toBe(false);
  });
});
