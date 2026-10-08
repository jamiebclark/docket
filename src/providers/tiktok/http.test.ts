import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeTikTok } from "../../../tests/helpers/fake-tiktok";
import { readEnvelope, scrubTikTok, tiktokRequest } from "./http";

const fake = createFakeTikTok();
beforeEach(() => {
  fake.reset();
  fake.install();
});
afterEach(() => fake.uninstall());
const sig = () => new AbortController().signal;
const PATH = "/v2/post/publish/creator_info/query/";

describe("tiktokRequest", () => {
  it("sends JSON with a bearer token and parses the reply", async () => {
    fake.on("POST", PATH, { kind: "ok", body: { data: { a: 1 } } });
    const r = await tiktokRequest({ method: "POST", path: PATH, token: "TOKEN-ABC", json: {}, signal: sig() });
    expect(r).toMatchObject({ kind: "ok", status: 200, body: { data: { a: 1 } } });
    expect(fake.requests[0]).toMatchObject({ host: "open.tiktokapis.com", auth: "bearer" });
  });

  it("sends a form body with no bearer token", async () => {
    fake.on("POST", "/v2/oauth/token/", { kind: "ok", body: {} });
    await tiktokRequest({ method: "POST", path: "/v2/oauth/token/", form: { grant_type: "refresh_token" }, signal: sig() });
    expect(fake.requests[0]).toMatchObject({ auth: "none", contentType: "application/x-www-form-urlencoded", fields: { grant_type: "refresh_token" } });
  });

  it("classifies empty, unparseable and error replies, and reads Retry-After", async () => {
    fake.on("POST", PATH, [
      { kind: "http", status: 200 },
      { kind: "unparseable" },
      { kind: "http", status: 429, body: "{}", headers: { "retry-after": "90" } },
      { kind: "http", status: 500, body: "<html>" },
    ]);
    const call = () => tiktokRequest({ method: "POST", path: PATH, signal: sig() });
    expect(await call()).toMatchObject({ kind: "ok", body: null });
    expect(await call()).toMatchObject({ kind: "unparseable" });
    expect(await call()).toMatchObject({ kind: "http_error", status: 429, retryAfterMs: 90_000 });
    expect(await call()).toMatchObject({ kind: "http_error", status: 500, body: null });
  });

  it("separates not-sent from lost", async () => {
    fake.on("POST", PATH, [{ kind: "pre_send_failure" }, { kind: "reset_mid_body" }]);
    expect(await tiktokRequest({ method: "POST", path: PATH, signal: sig() })).toEqual({ kind: "network", phase: "not_sent" });
    expect(await tiktokRequest({ method: "POST", path: PATH, signal: sig() })).toEqual({ kind: "network", phase: "lost" });
  });
});

describe("readEnvelope (research P12)", () => {
  it("reads an error code from body.error.code and the data from body.data", () => {
    expect(readEnvelope({ data: { x: 1 }, error: { code: "ok", message: "" } })).toEqual({ code: null, message: null, data: { x: 1 } });
    expect(readEnvelope({ data: {}, error: { code: "spam_risk_too_many_posts", message: "too many" } })).toMatchObject({
      code: "spam_risk_too_many_posts",
      message: "too many",
    });
  });
  it("reads a string error (the OAuth shape) and falls back to the body for data", () => {
    expect(readEnvelope({ error: "invalid_grant", error_description: "bad" })).toMatchObject({ code: "invalid_grant", message: "bad" });
    expect(readEnvelope({ access_token: "a" }).data).toEqual({ access_token: "a" });
  });
  it("is empty for a non-object", () => {
    expect(readEnvelope(null)).toEqual({ code: null, message: null, data: null });
    expect(readEnvelope([1])).toEqual({ code: null, message: null, data: null });
  });
});

describe("scrubTikTok", () => {
  it("redacts known secrets and truncates", () => {
    expect(scrubTikTok("bad SECRET-VALUE here", ["SECRET-VALUE"])).toBe("bad [redacted] here");
    expect(scrubTikTok("x".repeat(400), [])).toHaveLength(300);
  });
});
