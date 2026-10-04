import { describe, expect, it } from "vitest";
import { signatureHeader, verifySignature } from "./sign";

const body = '{"id":"e1","type":"ping"}';
const ts = 1_800_000_000;
const check = (header: string, secret: string, rawBody = body, now = ts) =>
  verifySignature({ header, secret, timestamp: String(ts), rawBody, now });

describe("webhook signatures", () => {
  it("verifies a good signature", () => {
    expect(check(signatureHeader(["s3cret"], ts, body), "s3cret")).toBe(true);
  });
  it("rejects the wrong secret", () => {
    expect(check(signatureHeader(["s3cret"], ts, body), "other")).toBe(false);
  });
  it("rejects a changed byte", () => {
    expect(check(signatureHeader(["s3cret"], ts, body), "s3cret", body.replace("e1", "e2"))).toBe(false);
  });
  it("rejects a stale timestamp (301 s) and accepts 300 s", () => {
    const h = signatureHeader(["s3cret"], ts, body);
    expect(check(h, "s3cret", body, ts + 301)).toBe(false);
    expect(check(h, "s3cret", body, ts + 300)).toBe(true);
  });
  it("accepts either value of a two-signature header", () => {
    const h = signatureHeader(["new", "old"], ts, body);
    expect(h.split(",")).toHaveLength(2);
    expect(check(h, "new")).toBe(true);
    expect(check(h, "old")).toBe(true);
    expect(check(h, "third")).toBe(false);
  });
  it("ignores unknown schemes and malformed values", () => {
    expect(check("v2=abc,v1=zz,v1", "s3cret")).toBe(false);
  });
});
