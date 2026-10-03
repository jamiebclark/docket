import { describe, expect, it } from "vitest";
import { applyStepResult } from "./record";

const now = new Date("2026-10-05T09:00:00Z");
const config = { maxAttempts: 3, backoffBaseMs: 60_000, backoffMaxMs: 3_600_000 };
const fresh = { attemptCount: 0, stepState: null };

describe("applyStepResult", () => {
  it("done → published with ids and cleared lease", () => {
    const r = applyStepResult({ result: { kind: "done", externalId: "x1", url: "https://e/x1" }, target: fresh, now, config });
    expect(r.outcome).toBe("done");
    expect(r.patch).toMatchObject({ status: "published", externalId: "x1", externalUrl: "https://e/x1", publishedAt: now, leaseOwner: null, nextAttemptAt: null });
  });
  it("continue → publishing with state, reset attempts, honouring notBefore", () => {
    const later = new Date(now.getTime() + 600_000);
    const r = applyStepResult({ result: { kind: "continue", state: { done: 1 }, notBefore: later }, target: { attemptCount: 2, stepState: null }, now, config });
    expect(r.patch).toMatchObject({ status: "publishing", stepState: { done: 1 }, attemptCount: 0, nextAttemptAt: later, leaseUntil: null });
  });
  it("continue without notBefore is due now", () => {
    const r = applyStepResult({ result: { kind: "continue", state: {} }, target: fresh, now, config });
    expect(r.patch.nextAttemptAt).toEqual(now);
  });
  it("retryable before any step → scheduled with backoff", () => {
    const r = applyStepResult({ result: { kind: "retryable_error", error: "boom" }, target: fresh, now, config });
    expect(r.patch).toMatchObject({ status: "scheduled", attemptCount: 1, lastError: "boom" });
    expect(r.patch.nextAttemptAt).toEqual(new Date(now.getTime() + 60_000));
  });
  it("retryable after a step stays publishing and doubles", () => {
    const r = applyStepResult({ result: { kind: "retryable_error", error: "boom" }, target: { attemptCount: 1, stepState: { done: 1 } }, now, config });
    expect(r.patch).toMatchObject({ status: "publishing", attemptCount: 2 });
    expect(r.patch.nextAttemptAt).toEqual(new Date(now.getTime() + 120_000));
  });
  it("retryable at the cap fails", () => {
    const r = applyStepResult({ result: { kind: "retryable_error", error: "boom" }, target: { attemptCount: 2, stepState: null }, now, config });
    expect(r.patch).toMatchObject({ status: "failed", attemptCount: 3, nextAttemptAt: null });
  });
  it("fatal → failed, ambiguous → ambiguous", () => {
    expect(applyStepResult({ result: { kind: "fatal_error", error: "no" }, target: fresh, now, config }).patch.status).toBe("failed");
    expect(applyStepResult({ result: { kind: "ambiguous", error: "?" }, target: fresh, now, config }).patch.status).toBe("ambiguous");
  });
  it("redacts known secrets from the stored error", () => {
    const r = applyStepResult({ result: { kind: "fatal_error", error: "bad token sk-secret1" }, target: fresh, now, config, secrets: ["sk-secret1"] });
    expect(r.error).toBe("[redacted]");
    expect(r.patch.lastError).toBe("[redacted]");
  });
});
