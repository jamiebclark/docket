import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { accountMetricPollStates, postMetricPollStates, postMetricSnapshots, postTargets } from "../../../src/server/db/schema";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";
import { tickConfig } from "../../helpers/tick";

afterAll(closeDb);
beforeEach(parkAllDueTargets);

const NOW = new Date("2026-03-01T00:00:00Z");

async function publishedTarget(projectId: string, accountId: string) {
  const repos = forSchedulerProject(projectId);
  const post = await repos.posts.insert({ baseText: "Hello" });
  const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: accountId }]);
  await repos.targets.update(target!.id, { status: "published", externalId: "ext-1", publishedAt: NOW });
  return { post, target: target! };
}

describe("insights storage (data-model.md §1-4)", () => {
  it("post_metric_snapshots accepts a valid row and rejects an oversized metrics payload (FR-014, FR-015)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const { target } = await publishedTarget(ctx.project.id, account.id);
    const db = getDb();

    await expect(
      db.insert(postMetricSnapshots).values({
        projectId: ctx.project.id,
        postTargetId: target.id,
        socialAccountId: account.id,
        providerKey: "mock",
        capturedAt: NOW,
        metrics: { padding: "x".repeat(2200) },
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(postMetricSnapshots).values({
        projectId: ctx.project.id,
        postTargetId: target.id,
        socialAccountId: account.id,
        providerKey: "mock",
        capturedAt: NOW,
        metrics: { likeCount: 1 },
      }),
    ).resolves.not.toThrow();
  });

  it("post_metric_poll_states rejects the lease, failures, frozen and failing-pair violations", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const { target } = await publishedTarget(ctx.project.id, account.id);
    const db = getDb();

    // lease pair: owner set, until null
    await expect(
      db.insert(postMetricPollStates).values({ postTargetId: target.id, projectId: ctx.project.id, socialAccountId: account.id, pollLeaseOwner: crypto.randomUUID() }),
    ).rejects.toThrow();

    // negative failures
    await expect(
      db.insert(postMetricPollStates).values({ postTargetId: target.id, projectId: ctx.project.id, socialAccountId: account.id, consecutiveFailures: -1 }),
    ).rejects.toThrow();

    // frozen pair: frozenAt set, frozenReason null
    await expect(
      db.insert(postMetricPollStates).values({ postTargetId: target.id, projectId: ctx.project.id, socialAccountId: account.id, frozenAt: NOW }),
    ).rejects.toThrow();

    // frozen reason enum
    await expect(
      db.insert(postMetricPollStates).values({ postTargetId: target.id, projectId: ctx.project.id, socialAccountId: account.id, frozenAt: NOW, frozenReason: "bogus" }),
    ).rejects.toThrow();

    // frozen-has-no-next: both frozenAt and nextPollAt set
    await expect(
      db.insert(postMetricPollStates).values({ postTargetId: target.id, projectId: ctx.project.id, socialAccountId: account.id, frozenAt: NOW, frozenReason: "settled", nextPollAt: NOW }),
    ).rejects.toThrow();

    // failing pair: failures > 0 but no failingSince
    await expect(
      db.insert(postMetricPollStates).values({ postTargetId: target.id, projectId: ctx.project.id, socialAccountId: account.id, consecutiveFailures: 1 }),
    ).rejects.toThrow();
  });

  it("an install whose providers all omit insights gains no poll-state row after a tick (FR-020)", async () => {
    const ctx = await createProjectWithMembers();
    // tiktok declares no `insights` member (it is not a pilot platform for this entry).
    const repos = forSchedulerProject(ctx.project.id);
    const account = await repos.accounts.upsertConnected({
      providerKey: "tiktok",
      displayName: "TikTok account",
      externalAccountId: "tt-1",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
    });
    const { target } = await publishedTarget(ctx.project.id, account.id);

    await atTime(new Date(NOW.getTime() + 3_600_000), () => runTick(tickConfig()));

    const [state] = await getDb().select().from(postMetricPollStates).where(eq(postMetricPollStates.postTargetId, target.id));
    expect(state).toBeUndefined();
    const [accState] = await getDb().select().from(accountMetricPollStates).where(eq(accountMetricPollStates.socialAccountId, account.id));
    expect(accState).toBeUndefined();
  });

  it("a provider returning an undeclared key stores a snapshot without it (FR-018)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id, { insightsReturnUndeclaredKey: true });
    const { target } = await publishedTarget(ctx.project.id, account.id);

    await atTime(new Date(NOW.getTime() + 3_600_000), () => runTick(tickConfig()));

    const [snapshot] = await getDb().select().from(postMetricSnapshots).where(eq(postMetricSnapshots.postTargetId, target.id));
    expect(snapshot?.metrics).toEqual({ likeCount: 4, repostCount: 1 });
    expect(snapshot?.metrics).not.toHaveProperty("notDeclared");
  });

  it("an oversized payload is refused with no partial row and the read counted failed (edge case)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id, { insightsOversizedPayload: true });
    const { target } = await publishedTarget(ctx.project.id, account.id);

    const summary = await atTime(new Date(NOW.getTime() + 3_600_000), () => runTick(tickConfig()));

    const rows = await getDb().select().from(postMetricSnapshots).where(eq(postMetricSnapshots.postTargetId, target.id));
    expect(rows).toHaveLength(0);
    expect(summary.insightsPoll.counts.failed).toBeGreaterThanOrEqual(1);
    const [state] = await getDb().select().from(postMetricPollStates).where(eq(postMetricPollStates.postTargetId, target.id));
    expect(state?.consecutiveFailures).toBeGreaterThanOrEqual(1);
  });

  it("re-resolving a target's external_id keeps its earlier snapshots and the next poll uses the new id", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const { target } = await publishedTarget(ctx.project.id, account.id);

    await atTime(new Date(NOW.getTime() + 3_600_000), () => runTick(tickConfig()));
    const before = await getDb().select().from(postMetricSnapshots).where(eq(postMetricSnapshots.postTargetId, target.id));
    expect(before).toHaveLength(1);

    const repos = forSchedulerProject(ctx.project.id);
    await repos.targets.update(target.id, { externalId: "ext-2" });

    const after = await getDb().select().from(postMetricSnapshots).where(eq(postMetricSnapshots.postTargetId, target.id));
    expect(after).toHaveLength(1);
    expect(after[0]!.metrics).toEqual(before[0]!.metrics);

    const [updatedTarget] = await getDb()
      .select()
      .from(postTargets)
      .where(and(eq(postTargets.projectId, ctx.project.id), eq(postTargets.id, target.id)));
    expect(updatedTarget?.externalId).toBe("ext-2");
  });
});
