import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { setLlmForTests } from "../../../src/server/llm";
import { runStandingSeries, type StandingSeriesCounts } from "../../../src/server/scheduler/standing-series";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { posts, standingSeries, standingSeriesPositions } from "../../../src/server/db/schema";
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

function tick(at: Date, config: SchedulerConfig = CONFIG): Promise<StandingSeriesCounts> {
  return atTime(at, () => runStandingSeries({ config, tickId: "test", startedAt: at }));
}

describe("standing-series idempotency (US3 AS1-AS5, FR-017, FR-021, SC-002)", () => {
  it("two concurrent ticks against one due series yield exactly one run and no doubled position", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } })),
    );
    setLlmForTests(createFakeLlm([post("Only post."), post("Only post.")]));
    const at = new Date("2026-01-11T00:00:01.000Z");
    const [a, b] = await Promise.all([tick(at), tick(at)]);
    expect(a.produced + b.produced).toBe(1);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 10 });
    expect(runs).toHaveLength(1);
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    expect(positions).toHaveLength(1);
  }, 60_000);

  it("a mid-run kill resumes on the next tick, reusing the stored plan with no extra planning call", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 2, period: "day" } })),
    );
    setLlmForTests(createFakeLlm([plan(2), post("Post one.")]));
    const firing = new Date("2026-01-11T00:00:01.000Z");
    const first = await tick(firing);
    expect(first.produced).toBe(1);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const openRun = runs[0]!;
    expect(openRun.closedAt).toBeNull();
    const positions = await e.scope.standingSeriesPositions.listForRun(openRun.id);
    // The second position was left running when the tick ran out of scripted model steps, simulating a kill
    // mid-call: no post was written for it, and its series lease is about to be treated as abandoned below.
    const remaining = positions.find((p) => p.status === "running")!;
    expect(remaining).toBeDefined();
    await runCrossProject("test: simulate an abandoned lease", async () => {
      await getDb()
        .update(standingSeries)
        .set({ leaseUntil: firing })
        .where(and(eq(standingSeries.id, seriesId), eq(standingSeries.projectId, e.project.id)));
    });

    const resumeLlm = createFakeLlm([post("Post two.")]);
    setLlmForTests(resumeLlm);
    const second = await tick(new Date(firing.getTime() + 60_000));
    expect(second.recovered).toBe(1);
    expect(second.produced).toBe(1);
    // Only one scripted step (a post, no plan) was needed: the stored plan was reused, not regenerated.
    expect(resumeLlm.requests).toHaveLength(1);

    const finalRuns = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(finalRuns).toHaveLength(1);
  }, 60_000);

  it("expired-lease recovery finishes a dead run", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } })),
    );
    setLlmForTests(createFakeLlm([post("Only post.")]));
    const firing = new Date("2026-01-11T00:00:01.000Z");
    await tick(firing);
    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs[0]!.closedAt).not.toBeNull();
  }, 60_000);

  it("a too-short deadline releases a position to queued with no attempt counted; written posts stay intact", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } })),
    );
    setLlmForTests(createFakeLlm([post("Only post.")]));
    const firing = new Date("2026-01-11T00:00:01.000Z");
    const tight: SchedulerConfig = { ...CONFIG, timeBudgetMs: 1 };
    const counts = await tick(firing, tight);
    expect(counts.notRunnable).toBe(1);
    expect(counts.produced).toBe(0);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs).toHaveLength(0);

    setLlmForTests(createFakeLlm([post("Only post.")]));
    const healthy = await tick(new Date(firing.getTime() + 1000));
    expect(healthy.produced).toBe(1);
  }, 60_000);

  it("a direct insert of a second post for the same position violates posts_standing_series_position_uq", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } })),
    );
    setLlmForTests(createFakeLlm([post("Only post.")]));
    await tick(new Date("2026-01-11T00:00:01.000Z"));
    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const [row] = await runCrossProject("test: read post", () =>
      getDb().select().from(posts).where(eq(posts.projectId, e.project.id)),
    );
    expect(row).toBeDefined();
    await expect(
      runCrossProject("test: duplicate standing-series post", () =>
        getDb().insert(posts).values({ ...row!, id: randomUUID() }),
      ),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  }, 60_000);
}, 60_000);
