import { describe, expect, it } from "vitest";
import { accountExpiry, needsRefresh, readXCredentials } from "./credentials";

const NOW = new Date("2026-10-06T12:00:00Z");
const good = (over: Record<string, unknown> = {}) => ({
  v: 1,
  accessToken: "A-TOKEN",
  refreshToken: "R-TOKEN",
  accessExpiresAt: NOW.getTime() + 2 * 3600_000,
  refreshIssuedAt: NOW.getTime(),
  ...over,
});

describe("readXCredentials", () => {
  it("reads a valid value", () => expect(readXCredentials(good())).toEqual(good()));
  it.each([
    ["null", null],
    ["wrong version", good({ v: 2 })],
    ["empty token", good({ accessToken: "" })],
    ["oversized token", good({ refreshToken: "x".repeat(4001) })],
    ["fractional time", good({ accessExpiresAt: 1.5 })],
    ["negative time", good({ refreshIssuedAt: -1 })],
    ["missing field", { v: 1, accessToken: "a", refreshToken: "b" }],
    ["a string", "nope"],
  ])("rejects %s", (_n, value) => expect(readXCredentials(value)).toBeNull());
});

describe("accountExpiry", () => {
  it("is the refresh issue time plus 180 days", () => {
    expect(accountExpiry({ refreshIssuedAt: NOW.getTime() }).getTime() - NOW.getTime()).toBe(180 * 86_400_000);
  });
});

describe("needsRefresh", () => {
  it("is false with plenty of life left", () => expect(needsRefresh(good(), NOW)).toBe(false));
  it("is true inside the 5 minute margin and when already expired", () => {
    expect(needsRefresh(good({ accessExpiresAt: NOW.getTime() + 4 * 60_000 }), NOW)).toBe(true);
    expect(needsRefresh(good({ accessExpiresAt: NOW.getTime() - 1000 }), NOW)).toBe(true);
  });
  it("is false for unreadable credentials", () => expect(needsRefresh({ junk: 1 }, NOW)).toBe(false));
});
