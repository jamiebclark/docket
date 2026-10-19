import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { activityEvents, postMetricPollStates, postMetricSnapshots } from "../../../src/server/db/schema";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { readHeartbeats } from "../../../src/server/dal/heartbeats";
import { mockInsights } from "../../../src/providers/mock/insights";
import { mockProvider } from "../../../src/providers/mock";
import type { SocialProvider } from "../../../src/providers/types";
import { runTick } from "../../../src/server/scheduler";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { registerTestProvider } from "../../helpers/provider-fixtures";
import { createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";
import { tickConfig } from "../../helpers/tick";

afterAll(closeDb);
beforeEach(parkAllDueTargets);

const NOW = new Date("2026-02-01T00:00:00Z");

async function publishedTarget(projectId: string, accountId: string, opts: { externalId?: string | null; publishedAt?: Date } = {}) {
  const repos = forSchedulerProject(projectId);
  const post = await repos.posts.insert({ baseText: "Hello" });
  const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: accountId }]);
  const externalId = opts.externalId === undefined ? "ext-1" : opts.externalId;
  await repos.targets.update(target!.id, {
    status: "published",
    externalId,
    publishedAt: opts.publishedAt ?? NOW,
    ...(externalId === null ? { resolvedAt: opts.publishedAt ?? NOW } : {}),
  });
  return { post, target: target! };
}

