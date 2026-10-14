import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setLlmForTests } from "../../../src/server/llm";
import { runStandingSeries, type StandingSeriesCounts } from "../../../src/server/scheduler/standing-series";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import { getStandingSeries } from "../../../src/server/services/standing-series/read";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { standingSeries } from "../../../src/server/db/schema";
import type { NewDatedRow } from "../../../src/server/dal/standing-series-dated";
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

const post = (text: string, images = 0): FakeStep => ({
  ok: {
    variants: { mock: { text } },
    ...(images > 0 ? { imageAltTexts: Array.from({ length: images }, (_, i) => `Alt text ${i + 1}`) } : {}),
  },
});

async function tick(at: Date): Promise<StandingSeriesCounts> {
  return atTime(at, () => runStandingSeries({ config: CONFIG, tickId: "test", startedAt: at }));
}

/** Project timezone is UTC (factories default), so a row's local date matches its UTC date. */
function rowInput(over: Partial<NewDatedRow> & { ordinal: number }): NewDatedRow {
  return {
    month: 3,
    day: 14,
    year: null,
    keyValue: "Ada Lovelace",
    fields: { name: "Ada Lovelace" },
    mediaFilename: null,
    mediaAssetId: null,
    nextTargetDate: null,
    sourceLine: over.ordinal + 2,
    ...over,
  };
}

