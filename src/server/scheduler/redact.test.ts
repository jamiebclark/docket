import { describe, expect, it } from "vitest";
import { redact, secretValues } from "./redact";

describe("redact", () => {
  it("drops sensitive keys at any depth", () => {
    expect(redact({ ok: 1, accessToken: "x", nested: { Authorization: "Bearer y", keep: "z" }, list: [{ password: "p", a: 1 }] })).toEqual({
      ok: 1,
      nested: { keep: "z" },
      list: [{ a: 1 }],
    });
  });
  it("replaces strings containing a known secret", () => {
    expect(redact({ error: "401 for sk-abc123 on /me", fine: "hello" }, ["sk-abc123"])).toEqual({
      error: "[redacted]",
      fine: "hello",
    });
  });
  it("redacts a bare string and leaves other primitives", () => {
    expect(redact("boom sk-abc123", ["sk-abc123"])).toBe("[redacted]");
    expect(redact(5)).toBe(5);
    expect(redact(null)).toBeNull();
  });
  it("collects secret values from nested credentials", () => {
    expect(secretValues({ token: "abcd1234", n: { k: "wxyz9876" }, short: "a", num: 3 }).sort()).toEqual(["abcd1234", "wxyz9876"]);
  });
});
