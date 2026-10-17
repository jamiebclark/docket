import { describe, expect, it } from "vitest";
import { createEmailAttemptLimiter, createGlobalAttemptLimiter } from "./sign-in-limit";

describe("createEmailAttemptLimiter", () => {
  it("allows exactly `max` attempts in a window, then refuses", () => {
    const limiter = createEmailAttemptLimiter({ max: 3, windowMs: 10_000 });
    const at = 1_000_000;
    expect([1, 2, 3].map(() => limiter.attempt("a@example.test", at))).toEqual([true, true, true]);
    expect(limiter.attempt("a@example.test", at)).toBe(false);
  });

  it("counts each address separately, so one person cannot lock out another", () => {
    const limiter = createEmailAttemptLimiter({ max: 1, windowMs: 10_000 });
    const at = 1_000_000;
    expect(limiter.attempt("a@example.test", at)).toBe(true);
    expect(limiter.attempt("a@example.test", at)).toBe(false);
    expect(limiter.attempt("b@example.test", at)).toBe(true);
  });

  it("normalises the key, so casing and padding cannot multiply the allowance", () => {
    const limiter = createEmailAttemptLimiter({ max: 1, windowMs: 10_000 });
    const at = 1_000_000;
    expect(limiter.attempt("a@example.test", at)).toBe(true);
    expect(limiter.attempt("  A@Example.TEST  ", at)).toBe(false);
  });

  it("starts a fresh window once the old one has passed", () => {
    const limiter = createEmailAttemptLimiter({ max: 1, windowMs: 10_000 });
    const at = 1_000_000;
    expect(limiter.attempt("a@example.test", at)).toBe(true);
    expect(limiter.attempt("a@example.test", at + 9_999)).toBe(false);
    expect(limiter.attempt("a@example.test", at + 10_000)).toBe(true);
  });
});

describe("createGlobalAttemptLimiter", () => {
  it("allows exactly `max` attempts in a window whatever the caller", () => {
    const limiter = createGlobalAttemptLimiter({ max: 2, windowMs: 60_000 });
    const at = 1_000_000;
    expect([limiter.attempt(at), limiter.attempt(at), limiter.attempt(at)]).toEqual([true, true, false]);
  });

  it("is not per-key: walking many addresses still hits the ceiling", () => {
    // The whole point — the per-email limiter cannot see a list of distinct addresses, this can.
    const limiter = createGlobalAttemptLimiter({ max: 5, windowMs: 60_000 });
    const at = 1_000_000;
    const results = Array.from({ length: 7 }, () => limiter.attempt(at));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(results.slice(5)).toEqual([false, false]);
  });

  it("starts a fresh window once the old one has passed", () => {
    const limiter = createGlobalAttemptLimiter({ max: 1, windowMs: 60_000 });
    const at = 1_000_000;
    expect(limiter.attempt(at)).toBe(true);
    expect(limiter.attempt(at + 59_999)).toBe(false);
    expect(limiter.attempt(at + 60_000)).toBe(true);
  });
});
