import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGraph } from "../../../tests/helpers/fake-graph";
import { refreshThreads } from "./refresh";

const fake = createFakeGraph();
const DAY = 24 * 3600 * 1000;
const NOW = new Date("2026-06-01T12:00:00Z");
const TOKEN = "OLD-THREADS-TOKEN-SECRET";

const creds = (over: Partial<{ issuedAt: number; expiresAt: number }> = {}) => ({
  v: 1,
  accessToken: TOKEN,
  issuedAt: NOW.getTime() - 50 * DAY,
  expiresAt: NOW.getTime() + 10 * DAY,
  expiryEstimated: false,
  ...over,
});
const run = (credentials: unknown) =>
  refreshThreads({ credentials, now: NOW, signal: new AbortController().signal });

beforeEach(() => {
  vi.stubEnv("THREADS_GRAPH_BASE", "https://graph.threads.test");
  fake.reset();
  fake.install();
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});

describe("refreshThreads (D7 table)", () => {
  it("unreadable credentials: definitive, no request", async () => {
    const r = await run({ pageToken: "x" });
    expect(r).toEqual({ ok: false, reason: "The stored Threads token is unreadable. Reconnect the account." });
    expect(fake.requests).toHaveLength(0);
  });

  it("expired: definitive, no request", async () => {
    const r = await run(creds({ expiresAt: NOW.getTime() }));
    expect(r).toEqual({ ok: false, reason: "The Threads token expired. Reconnect the account." });
    expect(fake.requests).toHaveLength(0);
  });

  it("under 24 h old: transient with retryAt issuedAt + 24 h, no request", async () => {
    const issuedAt = NOW.getTime() - 2 * 3600 * 1000;
    const r = await run(creds({ issuedAt }));
    expect(r).toMatchObject({ ok: false, transient: true, retryAt: new Date(issuedAt + DAY) });
    expect(fake.requests).toHaveLength(0);
  });

  it("success: new credentials with issuedAt now and expiry from expires_in", async () => {
    fake.on("GET", "/refresh_access_token", { kind: "ok", body: { access_token: "NEW", expires_in: 1000 } });
    const r = await run(creds());
    expect(r).toEqual({
      ok: true,
      credentials: { v: 1, accessToken: "NEW", issuedAt: NOW.getTime(), expiresAt: NOW.getTime() + 1_000_000, expiryEstimated: false },
      expiresAt: new Date(NOW.getTime() + 1_000_000),
    });
  });

  it("success without expires_in: 60 days", async () => {
    fake.on("GET", "/refresh_access_token", { kind: "ok", body: { access_token: "NEW" } });
    const r = await run(creds());
    expect(r).toMatchObject({ ok: true, expiresAt: new Date(NOW.getTime() + 60 * DAY) });
  });

  it("success with no token or an unparseable body: transient", async () => {
    fake.on("GET", "/refresh_access_token", [{ kind: "ok", body: {} }, { kind: "unparseable" }]);
    for (let i = 0; i < 2; i++) expect(await run(creds())).toMatchObject({ ok: false, transient: true });
  });

  it.each([
    ["network", { kind: "pre_send_failure" }],
    ["5xx", { kind: "http", status: 503 }],
    ["temporary code", { kind: "graph_error", code: 2, message: "Service temporarily unavailable" }],
    ["rate limit", { kind: "graph_error", code: 4, message: "Too many calls" }],
  ] as const)("%s: transient", async (_n, reply) => {
    fake.on("GET", "/refresh_access_token", reply);
    expect(await run(creds())).toMatchObject({ ok: false, transient: true });
  });

  it.each([
    ["190", { kind: "graph_error", code: 190, message: `Invalid token ${TOKEN}`, status: 400 }],
    ["other graph error", { kind: "graph_error", code: 100, message: "Bad request", status: 400 }],
    ["other 4xx", { kind: "http", status: 403 }],
  ] as const)("%s: definitive, scrubbed, asks to reconnect", async (_n, reply) => {
    fake.on("GET", "/refresh_access_token", reply);
    const r = await run(creds());
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.transient).toBeFalsy();
    expect(r.reason).toMatch(/Reconnect the account\.$/);
  });

  it("never puts a token in a reason", async () => {
    fake.on("GET", "/refresh_access_token", { kind: "graph_error", code: 190, message: `bad ${TOKEN}`, status: 400 });
    const r = await run(creds());
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});
