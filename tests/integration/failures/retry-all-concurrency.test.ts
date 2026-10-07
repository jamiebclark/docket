import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError } from "../../../src/server/dal/errors";
import { runTick } from "../../../src/server/scheduler";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { LATER } from "../../helpers/failures";
import { failedTarget } from "../../helpers/retry";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(async () => {
  await closeDb();
});

type Env = Awaited<ReturnType<typeof failedTarget>>["env"];

const hour = (h: number) => new Date(`2026-10-05T${String(h).padStart(2, "0")}:00:00Z`);

async function failedAt(env: Env, accountId: string, at: Date, text: string) {
  const d = await posts.createDraft(env.scope, { baseText: text, targets: [{ accountId }] });
  const targetId = d.targets[0]!.id;
  await env.scope.targets.update(targetId, { status: "failed", lastError: "boom", scheduleKind: "explicit", scheduledAt: at, nextAttemptAt: at });
  return { postId: d.post.id, targetId };
}

const entries = async (env: Env, id: string) => (await posts.listAttempts(env.scope, id)).filter((x) => x.outcome === "retry_requested");

/** Every held occurrence (slot id + time) among the targets is distinct. */
async function expectNoDoubleHold(env: Env, ids: string[]) {
  const held: string[] = [];
  for (const id of ids) {
    const t = (await env.scope.targets.get(id))!;
    if (t.slotOccurrenceAt) held.push(`${t.slotId}@${t.slotOccurrenceAt.toISOString()}`);
  }
  expect(new Set(held).size).toBe(held.length);
}

async function fixture() {
  const a = await failedTarget("A");
  const a2 = await failedAt(a.env, a.account.id, hour(10), "A2");
  const accB = await a.env.account({ behaviour: "fatal" });
  const b = await failedAt(a.env, accB.id, hour(8), "B");
  return { env: a.env, account: a.account, ids: [a.targetId, a2.targetId, b.targetId] };
}

describe("retryAllFailed — concurrency", () => {
  it.each([["now"], ["requeue"]] as const)("two bulk runs (now + %s) settle with one new entry per target", async (second) => {
    const f = await fixture();
    const results = await atTime(LATER, () =>
      Promise.allSettled([posts.retryAllFailed(f.env.scope, { mode: "now" }), posts.retryAllFailed(f.env.scope, { mode: second })]),
    );
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const [r1, r2] = results.map((r) => (r as PromiseFulfilledResult<posts.RetryAllResult>).value);
    expect(r1!.count + r2!.count).toBe(3);
    expect(r1!.count + r2!.count + r1!.skipped.no_longer_failed + r2!.skipped.no_longer_failed).toBeGreaterThanOrEqual(3);
    for (const id of f.ids) expect(await entries(f.env, id)).toHaveLength(1);
    await expectNoDoubleHold(f.env, f.ids);
  });

  it("a bulk run racing the scheduler tick: the tick never claims a still-failed target and attempts each at most once", async () => {
    const a = await failedTarget("A");
    const acc = await a.env.account({ behaviour: "succeed" });
    const ok1 = await failedAt(a.env, acc.id, hour(8), "S1");
    const ok2 = await failedAt(a.env, acc.id, hour(9), "S2");
    const ids = [a.targetId, ok1.targetId, ok2.targetId];
    const [bulk, tick] = await atTime(LATER, () => Promise.allSettled([posts.retryAllFailed(a.env.scope, { mode: "now" }), runTick()]));
    expect(bulk.status).toBe("fulfilled");
    expect(tick.status).toBe("fulfilled");
    // A second tick certainly sees every retried target as due, so the claim is verified whichever way the race went.
    await atTime(LATER, () => runTick());
    for (const id of ids) {
      const attempts = (await posts.listAttempts(a.env.scope, id)).reverse(); // listAttempts is newest first
      const retryAt = attempts.findIndex((x) => x.outcome === "retry_requested");
      expect(attempts.filter((x) => x.outcome === "retry_requested")).toHaveLength(1);
      // Under the frozen clock the retry and the tick share an `at`, so ordering is checked by time (never earlier), not by position.
      const retry = attempts[retryAt]!;
      for (const e of attempts.filter((x) => x.tickId && id !== a.targetId)) expect(e.createdAt.getTime()).toBeGreaterThanOrEqual(retry.createdAt.getTime());
      const after = attempts.filter((x) => x.tickId && x.createdAt.getTime() >= retry.createdAt.getTime() && (x.outcome === "done" || x.outcome === "fatal_error"));
      expect(after.length).toBeLessThanOrEqual(1);
    }
    for (const id of [ok1.targetId, ok2.targetId]) {
      const attempts = await posts.listAttempts(a.env.scope, id);
      expect(attempts.filter((x) => x.outcome === "done")).toHaveLength(1);
      expect((await a.env.scope.targets.get(id))!.status).toBe("published");
    }
  });

  it("a bulk run racing a single retry of one of its targets: exactly one wins it", async () => {
    const f = await fixture();
    const target = f.ids[0]!;
    const [bulk, single] = await atTime(LATER, () =>
      Promise.allSettled([posts.retryAllFailed(f.env.scope, { mode: "now" }), posts.retryTarget(f.env.scope, target, { mode: "now" })]),
    );
    expect(bulk.status).toBe("fulfilled");
    const res = (bulk as PromiseFulfilledResult<posts.RetryAllResult>).value;
    if (single.status === "rejected") {
      expect(single.reason).toBeInstanceOf(ConflictError);
      expect((single.reason as Error).message).toBe("This post is no longer failed.");
      expect(res.count).toBe(3);
    } else {
      expect(res.count).toBe(2);
      expect(res.skipped.no_longer_failed).toBe(1);
    }
    for (const id of f.ids) expect(await entries(f.env, id)).toHaveLength(1);
  });

  it("bulk requeue + addToQueue + single requeue on one account never double-hold an occurrence", async () => {
    const f = await fixture();
    const a2 = f.ids[1];
    const draft = await posts.createDraft(f.env.scope, { baseText: "queued", targets: [{ accountId: f.account.id }] });
    const results = await atTime(LATER, () =>
      Promise.allSettled([
        posts.retryAllFailed(f.env.scope, { mode: "requeue" }),
        posts.addToQueue(f.env.scope, draft.post.id, {}),
        posts.retryTarget(f.env.scope, a2!, { mode: "requeue" }),
      ]),
    );
    expect(results[0]!.status).toBe("fulfilled");
    expect(results[1]!.status).toBe("fulfilled");
    if (results[2]!.status === "rejected") expect((results[2] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    for (const id of f.ids) expect(await entries(f.env, id)).toHaveLength(1);
    await expectNoDoubleHold(f.env, [...f.ids, draft.targets[0]!.id]);
  });
});
