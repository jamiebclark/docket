import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { postMetricPollStates, postMetricSnapshots } from "../../../src/server/db/schema";
import { claimDuePostMetricPolls } from "../../../src/server/dal/insights-claims";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";
import { getRecordedQueries } from "../../setup/scope-recorder";

afterAll(closeDb);
beforeEach(parkAllDueTargets);

const NOW = new Date("2026-04-01T00:00:00Z");
const DUE_AT = new Date(NOW.getTime() + 3_600_000); // the schedule's 1h cadence for a fresh target's first poll
const CLAIM_OPTS = {
  leaseMs: 60_000,
  minIntervalMs: 0,
  providers: [
    {
      providerKey: "mock",
      postScopes: [],
      accountScopes: [],
      postIdSource: "externalId" as const,
      missingPostId: null,
      postMetricsDeclared: true,
      accountMetricsDeclared: true,
      ephemeralPostTypes: [],
    },
  ],
};

/** Pre-creates the poll-state rows directly, so a concurrency test exercises only the claim's own
 * `SKIP LOCKED` race and not the separate (and separately tested, T042) lazy-row-creation step. */
async function tenPublishedTargets(projectId: string, accountId: string) {
  const repos = forSchedulerProject(projectId);
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) {
    const post = await repos.posts.insert({ baseText: `t${i}` });
    const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: accountId }]);
    await repos.targets.update(target!.id, { status: "published", externalId: `ext-${i}`, publishedAt: NOW });
    await getDb().insert(postMetricPollStates).values({ postTargetId: target!.id, projectId, socialAccountId: accountId, nextPollAt: DUE_AT });
    ids.push(target!.id);
  }
  return ids;
}

