import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setLlmForTests } from "../../../src/server/llm";
import { runStandingSeries, type StandingSeriesCounts } from "../../../src/server/scheduler/standing-series";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { standingSeries } from "../../../src/server/db/schema";
import { closeDb } from "../../helpers/db";
import { atTime } from "../../helpers/clock";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { clearHolds } from "../../helpers/jobs-env";
import { standingSeriesEnv } from "../../helpers/standing-series-env";

const CONFIG: SchedulerConfig = {
  timeBudgetMs: 120_000,
  maxItems: 10,
  leaseMs: 300_000,
  providerTimeoutMs: 20_000,
  maxAttempts: 3,
  backoffBaseMs: 60_000,
  backoffMaxMs: 900_000,
  maxPublishDurationMs: 3_600_000,
  refreshWindowMs: 7_200_000,
  refreshMaxAccounts: 5,
  batchSize: 4,
  standingSeriesMaxSeries: 5,
  standingSeriesMaxPosts: 5,
};

/** Parks every series left enabled by another test file, so this file's ticks claim only its own. */
async function parkOtherSeries(): Promise<void> {
  await runCrossProject("test: park standing series", async () => {
    await getDb().update(standingSeries).set({ enabled: false }).where(eq(standingSeries.enabled, true));
  });
}

beforeEach(async () => {
  await clearHolds();
  await parkOtherSeries();
});
afterEach(async () => {
  setLlmForTests(null);
  await clearHolds();
});
afterAll(async () => {
  await closeDb();
});

const post = (text: string): FakeStep => ({ ok: { variants: { mock: { text } } } });
const plan = (n: number, prefix = "Angle"): FakeStep => ({
  ok: { angles: Array.from({ length: n }, (_, i) => ({ title: `${prefix} ${i + 1}`, description: `About thing ${i + 1}` })) },
});

async function tick(at: Date): Promise<StandingSeriesCounts> {
  return atTime(at, () => runStandingSeries({ config: CONFIG, tickId: "test", startedAt: at }));
}

describe("standing-series cadence (US1 AS1-AS5, FR-010, FR-011, FR-013, FR-016)", () => {
  it("a series created mid-week due at the coming Monday produces no output before then", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-14T12:00:00.000Z"); // Wednesday
    await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "week" } })),
    );
    setLlmForTests(createFakeLlm([post("Should not run.")]));
    const counts = await tick(new Date("2026-01-15T00:00:00.000Z"));
    expect(counts.claimed).toBe(0);
  });

  it("ticking past the boundary produces exactly the configured count with origin=generated and a standingSeriesPositionId", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 2, period: "day" } })),
    );
    setLlmForTests(createFakeLlm([plan(2), post("Post one."), post("Post two.")]));
    const firingTime = new Date("2026-01-11T00:00:01.000Z");
    const counts = await tick(firingTime);
    expect(counts.produced).toBe(2);

    const { rows } = await e.scope.standingSeries.list({ page: 1, pageSize: 10 });
    const runs = await e.scope.standingSeriesRuns.listForSeries(rows[0]!.id, { limit: 5 });
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    expect(positions).toHaveLength(2);
    for (const position of positions) {
      const saved = await e.scope.posts.findByStandingSeriesPosition(position.id);
      expect(saved).not.toBeNull();
    }
  });

  it("a further tick within the same period produces nothing more", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } })),
    );
    setLlmForTests(createFakeLlm([post("Only post.")]));
    const first = await tick(new Date("2026-01-11T00:00:01.000Z"));
    expect(first.produced).toBe(1);

    setLlmForTests(createFakeLlm([post("Should not be called.")]));
    const second = await tick(new Date("2026-01-11T06:00:00.000Z"));
    expect(second.claimed).toBe(0);
    expect(second.produced).toBe(0);
  });

  it("a 1-post series makes no planning call", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } })),
    );
    const llm = createFakeLlm([post("Only post.")]);
    setLlmForTests(llm);
    const counts = await tick(new Date("2026-01-11T00:00:01.000Z"));
    expect(counts.produced).toBe(1);
  });

  it("a second period's stored plan differs from the first's", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 2, period: "day" } })),
    );
    setLlmForTests(createFakeLlm([plan(2), post("Day one post A."), post("Day one post B.")]));
    await tick(new Date("2026-01-11T00:00:01.000Z"));
    const runs1 = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 10 });
    const firstPlan = runs1[0]!.plan;

    setLlmForTests(createFakeLlm([plan(2, "Second-day angle"), post("Day two post A."), post("Day two post B.")]));
    await tick(new Date("2026-01-12T00:00:01.000Z"));
    const runs2 = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 10 });
    const secondPlan = runs2.find((r) => r.id !== runs1[0]!.id)!.plan;
    expect(secondPlan).not.toEqual(firstPlan);
  });

  it("no-backfill: missed_periods is recorded but the gap is never iterated into extra runs", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } })),
    );
    setLlmForTests(createFakeLlm([post("Only post.")]));
    const counts = await tick(new Date("2026-01-10T00:00:01.000Z"));
    expect(counts.produced).toBe(1);
    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.missedPeriods).toBeGreaterThan(0);
  });
}, 60_000);
