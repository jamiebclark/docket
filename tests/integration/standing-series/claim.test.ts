import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimDueStandingSeries } from "../../../src/server/dal/standing-series-claims";
import { createStandingSeriesPositionsRepo, createStandingSeriesRepo, createStandingSeriesRunsRepo } from "../../../src/server/dal/standing-series";
import { INSTALL_CREDENTIAL_OWNER } from "../../../src/server/dal/credential-owners";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { posts, standingSeries } from "../../../src/server/db/schema";
import { closeDb } from "../../helpers/db";
import { createProject, createVoiceProfile } from "../../helpers/factories";
import { clearHolds, seedCreditHold } from "../../helpers/jobs-env";

/** Stops series left `enabled` and due by an earlier test in this file from being claimed by this one. */
async function parkStandingSeries(): Promise<void> {
  await runCrossProject("test: park standing series", async () => {
    await getDb().update(standingSeries).set({ enabled: false }).where(eq(standingSeries.enabled, true));
  });
}

beforeEach(async () => {
  await clearHolds();
  await parkStandingSeries();
});
afterEach(clearHolds);
afterAll(async () => {
  await closeDb();
});

const LEASE_MS = 300_000;

async function dueSeries(overrides: { nextRunAt?: Date; lastClaimedAt?: Date | null } = {}) {
  const project = await createProject();
  const voice = await createVoiceProfile(project.id);
  const repo = createStandingSeriesRepo(getDb(), project.id);
  const series = await repo.insert({
    name: `Series ${randomUUID().slice(0, 8)}`,
    brief: "Brief.",
    template: "Write about {{brief}}.",
    templateFields: [],
    voiceProfileId: voice.id,
    targetAccountIds: [randomUUID()],
    cadenceCount: 1,
    cadencePeriod: "week",
    mediaSource: "none",
    approvalPolicy: "review_required",
    schedulingPolicy: "leave_as_draft",
    nextRunAt: overrides.nextRunAt ?? new Date(Date.now() - 60_000),
  });
  if (overrides.lastClaimedAt !== undefined) {
    await runCrossProject("test: set last_claimed_at", async () => {
      await getDb().update(standingSeries).set({ lastClaimedAt: overrides.lastClaimedAt }).where(eq(standingSeries.id, series.id));
    });
  }
  return { project, series };
}

