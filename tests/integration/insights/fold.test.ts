import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { accountMetricRollups, accountMetricSnapshots, socialAccounts } from "../../../src/server/db/schema";
import { foldAndPruneAccountSnapshotsBefore } from "../../../src/server/dal/insights";
import { accountMetricReadingRows, latestPerSubjectMetricDay } from "../../../src/server/dal/insights-read";
import { shapeFor } from "../../../src/providers/registry";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(closeDb);

const DAY_MS = 86_400_000;

/** Drains any backlog a prior test in this file deliberately left behind (e.g. the rollback test), so a
 * bounded-batch assertion in the next test claims only rows this test itself creates. */
async function drainBacklog(): Promise<void> {
  for (;;) {
    const pass = await runCrossProject("test: drain insights fold backlog", () => foldAndPruneAccountSnapshotsBefore(new Date(), 10_000, shapeFor));
    if (pass.snapshotsDeleted === 0) return;
  }
}

beforeEach(drainBacklog);

describe("insights fold (contracts/fold.md §7, US5, FR-050 to FR-057)", () => {
  it("500 days of snapshots over 400-day retention: the trend still draws 500 days, old snapshots gone (US5.1, SC-005)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const now = Date.now();
    for (let i = 0; i < 500; i++) {
      await env.scope.accountMetricSnapshots.insertIfAbsent({
        socialAccountId: account.id,
        providerKey: "mock",
        capturedAt: new Date(now - (500 - i) * DAY_MS),
        metrics: { followersCount: i },
      });
    }
    const before = new Date(now - 400 * DAY_MS);
    let counts = { pointsFolded: 0, snapshotsDeleted: 0 };
    for (;;) {
      const pass = await runCrossProject("test: fold and prune", () => foldAndPruneAccountSnapshotsBefore(before, 1000, shapeFor));
      counts = pass;
      if (pass.snapshotsDeleted === 0) break;
    }
    const rows = await accountMetricReadingRows(env.project.id, [account.id], new Date(now - 600 * DAY_MS), new Date(now + DAY_MS));
    const days = new Set(latestPerSubjectMetricDay(rows).map((r) => r.capturedAt.toISOString().slice(0, 10)));
    expect(days.size).toBeGreaterThanOrEqual(499);
    const remaining = await getDb()
      .select()
      .from(accountMetricSnapshots)
      .where(and(eq(accountMetricSnapshots.projectId, env.project.id), eq(accountMetricSnapshots.socialAccountId, account.id)));
    expect(remaining.every((r) => r.capturedAt >= before)).toBe(true);
    void counts;
  });

  it("a failing fold deletes no snapshot (US5.2, FR-052)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const before = new Date(Date.now() - DAY_MS);
    await env.scope.accountMetricSnapshots.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: new Date(before.getTime() - DAY_MS),
      metrics: { followersCount: 1 },
    });
    const throwingShapeFor: typeof shapeFor = () => {
      throw new Error("boom");
    };
    await expect(runCrossProject("test: fold and prune", () => foldAndPruneAccountSnapshotsBefore(before, 10, throwingShapeFor))).rejects.toThrow("boom");
    const remaining = await getDb()
      .select()
      .from(accountMetricSnapshots)
      .where(and(eq(accountMetricSnapshots.projectId, env.project.id), eq(accountMetricSnapshots.socialAccountId, account.id)));
    expect(remaining).toHaveLength(1);
    const points = await getDb()
      .select()
      .from(accountMetricRollups)
      .where(and(eq(accountMetricRollups.projectId, env.project.id), eq(accountMetricRollups.socialAccountId, account.id)));
    expect(points).toHaveLength(0);
  });

  it("a batch smaller than the backlog deletes nothing newer than what was folded (US5.3, FR-051)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const before = new Date(Date.now() - DAY_MS);
    const ages = [1, 2, 3].map((d) => new Date(before.getTime() - d * DAY_MS));
    for (const capturedAt of ages) {
      await env.scope.accountMetricSnapshots.insertIfAbsent({ socialAccountId: account.id, providerKey: "mock", capturedAt, metrics: { followersCount: 1 } });
    }
    const pass = await runCrossProject("test: fold and prune", () => foldAndPruneAccountSnapshotsBefore(before, 2, shapeFor));
    expect(pass.snapshotsDeleted).toBe(2);
    const remaining = await getDb()
      .select()
      .from(accountMetricSnapshots)
      .where(and(eq(accountMetricSnapshots.projectId, env.project.id), eq(accountMetricSnapshots.socialAccountId, account.id)));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.capturedAt).toEqual(ages[0]);
  });

  it("re-running over the same days is idempotent (US5.4, FR-053)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const before = new Date(Date.now() - DAY_MS);
    await env.scope.accountMetricSnapshots.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: new Date(before.getTime() - DAY_MS),
      metrics: { followersCount: 7 },
    });
    await runCrossProject("test: fold and prune", () => foldAndPruneAccountSnapshotsBefore(before, 10, shapeFor));
    const pointsAfterFirst = await getDb()
      .select()
      .from(accountMetricRollups)
      .where(and(eq(accountMetricRollups.projectId, env.project.id), eq(accountMetricRollups.socialAccountId, account.id)));
    expect(pointsAfterFirst).toHaveLength(1);
    const second = await runCrossProject("test: fold and prune", () => foldAndPruneAccountSnapshotsBefore(before, 10, shapeFor));
    expect(second.snapshotsDeleted).toBe(0);
    const pointsAfterSecond = await getDb()
      .select()
      .from(accountMetricRollups)
      .where(and(eq(accountMetricRollups.projectId, env.project.id), eq(accountMetricRollups.socialAccountId, account.id)));
    expect(pointsAfterSecond).toEqual(pointsAfterFirst);
  });

  it("a day with both a point and a surviving snapshot yields exactly one value (US5.5, FR-054)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const now = Date.now();
    const before = new Date(now - 30 * DAY_MS);
    const day = new Date(Date.UTC(2026, 0, 1));
    await env.scope.accountMetricSnapshots.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: new Date(day.getTime() + 1 * 3_600_000),
      metrics: { followersCount: 1 },
    });
    await runCrossProject("test: fold and prune", () => foldAndPruneAccountSnapshotsBefore(new Date(day.getTime() + 12 * 3_600_000), 10, shapeFor));
    // a second, newer snapshot the same UTC day, not yet due for pruning
    await env.scope.accountMetricSnapshots.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: new Date(day.getTime() + 2 * 3_600_000),
      metrics: { followersCount: 2 },
    });
    void before;
    const rows = await accountMetricReadingRows(env.project.id, [account.id], day, new Date(day.getTime() + DAY_MS));
    const bucketed = latestPerSubjectMetricDay(rows).filter((r) => r.metricKey === "followersCount");
    expect(bucketed).toHaveLength(1);
    expect(bucketed[0]!.value).toBe(2);
  });

  it("an account deletion cascades its points (US5.6, FR-056)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const before = new Date(Date.now() - DAY_MS);
    await env.scope.accountMetricSnapshots.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: new Date(before.getTime() - DAY_MS),
      metrics: { followersCount: 1 },
    });
    await runCrossProject("test: fold and prune", () => foldAndPruneAccountSnapshotsBefore(before, 10, shapeFor));
    expect(
      await getDb()
        .select()
        .from(accountMetricRollups)
        .where(and(eq(accountMetricRollups.projectId, env.project.id), eq(accountMetricRollups.socialAccountId, account.id))),
    ).toHaveLength(1);

    await runCrossProject("test: delete account", () =>
      getDb().delete(socialAccounts).where(and(eq(socialAccounts.projectId, env.project.id), eq(socialAccounts.id, account.id))),
    );

    expect(
      await getDb()
        .select()
        .from(accountMetricRollups)
        .where(and(eq(accountMetricRollups.projectId, env.project.id), eq(accountMetricRollups.socialAccountId, account.id))),
    ).toHaveLength(0);
  });

  it("two concurrent folds over the same backlog double-write nothing (FR-057)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const before = new Date(Date.now() - DAY_MS);
    const ages = [1, 2, 3, 4].map((d) => new Date(before.getTime() - d * DAY_MS));
    for (const capturedAt of ages) {
      await env.scope.accountMetricSnapshots.insertIfAbsent({ socialAccountId: account.id, providerKey: "mock", capturedAt, metrics: { followersCount: 1 } });
    }
    const [a, b] = await Promise.all([
      runCrossProject("test: fold and prune", () => foldAndPruneAccountSnapshotsBefore(before, 2, shapeFor)),
      runCrossProject("test: fold and prune", () => foldAndPruneAccountSnapshotsBefore(before, 2, shapeFor)),
    ]);
    expect(a.snapshotsDeleted + b.snapshotsDeleted).toBe(4);
    const remaining = await getDb()
      .select()
      .from(accountMetricSnapshots)
      .where(and(eq(accountMetricSnapshots.projectId, env.project.id), eq(accountMetricSnapshots.socialAccountId, account.id)));
    expect(remaining).toHaveLength(0);
  });

  it("captured_day is the UTC day of captured_at for every point written", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const before = new Date(Date.now() - DAY_MS);
    const capturedAt = new Date(Date.UTC(2025, 5, 15, 23, 59, 59, 999) - 10 * DAY_MS);
    await env.scope.accountMetricSnapshots.insertIfAbsent({ socialAccountId: account.id, providerKey: "mock", capturedAt, metrics: { followersCount: 1 } });
    await runCrossProject("test: fold and prune", () => foldAndPruneAccountSnapshotsBefore(before, 10, shapeFor));
    const [point] = await getDb()
      .select()
      .from(accountMetricRollups)
      .where(and(eq(accountMetricRollups.projectId, env.project.id), eq(accountMetricRollups.socialAccountId, account.id)));
    expect(point!.capturedDay).toBe(capturedAt.toISOString().slice(0, 10));
  });

  it("a pass that folds nothing reports zero rather than being silent (FR-055)", async () => {
    const pass = await runCrossProject("test: fold and prune", () => foldAndPruneAccountSnapshotsBefore(new Date(0), 10, shapeFor));
    expect(pass).toEqual({ pointsFolded: 0, snapshotsDeleted: 0 });
  });
});
