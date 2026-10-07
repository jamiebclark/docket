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
    expect(results.map((r) => r.status)).toEqual(["scheduled", "scheduled"]);
    expect(new Set(at).size).toBe(2);
    for (const id of [targetId, sid]) expect((await env.scope.targets.get(id))!.status).toBe("scheduled");
  });

  it("a retry-now racing the scheduler tick is fulfilled and publishes at most once", async () => {
    const { env, targetId } = await failedTarget();
    const [retry] = await atTime(LATER, () =>
      Promise.allSettled([posts.retryTarget(env.scope, targetId, { mode: "now" }), runTick()]),
    );
    expect(retry.status).toBe("fulfilled");
    const row = (await env.scope.targets.get(targetId))!;
    expect(["scheduled", "publishing", "published", "failed"]).toContain(row.status);
    if (row.status === "scheduled") expect(row.scheduledAt).not.toBeNull();
    const attempts = await posts.listAttempts(env.scope, targetId);
    expect(attempts.filter((a) => a.outcome === "retry_requested")).toHaveLength(1);
    expect(attempts.filter((a) => a.outcome === "done").length).toBeLessThanOrEqual(1);
  });

  it("mixed-mode retries of one target: exactly one wins, the rest conflict, one entry, at most one hold", async () => {
    const { env, targetId, account } = await failedTarget();
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
    const held = await env.scope.targets.heldOccurrences(account.id, new Date("2026-01-01T00:00:00Z"), new Date("2027-12-31T00:00:00Z"));
    expect(held.filter((h) => h.targetId === targetId).length).toBeLessThanOrEqual(1);
  });
});