describe("claimDueStandingSeries", () => {
  it("never returns the same series to two concurrent claims", async () => {
    const a = await dueSeries();
    const b = await dueSeries();
    const [r1, r2] = await Promise.all([
      claimDueStandingSeries({ now: new Date(), limit: 1, leaseMs: LEASE_MS, maxAttempts: 3 }),
      claimDueStandingSeries({ now: new Date(), limit: 1, leaseMs: LEASE_MS, maxAttempts: 3 }),
    ]);
    const claimedIds = [...r1.series, ...r2.series].map((c) => c.series.id);
    expect(new Set(claimedIds)).toEqual(new Set([a.series.id, b.series.id]));
    expect(claimedIds).toHaveLength(2);
  }, 30_000);

  it("excludes a held owner's series entirely", async () => {
    const { series } = await dueSeries();
    const now = new Date();
    await seedCreditHold(INSTALL_CREDENTIAL_OWNER, { heldSince: now, nextProbeAt: new Date(now.getTime() + 10 * LEASE_MS) });
    const result = await claimDueStandingSeries({ now, limit: 5, leaseMs: LEASE_MS, maxAttempts: 3 });
    expect(result.series).toEqual([]);
    expect(result.held).toEqual([INSTALL_CREDENTIAL_OWNER]);
    expect(result.probing).toEqual([]);
    const reread = await createStandingSeriesRepo(getDb(), series.projectId).get(series.id);
    expect(reread).toMatchObject({ leaseOwner: null, lastClaimedAt: null });
  });

  it("lets exactly one series through as a probe for a held owner", async () => {
    const a = await dueSeries();
    const b = await dueSeries();
    const now = new Date();
    await seedCreditHold(INSTALL_CREDENTIAL_OWNER, { heldSince: now, nextProbeAt: now });
    const result = await claimDueStandingSeries({ now, limit: 5, leaseMs: LEASE_MS, maxAttempts: 3 });
    expect(result.series).toHaveLength(1);
    expect(result.series[0]!.probe).toBe(true);
    expect([a.series.id, b.series.id]).toContain(result.series[0]!.series.id);
    expect(result.probing).toEqual([INSTALL_CREDENTIAL_OWNER]);
  });

  it("prefers the series whose last_claimed_at is longest ago (NULLS FIRST)", async () => {
    const now = new Date();
    const claimedRecently = await dueSeries({ nextRunAt: now, lastClaimedAt: new Date(now.getTime() - 1_000) });
    const neverClaimed = await dueSeries({ nextRunAt: now, lastClaimedAt: null });
    const result = await claimDueStandingSeries({ now, limit: 1, leaseMs: LEASE_MS, maxAttempts: 3 });
    expect(result.series).toHaveLength(1);
    expect(result.series[0]!.series.id).toBe(neverClaimed.series.id);
    void claimedRecently;
  });

  async function openRunWithRunningPosition(now: Date) {
    const { project, series } = await dueSeries({ nextRunAt: now });
    const runs = createStandingSeriesRunsRepo(getDb(), project.id);
    const run = await runs.openRun({
      seriesId: series.id,
      period: "week",
      periodStart: "2026-01-05",
      periodStartAt: now,
      requestedCount: 1,
      config: { v: 1 },
    });
    const positions = createStandingSeriesPositionsRepo(getDb(), project.id);
    const [position] = await positions.insertMany(run.id, 1);
    await positions.update(position!.id, { status: "running", startedAt: now, attemptCount: 1 });
    return { project, series, run, position: position!, positions };
  }

  it("leaves a stale running position with a saved post running, for the producer to finish with no model call", async () => {
    const now = new Date();
    const { project, position, positions } = await openRunWithRunningPosition(now);
    const post = await runCrossProject("test: write post", async () => {
      return await getDb()
        .insert(posts)
        .values({ projectId: project.id, baseText: "Already written." })
        .returning();
    });
    await runCrossProject("test: link post to position", async () => {
      await getDb().update(posts).set({ standingSeriesPositionId: position.id }).where(eq(posts.id, post[0]!.id));
    });
    await claimDueStandingSeries({ now, limit: 5, leaseMs: LEASE_MS, maxAttempts: 3 });
    const reread = await positions.update(position.id, {});
    expect(reread!.status).toBe("running");
  });

  it("fails a stale running position as interrupted once attempts reach the cap", async () => {
    const now = new Date();
    const { position, positions } = await openRunWithRunningPosition(now);
    await positions.update(position.id, { status: "running", attemptCount: 2 }); // one more attempt reaches maxAttempts (3)
    await claimDueStandingSeries({ now, limit: 5, leaseMs: LEASE_MS, maxAttempts: 3 });
    const reread = await positions.update(position.id, {});
    expect(reread).toMatchObject({
      status: "failed",
      lastErrorKind: "interrupted",
      lastError: "Generation was interrupted too many times.",
    });
  });

  it("requeues a stale running position with one more attempt counted, below the cap", async () => {
    const now = new Date();
    const { position, positions } = await openRunWithRunningPosition(now);
    await positions.update(position.id, { status: "running", attemptCount: 0 });
    await claimDueStandingSeries({ now, limit: 5, leaseMs: LEASE_MS, maxAttempts: 3 });
    const reread = await positions.update(position.id, {});
    expect(reread).toMatchObject({ status: "queued", attemptCount: 1 });
    expect(reread!.nextAttemptAt.getTime()).toBe(now.getTime());
  });
});
