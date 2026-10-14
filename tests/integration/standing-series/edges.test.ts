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
});
