import { describe, expect, it } from "vitest";
import { activityDetailsSchema } from "./details";
import { ACTIVITY_KINDS } from "./outcomes";

describe("activityDetailsSchema", () => {
  it("has a schema for every kind, and each accepts an empty-or-minimal shape", () => {
    for (const kind of ACTIVITY_KINDS) expect(activityDetailsSchema(kind)).toBeDefined();
    expect(activityDetailsSchema("target_published").safeParse({}).success).toBe(true);
    expect(activityDetailsSchema("target_failed").safeParse({ attempt: 5, gaveUp: true, engine: "interrupted" }).success).toBe(true);
  });

  it("rejects extra keys, so nothing free-form can be stored", () => {
    for (const kind of ACTIVITY_KINDS) {
      const minimal = { target_retry_scheduled: { attempt: 1, nextAttemptAt: "2030-01-01T00:00:00Z" }, target_resolved: { action: "retry_now" }, account_needs_reauth: { reason: "renewal_refused" }, account_connect_failed: { via: "oauth", code: "too_many" } }[kind as string] ?? {};
      expect(activityDetailsSchema(kind).safeParse({ ...minimal, token: "secret" }).success).toBe(false);
    }
  });

  it("validates values", () => {
    expect(activityDetailsSchema("target_failed").safeParse({ attempt: 0 }).success).toBe(false);
    expect(activityDetailsSchema("target_failed").safeParse({ engine: "other" }).success).toBe(false);
    expect(activityDetailsSchema("target_published").safeParse({ url: "x".repeat(2001) }).success).toBe(false);
    expect(activityDetailsSchema("target_retry_scheduled").safeParse({ attempt: 1, nextAttemptAt: "soon" }).success).toBe(false);
    expect(activityDetailsSchema("target_resolved").safeParse({ action: "nope" }).success).toBe(false);
    expect(activityDetailsSchema("account_connect_failed").safeParse({ via: "oauth", code: "bogus" }).success).toBe(false);
    expect(activityDetailsSchema("account_needs_reauth").safeParse({ reason: "credentials_invalid", backfilled: true }).success).toBe(true);
  });
});
