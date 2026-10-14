import { afterEach, describe, expect, it, vi } from "vitest";
import type { PinterestConfig } from "./config";
import { authorizationUrl, exchangeToken, refreshToken } from "./oauth";

const cfg: PinterestConfig = { clientId: "client-123", clientSecret: "secret-456" };

describe("authorizationUrl", () => {
  it("carries client_id, redirect_uri, response_type, scope and state, pure", () => {
    const url = new URL(authorizationUrl(cfg, { state: "st8", redirectUri: "https://example.com/cb" }));
    expect(url.origin + url.pathname).toBe("https://www.pinterest.com/oauth/");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.com/cb");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("user_accounts:read,boards:read,pins:write");
    expect(url.searchParams.get("state")).toBe("st8");
  });

  it("never sets code_challenge or continuous_refresh", () => {
    const url = new URL(authorizationUrl(cfg, { state: "st8", redirectUri: "https://example.com/cb" }));
    expect(url.searchParams.has("code_challenge")).toBe(false);
    expect(url.searchParams.has("continuous_refresh")).toBe(false);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("exchangeToken / refreshToken request shapes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the Basic auth header and the authorization_code form body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ access_token: "a", refresh_token: "r" }));
    vi.stubGlobal("fetch", fetchMock);
    await exchangeToken(cfg, { code: "the-code", redirectUri: "https://example.com/cb", signal: new AbortController().signal });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.pinterest.com/v5/oauth/token");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("client-123:secret-456").toString("base64")}`);
    expect(headers["content-type"]).toContain("application/x-www-form-urlencoded");
    expect(init.body).toBe("grant_type=authorization_code&code=the-code&redirect_uri=https%3A%2F%2Fexample.com%2Fcb");
  });

  it("sends the refresh_token form body without a scope parameter", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ access_token: "a" }));
    vi.stubGlobal("fetch", fetchMock);
    await refreshToken(cfg, { refreshToken: "the-refresh", signal: new AbortController().signal });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe("grant_type=refresh_token&refresh_token=the-refresh");
  });

  it("returns ok with the raw token fields on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ access_token: "a", refresh_token: "r", expires_in: 2592000, refresh_token_expires_in: 5184000 })),
    );
    const out = await exchangeToken(cfg, { code: "c", redirectUri: "https://example.com/cb", signal: new AbortController().signal });
    expect(out).toEqual({
      ok: true,
      accessToken: "a",
      refreshToken: "r",
      expiresInSeconds: 2592000,
      refreshExpiresInSeconds: 5184000,
      refreshExpiresAtSeconds: null,
    });
  });

  it("is a transient failure on network/unparseable/5xx/429", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "server_error" }, 503)));
    const out = await refreshToken(cfg, { refreshToken: "r", signal: new AbortController().signal });
    expect(out).toMatchObject({ ok: false, transient: true });
  });

  it("is a definitive, client-naming failure for invalid_client / unauthorized_client", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "invalid_client" }, 401)));
    const out = await refreshToken(cfg, { refreshToken: "r", signal: new AbortController().signal });
    expect(out).toMatchObject({ ok: false, transient: false, clientProblem: true, code: "invalid_client" });
  });

  it("is a definitive, non-client failure for invalid_grant", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400)));
    const out = await refreshToken(cfg, { refreshToken: "r", signal: new AbortController().signal });
    expect(out).toMatchObject({ ok: false, transient: false, clientProblem: false, code: "invalid_grant" });
  });
});
