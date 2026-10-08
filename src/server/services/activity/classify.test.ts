import { describe, expect, it } from "vitest";
import type { AttemptOutcome } from "../../dal/attempts";
import { activityDetailsSchema } from "../../../lib/activity/details";
import { KIND_OUTCOME } from "../../../lib/activity/outcomes";
import { connectFailedEvent, eventForDecision, eventForStep, needsReauthEvent, resolvedEvent } from "./classify";

const now = new Date("2030-05-01T12:00:00.000Z");
const target = { id: "t1", postId: "p1", socialAccountId: "a1" };
const account = { id: "a1", providerKey: "bluesky" };
const step = (outcome: AttemptOutcome, error: string | null, patch: object) => eventForStep({ outcome: { outcome, error, patch }, now, target, account });

describe("eventForStep", () => {
  it("maps each provider result", () => {
    expect(step("done", null, { status: "published", externalUrl: "https://x.test/1" })).toMatchObject({ kind: "target_published", message: "Published.", details: { url: "https://x.test/1" }, postTargetId: "t1", providerKey: "bluesky" });
    expect(step("fatal_error", "Bad media", { status: "failed" })).toMatchObject({ kind: "target_failed", message: "Bad media" });
    expect(step("ambiguous", "Timed out", { status: "ambiguous" })).toMatchObject({ kind: "target_ambiguous", message: "Timed out" });
  });

  it("separates a scheduled retry from giving up", () => {
    const next = new Date("2030-05-01T12:05:00.000Z");
    expect(step("retryable_error", "Rate limited", { status: "scheduled", attemptCount: 2, nextAttemptAt: next })).toMatchObject({
      kind: "target_retry_scheduled",
      details: { attempt: 2, nextAttemptAt: next.toISOString() },
    });
    expect(step("retryable_error", "Rate limited", { status: "failed", attemptCount: 5 })).toMatchObject({
      kind: "target_failed",
      message: "Gave up after 5 attempts: Rate limited",
      details: { attempt: 5, gaveUp: true },
    });
  });

  it("writes nothing for continue or for engine and user outcomes", () => {
    for (const o of ["continue", "stale_result", "deferred", "released", "recovered_retry", "retry_requested"] as const) {
      expect(step(o, null, { status: "publishing" })).toBeNull();
    }
  });
});

describe("eventForDecision", () => {
  const decide = (patch: object, attempts: { outcome: AttemptOutcome; error?: string }[]) => eventForDecision({ decision: { patch, attempts }, target, account, now });

  it("maps engine settles", () => {
    expect(decide({ status: "failed", lastError: "The account is no longer available for publishing." }, [{ outcome: "account_unavailable", error: "Account removed" }])).toMatchObject({ kind: "target_failed", details: { engine: "account_unavailable" } });
    expect(decide({ status: "failed", lastError: "The account settings are invalid." }, [{ outcome: "account_unavailable", error: "Invalid account settings." }])).toMatchObject({ details: { engine: "invalid_settings" } });
    expect(decide({ status: "failed", lastError: "Publishing did not complete." }, [{ outcome: "did_not_complete" }])).toMatchObject({ details: { engine: "did_not_complete" } });
    expect(decide({ status: "failed", lastError: "The post is no longer available." }, [{ outcome: "fatal_error" }])).toMatchObject({ details: { engine: "post_gone" } });
    expect(decide({ status: "failed", attemptCount: 5, lastError: "Publishing was interrupted too many times." }, [{ outcome: "recovered_retry" }])).toMatchObject({ details: { engine: "interrupted", attempt: 5 } });
    expect(decide({ status: "ambiguous", lastError: "The publish step was interrupted and may have gone out." }, [{ outcome: "recovered_ambiguous" }])).toMatchObject({ kind: "target_ambiguous", details: { engine: "recovered_ambiguous" } });
  });

  it("reports an interrupted retry, using the deferral time when there is one", () => {
    expect(decide({ status: "publishing", attemptCount: 1 }, [{ outcome: "recovered_retry" }])).toMatchObject({ kind: "target_retry_scheduled", details: { attempt: 1, nextAttemptAt: now.toISOString(), interrupted: true } });
    const later = new Date("2030-05-01T13:00:00.000Z");
    expect(decide({ attemptCount: 1, nextAttemptAt: later }, [{ outcome: "recovered_retry" }, { outcome: "deferred" }])).toMatchObject({ details: { nextAttemptAt: later.toISOString() } });
  });

  it("writes nothing for deferral only, lease only or stale", () => {
    expect(decide({ nextAttemptAt: new Date() }, [{ outcome: "deferred" }])).toBeNull();
    expect(decide({ status: "publishing", leaseOwner: "x" } as object, [])).toBeNull();
    expect(decide({ status: "failed" }, [{ outcome: "stale_result" }])).toBeNull();
  });
});

describe("resolved, needs-reauth and connect events", () => {
  it("builds a resolved event with the actor and its sentence", () => {
    const e = resolvedEvent({ action: "marked_not_published", target, providerKey: "x", actor: { actorUserId: "u1" }, now, requeue: "no_free_slot" });
    expect(e).toMatchObject({ kind: "target_resolved", actorUserId: "u1", message: "Marked not published. No free posting slot to requeue.", details: { action: "marked_not_published", requeue: "no_free_slot" } });
    expect(resolvedEvent({ action: "retry_at", target, providerKey: "x", actor: {}, now, scheduledAt: now }).details).toEqual({ action: "retry_at", scheduledAt: now.toISOString() });
  });

  it("builds needs-reauth and connect-failed events that pass the strict details", () => {
    expect(needsReauthEvent({ account, reason: "renewal_refused", message: null, now })).toMatchObject({ socialAccountId: "a1", message: "This account needs reconnecting." });
    const c = connectFailedEvent({ via: "paste", code: "paste_refused", message: "Refused: hunter2-token", providerKeys: ["x", "bluesky"], groupKey: "meta", actor: { actorUserId: "u1" }, now, secrets: ["hunter2-token"] });
    expect(c.message).toBe("[redacted]");
    expect(c.providerKey).toBeNull();
    expect(c.providerKeys).toEqual(["x", "bluesky"]);
  });

  it("only produces details the strict schema accepts", () => {
    const events = [
      step("done", null, { status: "published" }),
      step("retryable_error", "e", { status: "scheduled", attemptCount: 1, nextAttemptAt: now }),
      resolvedEvent({ action: "bulk_retry", target, providerKey: "x", actor: {}, now, mode: "requeue" }),
      needsReauthEvent({ account, reason: "credentials_invalid", message: "m", now }),
      connectFailedEvent({ via: "oauth", code: "too_many", message: "m", providerKeys: ["x"], actor: {}, now }),
    ];
    for (const e of events) {
      expect(KIND_OUTCOME[e!.kind]).toBeDefined();
      expect(activityDetailsSchema(e!.kind).safeParse(e!.details).success).toBe(true);
    }
  });
});
