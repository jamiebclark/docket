import { describe, expect, it } from "vitest";
import {
  PINTEREST_REFRESH_MARGIN_MS,
  accountExpiry,
  computePinterestExpiry,
  needsRefresh,
  pinterestCredentialsSchema,
  readPinterestCredentials,
} from "./credentials";

const valid = {
  v: 1,
  accessToken: "pina-token",
  refreshToken: "pinr-token",
  accessExpiresAt: 1_000,
  refreshIssuedAt: 500,
  refreshExpiresAt: 2_000,
  refreshExpiryEstimated: false,
};

describe("pinterestCredentialsSchema / readPinterestCredentials", () => {
  it("parses a valid blob", () => {
    expect(pinterestCredentialsSchema.safeParse(valid).success).toBe(true);
    expect(readPinterestCredentials(valid)).toEqual(valid);
  });

  it("returns null on a malformed blob", () => {
    expect(readPinterestCredentials({ ...valid, accessToken: "" })).toBeNull();
    expect(readPinterestCredentials(null)).toBeNull();
    expect(readPinterestCredentials("not an object")).toBeNull();
  });
});

describe("accountExpiry", () => {
  it("is the refresh token's expiry", () => {
    expect(accountExpiry(valid)).toEqual(new Date(2_000));
  });
});

describe("needsRefresh", () => {
  it("is true at the margin and false outside it", () => {
    const now = new Date(0);
    const atMargin = { ...valid, accessExpiresAt: PINTEREST_REFRESH_MARGIN_MS - 1 };
    const outsideMargin = { ...valid, accessExpiresAt: PINTEREST_REFRESH_MARGIN_MS };
    expect(needsRefresh(atMargin, now)).toBe(true);
    expect(needsRefresh(outsideMargin, now)).toBe(false);
  });

  it("is false for unreadable credentials", () => {
    expect(needsRefresh(null, new Date(0))).toBe(false);
  });
});

describe("computePinterestExpiry", () => {
  const now = 10_000;

  it("uses expires_in for the access token, default 30 days when absent, estimating the refresh expiry at 60 days when neither is present", () => {
    const out = computePinterestExpiry({ expiresInSeconds: null, refreshExpiresInSeconds: null, refreshExpiresAtSeconds: null }, now);
    expect(out).toEqual({ accessExpiresAt: now + 2_592_000 * 1000, refreshExpiresAt: now + 60 * 24 * 60 * 60 * 1000, refreshExpiryEstimated: true });
  });

  it("uses refresh_token_expires_in when present", () => {
    const out = computePinterestExpiry({ expiresInSeconds: 100, refreshExpiresInSeconds: 200, refreshExpiresAtSeconds: null }, now);
    expect(out).toEqual({ accessExpiresAt: now + 100_000, refreshExpiresAt: now + 200_000, refreshExpiryEstimated: false });
  });

  it("uses refresh_token_expires_at (epoch seconds) when `_in` is absent", () => {
    const out = computePinterestExpiry({ expiresInSeconds: 100, refreshExpiresInSeconds: null, refreshExpiresAtSeconds: 500 }, now);
    expect(out).toEqual({ accessExpiresAt: now + 100_000, refreshExpiresAt: 500_000, refreshExpiryEstimated: false });
  });

  it("prefers refresh_token_expires_in over refresh_token_expires_at when both are present", () => {
    const out = computePinterestExpiry({ expiresInSeconds: 100, refreshExpiresInSeconds: 200, refreshExpiresAtSeconds: 500 }, now);
    expect(out.refreshExpiresAt).toBe(now + 200_000);
    expect(out.refreshExpiryEstimated).toBe(false);
  });
});
