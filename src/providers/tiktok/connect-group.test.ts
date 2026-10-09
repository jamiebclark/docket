import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTikTok, creatorReply, tokenReply } from "../../../tests/helpers/fake-tiktok";
import { tiktokConnectGroup } from "./connect-group";
import { UNAUDITED_NOTE } from "./settings";

const SECRET = "CLIENT-SECRET-XYZ";
const REDIRECT = "https://docket.test/connect/callback";
const STATE = "STATE-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const NOW = new Date(1_760_000_000_000);
const TOKEN = "/v2/oauth/token/";
const CREATOR = "/v2/post/publish/creator_info/query/";
const fake = createFakeTikTok();

beforeEach(() => {
  vi.stubEnv("TIKTOK_CLIENT_KEY", "CLIENT-KEY");
  vi.stubEnv("TIKTOK_CLIENT_SECRET", SECRET);
  vi.stubEnv("TIKTOK_APP_AUDITED", "true");
  fake.reset();
  fake.install();
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});

const run = (query: Record<string, string> = { scopes: "user.info.basic,video.publish" }) =>
  tiktokConnectGroup.exchangeCode({
    code: "CODE-123",
    redirectUri: REDIRECT,
    now: NOW,
    signal: new AbortController().signal,
    state: STATE,
    callbackParams: new URLSearchParams(query),
  });

describe("authorizationUrl", () => {
  it("carries the exact parameters, with no PKCE and no secret", () => {
    const url = new URL(tiktokConnectGroup.authorizationUrl({ state: STATE, redirectUri: REDIRECT }));
    expect(url.origin + url.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_key: "CLIENT-KEY",
      response_type: "code",
      scope: "user.info.basic,video.publish",
      redirect_uri: REDIRECT,
      state: STATE,
    });
    expect(url.toString()).not.toContain(SECRET);
  });

  it("throws, value-free, when TikTok is not configured", () => {
    vi.stubEnv("TIKTOK_CLIENT_KEY", "");
    vi.stubEnv("TIKTOK_CLIENT_SECRET", "");
    expect(() => tiktokConnectGroup.authorizationUrl({ state: STATE, redirectUri: REDIRECT })).toThrow(/not configured/);
  });
});

describe("group declaration", () => {
  it("requires an https public callback and offers no paste fallback", () => {
    expect(tiktokConnectGroup.redirectRequirement).toMatchObject({ https: true, publicHost: true });
    expect(tiktokConnectGroup.pasteToken).toBeUndefined();
  });
  it("is configured only with both variables", () => {
    expect(tiktokConnectGroup.environment.configured({})).toBe(false);
    expect(tiktokConnectGroup.environment.configured({ TIKTOK_CLIENT_KEY: "K", TIKTOK_CLIENT_SECRET: "S" })).toBe(true);
    expect(tiktokConnectGroup.environment.issues({ TIKTOK_CLIENT_KEY: "K" })).toHaveLength(1);
  });
});

