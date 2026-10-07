import { ZodError } from "zod";
import { ConflictError } from "../../../src/server/dal/errors";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as posts from "../../../src/server/services/posts";
import * as slots from "../../../src/server/services/slots";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { breakAccount, LATER, setAccountStatus } from "../../helpers/failures";
import { failedTarget, NEXT_MONDAY, pauseAllSlots } from "../../helpers/retry";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(async () => {
  await closeDb();
});

describe("retry mode: requeue", () => {
  it("moves the target into the next free slot and records the attempt", async () => {
    const { env, targetId, postId, account } = await failedTarget();
    const res = await atTime(LATER, () => posts.retryTarget(env.scope, targetId, { mode: "requeue", expected: NEXT_MONDAY }));
    expect(res).toMatchObject({ status: "scheduled", mode: "requeue", scheduledAt: NEXT_MONDAY, changedFromPreview: false, warnings: [] });
    const row = (await env.scope.targets.get(targetId))!;
    expect(row).toMatchObject({ status: "scheduled", scheduleKind: "slot", attemptCount: 0, lastError: null, stepState: null });
    expect(row.scheduledAt?.toISOString()).toBe(NEXT_MONDAY);
    expect(row.nextAttemptAt?.toISOString()).toBe(NEXT_MONDAY);
    expect(row.slotOccurrenceAt?.toISOString()).toBe(NEXT_MONDAY);
    expect(row.slotId).toBe((res as { slotId: string }).slotId);
    expect(account.id).toBe(row.socialAccountId);
    const [attempt] = await posts.listAttempts(env.scope, targetId);
    expect(attempt).toMatchObject({ step: "user", outcome: "retry_requested", error: null, actorUserId: env.owner.id });
    expect(attempt!.requestSummary).toMatchObject({ mode: "requeue", scheduledAt: NEXT_MONDAY, slotId: row.slotId, expected: NEXT_MONDAY });
    expect((await posts.getPost(env.scope, postId)).post.status).toBe("scheduled");
  });

  it("flags an instant that differs from the expected one", async () => {
    const { env, targetId } = await failedTarget();
    const res = await atTime(LATER, () => posts.retryTarget(env.scope, targetId, { mode: "requeue", expected: "2026-10-05T09:00:00.000Z" }));
    expect(res).toMatchObject({ status: "scheduled", changedFromPreview: true });
  });

  it("is refused with no_active_slots when every slot is paused", async () => {
    const { env, targetId, account } = await failedTarget();
    await pauseAllSlots(env, account.id);
    const res = await atTime(LATER, () => posts.retryTarget(env.scope, targetId, { mode: "requeue" }));
    expect(res).toMatchObject({ status: "failed", reason: "no_active_slots" });
    expect((res as { message: string }).message).toMatch(/^Not retried — .* has no active posting slots\. Retry now or pick a time\.$/);
    const row = (await env.scope.targets.get(targetId))!;
    expect(row.status).toBe("failed");
    expect(row.lastError).toBe((res as { message: string }).message);
    const [attempt] = await posts.listAttempts(env.scope, targetId);
    expect(attempt).toMatchObject({ outcome: "retry_requested", error: "no_free_slot" });
    expect(attempt!.requestSummary).toMatchObject({ mode: "requeue", reason: "no_active_slots" });
  });

  it("is refused with no_free_occurrence when the horizon is full", async () => {
    const { env, targetId, account } = await failedTarget();
    // Make the only upcoming occurrences unavailable by holding them with other targets.
    const [slot] = await slots.listSlots(env.scope, account.id);
    const instants = Array.from({ length: 60 }, (_, i) => new Date(Date.parse(NEXT_MONDAY) + i * 7 * 86_400_000));
    for (const [i, at] of instants.entries()) {
      const d = await posts.createDraft(env.scope, { baseText: `fill ${i}`, targets: [{ accountId: account.id }] });
      const id = d.targets[0]!.id;
      await env.scope.targets.update(id, { status: "scheduled", scheduleKind: "slot", scheduledAt: at, nextAttemptAt: at });
      await env.scope.targets.tryHoldOccurrence(id, at, slot!.id);
    }
    const res = await atTime(LATER, () => posts.retryTarget(env.scope, targetId, { mode: "requeue" }));
    expect(res).toMatchObject({ status: "failed", reason: "no_free_occurrence" });
    expect((res as { message: string }).message).toMatch(/^Not retried — .* has no free posting slot\. Retry now or pick a time\.$/);
    expect((await env.scope.targets.get(targetId))!.status).toBe("failed");
  });

  it("returns a validation failure and writes nothing when the content no longer validates", async () => {
    const { env, targetId } = await failedTarget();
    await env.scope.targets.update(targetId, { overrideText: "x".repeat(200_000) });
    const before = (await posts.listAttempts(env.scope, targetId)).length;
    const res = await atTime(LATER, () => posts.retryTarget(env.scope, targetId, { mode: "requeue" }));
    expect(res).toMatchObject({ status: "failed", reason: "validation" });
    expect((res as { issues?: unknown[] }).issues?.length).toBeGreaterThan(0);
    expect((await env.scope.targets.get(targetId))!.status).toBe("failed");
    expect((await posts.listAttempts(env.scope, targetId)).length).toBe(before);
  });

  it("reports account_unavailable from the gate without writing", async () => {
    const { env, targetId, account } = await failedTarget();
    await setAccountStatus(env.project.id, account.id, "needs_reauth");
    await expect(atTime(LATER, () => posts.retryTarget(env.scope, targetId, { mode: "requeue" }))).rejects.toThrow(/reconnected/);
  });
});