describe("insights claim concurrency (contracts/scheduler-insights.md §5, FR-032, FR-033, FR-017)", () => {
  it("two concurrent claims over the same due targets split them disjointly (US3-AS6)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const ids = await tenPublishedTargets(ctx.project.id, account.id);

    const [a, b] = await Promise.all([
      claimDuePostMetricPolls({ ...CLAIM_OPTS, now: DUE_AT, limit: 5 }),
      claimDuePostMetricPolls({ ...CLAIM_OPTS, now: DUE_AT, limit: 5 }),
    ]);
    const claimedIds = [...a, ...b].map((c) => c.state.postTargetId).filter((id) => ids.includes(id));
    expect(new Set(claimedIds).size).toBe(claimedIds.length); // no id claimed twice
    expect(claimedIds).toHaveLength(10); // between the two, every due target was claimed
  });

  it("the claim's FOR UPDATE names only the poll-state table, never post_targets or social_accounts (FR-032)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    await tenPublishedTargets(ctx.project.id, account.id);

    await claimDuePostMetricPolls({ ...CLAIM_OPTS, now: DUE_AT, limit: 10 });

    const lockingQueries = getRecordedQueries().filter((q) => q.sql.toLowerCase().includes("for update"));
    expect(lockingQueries.length).toBeGreaterThan(0);
    for (const q of lockingQueries) {
      expect(q.sql.toLowerCase()).toContain("post_metric_poll_states");
      expect(q.sql.toLowerCase()).not.toMatch(/for update of "?post_targets/);
      expect(q.sql.toLowerCase()).not.toMatch(/for update of "?social_accounts/);
    }
  });

  it("a lease past its expiry is reclaimed by the next claim, with no snapshot from the killed run (FR-033, SC-008)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const repos = forSchedulerProject(ctx.project.id);
    const post = await repos.posts.insert({ baseText: "lease" });
    const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: account.id }]);
    await repos.targets.update(target!.id, { status: "published", externalId: "ext-lease", publishedAt: NOW });
    await getDb().insert(postMetricPollStates).values({ postTargetId: target!.id, projectId: ctx.project.id, socialAccountId: account.id, nextPollAt: DUE_AT });
    const targetId = target!.id;

    const first = await claimDuePostMetricPolls({ ...CLAIM_OPTS, now: DUE_AT, limit: 1, leaseMs: 1_000 });
    expect(first).toHaveLength(1);
    expect(first[0]!.state.postTargetId).toBe(targetId);
    const tokenA = first[0]!.token;

    // Still inside the lease: a sibling claim gets nothing for this target.
    const tooSoon = await claimDuePostMetricPolls({ ...CLAIM_OPTS, now: new Date(DUE_AT.getTime() + 500), limit: 10 });
    expect(tooSoon.some((c) => c.state.postTargetId === targetId)).toBe(false);

    // The run that held tokenA is simulated killed: it never commits, never releases.
    const afterExpiry = new Date(DUE_AT.getTime() + 1_500);
    const second = await claimDuePostMetricPolls({ ...CLAIM_OPTS, now: afterExpiry, limit: 1 });
    expect(second).toHaveLength(1);
    expect(second[0]!.state.postTargetId).toBe(targetId);
    expect(second[0]!.token).not.toBe(tokenA);

    const [snapshot] = await getDb()
      .select()
      .from(postMetricSnapshots)
      .where(and(eq(postMetricSnapshots.projectId, ctx.project.id), eq(postMetricSnapshots.postTargetId, targetId)));
    expect(snapshot).toBeUndefined(); // the killed run wrote nothing

    const [state] = await getDb()
      .select()
      .from(postMetricPollStates)
      .where(and(eq(postMetricPollStates.projectId, ctx.project.id), eq(postMetricPollStates.postTargetId, targetId)));
    expect(state?.pollLeaseOwner).toBe(second[0]!.token);
  });

  it("two commits for the same subject at the same captured_at produce one row, no error (FR-017, SC-009)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const repos = forSchedulerProject(ctx.project.id);
    const post = await repos.posts.insert({ baseText: "dup" });
    const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: account.id }]);
    await repos.targets.update(target!.id, { status: "published", externalId: "ext-dup", publishedAt: NOW });

    const capturedAt = new Date(NOW.getTime() + 3_600_000);
    await Promise.all([
      repos.postMetricSnapshots.insertIfAbsent({ postTargetId: target!.id, socialAccountId: account.id, providerKey: "mock", capturedAt, metrics: { likeCount: 1 } }),
      repos.postMetricSnapshots.insertIfAbsent({ postTargetId: target!.id, socialAccountId: account.id, providerKey: "mock", capturedAt, metrics: { likeCount: 1 } }),
    ]);

    const rows = await getDb()
      .select()
      .from(postMetricSnapshots)
      .where(and(eq(postMetricSnapshots.projectId, ctx.project.id), eq(postMetricSnapshots.postTargetId, target!.id)));
    expect(rows).toHaveLength(1);
  });

  it("the clock moving backwards between captures is idempotent at each timestamp, not a duplicate (FR-017)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const repos = forSchedulerProject(ctx.project.id);
    const post = await repos.posts.insert({ baseText: "clockskew" });
    const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: account.id }]);
    await repos.targets.update(target!.id, { status: "published", externalId: "ext-skew", publishedAt: NOW });

    const later = new Date(NOW.getTime() + 7_200_000);
    const earlier = new Date(NOW.getTime() + 3_600_000); // the clock appears to have gone backwards

    await repos.postMetricSnapshots.insertIfAbsent({ postTargetId: target!.id, socialAccountId: account.id, providerKey: "mock", capturedAt: later, metrics: { likeCount: 2 } });
    await repos.postMetricSnapshots.insertIfAbsent({ postTargetId: target!.id, socialAccountId: account.id, providerKey: "mock", capturedAt: earlier, metrics: { likeCount: 1 } });
    // Re-running the earlier capture again (e.g. a retried tick) must not duplicate it.
    await repos.postMetricSnapshots.insertIfAbsent({ postTargetId: target!.id, socialAccountId: account.id, providerKey: "mock", capturedAt: earlier, metrics: { likeCount: 1 } });

    const rows = await getDb()
      .select()
      .from(postMetricSnapshots)
      .where(and(eq(postMetricSnapshots.projectId, ctx.project.id), eq(postMetricSnapshots.postTargetId, target!.id)));
    expect(rows.map((r) => r.capturedAt.getTime()).sort()).toEqual([earlier.getTime(), later.getTime()].sort());
  });
});
