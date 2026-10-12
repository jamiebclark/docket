import { describe, expect, it } from "vitest";
import { frame, parseReason, parseSnapshot, type StreamEventName } from "./stream-protocol";

const EVENT_NAMES: StreamEventName[] = ["snapshot", "ping", "reconnect", "unavailable", "ended"];

describe("frame", () => {
  it.each(EVENT_NAMES)("round-trips %s with no id: or retry:", (name) => {
    const payload = { count: 1, display: "1", label: "1 unread problem", nextChangeAt: null };
    const f = frame(name, payload);
    expect(f).toBe(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
    expect(f).not.toContain("id:");
    expect(f).not.toContain("retry:");
  });

  it("emits an empty data line when no data is given", () => {
    const f = frame("ping");
    expect(f).toBe("event: ping\ndata: \n\n");
    expect(f).not.toContain("id:");
    expect(f).not.toContain("retry:");
  });

  it("never emits id: or retry: for any event name or payload", () => {
    for (const name of EVENT_NAMES) {
      expect(frame(name, { reason: "busy" })).not.toMatch(/^id:|^retry:/m);
      expect(frame(name)).not.toMatch(/^id:|^retry:/m);
    }
  });
});

describe("parseSnapshot", () => {
  it("round-trips a valid UnreadSummary", () => {
    const summary = { count: 3, display: "3", label: "3 unread problems", nextChangeAt: "2026-10-12T00:00:00.000Z" };
    expect(parseSnapshot(JSON.stringify(summary))).toEqual(summary);
  });

  it("accepts a null nextChangeAt", () => {
    const summary = { count: 0, display: "0", label: "No unread problems", nextChangeAt: null };
    expect(parseSnapshot(JSON.stringify(summary))).toEqual(summary);
  });

  it("returns null for an unknown shape", () => {
    expect(parseSnapshot(JSON.stringify({ foo: "bar" }))).toBeNull();
  });

  it("returns null, not throws, for malformed/truncated JSON", () => {
    expect(() => parseSnapshot('{"count":3,"display":"3"')).not.toThrow();
    expect(parseSnapshot('{"count":3,"display":"3"')).toBeNull();
    expect(parseSnapshot("")).toBeNull();
  });

  it("rejects a non-numeric count", () => {
    expect(parseSnapshot(JSON.stringify({ count: "3", display: "3", label: "x", nextChangeAt: null }))).toBeNull();
  });
});

describe("parseReason", () => {
  it("extracts reason from a well-formed body", () => {
    expect(parseReason(JSON.stringify({ reason: "busy" }))).toBe("busy");
    expect(parseReason(JSON.stringify({ reason: "displaced" }))).toBe("displaced");
    expect(parseReason(JSON.stringify({ reason: "unauthenticated" }))).toBe("unauthenticated");
  });

  it("returns null, not throws, for malformed/truncated JSON", () => {
    expect(() => parseReason('{"reason":"bu')).not.toThrow();
    expect(parseReason('{"reason":"bu')).toBeNull();
    expect(parseReason("")).toBeNull();
  });

  it("returns null for a missing or non-string reason", () => {
    expect(parseReason(JSON.stringify({}))).toBeNull();
    expect(parseReason(JSON.stringify({ reason: 1 }))).toBeNull();
  });
});