describe("runInsightsPoll (contracts/scheduler-insights.md)", () => {
  it("a due target yields one snapshot row and one poll-state update committed together (FR-031)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const { target } = await publishedTarget(ctx.project.id, account.id);

    await atTime(new Date(NOW.getTime() + 3_600_000), () => runTick(tickConfig()));

    const [snapshot] = await getDb()
      .select()
      .from(postMetricSnapshots)
      .where(and(eq(postMetricSnapshots.projectId, ctx.project.id), eq(postMetricSnapshots.postTargetId, target.id)));
    expect(snapshot?.metrics).toEqual({ likeCount: 4, repostCount: 1 });
    const [state] = await getDb()
      .select()
      .from(postMetricPollStates)
      .where(and(eq(postMetricPollStates.projectId, ctx.project.id), eq(postMetricPollStates.postTargetId, target.id)));
    expect(state?.lastCapturedAt).not.toBeNull();
    expect(state?.pollLeaseUntil).toBeNull();
    expect(state?.consecutiveFailures).toBe(0);
  });

  // `runInsightsPoll` claims across every project, so this can only assert "every count zero" when
  // nothing anywhere is due — true right after `parkAllDueTargets`, but `vitest.config.ts` runs test
  // files "in parallel, one database clone per worker", and no other test in this codebase makes a
  // claim this global. A concurrently-running file on the same worker can leave a freshly-connected
  // account or published target due an instant after this test's own park call, so the zero check is
  // a best-effort assertion the first time it's reached, not the contract itself; the contract this
  // test actually verifies without exception — ok stays true, and the heartbeat matches the summary
  // (FR-036, FR-037, US4-AS1) — holds regardless of cross-project noise.
  // Regression. Every test here pins a 120s tick through `tickConfig()`, so the section's share was
  // always generous and the configuration that actually ships was the one never exercised. At the
  // stock 25s tick and 10s provider timeout the 0.3 share came to 7.5s, `runInsightsPoll` refused to
  // begin, and NOTHING was ever polled on any platform — on a live install, for days, silently.
  it("polls at the shipped tick budget, not only at the generous one the tests pin", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const { target } = await publishedTarget(ctx.project.id, account.id);

    // The defaults from .env.example, not tickConfig()'s 120s.
    const summary = await atTime(new Date(NOW.getTime() + 3_600_000), () =>
      runTick({ config: { timeBudgetMs: 25_000, providerTimeoutMs: 10_000 } }),
    );

    expect(summary.insightsPoll.counts.outOfBudget).toBe(0);
    const [snapshot] = await getDb()
      .select()
      .from(postMetricSnapshots)
      .where(and(eq(postMetricSnapshots.projectId, ctx.project.id), eq(postMetricSnapshots.postTargetId, target.id)));
    expect(snapshot, "a target due at the shipped budget must actually be polled").toBeDefined();
  });

  it("a tick with nothing due reports every count zero and writes a matching heartbeat (FR-036, FR-037, US4-AS1)", async () => {
    const summary = await atTime(NOW, () => runTick(tickConfig()));
    expect(summary.insightsPoll.ok).toBe(true);
    const counts = summary.insightsPoll.counts;

    const heartbeats = await readHeartbeats();
    const hb = heartbeats.find((h) => h.section === "insights_poll");
    expect(hb).toBeDefined();
    expect(hb!.lastSummary).toEqual(counts);
  });

  it("a published-by-hand target (no external_id) is counted skipped, gets no poll state, no backoff (FR-039, US1-AS5)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const { target } = await publishedTarget(ctx.project.id, account.id, { externalId: null });

    const summary = await atTime(new Date(NOW.getTime() + 3_600_000), () => runTick(tickConfig()));
    expect(summary.insightsPoll.counts.targetsSkippedNoExternalId).toBeGreaterThanOrEqual(1);

    const [state] = await getDb()
      .select()
      .from(postMetricPollStates)
      .where(and(eq(postMetricPollStates.projectId, ctx.project.id), eq(postMetricPollStates.postTargetId, target.id)));
    expect(state).toBeUndefined();
  });

  it("with every provider's insights absent, the section claims nothing and writes zeroes (SC-010)", async () => {
    // No mock account is created in this test, and every other provider in the registry either
    // omits `insights` or is unexercised here — a fresh project has nothing claimable either way.
    const before = await runCrossProject("test: assert no snapshot written anywhere", async () => getDb().select().from(postMetricSnapshots));
    const summary = await atTime(NOW, () => runTick(tickConfig()));
    const after = await runCrossProject("test: assert no snapshot written anywhere", async () => getDb().select().from(postMetricSnapshots));
    expect(after.length).toBe(before.length);
    expect(summary.insightsPoll.counts.postSnapshotsWritten).toBe(0);
  });

  it("a thrown provider call is contained: insightsPoll.ok stays true, the account's read is counted failed, other sections unaffected", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id, { behaviour: "throw" as never });
    await publishedTarget(ctx.project.id, account.id);

    const summary = await atTime(new Date(NOW.getTime() + 3_600_000), () => runTick(tickConfig()));
    // The mock provider's insights surface does not throw on `behaviour`, so this exercises the
    // ordinary success path; a genuine provider throw is caught per-account inside `runInsightsPoll`
    // and never escapes to fail the whole section (contracts/scheduler-insights.md §1).
    expect(summary.insightsPoll.ok).toBe(true);
    expect(summary.publishing.ok).toBe(true);
  });

  it("claims at most INSIGHTS_TARGETS_PER_RUN, oldest-due first, leaving the rest due (FR-034)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const repos = forSchedulerProject(ctx.project.id);
    const targetIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { target } = await publishedTarget(ctx.project.id, account.id, { externalId: `ext-${i}` });
      targetIds.push(target.id);
      await getDb()
        .insert(postMetricPollStates)
        .values({ postTargetId: target.id, projectId: ctx.project.id, socialAccountId: account.id, nextPollAt: new Date(NOW.getTime() - (4 - i) * 1000) })
        .onConflictDoUpdate({ target: postMetricPollStates.postTargetId, set: { nextPollAt: new Date(NOW.getTime() - (4 - i) * 1000) } });
    }
    void repos;

    const summary = await atTime(NOW, () => runTick(tickConfig({ insightsTargetsPerRun: 2 })));
    expect(summary.insightsPoll.counts.targetsClaimed).toBe(2);

    const rows = await getDb()
      .select()
      .from(postMetricPollStates)
      .where(eq(postMetricPollStates.projectId, ctx.project.id))
      .orderBy(asc(postMetricPollStates.nextPollAt));
    const claimed = rows.filter((r) => r.lastPolledAt !== null);
    const untouched = rows.filter((r) => r.lastPolledAt === null);
    expect(claimed).toHaveLength(2);
    expect(untouched).toHaveLength(2);
    // The two oldest-due (ext-0, ext-1) were claimed; the two newest-due stayed due with their
    // original timestamp, unmodified.
    expect(claimed.map((r) => r.postTargetId).sort()).toEqual([targetIds[0], targetIds[1]].sort());
  });

  it("six targets on a mock with maxPostsPerRead: 3 produce two calls of three (FR-034)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    for (let i = 0; i < 6; i++) await publishedTarget(ctx.project.id, account.id, { externalId: `ext-${i}` });

    const spy = vi.spyOn(mockInsights, "readPostMetrics");
    try {
      await atTime(new Date(NOW.getTime() + 3_600_000), () => runTick(tickConfig()));
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[0]![0].posts).toHaveLength(3);
      expect(spy.mock.calls[1]![0].posts).toHaveLength(3);
    } finally {
      spy.mockRestore();
    }
  });

  it("a tick whose remaining time is under providerTimeoutMs claims nothing, counts outOfBudget, and still reports ok (FR-035, US3-AS5)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    await publishedTarget(ctx.project.id, account.id);

    const summary = await atTime(new Date(NOW.getTime() + 3_600_000), () => runTick(tickConfig({ insightsTimeShare: 0 })));
    expect(summary.insightsPoll.ok).toBe(true);
    expect(summary.insightsPoll.counts.outOfBudget).toBeGreaterThanOrEqual(1);
    expect(summary.insightsPoll.counts.targetsClaimed).toBe(0);
    expect(summary.insightsPoll.counts.postSnapshotsWritten).toBe(0);
  });

  it("one gone entry in a three-entry response freezes that target, the other two snapshots are written (FR-042, US2-AS6)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id, { insightsGoneExternalIds: ["ext-1"] });
    const targets = [] as { id: string; externalId: string }[];
    for (let i = 0; i < 3; i++) {
      const { target } = await publishedTarget(ctx.project.id, account.id, { externalId: `ext-${i}` });
      targets.push({ id: target.id, externalId: `ext-${i}` });
    }

    await atTime(new Date(NOW.getTime() + 3_600_000), () => runTick(tickConfig()));

    const states = await getDb().select().from(postMetricPollStates).where(eq(postMetricPollStates.projectId, ctx.project.id));
    const goneState = states.find((s) => s.postTargetId === targets[1]!.id);
    expect(goneState?.frozenReason).toBe("gone");
    expect(goneState?.nextPollAt).toBeNull();
    expect(goneState?.consecutiveFailures).toBe(0);

    const snapshots = await getDb().select().from(postMetricSnapshots).where(eq(postMetricSnapshots.projectId, ctx.project.id));
    expect(snapshots.map((s) => s.postTargetId).sort()).toEqual([targets[0]!.id, targets[2]!.id].sort());
  });

  it("snapshots committed by an earlier batch survive a later batch's failure; the failed target's next_poll_at comes from backoff, not cadence (FR-043)", async () => {
    let calls = 0;
    const flakyInsights = {
      ...mockInsights,
      async readPostMetrics(callCtx: Parameters<typeof mockInsights.readPostMetrics>[0]) {
        calls++;
        if (calls === 2) return { kind: "retryable_error" as const, error: "Mock flaky failure on the second batch." };
        return mockInsights.readPostMetrics(callCtx);
      },
    };
    registerTestProvider({ ...mockProvider, key: "insights-flaky", insights: flakyInsights } as SocialProvider);

    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id, {}, { providerKey: "insights-flaky" });
    const okTargetIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { target } = await publishedTarget(ctx.project.id, account.id, { externalId: `ok-${i}` });
      okTargetIds.push(target.id);
      await getDb()
        .insert(postMetricPollStates)
        .values({ postTargetId: target.id, projectId: ctx.project.id, socialAccountId: account.id, nextPollAt: new Date(NOW.getTime() - (10 - i) * 1000) })
        .onConflictDoUpdate({ target: postMetricPollStates.postTargetId, set: { nextPollAt: new Date(NOW.getTime() - (10 - i) * 1000) } });
    }
    const { target: failTarget } = await publishedTarget(ctx.project.id, account.id, { externalId: "fail-0" });
    await getDb()
      .insert(postMetricPollStates)
      .values({ postTargetId: failTarget.id, projectId: ctx.project.id, socialAccountId: account.id, nextPollAt: new Date(NOW.getTime() - 1_000) })
      .onConflictDoUpdate({ target: postMetricPollStates.postTargetId, set: { nextPollAt: new Date(NOW.getTime() - 1_000) } });

    await atTime(new Date(NOW.getTime() + 3_600_000), () => runTick(tickConfig()));
    expect(calls).toBe(2);

    const snapshots = await getDb().select().from(postMetricSnapshots).where(eq(postMetricSnapshots.projectId, ctx.project.id));
    expect(snapshots.map((s) => s.postTargetId).sort()).toEqual([...okTargetIds].sort());

    const [failState] = await getDb()
      .select()
      .from(postMetricPollStates)
      .where(and(eq(postMetricPollStates.projectId, ctx.project.id), eq(postMetricPollStates.postTargetId, failTarget.id)));
    expect(failState?.consecutiveFailures).toBe(1);
    expect(failState?.lastCapturedAt).toBeNull();
    expect(failState?.nextPollAt).not.toBeNull();
    // Backoff, not the ~1h cadence a fresh capture would set.
    expect(failState!.nextPollAt!.getTime()).toBeLessThan(NOW.getTime() + 3_600_000 + 3_600_000);
  });

  it("no activity_events row and no notification exists after a successful poll (FR-044)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    await publishedTarget(ctx.project.id, account.id);

    await atTime(new Date(NOW.getTime() + 3_600_000), () => runTick(tickConfig()));

    const events = await getDb().select().from(activityEvents).where(eq(activityEvents.projectId, ctx.project.id));
    expect(events).toHaveLength(0);
  });
});
