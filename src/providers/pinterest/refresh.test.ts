import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshPinterest } from "./refresh";

const creds = {
  v: 1,
  accessToken: "old-access",
  refreshToken: "old-refresh",
  accessExpiresAt: 1_000,
  refreshIssuedAt: 500,
  refreshExpiresAt: 2_000,
  refreshExpiryEstimated: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("refreshPinterest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("is unreadable for malformed stored credentials, without touching anything", async () => {
    const out = await refreshPinterest({ credentials: { bad: true }, now: new Date(0), signal: new AbortController().signal });
    expect(out).toEqual({ ok: false, reason: "The stored Pinterest sign-in is unreadable. Reconnect the account." });
  });

  it("is transient when Pinterest is not configured", async () => {
    vi.stubEnv("PINTEREST_CLIENT_ID", "");
    vi.stubEnv("PINTEREST_CLIENT_SECRET", "");
    const now = new Date(10_000);
    const out = await refreshPinterest({ credentials: creds, now, signal: new AbortController().signal });
    expect(out).toMatchObject({ ok: false, transient: true, retryAt: new Date(10_000 + 5 * 60 * 1000) });
  });

  it("rotates the refresh token on a 2xx with both tokens, re-dating expiries", async () => {
    vi.stubEnv("PINTEREST_CLIENT_ID", "id");
    vi.stubEnv("PINTEREST_CLIENT_SECRET", "secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 100, refresh_token_expires_in: 200 })),
    );
    const now = new Date(10_000);
    const out = await refreshPinterest({ credentials: creds, now, signal: new AbortController().signal });
    expect(out).toEqual({
      ok: true,
      credentials: {
        v: 1,
        accessToken: "new-access",
        refreshToken: "new-refresh",
        accessExpiresAt: 10_000 + 100_000,
        refreshIssuedAt: 10_000,
        refreshExpiresAt: 10_000 + 200_000,
        refreshExpiryEstimated: false,
      },
      expiresAt: new Date(10_000 + 200_000),
    });
  });

  it("a reply whose scope differs from the stored grant updates grantedScopes", async () => {
    vi.stubEnv("PINTEREST_CLIENT_ID", "id");
    vi.stubEnv("PINTEREST_CLIENT_SECRET", "secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 100, scope: "pins:read" })),
    );
    const now = new Date(10_000);
    const out = await refreshPinterest({ credentials: creds, now, signal: new AbortController().signal });
    expect(out).toMatchObject({ ok: true, grantedScopes: ["pins:read"] });
  });

  it("a reply with no scope field leaves grantedScopes unchanged", async () => {
    vi.stubEnv("PINTEREST_CLIENT_ID", "id");
    vi.stubEnv("PINTEREST_CLIENT_SECRET", "secret");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ access_token: "new-access", expires_in: 100 })));
    const now = new Date(10_000);
    const out = await refreshPinterest({ credentials: creds, now, signal: new AbortController().signal });
    expect(out).toMatchObject({ ok: true });
    if (out.ok) expect(out).not.toHaveProperty("grantedScopes");
  });

  it("keeps the stored refresh token and expiry untouched when the reply carries no refresh token (U8)", async () => {
    vi.stubEnv("PINTEREST_CLIENT_ID", "id");
    vi.stubEnv("PINTEREST_CLIENT_SECRET", "secret");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ access_token: "new-access", expires_in: 100 })));
    const now = new Date(10_000);
    const out = await refreshPinterest({ credentials: creds, now, signal: new AbortController().signal });
    expect(out).toEqual({
      ok: true,
      credentials: { ...creds, accessToken: "new-access", accessExpiresAt: 10_000 + 100_000 },
      expiresAt: new Date(creds.refreshExpiresAt),
    });
  });

  it("is needs_reauth for a definitive 4xx, with reconnect wording", async () => {
    vi.stubEnv("PINTEREST_CLIENT_ID", "id");
    vi.stubEnv("PINTEREST_CLIENT_SECRET", "secret");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400)));
    const out = await refreshPinterest({ credentials: creds, now: new Date(0), signal: new AbortController().signal });
    expect(out).toEqual({ ok: false, reason: "Re-approve Docket on Pinterest to publish again." });
  });

  it("is needs_reauth for a client-naming 4xx, naming both env vars", async () => {
    vi.stubEnv("PINTEREST_CLIENT_ID", "id");
    vi.stubEnv("PINTEREST_CLIENT_SECRET", "secret");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "invalid_client" }, 401)));
    const out = await refreshPinterest({ credentials: creds, now: new Date(0), signal: new AbortController().signal });
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toContain("PINTEREST_CLIENT_ID");
    expect((out as { reason: string }).reason).toContain("PINTEREST_CLIENT_SECRET");
  });

  it.each([429, 500, 503])("is transient with retryAt 5 minutes out on HTTP %s", async (status) => {
    vi.stubEnv("PINTEREST_CLIENT_ID", "id");
    vi.stubEnv("PINTEREST_CLIENT_SECRET", "secret");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "server_error" }, status)));
    const now = new Date(10_000);
    const out = await refreshPinterest({ credentials: creds, now, signal: new AbortController().signal });
    expect(out).toMatchObject({ ok: false, transient: true, retryAt: new Date(10_000 + 5 * 60 * 1000) });
  });

  it("is transient on network failure", async () => {
    vi.stubEnv("PINTEREST_CLIENT_ID", "id");
    vi.stubEnv("PINTEREST_CLIENT_SECRET", "secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    const now = new Date(10_000);
    const out = await refreshPinterest({ credentials: creds, now, signal: new AbortController().signal });
    expect(out).toMatchObject({ ok: false, transient: true, retryAt: new Date(10_000 + 5 * 60 * 1000) });
  });

  it("is transient on an unparseable 2xx", async () => {
    vi.stubEnv("PINTEREST_CLIENT_ID", "id");
    vi.stubEnv("PINTEREST_CLIENT_SECRET", "secret");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    const now = new Date(10_000);
    const out = await refreshPinterest({ credentials: creds, now, signal: new AbortController().signal });
    expect(out).toMatchObject({ ok: false, transient: true, retryAt: new Date(10_000 + 5 * 60 * 1000) });
  });
});
