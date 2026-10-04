import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeGraph } from "../../../tests/helpers/fake-graph";
import { graphList, graphRequest, type MetaApp } from "./graph";

const app: MetaApp = { graphBase: "https://graph.facebook.com", version: "v26.0" };
const fake = createFakeGraph();
const signal = () => new AbortController().signal;

beforeEach(() => {
  fake.reset();
  fake.install();
});
afterEach(() => fake.uninstall());

describe("graphRequest", () => {
  it("returns parsed ok bodies", async () => {
    fake.on("GET", "/v26.0/me", { kind: "ok", body: { id: "1" } });
    const r = await graphRequest(app, { method: "GET", path: "/me", token: "T0K", signal: signal() });
    expect(r).toEqual({ kind: "ok", status: 200, body: { id: "1" } });
    expect(fake.requests[0]?.hadToken).toBe(true);
  });

  it("sends POST params and the token in the body, never the URL", async () => {
    const urls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = ((u: RequestInfo | URL, i?: RequestInit) => {
      urls.push(String(u));
      return real(u, i);
    }) as typeof fetch;
    fake.on("POST", "/v26.0/123/feed", { kind: "ok", body: { id: "1_2" } });
    await graphRequest(app, { method: "POST", path: "/123/feed", params: { message: "hi" }, token: "SECRET", signal: signal() });
    expect(urls[0]).toBe("https://graph.facebook.com/v26.0/123/feed");
    expect(urls[0]).not.toContain("SECRET");
    expect(fake.requests[0]?.params).toMatchObject({ message: "hi", access_token: "[redacted]" });
  });

  it("builds URLs with the version, without it for a null version, and without it for one unversioned request", async () => {
    const urls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: RequestInfo | URL) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      await graphRequest(app, { method: "GET", path: "/me", signal: signal() });
      await graphRequest({ graphBase: "https://graph.threads.net", version: null }, { method: "GET", path: "/me", signal: signal() });
      await graphRequest(app, { method: "GET", path: "/refresh_access_token", unversioned: true, signal: signal() });
      await graphRequest({ graphBase: "https://graph.threads.net", version: "v1.0" }, { method: "POST", path: "/oauth/access_token", unversioned: true, signal: signal() });
    } finally {
      globalThis.fetch = real;
    }
    expect(urls).toEqual([
      "https://graph.facebook.com/v26.0/me?",
      "https://graph.threads.net/me?",
      "https://graph.facebook.com/refresh_access_token?",
      "https://graph.threads.net/oauth/access_token",
    ]);
  });

  it("rejects malformed ids in the path", () => {
    expect(() => graphRequest(app, { method: "GET", path: "/12/../x?y=1", signal: signal() })).toThrow();
    expect(() => graphRequest(app, { method: "GET", path: "/abc def", signal: signal() })).toThrow();
  });

  it("classifies graph errors, http errors and unparseable bodies", async () => {
    fake.on("GET", "/v26.0/a", { kind: "graph_error", code: 190, subcode: 463, status: 401 });
    fake.on("GET", "/v26.0/b", { kind: "http", status: 502 });
    fake.on("GET", "/v26.0/c", { kind: "unparseable" });
    const a = await graphRequest(app, { method: "GET", path: "/a", signal: signal() });
    expect(a).toMatchObject({ kind: "graph_error", status: 401, error: { code: 190, subcode: 463 } });
    expect(await graphRequest(app, { method: "GET", path: "/b", signal: signal() })).toEqual({ kind: "http_error", status: 502 });
    expect(await graphRequest(app, { method: "GET", path: "/c", signal: signal() })).toEqual({ kind: "unparseable", status: 200 });
  });

  it("reports a timeout and a mid-body reset as after_send, a refused connection as before_send", async () => {
    fake.on("GET", "/v26.0/hang", { kind: "hang" });
    const ac = new AbortController();
    const pending = graphRequest(app, { method: "GET", path: "/hang", signal: ac.signal });
    ac.abort();
    expect(await pending).toEqual({ kind: "network", phase: "after_send" });
    fake.on("GET", "/v26.0/reset", { kind: "reset_mid_body" });
    expect(await graphRequest(app, { method: "GET", path: "/reset", signal: signal() })).toEqual({ kind: "network", phase: "after_send" });
    fake.on("GET", "/v26.0/pre", { kind: "pre_send_failure" });
    expect(await graphRequest(app, { method: "GET", path: "/pre", signal: signal() })).toEqual({ kind: "network", phase: "before_send" });
  });
});

describe("graphList", () => {
  it("follows paging.next on the Graph origin and stops at the page cap", async () => {
    fake.on("GET", "/v26.0/me/accounts", [
      { kind: "ok", body: { data: [{ id: "1" }], paging: { next: "https://graph.facebook.com/v26.0/me/accounts?after=a" } } },
    ]);
    const r = await graphList(app, { method: "GET", path: "/me/accounts", signal: signal() }, 3);
    expect(r).toMatchObject({ kind: "ok", truncated: true });
    expect(r.kind === "ok" && r.items).toHaveLength(3);
  });

  it("does not follow a foreign origin", async () => {
    fake.on("GET", "/v26.0/me/accounts", { kind: "ok", body: { data: [{ id: "1" }], paging: { next: "https://evil.example/x" } } });
    const r = await graphList(app, { method: "GET", path: "/me/accounts", signal: signal() }, 4);
    expect(r).toMatchObject({ kind: "ok", truncated: true });
    expect(fake.requests).toHaveLength(1);
  });

  it("finishes without truncation and surfaces errors", async () => {
    fake.on("GET", "/v26.0/me/accounts", { kind: "ok", body: { data: [] } });
    expect(await graphList(app, { method: "GET", path: "/me/accounts", signal: signal() }, 4)).toEqual({ kind: "ok", items: [], truncated: false });
    fake.on("GET", "/v26.0/me/accounts", { kind: "ok", body: { nope: 1 } });
    expect((await graphList(app, { method: "GET", path: "/me/accounts", signal: signal() }, 4)).kind).toBe("unparseable");
  });
});
