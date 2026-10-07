import { ZodError } from "zod";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { breakAccount, LATER, outcomeTarget, setAccountStatus } from "../../helpers/failures";
import { failedTarget } from "../../helpers/retry";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(async () => {
  await closeDb();
});

type Env = Awaited<ReturnType<typeof failedTarget>>["env"];

const sum = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);

/** A second failed target in the same project, on its own account. */
const another = (env: Env, text: string) => outcomeTarget(env, "fatal", text);

describe("retryAllFailed — retry now", () => {
  it("retries every failed target and matches a single retry on a twin", async () => {
    const a = await failedTarget();
    const b = await another(a.env, "Twin");
    await atTime(LATER, () => posts.retryTarget(a.env.scope, a.targetId, { mode: "now" }));
    const res = await atTime(LATER, () => posts.retryAllFailed(a.env.scope, { mode: "now" }));
    expect(res).toMatchObject({ changed: true, count: 1, mode: "now", inScope: 1, remaining: 0 });
    expect(res.message).toBe("1 post will be retried.");

    const single = (await a.env.scope.targets.get(a.targetId))!;
    const bulk = (await a.env.scope.targets.get(b.targetId))!;
    const pick = (r: typeof single) => ({
      status: r.status,
      attemptCount: r.attemptCount,
      stepState: r.stepState,
      firstStepAt: r.firstStepAt,
      publishStartedAt: r.publishStartedAt,
      lastError: r.lastError,
      nextAttemptAt: r.nextAttemptAt,
      scheduleKind: r.scheduleKind,
    });
    expect(pick(bulk)).toEqual(pick(single));
    const [sa] = (await posts.listAttempts(a.env.scope, a.targetId)).filter((x) => x.outcome === "retry_requested");
    const [ba] = (await posts.listAttempts(a.env.scope, b.targetId)).filter((x) => x.outcome === "retry_requested");
    expect(ba).toMatchObject({ step: sa!.step, outcome: "retry_requested", actorUserId: a.env.owner.id, error: sa!.error });
    expect(ba!.requestSummary).toEqual(sa!.requestSummary);
  });

  it("leaves ambiguous, scheduled and deleted-post targets alone and uncounted", async () => {
    const f = await failedTarget();
    const amb = await outcomeTarget(f.env, "ambiguous", "Amb");
    const del = await another(f.env, "Del");
    await posts.deletePost(f.env.scope, del.postId);
    const acc = await f.env.account();
    const draft = await posts.createDraft(f.env.scope, { baseText: "Sched", targets: [{ accountId: acc.id }] });
    await posts.addToQueue(f.env.scope, draft.post.id, {});

    const res = await atTime(LATER, () => posts.retryAllFailed(f.env.scope, { mode: "now" }));
    expect(res).toMatchObject({ count: 1, inScope: 1 });
    expect((await f.env.scope.targets.get(amb.targetId))!.status).toBe("ambiguous");
    expect((await f.env.scope.targets.get(del.targetId))!.status).toBe("failed");
    expect((await posts.listAttempts(f.env.scope, del.targetId)).some((x) => x.outcome === "retry_requested")).toBe(false);
  });

  it("includes targets beyond the first page of the Failures list", async () => {
    const f = await failedTarget();
    for (let i = 0; i < 26; i++) {
      const d = await posts.createDraft(f.env.scope, { baseText: `Bulk ${i}`, targets: [{ accountId: f.account.id }] });
      await f.env.scope.targets.update(d.targets[0]!.id, {
        status: "failed",
        lastError: "boom",
        scheduleKind: "explicit",
        scheduledAt: new Date("2026-10-05T09:00:00Z"),
        nextAttemptAt: new Date("2026-10-05T09:00:00Z"),
      });
    }
    const res = await atTime(LATER, () => posts.retryAllFailed(f.env.scope, { mode: "now" }));
    expect(res).toMatchObject({ count: 27, inScope: 27, remaining: 0 });
    expect((await f.env.scope.targets.countAttention()).failed).toBe(0);
  });

  it.each([
    { reason: "account_removed", apply: (e: Awaited<ReturnType<typeof failedTarget>>) => breakAccount(e.env.project.id, e.account.id, "removed") },
    { reason: "needs_reconnecting", apply: (e: Awaited<ReturnType<typeof failedTarget>>) => setAccountStatus(e.env.project.id, e.account.id, "needs_reauth") },
    { reason: "provider_unavailable", apply: (e: Awaited<ReturnType<typeof failedTarget>>) => breakAccount(e.env.project.id, e.account.id, "provider_missing") },
  ])("skips a target whose account is blocked ($reason) without writing", async ({ reason, apply }) => {
    const blocked = await failedTarget();
    const ok = await another(blocked.env, "Ok");
    await apply(blocked);
    const before = (await posts.listAttempts(blocked.env.scope, blocked.targetId)).length;
    const res = await atTime(LATER, () => posts.retryAllFailed(blocked.env.scope, { mode: "now" }));
    expect(res).toMatchObject({ count: 1, inScope: 2, remaining: 0 });
    expect(res.skipped[reason as keyof typeof res.skipped]).toBe(1);
    expect(res.count + sum(res.skipped) + res.remaining).toBe(res.inScope);
    expect((await blocked.env.scope.targets.get(blocked.targetId))!.status).toBe("failed");
    expect((await posts.listAttempts(blocked.env.scope, blocked.targetId)).length).toBe(before);
    expect((await blocked.env.scope.targets.get(ok.targetId))!.status).toBe("scheduled");
    expect(res.message).toContain("Skipped 1:");
  });

  it("breaks the counts down per account and they sum to the totals", async () => {
    const a = await failedTarget();
    const b = await another(a.env, "B");
    await setAccountStatus(a.env.project.id, b.account.id, "needs_reauth");
    const res = await atTime(LATER, () => posts.retryAllFailed(a.env.scope, { mode: "now" }));
    expect(res.accounts).toHaveLength(2);
    expect(res.accounts.reduce((n, r) => n + r.retried, 0)).toBe(res.count);
    expect(res.accounts.reduce((n, r) => n + sum(r.skipped), 0)).toBe(sum(res.skipped));
    const row = res.accounts.find((r) => r.accountId === b.account.id)!;
    expect(row).toMatchObject({ retried: 0, remaining: 0 });
    expect(row.skipped.needs_reconnecting).toBe(1);
    expect(res.accounts.find((r) => r.accountId === a.account.id)!.retried).toBe(1);
  });

  it("says so, and changes nothing, when no target has failed", async () => {
    const f = await failedTarget();
    await atTime(LATER, () => posts.retryAllFailed(f.env.scope, { mode: "now" }));
    const res = await atTime(LATER, () => posts.retryAllFailed(f.env.scope, { mode: "now" }));
    expect(res).toMatchObject({ changed: false, count: 0, inScope: 0, accounts: [], message: "There are no failed posts to retry." });
  });

  it("a second press changes nothing and reports only the still-blocked targets", async () => {
    const a = await failedTarget();
    const b = await another(a.env, "B");
    await setAccountStatus(a.env.project.id, b.account.id, "needs_reauth");
    const first = await atTime(LATER, () => posts.retryAllFailed(a.env.scope, { mode: "now" }));
    expect(first.count).toBe(1);
    const before = (await posts.listAttempts(a.env.scope, a.targetId)).length;

    const second = await atTime(LATER, () => posts.retryAllFailed(a.env.scope, { mode: "now" }));
    expect(second).toMatchObject({ changed: false, count: 0, inScope: 1, remaining: 0 });
    expect(second.skipped.needs_reconnecting).toBe(1);
    expect(sum(second.skipped)).toBe(1);
    expect((await posts.listAttempts(a.env.scope, a.targetId)).length).toBe(before);
    expect((await posts.listAttempts(a.env.scope, b.targetId)).filter((x) => x.outcome === "retry_requested")).toHaveLength(0);
  });

  it("only retries the given account's failures", async () => {
    const a = await failedTarget();
    const b = await another(a.env, "Other");
    const res = await atTime(LATER, () => posts.retryAllFailed(a.env.scope, { mode: "now", account: b.account.id }));
    expect(res).toMatchObject({ changed: true, count: 1, inScope: 1 });
    expect((await posts.listAttempts(a.env.scope, a.targetId)).some((x) => x.outcome === "retry_requested")).toBe(false);
    expect((await posts.listAttempts(a.env.scope, b.targetId)).some((x) => x.outcome === "retry_requested")).toBe(true);
    const none = await atTime(LATER, () =>
      posts.retryAllFailed(a.env.scope, { mode: "now", account: "00000000-0000-4000-8000-000000000000" }),
    );
    expect(none).toMatchObject({ changed: false, count: 0, message: "There are no failed posts to retry." });
  });

  it("re-derives the post status", async () => {
    const f = await failedTarget();
    expect((await posts.getPost(f.env.scope, f.postId)).post.status).toBe("failed");
    await atTime(LATER, () => posts.retryAllFailed(f.env.scope, { mode: "now" }));
    expect((await posts.getPost(f.env.scope, f.postId)).post.status).toBe("scheduled");
  });

  it.each([
    { name: "a targetIds key", input: { mode: "now", targetIds: ["x"] } },
    { name: "no mode", input: {} },
    { name: "an unknown mode", input: { mode: "at" } },
    { name: "a malformed account", input: { mode: "now", account: "nope" } },
  ])("rejects $name and changes nothing", async ({ input }) => {
    const f = await failedTarget();
    await expect(posts.retryAllFailed(f.env.scope, input)).rejects.toBeInstanceOf(ZodError);
    expect((await f.env.scope.targets.get(f.targetId))!.status).toBe("failed");
  });
});

