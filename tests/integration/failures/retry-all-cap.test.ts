import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { LATER, setAccountStatus } from "../../helpers/failures";
import { postsEnv } from "../../helpers/posts-env";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(async () => {
  await closeDb();
});

type Env = Awaited<ReturnType<typeof postsEnv>>;

/** `n` failed targets over the given accounts, with distinct intended times so the D2 order is the seed order. */
async function seedFailed(env: Env, accountIds: string[], n: number, offset = 0) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const at = new Date(Date.UTC(2026, 9, 5, 0, 0, 0) + (offset + i) * 1000);
    const d = await posts.createDraft(env.scope, { baseText: `Cap ${offset + i}`, targets: [{ accountId: accountIds[i % accountIds.length]! }] });
    const id = d.targets[0]!.id;
    await env.scope.targets.update(id, { status: "failed", lastError: "boom", scheduleKind: "explicit", scheduledAt: at, nextAttemptAt: at });
    ids.push(id);
  }
  return ids;
}

const statusOf = async (env: Env, id: string) => (await env.scope.targets.get(id))!.status;

describe("retryAllFailed — cap", () => {
  it("retries 100 per press in order and reports the rest", async () => {
    const env = await postsEnv();
    const a = await env.account({ behaviour: "fatal" });
    const b = await env.account({ behaviour: "fatal" });
    const ids = await seedFailed(env, [a.id, b.id], 230);

    const first = await atTime(LATER, () => posts.retryAllFailed(env.scope, { mode: "now" }));
    expect(first).toMatchObject({ count: 100, inScope: 230, remaining: 130 });
    expect(first.message).toContain("130 more failed posts were not retried yet. Press Retry all failed again to continue.");
    for (const id of ids.slice(0, 100)) expect(await statusOf(env, id)).toBe("scheduled");
    for (const id of ids.slice(100)) expect(await statusOf(env, id)).toBe("failed");
    expect(first.accounts.reduce((s, r) => s + r.retried + r.remaining, 0)).toBe(230);

    const second = await atTime(LATER, () => posts.retryAllFailed(env.scope, { mode: "now" }));
    expect(second).toMatchObject({ count: 100, inScope: 130, remaining: 30 });

    const third = await atTime(LATER, () => posts.retryAllFailed(env.scope, { mode: "now" }));
    expect(third).toMatchObject({ count: 30, inScope: 30, remaining: 0 });
    expect(third.message).not.toContain("Press Retry all failed again");
  });

  it("does not spend the cap on blocked targets", async () => {
    const env = await postsEnv();
    const blocked = await env.account({ behaviour: "fatal" });
    const ok = await env.account({ behaviour: "fatal" });
    await seedFailed(env, [blocked.id], 150);
    await seedFailed(env, [ok.id], 20, 1000);
    await setAccountStatus(env.project.id, blocked.id, "needs_reauth");

    const res = await atTime(LATER, () => posts.retryAllFailed(env.scope, { mode: "now" }));
    expect(res).toMatchObject({ count: 20, inScope: 170, remaining: 0 });
    expect(res.skipped.needs_reconnecting).toBe(150);
  });

  it("previews the cap", async () => {
    const env = await postsEnv();
    const a = await env.account({ behaviour: "fatal" });
    await seedFailed(env, [a.id], 120);
    const p = await posts.previewRetryAll(env.scope);
    expect(p).toMatchObject({ inScope: 120, eligible: 120, willAttempt: 100, cap: 100, capApplies: true });
  });

  it("logs the wall time of a 100-attempt requeue press", async () => {
    const env = await postsEnv();
    // 50 per account: each account's weekly slot has room for that many free occurrences, so all 100 really are attempted.
    const a = await env.account({ behaviour: "fatal" });
    const b = await env.account({ behaviour: "fatal" });
    await seedFailed(env, [a.id, b.id], 100);
    const t0 = Date.now();
    const res = await atTime(LATER, () => posts.retryAllFailed(env.scope, { mode: "requeue" }));
    console.log(`requeue press of 100 attempts: ${Date.now() - t0} ms (count ${res.count})`);
    expect(res.count).toBe(100);
    expect(res.skipped.no_free_slot).toBe(0);
  });
});
