import { describe, expect, it } from "vitest";
import { TIKTOK_REFRESH_MARGIN_MS } from "./config";
import { accountExpiry, needsRefresh, readTikTokCredentials } from "./credentials";

const NOW = new Date("2026-10-01T12:00:00Z");
const creds = (over: Record<string, unknown> = {}) => ({
  v: 1,
  accessToken: "A",
  refreshToken: "R",
  accessExpiresAt: NOW.getTime() + 3_600_000,
  refreshIssuedAt: NOW.getTime(),
  refreshExpiresAt: NOW.getTime() + 86_400_000,
  refreshExpiryEstimated: false,
  openId: "open-1",
  ...over,
});

describe("credentials", () => {
  it("reads valid credentials and rejects others", () => {
    expect(readTikTokCredentials(creds())).not.toBeNull();
    expect(readTikTokCredentials({ accessToken: "x" })).toBeNull();
  });
  it("uses the refresh expiry as the account expiry", () => {
    expect(accountExpiry(creds())).toEqual(new Date(NOW.getTime() + 86_400_000));
  });
  it("needsRefresh is false at the 30 minute margin and true just inside it or when unreadable is false", () => {
    expect(needsRefresh(creds({ accessExpiresAt: NOW.getTime() + TIKTOK_REFRESH_MARGIN_MS }), NOW)).toBe(false);
    expect(needsRefresh(creds({ accessExpiresAt: NOW.getTime() + TIKTOK_REFRESH_MARGIN_MS - 1 }), NOW)).toBe(true);
    expect(needsRefresh({ nope: 1 }, NOW)).toBe(false);
  });
});
