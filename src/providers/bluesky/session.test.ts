import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePds, mintJwt, type FakePds } from "../../../tests/helpers/fake-pds";
import { connectAccount, jwtExp, needsRefresh, refreshCredentials } from "./session";

const now = new Date("2026-01-01T00:00:00Z");
const CREATE = "/xrpc/com.atproto.server.createSession";
const session = (over: Record<string, unknown> = {}) => ({
  accessJwt: mintJwt(new Date("2026-01-01T01:00:00Z")),
  refreshJwt: mintJwt(new Date("2026-03-01T00:00:00Z")),
  handle: "alice.bsky.social",
  did: "did:plc:alice",
  ...over,
});
const PASSWORD = "abcd-efgh-ijkl-mnop";
const fields = (over: Record<string, string> = {}) => ({ handle: "Alice.bsky.social", appPassword: PASSWORD, pdsUrl: "", ...over });
const connect = (f = fields()) => connectAccount({ fields: f, now, signal: new AbortController().signal });

let pds: FakePds;
beforeEach(() => {
  pds = createFakePds();
  vi.stubGlobal("fetch", pds.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("connectAccount", () => {
  it("returns the stored shape and never the app password", async () => {
    pds.route("POST", CREATE, { json: session() });
    const result = await connect();
    expect(result).toEqual({
      ok: true,
      account: {
        externalId: "did:plc:alice",
        displayName: "alice.bsky.social",
        settings: { pdsUrl: "https://bsky.social" },
        credentials: expect.objectContaining({ did: "did:plc:alice", handle: "alice.bsky.social" }),
        expiresAt: new Date("2026-03-01T00:00:00Z"),
      },
    });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(pds.requests).toHaveLength(1);
    expect(pds.requests[0]!.url).toMatch(/^https:\/\/bsky\.social\//);
    expect(pds.requests[0]!.body).toEqual({ identifier: "alice.bsky.social", password: PASSWORD });
  });

  it("uses a custom PDS and falls back to now + 60 d when the refresh JWT has no exp", async () => {
    pds.route("POST", CREATE, { json: session({ refreshJwt: "opaque" }) });
    const result = await connect(fields({ pdsUrl: "https://pds.example.com/" }));
    expect(pds.requests[0]!.url).toMatch(/^https:\/\/pds\.example\.com\//);
    expect(result).toMatchObject({
      ok: true,
      account: { settings: { pdsUrl: "https://pds.example.com" }, expiresAt: new Date(now.getTime() + 60 * 86_400_000) },
    });
  });

  it.each([
    ["no handle", fields({ handle: " @ " }), "handle"],
    ["spaces in handle", fields({ handle: "a b.bsky.social" }), "handle"],
    ["http PDS", fields({ pdsUrl: "http://pds.example.com" }), "pdsUrl"],
    ["PDS with a path", fields({ pdsUrl: "https://pds.example.com/x" }), "pdsUrl"],
  ])("rejects %s without any request", async (_n, f, field) => {
    const result = await connect(f);
    expect(result).toMatchObject({ ok: false, field });
    expect(pds.requests).toHaveLength(0);
  });

  const failureRows: [string, Parameters<FakePds["route"]>[2], RegExp, string | undefined][] = [
    ["401", { status: 401, json: { error: "AuthenticationRequired", message: "bad" } }, /did not accept/, "appPassword"],
    ["400", { status: 400, json: { error: "InvalidRequest", message: "bad" } }, /handle, the app password and the server address/, undefined],
    ["404 from a non-PDS host", { status: 404, json: { error: "XRPCNotSupported" } }, /did not answer as a Bluesky server/, "pdsUrl"],
    ["2fa", { status: 401, json: { error: "AuthFactorTokenRequired", message: "code" } }, /sign-in code/, "appPassword"],
    ["takedown", { status: 400, json: { error: "AccountTakedown", message: "x" } }, /suspended/, undefined],
    ["5xx", { status: 503, json: { error: "Unavailable" } }, /Could not reach a Bluesky server at https:\/\/bsky\.social/, "pdsUrl"],
    ["junk 200", { json: { nope: true } }, /Could not reach/, "pdsUrl"],
    ["no route / network", { mode: "pre-send-failure" }, /Could not reach/, "pdsUrl"],
  ];
  it.each(failureRows)("maps %s", async (_n, script, message, field) => {
    pds.route("POST", CREATE, script);
    const result = await connect();
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(message) });
    expect((result as { field?: string }).field).toBe(field);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it("429 carries retryAt from Retry-After", async () => {
    pds.route("POST", CREATE, { status: 429, headers: { "retry-after": "120" }, json: { error: "RateLimitExceeded" } });
    expect(await connect()).toMatchObject({ ok: false, message: expect.stringMatching(/Too many/), retryAt: new Date(now.getTime() + 120_000) });
  });

  it("aborts on the signal", async () => {
    pds.route("POST", CREATE, { mode: "hang" });
    const ac = new AbortController();
    const pending = connectAccount({ fields: fields(), now, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    expect(await pending).toMatchObject({ ok: false, field: "pdsUrl" });
  });
});

describe("jwtExp / needsRefresh", () => {
  it("reads exp and tolerates junk", () => {
    expect(jwtExp(mintJwt(1_800_000_000))).toEqual(new Date(1_800_000_000_000));
    for (const junk of ["", "a", "a.b.c", "a.!!.c"]) expect(jwtExp(junk)).toBeNull();
  });
  const creds = (exp: Date | string) => ({ accessJwt: typeof exp === "string" ? exp : mintJwt(exp), refreshJwt: "r", did: "did:plc:a", handle: "a.b" });
  it("is true only when under five minutes remain", () => {
    expect(needsRefresh(creds(new Date(now.getTime() + 4 * 60_000)), now)).toBe(true);
    expect(needsRefresh(creds(new Date(now.getTime() - 1000)), now)).toBe(true);
    expect(needsRefresh(creds(new Date(now.getTime() + 6 * 60_000)), now)).toBe(false);
    expect(needsRefresh(creds("opaque"), now)).toBe(false);
    expect(needsRefresh({ nope: 1 }, now)).toBe(false);
  });
});

describe("refreshCredentials", () => {
  const REFRESH = "/xrpc/com.atproto.server.refreshSession";
  const stored = { accessJwt: "old-access", refreshJwt: "old-refresh", did: "did:plc:alice", handle: "alice.bsky.social" };
  const refresh = (credentials: unknown = stored) =>
    refreshCredentials({
      account: { id: "a1", externalId: "did:plc:alice", settings: { pdsUrl: "https://bsky.social" } },
      credentials,
      now,
      signal: new AbortController().signal,
    });

  it("rotates both tokens, authorises with the refresh JWT and follows a handle change", async () => {
    const next = session({ handle: "alice.example.com" });
    pds.route("POST", REFRESH, { json: next });
    expect(await refresh()).toEqual({
      ok: true,
      credentials: { accessJwt: next.accessJwt, refreshJwt: next.refreshJwt, did: "did:plc:alice", handle: "alice.example.com" },
      expiresAt: new Date("2026-03-01T00:00:00Z"),
      displayName: "alice.example.com",
    });
    expect(pds.callsTo("POST", REFRESH)).toHaveLength(1);
    expect(pds.callsTo("POST", REFRESH)[0]!.headers.authorization).toBe("Bearer old-refresh");
  });

  it("falls back to now + 60 d when the new refresh JWT has no exp", async () => {
    pds.route("POST", REFRESH, { json: session({ refreshJwt: "opaque" }) });
    const result = await refresh();
    expect(result).toMatchObject({ ok: true, expiresAt: new Date(now.getTime() + 60 * 86_400_000) });
  });

  it("treats a different DID as a definitive failure", async () => {
    pds.route("POST", REFRESH, { json: session({ did: "did:plc:mallory" }) });
    const result = await refresh();
    expect(result).toEqual({ ok: false, reason: "The server returned a different account." });
  });

  it("treats unreadable stored credentials as definitive", async () => {
    expect(await refresh({ nope: 1 })).toEqual({ ok: false, reason: "Stored credentials are unreadable." });
    expect(pds.requests).toHaveLength(0);
  });

  it.each([
    [401, "AuthenticationRequired"],
    [400, "ExpiredToken"],
    [400, "InvalidToken"],
    [400, "AccountTakedown"],
  ])("refuses definitively on %i %s", async (status, error) => {
    pds.route("POST", REFRESH, { status, json: { error } });
    const result = await refresh();
    expect(result).toMatchObject({ ok: false });
    expect(result).not.toHaveProperty("transient");
    expect((result as { reason: string }).reason).toContain(error);
    expect((result as { reason: string }).reason).toContain("Reconnect the account");
  });

  it("is transient on a 5xx, a dropped connection and a 429 (with retryAt)", async () => {
    pds.route("POST", REFRESH, { status: 503, json: { error: "Unavailable" } });
    expect(await refresh()).toMatchObject({ ok: false, transient: true, reason: expect.stringContaining("503") });

    pds.route("POST", REFRESH, { mode: "pre-send-failure", code: "ECONNREFUSED" });
    expect(await refresh()).toMatchObject({ ok: false, transient: true, reason: "Could not renew the Bluesky session (no response)." });

    pds.route("POST", REFRESH, { status: 429, headers: { "retry-after": "90" }, json: { error: "RateLimitExceeded" } });
    expect(await refresh()).toMatchObject({ ok: false, transient: true, retryAt: new Date(now.getTime() + 90_000) });
  });
});
