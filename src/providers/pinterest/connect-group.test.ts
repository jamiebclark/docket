import { afterEach, describe, expect, it, vi } from "vitest";
import { pinterestConnectGroup } from "./connect-group";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const baseEnv = () => {
  vi.stubEnv("PINTEREST_CLIENT_ID", "client-id");
  vi.stubEnv("PINTEREST_CLIENT_SECRET", "client-secret");
};

describe("pinterestConnectGroup.authorizationUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("with PINTEREST_INSIGHTS_SCOPES unset, is byte-for-byte today's literal (FR-027)", () => {
    baseEnv();
    const url = pinterestConnectGroup.authorizationUrl({ state: "st8", redirectUri: "https://example.com/cb" });
    expect(url).toBe(
      "https://www.pinterest.com/oauth/?client_id=client-id&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&response_type=code&scope=user_accounts%3Aread%2Cboards%3Aread%2Cpins%3Awrite&state=st8",
    );
  });

  it("with PINTEREST_INSIGHTS_SCOPES=true, carries today's scopes plus pins:read (FR-027)", () => {
    baseEnv();
    vi.stubEnv("PINTEREST_INSIGHTS_SCOPES", "true");
    const url = new URL(pinterestConnectGroup.authorizationUrl({ state: "st8", redirectUri: "https://example.com/cb" }));
    expect(url.searchParams.get("scope")).toBe("user_accounts:read,boards:read,pins:write,pins:read");
  });

  it("with PINTEREST_INSIGHTS_SCOPES=false, is byte-identical to today's literal (FR-027)", () => {
    baseEnv();
    vi.stubEnv("PINTEREST_INSIGHTS_SCOPES", "false");
    const url = new URL(pinterestConnectGroup.authorizationUrl({ state: "st8", redirectUri: "https://example.com/cb" }));
    expect(url.searchParams.get("scope")).toBe("user_accounts:read,boards:read,pins:write");
  });
});

describe("pinterestConnectGroup.optionalScopes", () => {
  it("declares pins:read, requested only when PINTEREST_INSIGHTS_SCOPES is on (FR-027)", () => {
    expect(pinterestConnectGroup.optionalScopes?.declared).toEqual([{ scope: "pins:read", purpose: "Read a pin's analytics (impressions, clicks, saves)" }]);
    const base = { PINTEREST_CLIENT_ID: "client-id", PINTEREST_CLIENT_SECRET: "client-secret" };
    expect(pinterestConnectGroup.optionalScopes?.requested(base)).toEqual([]);
    expect(pinterestConnectGroup.optionalScopes?.requested({ ...base, PINTEREST_INSIGHTS_SCOPES: "true" })).toEqual(["pins:read"]);
  });
});

