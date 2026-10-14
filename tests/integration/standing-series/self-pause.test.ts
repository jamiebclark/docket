import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLlmForTests } from "../../../src/server/llm";
import { runStandingSeries, type StandingSeriesCounts } from "../../../src/server/scheduler/standing-series";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { createStandingSeries, resumeStandingSeries } from "../../../src/server/services/standing-series/manage";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { standingSeries } from "../../../src/server/db/schema";
import { createVoiceProfilesRepo } from "../../../src/server/dal/voice";
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

async function tick(at: Date): Promise<StandingSeriesCounts> {
  return atTime(at, () => runStandingSeries({ config: CONFIG, tickId: "test", startedAt: at }));
}

describe("standing-series self-pause (US6 AS4-AS5, FR-053)", () => {
  it("pauses the series with no_output after three consecutive zero-post closed runs, and one Resume action restores it", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 2, period: "day" } })),
    );

    for (let day = 1; day <= 3; day++) {
      // A non-temporary plan failure fails every queued position and closes the run in the same
      // tick, reaching the self-pause check via `closeRun` directly. The two tests below exercise
      // the other two close sites — a blocked-reason close inside `openOrResumeRun`, and a
      // per-position immediate failure closed a period later by `closeStale` — which must reach the
      // same check (review F6).
      setLlmForTests(createFakeLlm([{ fail: "bad_request" }]));
      const t = new Date(`2026-01-${String(10 + day).padStart(2, "0")}T00:00:01.000Z`);
      const counts = await tick(t);
      expect(counts.produced).toBe(0);
      expect(counts.failed).toBe(2);
    }

    const row = await e.scope.standingSeries.get(seriesId);
    expect(row).toMatchObject({ enabled: false, autoPausedReason: "no_output" });
    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs).toHaveLength(3);
    for (const run of runs) expect(run.outcome).toBe("produced_none");

    const { nextRunAt } = await resumeStandingSeries(e.scope, seriesId);
    const resumed = await e.scope.standingSeries.get(seriesId);
    expect(resumed).toMatchObject({ enabled: true, autoPausedReason: null });

    const plan: FakeStep = {
      ok: { angles: [{ title: "Angle 1", description: "About thing 1" }, { title: "Angle 2", description: "About thing 2" }] },
    };
    setLlmForTests(createFakeLlm([plan, post("Back from pause, one."), post("Back from pause, two.")]));
    const after = new Date(nextRunAt!.getTime() + 1_000);
    const counts = await tick(after);
    expect(counts.produced).toBe(2);
  }, 60_000);

  it("pauses a series blocked every period by a missing voice profile, which closes inside openOrResumeRun, not the producer (review F6)", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-02-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } })),
    );
    await createVoiceProfilesRepo(getDb(), e.project.id).setArchived(e.profile.id, created);

    setLlmForTests(createFakeLlm([]));
    for (let day = 1; day <= 3; day++) {
      const t = new Date(`2026-02-${String(10 + day).padStart(2, "0")}T00:00:01.000Z`);
      const counts = await tick(t);
      expect(counts.blocked).toBe(1);
    }

    const row = await e.scope.standingSeries.get(seriesId);
    expect(row).toMatchObject({ enabled: false, autoPausedReason: "no_output" });
    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs).toHaveLength(3);
    for (const run of runs) expect(run).toMatchObject({ blockedReason: "voice_profile_missing", outcome: "produced_none" });
  }, 60_000);

  it("pauses a series whose every position fails outright, closed a period later by closeStale, not the producer (review F6)", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-03-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } })),
    );

    // Each tick fails its one position outright and returns without closing its own run (runner.ts
    // returns right after recording the failure); the run is only closed on the *next* tick, by
    // `closeStale` inside `openOrResumeRun`, which must still reach the self-pause check. The 4th
    // tick is the one that closes the 3rd run and crosses the self-pause threshold — by then the
    // series is paused before its own (4th) run's position is ever touched.
    for (let day = 1; day <= 4; day++) {
      setLlmForTests(createFakeLlm([{ fail: "bad_request" }]));
      const t = new Date(`2026-03-${String(10 + day).padStart(2, "0")}T00:00:01.000Z`);
      const counts = await tick(t);
      expect(counts.failed).toBe(day <= 3 ? 1 : 0);
    }

    const row = await e.scope.standingSeries.get(seriesId);
    expect(row).toMatchObject({ enabled: false, autoPausedReason: "no_output" });
    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const closed = runs.filter((r) => r.closedAt !== null);
    expect(closed.length).toBeGreaterThanOrEqual(3);
    for (const run of closed.slice(0, 3)) expect(run.outcome).toBe("produced_none");
  }, 60_000);

  it("resumes cleanly after pausing on the closeStale path, with no orphan run to re-pause it a period later (review F2)", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-04-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } })),
    );

    // Same shape as the closeStale pause above: each tick fails its one position outright, and the
    // 4th tick is the one whose closeStale call closes the 3rd run and crosses the self-pause
    // threshold — the exact tick that, before the fix, also opened an orphan run on the now-disabled
    // series.
    for (let day = 1; day <= 4; day++) {
      setLlmForTests(createFakeLlm([{ fail: "bad_request" }]));
      const t = new Date(`2026-04-${String(10 + day).padStart(2, "0")}T00:00:01.000Z`);
      await tick(t);
    }

    const paused = await e.scope.standingSeries.get(seriesId);
    expect(paused).toMatchObject({ enabled: false, autoPausedReason: "no_output" });

    const { nextRunAt } = await resumeStandingSeries(e.scope, seriesId);
    const resumed = await e.scope.standingSeries.get(seriesId);
    expect(resumed).toMatchObject({ enabled: true, autoPausedReason: null });

    setLlmForTests(createFakeLlm([post("Back from pause.")]));
    const after = new Date(nextRunAt!.getTime() + 1_000);
    const counts = await tick(after);
    expect(counts.produced).toBe(1);

    // One Resume was enough: the series must not have self-paused again.
    const row = await e.scope.standingSeries.get(seriesId);
    expect(row).toMatchObject({ enabled: true, autoPausedReason: null });
  }, 60_000);
});
