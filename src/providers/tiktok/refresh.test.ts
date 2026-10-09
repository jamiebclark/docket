import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTikTok, tokenReply } from "../../../tests/helpers/fake-tiktok";
import { TIKTOK_REFRESH_RETRY_MS } from "./config";
import { refreshTikTok } from "./refresh";

const fake = createFakeTikTok();
const NOW = new Date("2026-10-01T12:00:00Z");
const OLD_REFRESH = "OLD-REFRESH-TOKEN-SECRET";
const TOKEN = "/v2/oauth/token/";
const DAY = 86_400_000;

const creds = (over: Record<string, unknown> = {}) => ({
  v: 1,
  accessToken: "OLD-ACCESS-TOKEN-SECRET",
  refreshToken: OLD_REFRESH,
  accessExpiresAt: NOW.getTime() + 60_000,
  refreshIssuedAt: NOW.getTime() - DAY,
  refreshExpiresAt: NOW.getTime() + 364 * DAY,
  refreshExpiryEstimated: false,
  openId: "open-id-1",
  ...over,
});
const run = (credentials: unknown, now = NOW) => refreshTikTok({ credentials, now, signal: new AbortController().signal });

beforeEach(() => {
  vi.stubEnv("TIKTOK_CLIENT_KEY", "CLIENT-KEY");
  vi.stubEnv("TIKTOK_CLIENT_SECRET", "CLIENT-SECRET-XYZ");
  fake.reset();
  fake.install();
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});

describe("refreshTikTok", () => {
  it("unreadable credentials: definitive, no request", async () => {
    expect(await run({ nope: 1 })).toEqual({ ok: false, reason: "The stored TikTok sign-in is unreadable. Reconnect the account." });
    expect(fake.requests).toHaveLength(0);
  });

  it("a new refresh token replaces the old and re-bases both timestamps", async () => {
    fake.on("POST", TOKEN, { kind: "ok", body: tokenReply({ access_token: "NEW-ACCESS", refresh_token: "NEW-REFRESH", expires_in: 3600, refresh_expires_in: 1000 }) });
    const r = await run(creds());
    const next = creds({
      accessToken: "NEW-ACCESS",
      refreshToken: "NEW-REFRESH",
      accessExpiresAt: NOW.getTime() + 3_600_000,
      refreshIssuedAt: NOW.getTime(),
      refreshExpiresAt: NOW.getTime() + 1_000_000,
    });
    expect(r).toEqual({ ok: true, credentials: next, expiresAt: new Date(NOW.getTime() + 1_000_000) });
    expect(fake.requests[0]!.fields).toMatchObject({ grant_type: "refresh_token", refresh_token: OLD_REFRESH, client_key: "CLIENT-KEY" });
  });

  it("estimates the refresh expiry when the reply gives none", async () => {
    fake.on("POST", TOKEN, { kind: "ok", body: { access_token: "A", refresh_token: "NEW-REFRESH", expires_in: 100 } });
    const r = await run(creds());
    expect(r).toMatchObject({ ok: true, credentials: { refreshExpiryEstimated: true, refreshExpiresAt: NOW.getTime() + 365 * DAY } });
  });

  it("no refresh token in the reply (or the same one): keeps the old token and its times", async () => {
    fake.on("POST", TOKEN, [
      { kind: "ok", body: { access_token: "A1", expires_in: 7200 } },
      { kind: "ok", body: { access_token: "A2", expires_in: 7200, refresh_token: OLD_REFRESH } },
    ]);
    const base = creds();
    for (const access of ["A1", "A2"]) {
      expect(await run(base)).toEqual({
        ok: true,
        credentials: { ...base, accessToken: access, accessExpiresAt: NOW.getTime() + 7_200_000 },
        expiresAt: new Date(base.refreshExpiresAt),
      });
    }
  });

  it.each(["invalid_grant", "invalid_request", "access_token_invalid"])("%s: definitive refusal", async (error) => {
    fake.on("POST", TOKEN, { kind: "oauth_error", status: 400, error });
    expect(await run(creds())).toEqual({ ok: false, reason: `TikTok refused to renew the sign-in (${error}). Reconnect the account.` });
  });

  it.each(["invalid_client", "unauthorized_client"])("%s: names the app credentials", async (error) => {
    fake.on("POST", TOKEN, { kind: "oauth_error", status: 401, error });
    expect(await run(creds())).toEqual({
      ok: false,
      reason: `TikTok refused Docket's app credentials (${error}). Check TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET, then reconnect the account.`,
    });
  });

  it.each([
    ["429", { kind: "http", status: 429, body: "{}" } as const],
    ["5xx", { kind: "http", status: 503 } as const],
    ["unreadable 2xx", { kind: "unparseable" } as const],
    ["4xx without an OAuth error", { kind: "http", status: 400, body: "<html>" } as const],
    ["network loss", { kind: "reset_mid_body" } as const],
    ["refused connection", { kind: "pre_send_failure" } as const],
  ])("%s: transient, retry in 5 minutes", async (_name, reply) => {
    fake.on("POST", TOKEN, reply);
    expect(await run(creds())).toEqual({
      ok: false,
      transient: true,
      retryAt: new Date(NOW.getTime() + TIKTOK_REFRESH_RETRY_MS),
      reason: "TikTok could not be reached to renew the sign-in; will retry.",
    });
  });

  it("not configured: transient, no request", async () => {
    vi.stubEnv("TIKTOK_CLIENT_KEY", "");
    vi.stubEnv("TIKTOK_CLIENT_SECRET", "");
    expect(await run(creds())).toEqual({
      ok: false,
      transient: true,
      retryAt: new Date(NOW.getTime() + TIKTOK_REFRESH_RETRY_MS),
      reason: "TikTok is not configured on this server.",
    });
    expect(fake.requests).toHaveLength(0);
  });

  it("two refreshes in a row: the second sends the first's new refresh token", async () => {
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
