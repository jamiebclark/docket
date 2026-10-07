import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeX, tokenReply } from "../../../tests/helpers/fake-x";
import { xConnectGroup } from "./connect-group";
import { pkceChallenge, pkceVerifier } from "./pkce";

const SECRET = "CLIENT-SECRET-XYZ";
const REDIRECT = "https://docket.test/connect/callback";
const STATE = "STATE-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const fake = createFakeX();

beforeEach(() => {
  vi.stubEnv("X_CLIENT_ID", "CLIENT-ID");
  vi.stubEnv("X_CLIENT_SECRET", SECRET);
  fake.reset();
  fake.install();
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});

const run = () =>
  xConnectGroup.exchangeCode({ code: "CODE-123", redirectUri: REDIRECT, now: new Date(1_760_000_000_000), signal: new AbortController().signal, state: STATE });
const me = (data: Record<string, unknown> = { id: "9001", username: "dockettest", name: "Docket Test" }) =>
  fake.on("GET", "/2/users/me", { kind: "ok", body: { data } });

describe("authorizationUrl", () => {
  it("carries the exact scopes, state and an S256 challenge of the derived verifier", () => {
    const url = new URL(xConnectGroup.authorizationUrl({ state: STATE, redirectUri: REDIRECT }));
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "CLIENT-ID",
      redirect_uri: REDIRECT,
      scope: "tweet.read tweet.write users.read media.write offline.access",
      state: STATE,
      code_challenge: pkceChallenge(pkceVerifier(STATE, SECRET)),
      code_challenge_method: "S256",
    });
    expect(url.toString()).not.toContain(SECRET);
  });

  it("throws, value-free, when X is not configured", () => {
    vi.stubEnv("X_CLIENT_ID", "");
    vi.stubEnv("X_CLIENT_SECRET", "");
    expect(() => xConnectGroup.authorizationUrl({ state: STATE, redirectUri: REDIRECT })).toThrow(/not configured/);
  });
});

describe("exchangeCode", () => {
  it("sends the verifier whose challenge was in the authorize URL and returns one candidate", async () => {
    fake.on("POST", "/2/oauth2/token", { kind: "ok", body: tokenReply() });
    me();
    const r = await run();
    const challenge = new URL(xConnectGroup.authorizationUrl({ state: STATE, redirectUri: REDIRECT })).searchParams.get("code_challenge");
    expect(pkceChallenge(fake.requests[0]!.fields.code_verifier as string)).toBe(challenge);
    expect(fake.requests[1]).toMatchObject({ path: "/2/users/me", auth: "bearer" });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) throw new Error("unreachable");
    const [c] = r.candidates;
    expect(r.candidates).toHaveLength(1);
    expect(c).toMatchObject({
      providerKey: "x",
      externalId: "9001",
      displayName: "@dockettest",
      settings: { username: "dockettest", name: "Docket Test" },
      credentials: {
        v: 1,
        accessToken: "ACCESS-TOKEN-1",
        refreshToken: "REFRESH-TOKEN-1",
        accessExpiresAt: 1_760_000_000_000 + 7_200_000,
        refreshIssuedAt: 1_760_000_000_000,
      },
    });
    expect(c!.expiresAt).toEqual(new Date(1_760_000_000_000 + 180 * 86_400_000));
    expect(c!.notes).toBeUndefined();
  });

  it("falls back to the id when the profile has no username", async () => {
    fake.on("POST", "/2/oauth2/token", { kind: "ok", body: tokenReply() });
    me({ id: "9001" });
    const r = await run();
    expect(r).toMatchObject({ ok: true, candidates: [{ displayName: "9001", settings: {} }] });
  });

  it("refuses when no refresh token was granted, and never calls users/me", async () => {
    fake.on("POST", "/2/oauth2/token", { kind: "ok", body: tokenReply({ refresh_token: undefined }) });
    me();
    expect(await run()).toEqual({
      ok: false,
      message: "X did not grant offline access, so Docket could not stay signed in. Connect again and allow it.",
    });
    expect(fake.callsTo("GET", "/2/users/me")).toHaveLength(0);
  });

  it("refuses when the profile call fails", async () => {
    fake.on("POST", "/2/oauth2/token", { kind: "ok", body: tokenReply() });
    fake.on("GET", "/2/users/me", { kind: "problem", status: 403, title: "Forbidden" });
    expect(await run()).toMatchObject({ ok: false });
    fake.on("GET", "/2/users/me", { kind: "ok", body: { data: {} } });
    expect(await run()).toMatchObject({ ok: false });
  });

  it("notes missing scopes", async () => {
    fake.on("POST", "/2/oauth2/token", { kind: "ok", body: tokenReply({ scope: "tweet.read users.read offline.access" }) });
    me();
    const r = await run();
    expect(r).toMatchObject({
      ok: true,
      candidates: [
        {
          notes: [
            "Posting permission (tweet.write) was not granted. Connect again and allow it.",
            "Image upload permission (media.write) was not granted. Connect again and allow it.",
          ],
        },
      ],
    });
  });

  it("explains a refusal in words that carry no secret", async () => {
    fake.on("POST", "/2/oauth2/token", {
      kind: "oauth_error",
      status: 400,
      error: "invalid_grant",
      error_description: `bad CODE-123 ${STATE} ${SECRET}`,
    });
    const r = await run();
    expect(r).toMatchObject({ ok: false });
    const text = JSON.stringify(r);
    for (const secret of [SECRET, "CODE-123", STATE, pkceVerifier(STATE, SECRET)]) expect(text).not.toContain(secret);
  });

  it("says X could not be reached on a transient failure", async () => {
    fake.on("POST", "/2/oauth2/token", { kind: "pre_send_failure" });
    expect(await run()).toEqual({ ok: false, message: "X could not be reached. Nothing changed. Try again." });
  });
});

describe("describeCallbackError", () => {
  it("maps access_denied to cancelled and anything else to platform_error", () => {
    expect(xConnectGroup.describeCallbackError!(new URLSearchParams({ error: "access_denied" }))).toMatchObject({ code: "cancelled" });
    expect(xConnectGroup.describeCallbackError!(new URLSearchParams({ error: "server_error" }))).toMatchObject({ code: "platform_error" });
  });
});
