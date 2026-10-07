import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeX, rateLimited, tokenReply } from "../../../tests/helpers/fake-x";
import { X_REFRESH_MARGIN_MS, X_REFRESH_RETRY_MS, X_REFRESH_TOKEN_LIFETIME_MS } from "./config";
import { needsRefresh, refreshX } from "./refresh";

const fake = createFakeX();
const NOW = new Date("2026-06-01T12:00:00Z");
const OLD_REFRESH = "OLD-REFRESH-TOKEN-SECRET";
const TOKEN = "/2/oauth2/token";

const creds = (over: Record<string, unknown> = {}) => ({
  v: 1,
  accessToken: "OLD-ACCESS-TOKEN-SECRET",
  refreshToken: OLD_REFRESH,
  accessExpiresAt: NOW.getTime() + 60_000,
  refreshIssuedAt: NOW.getTime() - 86_400_000,
  ...over,
});
const run = (credentials: unknown, now = NOW) => refreshX({ credentials, now, signal: new AbortController().signal });

beforeEach(() => {
  vi.stubEnv("X_CLIENT_ID", "CLIENT-ID");
  vi.stubEnv("X_CLIENT_SECRET", "CLIENT-SECRET-XYZ");
  fake.reset();
  fake.install();
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});

describe("needsRefresh", () => {
  it("is false at exactly the margin and true 1 ms inside it", () => {
    expect(needsRefresh(creds({ accessExpiresAt: NOW.getTime() + X_REFRESH_MARGIN_MS }), NOW)).toBe(false);
    expect(needsRefresh(creds({ accessExpiresAt: NOW.getTime() + X_REFRESH_MARGIN_MS - 1 }), NOW)).toBe(true);
    expect(needsRefresh(creds({ accessExpiresAt: NOW.getTime() + X_REFRESH_MARGIN_MS + 1 }), NOW)).toBe(false);
  });
  it("is true once expired, false for unreadable credentials", () => {
    expect(needsRefresh(creds({ accessExpiresAt: NOW.getTime() - 1000 }), NOW)).toBe(true);
    expect(needsRefresh({ pageToken: "x" }, NOW)).toBe(false);
  });
});

describe("refreshX (contracts/providers.md refresh table)", () => {
  it("unreadable credentials: definitive, no request", async () => {
    expect(await run({ nope: 1 })).toEqual({ ok: false, reason: "The stored X sign-in is unreadable. Reconnect the account." });
    expect(fake.requests).toHaveLength(0);
  });

  it("success with a new refresh token: stores both and re-bases the account expiry", async () => {
    fake.on("POST", TOKEN, { kind: "ok", body: tokenReply({ access_token: "NEW-ACCESS", refresh_token: "NEW-REFRESH", expires_in: 7200 }) });
    const r = await run(creds());
    const next = { v: 1, accessToken: "NEW-ACCESS", refreshToken: "NEW-REFRESH", accessExpiresAt: NOW.getTime() + 7_200_000, refreshIssuedAt: NOW.getTime() };
    expect(r).toEqual({ ok: true, credentials: next, expiresAt: new Date(NOW.getTime() + X_REFRESH_TOKEN_LIFETIME_MS) });
    expect(fake.requests[0]).toMatchObject({ auth: "basic", fields: { grant_type: "refresh_token" } });
  });

  it("success without a refresh token keeps the old token and its issue time", async () => {
    const issued = NOW.getTime() - 5 * 86_400_000;
    fake.on("POST", TOKEN, { kind: "ok", body: { access_token: "NEW-ACCESS", expires_in: 7200 } });
    const r = await run(creds({ refreshIssuedAt: issued }));
    expect(r).toEqual({
      ok: true,
      credentials: { v: 1, accessToken: "NEW-ACCESS", refreshToken: OLD_REFRESH, accessExpiresAt: NOW.getTime() + 7_200_000, refreshIssuedAt: issued },
      expiresAt: new Date(issued + X_REFRESH_TOKEN_LIFETIME_MS),
    });
  });

  it.each(["invalid_grant", "invalid_request", "invalid_scope"])("%s: definitive refusal", async (error) => {
    fake.on("POST", TOKEN, { kind: "oauth_error", status: 400, error });
    expect(await run(creds())).toEqual({ ok: false, reason: `X refused to renew the sign-in (${error}). Reconnect the account.` });
  });

  it.each(["invalid_client", "unauthorized_client"])("%s: names the app credentials", async (error) => {
    fake.on("POST", TOKEN, { kind: "oauth_error", status: 401, error });
    expect(await run(creds())).toEqual({
      ok: false,
      reason: `X refused Docket's app credentials (${error}). Check X_CLIENT_ID and X_CLIENT_SECRET, then reconnect the account.`,
    });
  });

  it("429 with a readable reset: transient until the reset", async () => {
    const reset = Math.floor(NOW.getTime() / 1000) + 600;
    fake.on("POST", TOKEN, { kind: "problem", status: 429, headers: rateLimited({ remaining: 0, reset }) });
    expect(await run(creds())).toEqual({
      ok: false,
      transient: true,
      retryAt: new Date(reset * 1000),
      reason: "X rate-limited the renewal; will retry.",
    });
  });

  it("429 without a reset: retries in 5 minutes", async () => {
    fake.on("POST", TOKEN, { kind: "problem", status: 429 });
    expect(await run(creds())).toMatchObject({ ok: false, transient: true, retryAt: new Date(NOW.getTime() + X_REFRESH_RETRY_MS) });
  });

  it.each([
    ["5xx", { kind: "problem", status: 503 } as const],
    ["unreadable 2xx", { kind: "unparseable" } as const],
    ["4xx without an OAuth error", { kind: "http", status: 400, body: "<html>" } as const],
    ["network loss", { kind: "reset_mid_body" } as const],
    ["refused connection", { kind: "pre_send_failure" } as const],
  ])("%s: transient, retry in 5 minutes", async (_name, reply) => {
    fake.on("POST", TOKEN, reply);
    expect(await run(creds())).toEqual({
      ok: false,
      transient: true,
      retryAt: new Date(NOW.getTime() + X_REFRESH_RETRY_MS),
      reason: "X could not be reached to renew the sign-in; will retry.",
    });
  });

  it("not configured: transient, no request", async () => {
    vi.stubEnv("X_CLIENT_ID", "");
    vi.stubEnv("X_CLIENT_SECRET", "");
    expect(await run(creds())).toEqual({
      ok: false,
      transient: true,
      retryAt: new Date(NOW.getTime() + X_REFRESH_RETRY_MS),
      reason: "X is not configured on this server.",
    });
    expect(fake.requests).toHaveLength(0);
  });

  it("two refreshes in a row: the second sends the first's new refresh token (SC-005)", async () => {
    fake.on("POST", TOKEN, [
      { kind: "ok", body: tokenReply({ access_token: "A1", refresh_token: "R1" }) },
      { kind: "ok", body: tokenReply({ access_token: "A2", refresh_token: "R2" }) },
    ]);
    const first = await run(creds());
    if (!first.ok) throw new Error("first refresh failed");
    const second = await run(first.credentials, new Date(NOW.getTime() + 7_000_000));
    expect(second).toMatchObject({ ok: true, credentials: { accessToken: "A2", refreshToken: "R2" } });
    expect(fake.requests.map((r) => r.fields.refresh_token)).toEqual([OLD_REFRESH, "R1"]);
  });
});
