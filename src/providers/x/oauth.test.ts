import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeX, rateLimited, tokenReply } from "../../../tests/helpers/fake-x";
import { exchangeCode, readMe, refreshTokens } from "./oauth";
import { pkceVerifier } from "./pkce";

const cfg = { clientId: "CLIENT-ID", clientSecret: "CLIENT-SECRET-XYZ" };
const fake = createFakeX();
beforeEach(() => {
  fake.reset();
  fake.install();
});
afterEach(() => fake.uninstall());
const signal = () => new AbortController().signal;
const exch = () => exchangeCode(cfg, { code: "CODE-123", redirectUri: "https://d.test/cb", state: "STATE-ABC", signal: signal() });

describe("exchangeCode", () => {
  it("posts the grant with Basic auth and the derived verifier", async () => {
    fake.on("POST", "/2/oauth2/token", { kind: "ok", body: tokenReply() });
    const r = await exch();
    expect(r).toEqual({
      ok: true,
      accessToken: "ACCESS-TOKEN-1",
      refreshToken: "REFRESH-TOKEN-1",
      expiresInSeconds: 7200,
      scopes: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
    });
    expect(fake.requests[0]).toMatchObject({
      auth: "basic",
      basicUser: "CLIENT-ID",
      fields: {
        grant_type: "authorization_code",
        code: "CODE-123",
        redirect_uri: "https://d.test/cb",
        code_verifier: pkceVerifier("STATE-ABC", cfg.clientSecret),
      },
    });
  });

  it("defaults a missing expiry and scope, and reports a missing refresh token as null", async () => {
    fake.on("POST", "/2/oauth2/token", { kind: "ok", body: { access_token: "A-TOKEN", expires_in: 0 } });
    expect(await exch()).toMatchObject({ ok: true, refreshToken: null, expiresInSeconds: 7200, scopes: null });
  });

  it("refuses definitively on an RFC 6749 error, naming client problems", async () => {
    fake.on("POST", "/2/oauth2/token", [
      { kind: "oauth_error", status: 400, error: "invalid_grant", error_description: "bad CODE-123" },
      { kind: "oauth_error", status: 401, error: "invalid_client" },
    ]);
    const a = await exch();
    expect(a).toMatchObject({ ok: false, transient: false, clientProblem: false });
    expect(JSON.stringify(a)).not.toContain("CODE-123");
    expect(await exch()).toMatchObject({ ok: false, transient: false, clientProblem: true });
  });

  it("treats a 400 with an empty body as not definitive-by-name but not transient either", async () => {
    fake.on("POST", "/2/oauth2/token", { kind: "http", status: 400 });
    expect(await exch()).toMatchObject({ ok: false, transient: false, reason: "HTTP 400" });
  });

  it("is transient for 5xx, 429 (with its reset), network failure and unreadable replies", async () => {
    fake.on("POST", "/2/oauth2/token", [
      { kind: "http", status: 503 },
      { kind: "http", status: 429, headers: rateLimited({ remaining: 0, reset: 1760000000 }) },
      { kind: "pre_send_failure" },
      { kind: "unparseable" },
      { kind: "ok", body: { nothing: true } },
    ]);
    expect(await exch()).toMatchObject({ transient: true });
    expect(await exch()).toMatchObject({ transient: true, retryAtMs: 1760000000000 });
    expect(await exch()).toMatchObject({ transient: true, reason: "X could not be reached" });
    expect(await exch()).toMatchObject({ transient: true });
    expect(await exch()).toMatchObject({ transient: true });
  });
});

describe("refreshTokens", () => {
  it("posts the refresh grant", async () => {
    fake.on("POST", "/2/oauth2/token", { kind: "ok", body: tokenReply({ refresh_token: undefined }) });
    const r = await refreshTokens(cfg, { refreshToken: "REFRESH-OLD", signal: signal() });
    expect(r).toMatchObject({ ok: true, refreshToken: null });
    expect(fake.requests[0]).toMatchObject({ auth: "basic", fields: { grant_type: "refresh_token", refresh_token: "REFRESH-OLD" } });
  });

  it("scrubs the refresh token from a refusal", async () => {
    fake.on("POST", "/2/oauth2/token", { kind: "oauth_error", status: 400, error: "invalid_grant", error_description: "token REFRESH-OLD used" });
    const r = await refreshTokens(cfg, { refreshToken: "REFRESH-OLD", signal: signal() });
    expect(r).toMatchObject({ ok: false, transient: false });
    expect(JSON.stringify(r)).not.toContain("REFRESH-OLD");
  });
});

describe("readMe", () => {
  it("reads id, username and name with a bearer token", async () => {
    fake.on("GET", "/2/users/me", { kind: "ok", body: { data: { id: "2244994945", name: "Docket Test", username: "dockettest" } } });
    expect(await readMe("ACCESS-TOKEN-1", signal())).toEqual({ ok: true, id: "2244994945", username: "dockettest", name: "Docket Test" });
    expect(fake.requests[0]).toMatchObject({ auth: "bearer" });
  });

  it("accepts a reply with only an id", async () => {
    fake.on("GET", "/2/users/me", { kind: "ok", body: { data: { id: "7" } } });
    expect(await readMe("ACCESS-TOKEN-1", signal())).toEqual({ ok: true, id: "7", username: null, name: null });
  });

  it.each([
    ["no data", { kind: "ok", body: {} }],
    ["non-numeric id", { kind: "ok", body: { data: { id: "abc" } } }],
    ["a 401", { kind: "problem", status: 401 }],
    ["a network failure", { kind: "pre_send_failure" }],
  ] as const)("fails on %s", async (_n, reply) => {
    fake.on("GET", "/2/users/me", reply);
    expect(await readMe("ACCESS-TOKEN-1", signal())).toMatchObject({ ok: false });
  });
});
