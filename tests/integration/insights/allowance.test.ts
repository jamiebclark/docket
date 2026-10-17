import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { postMetricPollStates, postMetricSnapshots } from "../../../src/server/db/schema";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { createDueTarget, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";
import { tickConfig } from "../../helpers/tick";

afterAll(closeDb);
beforeEach(parkAllDueTargets);

const NOW = new Date("2026-03-01T00:00:00Z");
const DUE_AT = new Date(NOW.getTime() + 3_600_000);
const WRITE_AT = new Date(DUE_AT.getTime() - 60_000); // inside the 1-hour window ending at DUE_AT

async function accountWithLimit(limitCount: number) {
  const ctx = await createProjectWithMembers();
  const repos = forSchedulerProject(ctx.project.id);
  const account = await createMockAccount(ctx.project.id);
  await repos.accounts.setLimit(account.id, { count: limitCount, windowSeconds: 3_600 });
  return { ctx, repos, account };
}

/** Fills the window with `n` writes that count against the account's publish-limit allowance. */
async function fillWritesInWindow(repos: ReturnType<typeof forSchedulerProject>, accountId: string, n: number) {
  for (let i = 0; i < n; i++) {
    const post = await repos.posts.insert({ baseText: `filler ${i}` });
    const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: accountId }]);
    await repos.targets.update(target!.id, { status: "published", publishStartedAt: WRITE_AT, externalId: `filler-${i}`, publishedAt: WRITE_AT });
  }
}

async function insightsTarget(repos: ReturnType<typeof forSchedulerProject>, accountId: string) {
  const post = await repos.posts.insert({ baseText: "Hello" });
  const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: accountId }]);
  await repos.targets.update(target!.id, { status: "published", externalId: "ext-1", publishedAt: NOW });
  return target!;
}

describe("insights allowance (contracts/scheduler-insights.md §3, FR-045 … FR-049)", () => {
  it("refuses the call once writes + snapshots in window reach the reserve floor, leaving the poll due and un-failed (US3-AS3, FR-046)", async () => {
    const { ctx, repos, account } = await accountWithLimit(10); // reserveFloor(10, 0.5) === 5
    await fillWritesInWindow(repos, account.id, 5);
    const target = await insightsTarget(repos, account.id);

    const summary = await atTime(DUE_AT, () => runTick(tickConfig()));
    expect(summary.insightsPoll.counts.deferredForAllowance).toBeGreaterThanOrEqual(1);

    const [snapshot] = await getDb()
      .select()
      .from(postMetricSnapshots)
      .where(and(eq(postMetricSnapshots.projectId, ctx.project.id), eq(postMetricSnapshots.postTargetId, target.id)));
    expect(snapshot).toBeUndefined();

    const [state] = await getDb()
      .select()
      .from(postMetricPollStates)
      .where(and(eq(postMetricPollStates.projectId, ctx.project.id), eq(postMetricPollStates.postTargetId, target.id)));
    expect(state?.consecutiveFailures).toBe(0);
    expect(state?.lastError).toBeNull();
    expect(state?.pollLeaseUntil).toBeNull();
    expect(state?.nextPollAt).not.toBeNull();
    expect(state!.nextPollAt!.getTime()).toBeLessThanOrEqual(DUE_AT.getTime());
  });

  it("with the default reserve of 0.5, four writes out of ten still leave the account pollable (FR-047)", async () => {
    const { ctx, repos, account } = await accountWithLimit(10); // floor is 5; 4 used stays under it
    await fillWritesInWindow(repos, account.id, 4);
    const target = await insightsTarget(repos, account.id);

    const summary = await atTime(DUE_AT, () => runTick(tickConfig()));
    expect(summary.insightsPoll.counts.deferredForAllowance).toBe(0);

    const [snapshot] = await getDb()
      .select()
      .from(postMetricSnapshots)
      .where(and(eq(postMetricSnapshots.projectId, ctx.project.id), eq(postMetricSnapshots.postTargetId, target.id)));
    expect(snapshot).toBeDefined();
  });

  it("a scheduled publish for the same account in the same tick publishes normally while polling is deferred at the floor (FR-048, SC-005)", async () => {
    const { ctx, repos, account } = await accountWithLimit(10);
    await fillWritesInWindow(repos, account.id, 5);
    const { target: scheduledTarget } = await createDueTarget(ctx.project.id, account.id, { dueAt: new Date(DUE_AT.getTime() - 1_000) });

    const summary = await atTime(DUE_AT, () => runTick(tickConfig()));
    expect(summary.insightsPoll.counts.deferredForAllowance).toBeGreaterThanOrEqual(1);
    expect(summary.publishing.ok).toBe(true);

    const published = await repos.targets.get(scheduledTarget.id);
    expect(published?.status).toBe("published");
    expect(published?.externalId).not.toBeNull();
  });
});