describe("retry mode: at", () => {
  const AT = "2026-10-07T15:00:00.000Z";

  it("stores an explicit schedule, releases the old hold and records the attempt", async () => {
    const { env, targetId } = await failedTarget();
    const res = await atTime(LATER, () => posts.retryTarget(env.scope, targetId, { mode: "at", at: AT }));
    expect(res).toMatchObject({ status: "scheduled", mode: "at", scheduledAt: AT, slotId: null, changedFromPreview: false });
    const row = (await env.scope.targets.get(targetId))!;
    expect(row).toMatchObject({ status: "scheduled", scheduleKind: "explicit", slotOccurrenceAt: null, slotId: null, attemptCount: 0, lastError: null, stepState: null });
    expect(row.scheduledAt?.toISOString()).toBe(AT);
    expect(row.nextAttemptAt?.toISOString()).toBe(AT);
    const [attempt] = await posts.listAttempts(env.scope, targetId);
    expect(attempt).toMatchObject({ step: "user", outcome: "retry_requested", actorUserId: env.owner.id });
    expect(attempt!.requestSummary).toMatchObject({ mode: "at", scheduledAt: AT });
  });

  it("refuses a time in the past or equal to now without writing", async () => {
    const { env, targetId } = await failedTarget();
    for (const at of ["2026-10-05T09:00:00.000Z", LATER.toISOString()]) {
      const res = await atTime(LATER, () => posts.retryTarget(env.scope, targetId, { mode: "at", at }));
      expect(res).toEqual({ status: "failed", reason: "in_past", message: "That time has passed. Use Retry now instead." });
    }
    expect((await env.scope.targets.get(targetId))!.status).toBe("failed");
    expect((await posts.listAttempts(env.scope, targetId)).length).toBe(1);
  });

  it("returns a validation failure with issues and writes nothing", async () => {
    const { env, targetId } = await failedTarget();
    await env.scope.targets.update(targetId, { overrideText: "x".repeat(200_000) });
    const before = (await posts.listAttempts(env.scope, targetId)).length;
    const res = await atTime(LATER, () => posts.retryTarget(env.scope, targetId, { mode: "at", at: AT }));
    expect(res).toMatchObject({ status: "failed", reason: "validation" });
    expect((res as { issues?: unknown[] }).issues?.length).toBeGreaterThan(0);
    expect((await env.scope.targets.get(targetId))!.status).toBe("failed");
    expect((await posts.listAttempts(env.scope, targetId)).length).toBe(before);
  });

  it("warns about a nearby queued post without blocking, excluding the target itself", async () => {
    const { env, targetId, account } = await failedTarget();
    const nearAt = new Date(Date.parse(AT) + 5 * 60_000);
    const d = await posts.createDraft(env.scope, { baseText: "neighbour", targets: [{ accountId: account.id }] });
    await env.scope.targets.update(d.targets[0]!.id, { status: "scheduled", scheduleKind: "explicit", scheduledAt: nearAt, nextAttemptAt: nearAt });
    const res = await atTime(LATER, () => posts.retryTarget(env.scope, targetId, { mode: "at", at: AT }));
    expect(res).toMatchObject({ status: "scheduled", mode: "at" });
    const warnings = (res as { warnings: { targetId?: string }[] }).warnings;
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain(targetId);
  });

  it("throws ZodError for malformed input and changes nothing", async () => {
    const { env, targetId } = await failedTarget();
    for (const input of [{ mode: "later" }, { mode: "at" }, { mode: "at", at: "tomorrow" }]) {
      await expect(atTime(LATER, () => posts.retryTarget(env.scope, targetId, input))).rejects.toBeInstanceOf(ZodError);
    }
    expect((await env.scope.targets.get(targetId))!.status).toBe("failed");
  });
});