describe("dated series due resolution and firing (US1 AS1-AS6, FR-030-FR-033, FR-037, FR-040-FR-043)", () => {
  it("AS1/AS4: nothing before the due date; one post per fired row with the row's data rendered", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null })),
    );
    // Simulates what an import would do (dated-import.ts, Phase 5): the template may only
    // reference a placeholder once the list supplies that column (FR-027).
    await e.scope.standingSeries.update(seriesId, {
      template: "Write a birthday post for {{name}}.",
      templateFields: ["name"],
    });
    await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 0, nextTargetDate: "2026-03-14" }));

    setLlmForTests(createFakeLlm([post("Should not run.")]));
    const before = await tick(new Date("2026-03-13T00:00:01.000Z"));
    expect(before.produced).toBe(0);
    const detailBefore = await getStandingSeries(e.scope, seriesId);
    expect(detailBefore.upcoming[0]!.target).toBe("2026-03-14");

    const llm = createFakeLlm([post("Happy birthday!")]);
    setLlmForTests(llm);
    const fired = await tick(new Date("2026-03-14T00:00:01.000Z"));
    expect(fired.produced).toBe(1);
    expect(llm.requests[0]!.user).toContain("Ada Lovelace");

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs).toHaveLength(1);
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    const post1 = await e.scope.posts.findByStandingSeriesPosition(positions[0]!.id);
    expect(post1).not.toBeNull();
  });

  it("AS2: no second post the next day", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null })),
    );
    await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 0, nextTargetDate: "2026-03-14" }));

    setLlmForTests(createFakeLlm([post("Happy birthday!")]));
    expect((await tick(new Date("2026-03-14T00:00:01.000Z"))).produced).toBe(1);

    setLlmForTests(createFakeLlm([post("Should not run.")]));
    const next = await tick(new Date("2026-03-15T00:00:01.000Z"));
    expect(next.produced).toBe(0);
    expect(next.runsOpened).toBe(0);
  });

  it("AS3: a new post the following year", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null })),
    );
    await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 0, nextTargetDate: "2026-03-14" }));

    setLlmForTests(createFakeLlm([post("Happy birthday 2026!")]));
    expect((await tick(new Date("2026-03-14T00:00:01.000Z"))).produced).toBe(1);

    setLlmForTests(createFakeLlm([post("Happy birthday 2027!")]));
    const nextYear = await tick(new Date("2027-03-14T00:00:01.000Z"));
    expect(nextYear.produced).toBe(1);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs).toHaveLength(2);
  });

  it("AS5: a year-specific row never fires again and shows as past", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null })),
    );
    const row = await e.scope.datedRows.insert(
      seriesId,
      rowInput({ ordinal: 0, month: 6, day: 1, year: 2026, keyValue: "Grand opening", fields: { name: "Grand opening" }, nextTargetDate: "2026-06-01" }),
    );

    setLlmForTests(createFakeLlm([post("Grand opening!")]));
    expect((await tick(new Date("2026-06-01T00:00:01.000Z"))).produced).toBe(1);

    setLlmForTests(createFakeLlm([post("Should not run.")]));
    const nextYear = await tick(new Date("2027-06-01T00:00:01.000Z"));
    expect(nextYear.produced).toBe(0);

    const detail = await getStandingSeries(e.scope, seriesId);
    const view = detail.rows.items.find((r) => r.id === row.id)!;
    expect(view.nextTargetDate).toBeNull();
    expect(view.lastOutcome).toBe("produced");
  });

  it("AS6: a named portrait's post carries it unreserved and the same asset is reused next year", async () => {
    const e = await standingSeriesEnv();
    const asset = await e.asset({ filename: "ada.png" });
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null, media: { source: "none" } })),
    );
    await e.scope.datedRows.insert(
      seriesId,
      rowInput({ ordinal: 0, nextTargetDate: "2026-03-14", mediaFilename: "ada.png", mediaAssetId: asset.id }),
    );

    setLlmForTests(createFakeLlm([post("Happy birthday!", 1)]));
    expect((await tick(new Date("2026-03-14T00:00:01.000Z"))).produced).toBe(1);
    const runs1 = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const positions1 = await e.scope.standingSeriesPositions.listForRun(runs1[0]!.id);
    const post1 = await e.scope.posts.findByStandingSeriesPosition(positions1[0]!.id);
    expect(await e.scope.posts.listMediaIds(post1!.id)).toEqual([asset.id]);
    // Never claimed: the dated-row asset path never calls claimMedia/markUsed (B12).
    expect(positions1[0]!.mediaAssetId).toBeNull();

    setLlmForTests(createFakeLlm([post("Happy birthday again!", 1)]));
    expect((await tick(new Date("2027-03-14T00:00:01.000Z"))).produced).toBe(1);
    const runs2 = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const openedRun = runs2.find((r) => r.periodStart === "2027-03-14")!;
    const positions2 = await e.scope.standingSeriesPositions.listForRun(openedRun.id);
    const post2 = await e.scope.posts.findByStandingSeriesPosition(positions2[0]!.id);
    expect(await e.scope.posts.listMediaIds(post2!.id)).toEqual([asset.id]);
  });

  it("SC-002: a pinned-clock walk across the fixture fires exactly once per row per year, zero duplicates", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null })),
    );
    await e.scope.datedRows.insert(
      seriesId,
      rowInput({ ordinal: 0, month: 3, day: 14, year: null, keyValue: "Every year row", fields: { name: "Every year row" }, nextTargetDate: "2026-03-14" }),
    );
    await e.scope.datedRows.insert(
      seriesId,
      rowInput({ ordinal: 1, month: 6, day: 1, year: 2027, keyValue: "Once only", fields: { name: "Once only" }, nextTargetDate: "2027-06-01" }),
    );

    let producedTotal = 0;
    const start = new Date("2026-01-01T00:00:01.000Z");
    const end = new Date("2028-01-02T00:00:01.000Z");
    for (let day = new Date(start); day.getTime() <= end.getTime(); day = new Date(day.getTime() + 86_400_000)) {
      setLlmForTests(createFakeLlm(Array.from({ length: 3 }, () => post("A fixture post."))));
      const counts = await tick(day);
      producedTotal += counts.produced;
    }

    // Every-year row fires on 2026-03-14 and 2027-03-14; the year-specific row fires once on 2027-06-01.
    expect(producedTotal).toBe(3);
    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 20 });
    const periods = runs.map((r) => r.periodStart).sort();
    expect(periods).toEqual(["2026-03-14", "2027-03-14", "2027-06-01"]);
    for (const run of runs) {
      const positions = await e.scope.standingSeriesPositions.listForRun(run.id);
      expect(positions.filter((p) => p.status === "produced")).toHaveLength(1);
    }
  });
});