describe("exchangeCode", () => {
  it("returns one candidate from the token reply and creator info", async () => {
    fake.on("POST", TOKEN, { kind: "ok", body: tokenReply() });
    fake.on("POST", CREATOR, { kind: "ok", body: creatorReply() });
    const r = await run();
    expect(fake.requests[1]).toMatchObject({ path: CREATOR, auth: "bearer" });
    if (!r.ok) throw new Error(r.message);
    expect(r.candidates).toHaveLength(1);
    const [c] = r.candidates;
    expect(c).toMatchObject({
      providerKey: "tiktok",
      externalId: "open-id-1",
      displayName: "Ada (@ada)",
      settings: { username: "ada", nickname: "Ada" },
      credentials: {
        v: 1,
        accessToken: "ACCESS-TOKEN-1",
        refreshToken: "REFRESH-TOKEN-1",
        accessExpiresAt: NOW.getTime() + 86_400_000,
        refreshIssuedAt: NOW.getTime(),
        refreshExpiresAt: NOW.getTime() + 31_536_000_000,
        refreshExpiryEstimated: false,
        openId: "open-id-1",
      },
    });
    expect(c!.expiresAt).toEqual(new Date(NOW.getTime() + 31_536_000_000));
    expect(c!.notes).toBeUndefined();
  });

  it("adds the unaudited note on an unaudited install and estimates a missing refresh expiry", async () => {
    vi.stubEnv("TIKTOK_APP_AUDITED", "false");
    fake.on("POST", TOKEN, { kind: "ok", body: tokenReply({ refresh_expires_in: undefined }) });
    fake.on("POST", CREATOR, { kind: "ok", body: creatorReply() });
    const r = await run();
    expect(r).toMatchObject({ ok: true, candidates: [{ notes: [UNAUDITED_NOTE], credentials: { refreshExpiryEstimated: true } }] });
  });

  it("falls back from nickname and username to the open_id for the display name", async () => {
    fake.on("POST", TOKEN, { kind: "ok", body: tokenReply() });
    fake.on("POST", CREATOR, [
      { kind: "ok", body: creatorReply({ creator_username: "" }) },
      { kind: "ok", body: creatorReply({ creator_nickname: "" }) },
    ]);
    expect(await run()).toMatchObject({ ok: true, candidates: [{ displayName: "Ada" }] });
    expect(await run()).toMatchObject({ ok: true, candidates: [{ displayName: "@ada" }] });
  });

  it("refuses callback scopes without video.publish, with no token call", async () => {
    const r = await run({ scopes: "user.info.basic" });
    expect(r).toEqual({ ok: false, message: "TikTok did not grant permission to post. Connect again and allow posting." });
    expect(fake.requests).toHaveLength(0);
  });

  it("falls back to the token reply's scope when the callback has none", async () => {
    fake.on("POST", TOKEN, { kind: "ok", body: tokenReply({ scope: "user.info.basic" }) });
    fake.on("POST", CREATOR, { kind: "ok", body: creatorReply() });
    expect(await run({})).toMatchObject({ ok: false, message: expect.stringContaining("permission to post") });
    expect(fake.callsTo("POST", CREATOR)).toHaveLength(0);
  });

  it("refuses scope_not_authorized from creator info", async () => {
    fake.on("POST", TOKEN, { kind: "ok", body: tokenReply({ scope: undefined }) });
    fake.on("POST", CREATOR, { kind: "error", status: 403, code: "scope_not_authorized" });
    expect(await run({})).toMatchObject({ ok: false, message: expect.stringContaining("permission to post") });
  });

  it("says TikTok could not be reached on a transient creator-info failure, and names the code on a refusal", async () => {
    fake.on("POST", TOKEN, { kind: "ok", body: tokenReply() });
    fake.on("POST", CREATOR, [{ kind: "http", status: 503 }, { kind: "error", status: 400, code: "invalid_param" }]);
    expect(await run()).toEqual({ ok: false, message: "TikTok could not be reached to finish connecting. Nothing changed. Try again." });
    expect(await run()).toMatchObject({ ok: false, message: expect.stringContaining("(invalid_param)") });
  });

  it("explains a token refusal in words that carry no secret", async () => {
    fake.on("POST", TOKEN, { kind: "oauth_error", status: 400, error: "invalid_grant", error_description: `bad CODE-123 ${STATE} ${SECRET}` });
    const r = await run();
    expect(r).toMatchObject({ ok: false });
    const text = JSON.stringify(r);
    for (const secret of [SECRET, "CODE-123", STATE]) expect(text).not.toContain(secret);
    expect(text.length).toBeLessThan(600);
  });

  it("says TikTok could not be reached on a transient token failure", async () => {
    fake.on("POST", TOKEN, { kind: "pre_send_failure" });
    expect(await run()).toEqual({ ok: false, message: "TikTok could not be reached to finish connecting. Nothing changed. Try again." });
  });
});

describe("describeCallbackError", () => {
  it("maps access_denied to cancelled and anything else to platform_error, never echoing the query", () => {
    expect(tiktokConnectGroup.describeCallbackError!(new URLSearchParams({ error: "access_denied" }))).toMatchObject({ code: "cancelled" });
    const other = tiktokConnectGroup.describeCallbackError!(new URLSearchParams({ error: "server_error", error_description: "LEAK" }));
    expect(other).toMatchObject({ code: "platform_error" });
    expect(JSON.stringify(other)).not.toContain("LEAK");
  });
});