describe("retry mode: now", () => {
  it("stores exactly today's state, keeping the old schedule and any held occurrence", async () => {
    const { env, targetId, account } = await failedTarget();
    const [slot] = await slots.listSlots(env.scope, account.id);
    const held = new Date(NEXT_MONDAY);
    await env.scope.targets.update(targetId, { scheduleKind: "slot", scheduledAt: held });
    await env.scope.targets.tryHoldOccurrence(targetId, held, slot!.id);
    const before = (await env.scope.targets.get(targetId))!;

    const res = await atTime(LATER, () => posts.retryTarget(env.scope, targetId, { mode: "now" }));
    expect(res).toMatchObject({ status: "scheduled", mode: "now", slotId: null, changedFromPreview: false, warnings: [] });
    const row = (await env.scope.targets.get(targetId))!;
    expect(row).toMatchObject({
      status: "scheduled",
      scheduleKind: before.scheduleKind,
      slotId: before.slotId,
      attemptCount: 0,
      lastError: null,
      stepState: null,
      firstStepAt: null,
      publishStartedAt: null,
    });
    expect(row.nextAttemptAt?.toISOString()).toBe(new Date(LATER).toISOString());
    expect(row.scheduledAt?.toISOString()).toBe(before.scheduledAt?.toISOString());
    expect(row.slotOccurrenceAt?.toISOString()).toBe(before.slotOccurrenceAt?.toISOString());
    expect(row.slotOccurrenceAt).not.toBeNull();
    const attempts = await posts.listAttempts(env.scope, targetId);
    const requested = attempts.filter((a) => a.outcome === "retry_requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]!.requestSummary ?? {}).toEqual({});
  });

  it("treats no input and null as now", async () => {
    for (const input of [undefined, null] as const) {
      const { env, targetId } = await failedTarget();
      const res = await atTime(LATER, () => (input === undefined ? posts.retryTarget(env.scope, targetId) : posts.retryTarget(env.scope, targetId, input)));
      expect(res).toMatchObject({ status: "scheduled", mode: "now", slotId: null, changedFromPreview: false, warnings: [] });
      expect((await env.scope.targets.get(targetId))!.nextAttemptAt?.toISOString()).toBe(new Date(LATER).toISOString());
    }
  });
});

const MODES = [
  { mode: "now" },
  { mode: "requeue" },
  { mode: "at", at: "2026-10-07T15:00:00.000Z" },
] as const;

describe("blocked and stale retries, every mode (US4)", () => {
  const blocks = [
    { name: "removed", expected: /removed/, apply: (e: Awaited<ReturnType<typeof failedTarget>>) => breakAccount(e.env.project.id, e.account.id, "removed") },
    { name: "needs_reauth", expected: /reconnected/, apply: (e: Awaited<ReturnType<typeof failedTarget>>) => setAccountStatus(e.env.project.id, e.account.id, "needs_reauth") },
    { name: "provider missing", expected: /no longer available/, apply: (e: Awaited<ReturnType<typeof failedTarget>>) => breakAccount(e.env.project.id, e.account.id, "provider_missing") },
  ];

  for (const block of blocks) {
    for (const input of MODES) {
      it(`${input.mode}: refuses a ${block.name} account and leaves the target unchanged`, async () => {
        const t = await failedTarget();
        await block.apply(t);
        const before = (await t.env.scope.targets.get(t.targetId))!;
        const attempts = (await posts.listAttempts(t.env.scope, t.targetId)).length;
        await expect(atTime(LATER, () => posts.retryTarget(t.env.scope, t.targetId, input))).rejects.toThrow(block.expected);
        const after = (await t.env.scope.targets.get(t.targetId))!;
        expect(after).toEqual(before);
        expect((await posts.listAttempts(t.env.scope, t.targetId)).length).toBe(attempts);
      });
    }
  }

  for (const input of MODES) {
    it(`${input.mode}: a publishing target gets the in-progress conflict`, async () => {
      const t = await failedTarget();
      await t.env.scope.targets.update(t.targetId, { status: "publishing", nextAttemptAt: LATER, publishStartedAt: LATER });
      const err = await atTime(LATER, () => posts.retryTarget(t.env.scope, t.targetId, input)).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.message).toBe("Publishing in progress. Try again in a moment.");
      expect((await t.env.scope.targets.get(t.targetId))!.status).toBe("publishing");
    });

    it(`${input.mode}: an already-scheduled target gets the no-longer-failed conflict`, async () => {
      const t = await failedTarget();
      await atTime(LATER, () => posts.retryTarget(t.env.scope, t.targetId, { mode: "now" }));
      const err = await atTime(LATER, () => posts.retryTarget(t.env.scope, t.targetId, input)).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.message).toBe("This post is no longer failed.");
    });
  }
});