describe("pinterestConnectGroup.exchangeCode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("does the Basic-auth token POST, then GET /v5/user_account, and returns one candidate", async () => {
    baseEnv();
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      if (String(url).includes("/oauth/token")) {
        return jsonResponse({ access_token: "access-tok", refresh_token: "refresh-tok", expires_in: 2_592_000, refresh_token_expires_in: 5_184_000 });
      }
      return jsonResponse({ id: "user-1", username: "someone", business_name: "Acme Co" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const now = new Date(10_000);
    const out = await pinterestConnectGroup.exchangeCode({ code: "the-code", redirectUri: "https://example.com/cb", state: "st8", now, signal: new AbortController().signal });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.candidates).toHaveLength(1);
    const candidate = out.candidates[0]!;
    expect(candidate.providerKey).toBe("pinterest");
    expect(candidate.externalId).toBe("user-1");
    expect(candidate.displayName).toBe("Acme Co");
    expect(candidate.settings).toEqual({});
    expect(candidate.expiresAt).toEqual(new Date(10_000 + 5_184_000 * 1000));
    expect(candidate.notes?.[0]).toMatch(/Trial access/);

    const tokenCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/oauth/token"))!;
    const headers = tokenCall[1]!.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);
  });

  it("attaches grantedScopes when the token reply carries a scope field, otherwise leaves it absent (R6, FR-012)", async () => {
    baseEnv();
    vi.stubGlobal("fetch", async (url: string | URL) => {
      if (String(url).includes("/oauth/token")) {
        return jsonResponse({ access_token: "a", refresh_token: "r", scope: "user_accounts:read,boards:read" });
      }
      return jsonResponse({ id: "user-3", username: "someone" });
    });
    const out = await pinterestConnectGroup.exchangeCode({ code: "c", redirectUri: "https://example.com/cb", state: "s", now: new Date(), signal: new AbortController().signal });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.candidates[0]!.grantedScopes).toEqual(["user_accounts:read", "boards:read"]);
  });

  it("leaves grantedScopes absent when the token reply carries no scope field", async () => {
    baseEnv();
    vi.stubGlobal("fetch", async (url: string | URL) => {
      if (String(url).includes("/oauth/token")) return jsonResponse({ access_token: "a", refresh_token: "r" });
      return jsonResponse({ id: "user-4", username: "someone" });
    });
    const out = await pinterestConnectGroup.exchangeCode({ code: "c", redirectUri: "https://example.com/cb", state: "s", now: new Date(), signal: new AbortController().signal });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.candidates[0]!.grantedScopes).toBeUndefined();
  });

  it("falls back to the username when business_name is absent", async () => {
    baseEnv();
    vi.stubGlobal("fetch", async (url: string | URL) => {
      if (String(url).includes("/oauth/token")) return jsonResponse({ access_token: "a", refresh_token: "r" });
      return jsonResponse({ id: "user-2", username: "someone" });
    });
    const out = await pinterestConnectGroup.exchangeCode({ code: "c", redirectUri: "https://example.com/cb", state: "s", now: new Date(), signal: new AbortController().signal });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.candidates[0]!.displayName).toBe("someone");
  });

  it("refuses a reply with no usable id, storing nothing", async () => {
    baseEnv();
    vi.stubGlobal("fetch", async (url: string | URL) => {
      if (String(url).includes("/oauth/token")) return jsonResponse({ access_token: "a", refresh_token: "r" });
      return jsonResponse({ username: "no-id-here" });
    });
    const out = await pinterestConnectGroup.exchangeCode({ code: "c", redirectUri: "https://example.com/cb", state: "s", now: new Date(), signal: new AbortController().signal });
    expect(out).toEqual({ ok: false, message: expect.stringContaining("Pinterest sent a reply Docket could not read") });
  });

  it("every refusal message is secret- and code-free", async () => {
    baseEnv();
    vi.stubGlobal("fetch", async () => jsonResponse({ error: "invalid_grant", error_description: "client-secret the-code" }, 400));
    const out = await pinterestConnectGroup.exchangeCode({ code: "the-code", redirectUri: "https://example.com/cb", state: "s", now: new Date(), signal: new AbortController().signal });
    expect(out.ok).toBe(false);
    const message = (out as { message: string }).message;
    expect(message).not.toContain("client-secret");
    expect(message).not.toContain("the-code");
  });

  it("names the client credentials for invalid_client / unauthorized_client", async () => {
    baseEnv();
    vi.stubGlobal("fetch", async () => jsonResponse({ error: "invalid_client" }, 401));
    const out = await pinterestConnectGroup.exchangeCode({ code: "c", redirectUri: "https://example.com/cb", state: "s", now: new Date(), signal: new AbortController().signal });
    expect(out.ok).toBe(false);
    expect((out as { message: string }).message).toContain("PINTEREST_CLIENT_ID");
  });

  it("is transient-worded for network/5xx/429/unparseable, without echoing the status as a code", async () => {
    baseEnv();
    vi.stubGlobal("fetch", async () => jsonResponse({}, 503));
    const out = await pinterestConnectGroup.exchangeCode({ code: "c", redirectUri: "https://example.com/cb", state: "s", now: new Date(), signal: new AbortController().signal });
    expect(out).toEqual({ ok: false, message: "Pinterest could not be reached to finish connecting. Nothing changed. Try again." });
  });
});

describe("pinterestConnectGroup.describeCallbackError", () => {
  it("maps access_denied to cancelled and never echoes the query", () => {
    const params = new URLSearchParams("error=access_denied&error_description=<script>evil</script>");
    expect(pinterestConnectGroup.describeCallbackError!(params)).toEqual({ code: "cancelled", message: "Connecting was cancelled. Nothing changed." });
  });

  it("maps anything else to a generic platform error, never echoing the query", () => {
    const params = new URLSearchParams("error=server_error&error_description=<script>evil</script>");
    const result = pinterestConnectGroup.describeCallbackError!(params);
    expect(result).toEqual({ code: "platform_error", message: "Pinterest returned an error. Nothing changed. Try again." });
    expect(result.message).not.toContain("script");
  });
});