describe("previewRetryAll", () => {
  it("reads only and classifies blocked targets", async () => {
    const a = await failedTarget();
    const b = await another(a.env, "B");
    await setAccountStatus(a.env.project.id, b.account.id, "needs_reauth");
    const p = await posts.previewRetryAll(a.env.scope);
    expect(p).toMatchObject({ scope: null, inScope: 2, eligible: 1, willAttempt: 1, cap: 100, capApplies: false });
    expect(p.blocked.needs_reconnecting).toBe(1);
    expect((await a.env.scope.targets.get(a.targetId))!.status).toBe("failed");
  });
  it("populates scope only for a present account, matches the run's pre-pass, and writes nothing", async () => {
    const a = await failedTarget();
    const b = await another(a.env, "B");
    await setAccountStatus(a.env.project.id, b.account.id, "needs_reauth");
    const entries = async () => (await posts.listAttempts(a.env.scope, a.targetId)).length + (await posts.listAttempts(a.env.scope, b.targetId)).length;
    const before = await entries();

    const scoped = await posts.previewRetryAll(a.env.scope, { account: a.account.id });
    expect(scoped.scope).toEqual({ accountId: a.account.id, accountName: expect.any(String) });
    expect(scoped).toMatchObject({ inScope: 1, eligible: 1 });
    const unknown = await posts.previewRetryAll(a.env.scope, { account: "00000000-0000-4000-8000-000000000000" });
    expect(unknown).toMatchObject({ scope: null, inScope: 0, eligible: 0, willAttempt: 0 });

    const p = await posts.previewRetryAll(a.env.scope);
    expect((await a.env.scope.targets.countAttention()).failed).toBe(2);
    expect(await entries()).toBe(before);

    const res = await atTime(LATER, () => posts.retryAllFailed(a.env.scope, { mode: "now" }));
    expect(res.count).toBe(p.willAttempt);
    expect(res.inScope).toBe(p.inScope);
    expect(res.skipped.needs_reconnecting).toBe(p.blocked.needs_reconnecting);
  });
});
