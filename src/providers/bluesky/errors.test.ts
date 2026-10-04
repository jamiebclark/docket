import { XRPCError } from "@atproto/api";
import { describe, expect, it } from "vitest";
import { classify, isPreSend, rateLimitNotBefore, safeReason } from "./errors";

const now = new Date("2026-01-01T00:00:00Z");

describe("rateLimitNotBefore", () => {
  it("reads delta-seconds and HTTP-dates", () => {
    expect(rateLimitNotBefore({ "retry-after": "30" }, now)).toEqual(new Date(now.getTime() + 30_000));
    expect(rateLimitNotBefore(new Headers({ "Retry-After": "Thu, 01 Jan 2026 00:10:00 GMT" }), now)).toEqual(
      new Date("2026-01-01T00:10:00Z"),
    );
  });
  it("ignores junk, past values and missing headers", () => {
    expect(rateLimitNotBefore({ "retry-after": "soon" }, now)).toBeNull();
    expect(rateLimitNotBefore({ "retry-after": "Wed, 31 Dec 2025 00:00:00 GMT" }, now)).toBeNull();
    expect(rateLimitNotBefore({ "retry-after": "0" }, now)).toBeNull();
    expect(rateLimitNotBefore(undefined, now)).toBeNull();
  });
  it("caps at 24 h", () => {
    expect(rateLimitNotBefore({ "retry-after": "999999999" }, now)).toEqual(new Date(now.getTime() + 86_400_000));
  });
});

describe("isPreSend", () => {
  it("walks the cause chain", () => {
    const err = new TypeError("fetch failed", { cause: new Error("x", { cause: { code: "ENOTFOUND" } }) });
    expect(isPreSend(err)).toBe(true);
    expect(isPreSend(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }))).toBe(false);
    expect(isPreSend("boom")).toBe(false);
  });
  it("is bounded", () => {
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(isPreSend(loop)).toBe(false);
  });
});

describe("classify", () => {
  const xrpc = (status: number, error?: string, message?: string, headers?: Record<string, string>) =>
    new XRPCError(status, error, message, headers);
  it("maps credential rejection by kind", () => {
    expect(classify(xrpc(401), "publish")).toMatchObject({ kind: "retryable_error", credentialsExpired: true });
    expect(classify(xrpc(400, "ExpiredToken"), "upload")).toMatchObject({ credentialsExpired: true });
    expect(classify(xrpc(401), "read")).toMatchObject({ kind: "fatal_error" });
  });
  it("429 carries notBefore", () => {
    expect(classify(xrpc(429, undefined, undefined, { "retry-after": "60" }), "publish", now)).toMatchObject({
      kind: "retryable_error",
      notBefore: new Date(now.getTime() + 60_000),
    });
  });
  it("is ambiguous only when publishing", () => {
    expect(classify(xrpc(503), "publish").kind).toBe("ambiguous");
    expect(classify(xrpc(503), "upload").kind).toBe("retryable_error");
    expect(classify(xrpc(1), "publish").kind).toBe("ambiguous");
    expect(classify(xrpc(1), "read").kind).toBe("retryable_error");
    expect(classify(new Error("weird"), "publish").kind).toBe("ambiguous");
  });
  it("pre-send is retryable even when publishing", () => {
    const err = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    expect(classify(err, "publish").kind).toBe("retryable_error");
  });
  it("other 4xx are fatal with bounded text", () => {
    expect(classify(xrpc(400, "InvalidRequest", "x".repeat(500)), "publish")).toMatchObject({ kind: "fatal_error" });
    const r = classify(xrpc(400, "InvalidRequest", "x".repeat(500)), "publish");
    expect(r.kind === "fatal_error" && r.error.length).toBeLessThan(400);
    expect(classify(xrpc(413, "PayloadTooLarge"), "upload", now, 2)).toEqual({
      kind: "fatal_error",
      error: "Bluesky refused image 2 (PayloadTooLarge).",
    });
  });
  it("safeReason names only status and error", () => {
    expect(safeReason(xrpc(400, "InvalidToken", "secret"))).toBe("InvalidToken, HTTP 400");
    expect(safeReason(xrpc(1))).toBe("NoResponse");
  });
});
