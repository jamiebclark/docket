import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pkceChallenge, pkceVerifier } from "./pkce";

describe("pkceVerifier", () => {
  it("is 43 characters of the unreserved base64url alphabet", () => {
    expect(pkceVerifier("state-1", "secret")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("is deterministic", () => {
    expect(pkceVerifier("state-1", "secret")).toBe(pkceVerifier("state-1", "secret"));
  });
  it("differs per state and per secret", () => {
    const base = pkceVerifier("state-1", "secret");
    expect(pkceVerifier("state-2", "secret")).not.toBe(base);
    expect(pkceVerifier("state-1", "other")).not.toBe(base);
  });
});

describe("pkceChallenge", () => {
  it("is base64url(SHA-256(verifier))", () => {
    const verifier = pkceVerifier("state-1", "secret");
    expect(pkceChallenge(verifier)).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(pkceChallenge(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
