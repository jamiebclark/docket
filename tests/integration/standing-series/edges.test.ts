import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLlmForTests } from "../../../src/server/llm";
import { runStandingSeries, type StandingSeriesCounts } from "../../../src/server/scheduler/standing-series";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { createStandingSeries, updateStandingSeries } from "../../../src/server/services/standing-series/manage";
import { openOrResumeRun } from "../../../src/server/services/standing-series/run";
import { createVoiceProfilesRepo } from "../../../src/server/dal/voice";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { standingSeries } from "../../../src/server/db/schema";
import { closeDb } from "../../helpers/db";
import { atTime } from "../../helpers/clock";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { clearHolds, clearProjectCredentials } from "../../helpers/jobs-env";
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
  await clearProjectCredentials();
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

async function tick(at: Date, over: Partial<SchedulerConfig> = {}): Promise<StandingSeriesCounts> {
  return atTime(at, () => runStandingSeries({ config: { ...CONFIG, ...over }, tickId: "test", startedAt: at }));
}

describe("standing-series edge cases (US6, FR-053 and friends)", () => {
  it("records no_usable_target once every target account is removed", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } })),
    );
    await e.scope.accounts.markRemoved(e.account.id, created);

    setLlmForTests(createFakeLlm([]));
    const t0 = new Date("2026-01-11T00:00:01.000Z");
    const counts = await tick(t0);
    expect(counts.blocked).toBe(1);
    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs[0]).toMatchObject({ blockedReason: "no_usable_target", droppedAccountIds: [e.account.id] });
    expect(runs[0]!.closedAt).not.toBeNull();
  });

  it("records voice_profile_missing once the voice profile is archived", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } })),
    );
    await createVoiceProfilesRepo(getDb(), e.project.id).setArchived(e.profile.id, created);

    setLlmForTests(createFakeLlm([]));
    const t0 = new Date("2026-01-11T00:00:01.000Z");
    const counts = await tick(t0);
    expect(counts.blocked).toBe(1);
    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs[0]).toMatchObject({ blockedReason: "voice_profile_missing" });
  });

  it("records an account removed between runs in dropped_account_ids, without blocking a series with another live target", async () => {
    const e = await standingSeriesEnv();
    const second = await e.addAccount();
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" }, targetAccountIds: [e.account.id, second.id] })),
    );

    setLlmForTests(createFakeLlm([post("Day one.")]));
    const t0 = new Date("2026-01-11T00:00:01.000Z");
    const first = await tick(t0);
    expect(first.produced).toBe(1);

    await e.scope.accounts.markRemoved(e.account.id, t0);

    setLlmForTests(createFakeLlm([post("Day two.")]));
    const t1 = new Date("2026-01-12T00:00:01.000Z");
    const second_ = await tick(t1);
    expect(second_.produced).toBe(1);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const run2 = runs.find((r) => r.periodStart === "2026-01-12")!;
    expect(run2.droppedAccountIds).toEqual([e.account.id]);
    expect(run2.blockedReason).toBeNull();
  });

  it("a cadence lowered mid-run does not truncate the already-open run", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 3, period: "day" } })),
    );
    const now = new Date("2026-01-11T00:00:01.000Z");
    const series = (await e.scope.standingSeries.get(seriesId))!;
    const opened = await openOrResumeRun(e.scope, series, now);
    expect(opened!.run.requestedCount).toBe(3);

    await updateStandingSeries(e.scope, seriesId, e.create({ cadence: { count: 1, period: "day" } }));

    const run = await e.scope.standingSeriesRuns.get(opened!.run.id);
    expect(run!.requestedCount).toBe(3);
    const positions = await e.scope.standingSeriesPositions.listForRun(opened!.run.id);
    expect(positions).toHaveLength(3);
  });

  it("an edit while a run is open changes nothing about that run's own snapshot", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ brief: "Original brief." })),
    );
    const now = new Date("2026-01-11T00:00:01.000Z");
    const series = (await e.scope.standingSeries.get(seriesId))!;
    const opened = await openOrResumeRun(e.scope, series, now);

    await updateStandingSeries(e.scope, seriesId, e.create({ brief: "Edited brief." }));

    const run = await e.scope.standingSeriesRuns.get(opened!.run.id);
    expect((run!.config as { brief: string }).brief).toBe("Original brief.");
    const edited = await e.scope.standingSeries.get(seriesId);
    expect(edited!.brief).toBe("Edited brief.");
  });

  it("reports notRunnable=1 when the tick budget is too short to make even one call", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    await atTime(created, () => createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } })));
    setLlmForTests(createFakeLlm([post("Should never be called.")]));

    const t0 = new Date("2026-01-11T00:00:01.000Z");
    const counts = await tick(t0, { timeBudgetMs: 1_000 });
    expect(counts).toMatchObject({ notRunnable: 1, claimed: 0, produced: 0 });
  });

  it("reports notConfigured=1 when no text provider is configured anywhere, claiming no series", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    await atTime(created, () => createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } })));

    const t0 = new Date("2026-01-11T00:00:01.000Z");
    const counts = await tick(t0);
    expect(counts).toMatchObject({ notConfigured: 1, claimed: 0, produced: 0 });
  });

  it("spreads a cadence above the per-tick cap across ticks, closing the run only once nothing is left (FR-044, review F2/F12)", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 3, period: "day" } })),
    );

    const plan: FakeStep = {
      ok: {
        angles: [
          { title: "Angle 1", description: "About thing 1" },
          { title: "Angle 2", description: "About thing 2" },
          { title: "Angle 3", description: "About thing 3" },
        ],
      },
    };
    setLlmForTests(createFakeLlm([plan, post("One."), post("Two."), post("Three.")]));
    const t0 = new Date("2026-01-11T00:00:01.000Z");
    const first = await tick(t0, { standingSeriesMaxPosts: 1 });
    expect(first).toMatchObject({ produced: 1, runsClosed: 0 });
    let run = (await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 1 }))[0]!;
    expect(run.closedAt).toBeNull();

    // Each tick must outlast the series lease (default 300s) for the worker to re-claim the same
    // still-open run rather than finding it already leased to "itself".
    const t1 = new Date("2026-01-11T00:06:02.000Z");
    const second = await tick(t1, { standingSeriesMaxPosts: 1 });
    expect(second).toMatchObject({ produced: 1, runsClosed: 0 });
    run = (await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 1 }))[0]!;
    expect(run.closedAt).toBeNull();

    // The third and last post lands exactly on the per-tick cap — the run must still close in this
    // same tick rather than waiting for a boundary that never comes due again (review F2).
    const t2 = new Date("2026-01-11T00:12:03.000Z");
    const third = await tick(t2, { standingSeriesMaxPosts: 1 });
    expect(third).toMatchObject({ produced: 1, runsClosed: 1 });
    run = (await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 1 }))[0]!;
    expect(run).toMatchObject({ outcome: "produced_all" });
  });

  it("doesn't close a run in the same tick a position enters retry backoff while another finishes (FR-022, review F1/F12)", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 2, period: "day" } })),
    );

    const plan: FakeStep = {
      ok: { angles: [{ title: "Angle 1", description: "About thing 1" }, { title: "Angle 2", description: "About thing 2" }] },
    };
    // Tick 1: position 0's call fails "rate_limited" (not schema-correction-retryable, so it
    // surfaces straight to the runner's own TEMPORARY/backoff handling) and enters backoff; the
    // tick returns without touching position 1.
    setLlmForTests(createFakeLlm([plan, { fail: "rate_limited" }]));
    const t0 = new Date("2026-01-11T00:00:01.000Z");
    const first = await tick(t0, { leaseMs: 5_000 });
    expect(first).toMatchObject({ produced: 0, retried: 1, failed: 0, runsClosed: 0 });
    let run = (await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 1 }))[0]!;
    expect(run.closedAt).toBeNull();

    // Tick 2: past the lease but still inside position 0's 60s backoff. Position 1 produces, the
    // loop continues, and `nextDue` now returns `null` — exactly the shape review F1 found. That
    // must not be read as "nothing left": position 0 is still queued, so the run stays open.
    setLlmForTests(createFakeLlm([post("Position one.")]));
    const t1 = new Date("2026-01-11T00:00:07.000Z");
    const second = await tick(t1, { leaseMs: 5_000 });
    expect(second).toMatchObject({ produced: 1, runsClosed: 0 });
    run = (await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 1 }))[0]!;
    expect(run.closedAt).toBeNull();

    // Tick 3: past the backoff too. Position 0 is due again, and finishing it must close the run
    // as `produced_all` rather than having lost it (review F1).
    setLlmForTests(createFakeLlm([post("Position zero, recovered.")]));
    const t2 = new Date("2026-01-11T00:01:10.000Z");
    const third = await tick(t2, { leaseMs: 5_000 });
    expect(third).toMatchObject({ produced: 1, runsClosed: 1 });
    run = (await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 1 }))[0]!;
    expect(run).toMatchObject({ outcome: "produced_all" });
  });
});
