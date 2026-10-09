import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeTikTok, tokenReply } from "../../../tests/helpers/fake-tiktok";
import { exchangeCode, refreshLifetimeMs, refreshTokens } from "./oauth";

const cfg = { clientKey: "CLIENT-KEY", clientSecret: "CLIENT-SECRET-XYZ" };
const TOKEN = "/v2/oauth/token/";
const fake = createFakeTikTok();
beforeEach(() => {
  fake.reset();
  fake.install();
});
afterEach(() => fake.uninstall());
const signal = () => new AbortController().signal;
const exch = () => exchangeCode(cfg, { code: "CODE-123", redirectUri: "https://d.test/cb", signal: signal() });

describe("exchangeCode", () => {
  it("posts the grant as a form body with the key, secret, code and redirect URI", async () => {
    fake.on("POST", TOKEN, { kind: "ok", body: tokenReply() });
    expect(await exch()).toEqual({
      ok: true,
      accessToken: "ACCESS-TOKEN-1",
      refreshToken: "REFRESH-TOKEN-1",
      openId: "open-id-1",
      expiresInSeconds: 86_400,
      refreshExpiresInSeconds: 31_536_000,
      scopes: ["user.info.basic", "video.publish"],
    });
    expect(fake.requests[0]).toMatchObject({
      host: "open.tiktokapis.com",
      auth: "none",
      contentType: "application/x-www-form-urlencoded",
      fields: {
        client_key: "CLIENT-KEY",
        client_secret: "CLIENT-SECRET-XYZ",
        code: "CODE-123",
        grant_type: "authorization_code",
        redirect_uri: "https://d.test/cb",
      },
    });
  });

  it("defaults a missing expiry and scope", async () => {
    fake.on("POST", TOKEN, { kind: "ok", body: { access_token: "A-TOKEN", refresh_token: "R-TOKEN", open_id: "o", expires_in: 0 } });
    expect(await exch()).toMatchObject({ ok: true, expiresInSeconds: 86_400, refreshExpiresInSeconds: null, scopes: null });
  });

  it("refuses a reply without a refresh token or open_id as unreadable", async () => {
    fake.on("POST", TOKEN, [
      { kind: "ok", body: { access_token: "A-TOKEN", open_id: "o" } },
      { kind: "ok", body: { access_token: "A-TOKEN", refresh_token: "R-TOKEN" } },
    ]);
    expect(await exch()).toMatchObject({ ok: false, transient: true, reason: "TikTok sent a reply Docket could not read" });
    expect(await exch()).toMatchObject({ ok: false, transient: true });
  });

  it("classifies a definitive refusal, a client problem and a transient failure", async () => {
    fake.on("POST", TOKEN, [
      { kind: "oauth_error", status: 400, error: "invalid_grant", error_description: "code CODE-123 expired" },
      { kind: "oauth_error", status: 401, error: "invalid_client" },
      { kind: "http", status: 429, body: "{}", headers: { "retry-after": "30" } },
      { kind: "http", status: 503 },
      { kind: "pre_send_failure" },
    ]);
    const first = await exch();
    expect(first).toMatchObject({ ok: false, transient: false, code: "invalid_grant", clientProblem: false });
    expect(JSON.stringify(first)).not.toContain("CODE-123");
    expect(await exch()).toMatchObject({ ok: false, transient: false, code: "invalid_client", clientProblem: true });
    expect(await exch()).toMatchObject({ ok: false, transient: true, retryAfterMs: 30_000 });
    expect(await exch()).toMatchObject({ ok: false, transient: true, reason: "HTTP 503" });
    expect(await exch()).toMatchObject({ ok: false, transient: true, reason: "TikTok could not be reached" });
  });

  it("treats an error code in an HTTP 200 body as a refusal", async () => {
    fake.on("POST", TOKEN, { kind: "ok", body: { error: "invalid_grant", error_description: "x" } });
    expect(await exch()).toMatchObject({ ok: false, transient: false, code: "invalid_grant" });
  });
});

describe("refreshTokens", () => {
  it("posts the refresh grant and accepts a reply without a refresh token", async () => {
    fake.on("POST", TOKEN, { kind: "ok", body: { access_token: "NEW", expires_in: 3600 } });
    const r = await refreshTokens(cfg, { refreshToken: "OLD-REFRESH", signal: signal() });
    expect(r).toMatchObject({ ok: true, accessToken: "NEW", refreshToken: null, expiresInSeconds: 3600 });
    expect(fake.requests[0]!.fields).toEqual({
      client_key: "CLIENT-KEY",
      client_secret: "CLIENT-SECRET-XYZ",
      grant_type: "refresh_token",
      refresh_token: "OLD-REFRESH",
    });
  });
});

describe("refreshLifetimeMs", () => {
  it("uses the reply's lifetime, else estimates 365 days", () => {
    expect(refreshLifetimeMs({ refreshExpiresInSeconds: 100 })).toEqual({ ms: 100_000, estimated: false });
    expect(refreshLifetimeMs({ refreshExpiresInSeconds: null })).toEqual({ ms: 365 * 86_400_000, estimated: true });
  });
});
