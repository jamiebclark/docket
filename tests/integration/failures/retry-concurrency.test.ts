import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError } from "../../../src/server/dal/errors";
import { runTick } from "../../../src/server/scheduler";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { LATER } from "../../helpers/failures";
import { parkAllDueTargets } from "../../helpers/scheduling";
import { failedTarget } from "../../helpers/retry";

beforeEach(parkAllDueTargets);
afterAll(async () => {
  await closeDb();
});

describe("retry requeue concurrency", () => {
  it("two failed targets of one account get distinct occurrences", async () => {
    const { env, targetId, account } = await failedTarget("one");
    const second = await posts.createDraft(env.scope, { baseText: "two", targets: [{ accountId: account.id }] });
    const sid = second.targets[0]!.id;
    await env.scope.targets.update(sid, { status: "failed", scheduleKind: "explicit", scheduledAt: new Date("2026-10-05T09:00:00Z") });
    const results = await atTime(LATER, () =>
      Promise.all([targetId, sid].map((id) => posts.retryTarget(env.scope, id, { mode: "requeue" }))),
    );
    const at = results.map((r) => (r.status === "scheduled" ? r.scheduledAt : r.status));
    expect(new Set(at).size).toBe(2);
  });

  it("a requeue racing the scheduler tick never leaves an inconsistent target", async () => {
    const { env, targetId } = await failedTarget();
    await atTime(LATER, () => Promise.allSettled([posts.retryTarget(env.scope, targetId, { mode: "requeue" }), runTick()]));
    const row = (await env.scope.targets.get(targetId))!;
    if (row.status === "failed") expect(row.slotOccurrenceAt?.toISOString()).not.toBe("2026-10-12T09:00:00.000Z");
    if (row.status === "scheduled") expect(row.slotOccurrenceAt).not.toBeNull();
    const published = (await posts.listAttempts(env.scope, targetId)).filter((a) => a.outcome === "done");
    expect(published.length).toBeLessThanOrEqual(1);
  });

  it("mixed-mode retries of one target: exactly one wins, the rest conflict, one entry, at most one hold", async () => {
    const { env, targetId } = await failedTarget();
    const inputs = [
      { mode: "now" },
      { mode: "requeue" },
      { mode: "at", at: "2026-10-07T15:00:00.000Z" },
      { mode: "requeue" },
      { mode: "now" },
      { mode: "at", at: "2026-10-08T15:00:00.000Z" },
    ];
    const results = await atTime(LATER, () => Promise.allSettled(inputs.map((i) => posts.retryTarget(env.scope, targetId, i))));
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(inputs.length - 1);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(ConflictError);
    const requested = (await posts.listAttempts(env.scope, targetId)).filter((a) => a.outcome === "retry_requested");
    expect(requested).toHaveLength(1);
    const row = (await env.scope.targets.get(targetId))!;
    expect(row.status).toBe("scheduled");
  });
});
