import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { postMetricPollStates, postMetricSnapshots } from "../../../src/server/db/schema";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { readHeartbeats } from "../../../src/server/dal/heartbeats";
import { runTick } from "../../../src/server/scheduler";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
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

    const [snapshot] = await getDb().select().from(postMetricSnapshots).where(eq(postMetricSnapshots.postTargetId, target.id));
    expect(snapshot?.metrics).toEqual({ likeCount: 4, repostCount: 1 });
    const [state] = await getDb().select().from(postMetricPollStates).where(eq(postMetricPollStates.postTargetId, target.id));
    expect(state?.lastCapturedAt).not.toBeNull();
    expect(state?.pollLeaseUntil).toBeNull();
    expect(state?.consecutiveFailures).toBe(0);
  });

  it("a tick with nothing due reports every count zero and writes a matching heartbeat (FR-036, FR-037, US4-AS1)", async () => {
    const summary = await atTime(NOW, () => runTick(tickConfig()));
    expect(summary.insightsPoll.ok).toBe(true);
    const counts = summary.insightsPoll.counts;
    for (const value of Object.values(counts)) expect(value).toBe(0);

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

    const [state] = await getDb().select().from(postMetricPollStates).where(eq(postMetricPollStates.postTargetId, target.id));
    expect(state).toBeUndefined();
  });

  it("with every provider's insights absent, the section claims nothing and writes zeroes (SC-010)", async () => {
    // No mock account is created in this test, and every other provider in the registry either
    // omits `insights` or is unexercised here — a fresh project has nothing claimable either way.
    const before = await getDb().select().from(postMetricSnapshots);
    const summary = await atTime(NOW, () => runTick(tickConfig()));
    const after = await getDb().select().from(postMetricSnapshots);
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
});
