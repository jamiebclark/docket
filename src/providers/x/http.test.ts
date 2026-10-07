import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeX, rateLimited } from "../../../tests/helpers/fake-x";
import { problemText, readRate, scrubX, xRequest } from "./http";

const fake = createFakeX();
beforeEach(() => {
  fake.reset();
  fake.install();
});
afterEach(() => fake.uninstall());
const sig = () => new AbortController().signal;
const base = { method: "POST" as const, path: "/2/tweets", auth: { kind: "bearer" as const, token: "TOKEN-ABC" } };

describe("xRequest", () => {
  it("sends JSON with a bearer token and parses the reply", async () => {
    fake.on("POST", "/2/tweets", { kind: "ok", status: 201, body: { data: { id: "1" } } });
    const r = await xRequest({ ...base, json: { text: "hi" }, signal: sig() });
    expect(r).toMatchObject({ kind: "ok", status: 201, body: { data: { id: "1" } } });
    expect(fake.requests[0]).toMatchObject({ host: "api.x.com", auth: "bearer", fields: { text: "hi" } });
  });

  it("sends a form body with Basic auth", async () => {
    fake.on("POST", "/2/oauth2/token", { kind: "ok", body: {} });
    await xRequest({ method: "POST", path: "/2/oauth2/token", auth: { kind: "basic", id: "CID", secret: "SECRET" }, form: { grant_type: "refresh_token" }, signal: sig() });
    expect(fake.requests[0]).toMatchObject({ auth: "basic", basicUser: "CID", fields: { grant_type: "refresh_token" } });
  });

  it("sends multipart and a query", async () => {
    fake.on("POST", "/2/media/upload/9/append", { kind: "http", status: 204 });
    const fd = new FormData();
    fd.set("media", new Blob([new Uint8Array(5)], { type: "image/png" }));
    fd.set("segment_index", "0");
    const r = await xRequest({ ...base, path: "/2/media/upload/9/append", query: { a: "b" }, multipart: fd, signal: sig() });
    expect(r.kind).toBe("ok");
    expect(fake.requests[0]).toMatchObject({ query: { a: "b" }, multipart: { fields: ["media", "segment_index"], mediaBytes: 5 } });
  });

  it("classifies an empty 2xx as ok with a null body and a non-JSON 2xx as unparseable", async () => {
    fake.on("POST", "/2/tweets", [{ kind: "http", status: 200 }, { kind: "unparseable" }]);
    expect(await xRequest({ ...base, signal: sig() })).toMatchObject({ kind: "ok", body: null });
    expect(await xRequest({ ...base, signal: sig() })).toMatchObject({ kind: "unparseable" });
  });

  it("classifies errors with and without a JSON body, and reads rate headers", async () => {
    fake.on("POST", "/2/tweets", [
      { kind: "problem", status: 429, detail: "slow", headers: rateLimited({ remaining: 0, reset: 1760000000 }) },
      { kind: "http", status: 500, body: "<html>" },
    ]);
    expect(await xRequest({ ...base, signal: sig() })).toMatchObject({
      kind: "http_error",
      status: 429,
      body: { detail: "slow" },
      rate: { limit: 100, remaining: 0, resetAtMs: 1760000000000 },
    });
    expect(await xRequest({ ...base, signal: sig() })).toMatchObject({ kind: "http_error", status: 500, body: null });
  });

  it("separates not-sent from lost", async () => {
    fake.on("POST", "/2/tweets", [{ kind: "pre_send_failure" }, { kind: "reset_mid_body" }]);
    expect(await xRequest({ ...base, signal: sig() })).toEqual({ kind: "network", phase: "not_sent" });
    expect(await xRequest({ ...base, signal: sig() })).toEqual({ kind: "network", phase: "lost" });
  });

  it("a hung request ends as lost when the signal aborts", async () => {
    fake.on("POST", "/2/tweets", { kind: "hang" });
    const c = new AbortController();
    const p = xRequest({ ...base, signal: c.signal });
    c.abort();
    expect(await p).toEqual({ kind: "network", phase: "lost" });
  });
});

describe("readRate", () => {
  it.each([
    [{}, { limit: null, remaining: null, resetAtMs: null }],
    [{ "x-rate-limit-reset": "abc", "x-rate-limit-remaining": "-1" }, { limit: null, remaining: null, resetAtMs: null }],
    [{ "x-rate-limit-reset": "0" }, { limit: null, remaining: null, resetAtMs: null }],
    [{ "x-rate-limit-reset": "100", "x-rate-limit-remaining": "5" }, { limit: null, remaining: 5, resetAtMs: 100000 }],
  ])("%j", (h, expected) => expect(readRate(new Headers(h))).toEqual(expected));
});

describe("scrubbing", () => {
  it("removes credentials and truncates to 300", () => {
    const out = scrubX(`bad TOKEN-ABC ${"x".repeat(400)}`, ["TOKEN-ABC"]);
    expect(out).not.toContain("TOKEN-ABC");
    expect(out.length).toBe(300);
  });
  it("problemText prefers detail, then title, and scrubs", () => {
    expect(problemText({ title: "T", detail: "has SECRET-1" }, ["SECRET-1"])).toBe("has [redacted]");
    expect(problemText({ title: "T" }, [])).toBe("T");
    expect(problemText(null, [])).toBeNull();
    expect(problemText({ detail: 5 }, [])).toBeNull();
  });
});
