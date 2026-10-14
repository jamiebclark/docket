import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setLlmForTests } from "../../../src/server/llm";
import { runStandingSeries, type StandingSeriesCounts } from "../../../src/server/scheduler/standing-series";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import { getStandingSeries } from "../../../src/server/services/standing-series/read";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { projects, standingSeries } from "../../../src/server/db/schema";
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

/** Writes straight to the project row: changes `scope.project.timezone` for the next fresh scope
 *  (every tick builds its own via `forJobRunner`), without disturbing an already-built scope. */
async function setProjectTimezone(projectId: string, timezone: string): Promise<void> {
  await runCrossProject("test: set project timezone", async () => {
    await getDb().update(projects).set({ timezone }).where(eq(projects.id, projectId));
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

describe("dated series at the edges (US3 AS1, AS2, AS6, AS7, FR-033, FR-041, SC-004, SC-006, SC-008)", () => {
  it("AS1/SC-006: two projects in different time zones each fire on their own local date, never the other's", async () => {
    const eastern = await standingSeriesEnv();
    await setProjectTimezone(eastern.project.id, "America/New_York");
    const auckland = await standingSeriesEnv();
    await setProjectTimezone(auckland.project.id, "Pacific/Auckland");

    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId: easternId } = await atTime(created, () =>
      createStandingSeries(eastern.scope, eastern.create({ occurrenceRule: "dated_list", cadence: null })),
    );
    const { seriesId: aucklandId } = await atTime(created, () =>
      createStandingSeries(auckland.scope, auckland.create({ occurrenceRule: "dated_list", cadence: null })),
    );
    await eastern.scope.datedRows.insert(easternId, rowInput({ ordinal: 0, nextTargetDate: "2026-03-14" }));
    await auckland.scope.datedRows.insert(aucklandId, rowInput({ ordinal: 0, nextTargetDate: "2026-03-14" }));

    // Auckland's local midnight for 14 March is 2026-03-13T11:00:00Z (NZDT, UTC+13); New York's is
    // 2026-03-14T04:00:00Z (EDT, UTC-4, in effect since 2026-03-08).
    setLlmForTests(createFakeLlm(Array.from({ length: 4 }, () => post("A fixture post."))));
    const mid = await tick(new Date("2026-03-13T12:00:00.000Z"));
    expect(mid.produced).toBe(1);
    expect(await auckland.scope.standingSeriesRuns.listForSeries(aucklandId, { limit: 5 })).toHaveLength(1);
    expect(await eastern.scope.standingSeriesRuns.listForSeries(easternId, { limit: 5 })).toHaveLength(0);

    setLlmForTests(createFakeLlm(Array.from({ length: 4 }, () => post("A fixture post."))));
    const later = await tick(new Date("2026-03-14T05:00:00.000Z"));
    expect(later.produced).toBe(1);
    expect(await eastern.scope.standingSeriesRuns.listForSeries(easternId, { limit: 5 })).toHaveLength(1);
    expect(await auckland.scope.standingSeriesRuns.listForSeries(aucklandId, { limit: 5 })).toHaveLength(1);
  });

  it("AS2: a missing local midnight (America/Santiago, 6 September 2026) resolves forward and fires exactly once", async () => {
    const e = await standingSeriesEnv();
    await setProjectTimezone(e.project.id, "America/Santiago");
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null })),
    );
    await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 0, month: 9, day: 6, year: null, nextTargetDate: "2026-09-06" }));

    // Local midnight on 6 September never exists there (00:00-00:59 is skipped); the resolved due
    // instant is 2026-09-06T04:00:00Z, local 01:00.
    setLlmForTests(createFakeLlm([post("Should not run.")]));
    expect((await tick(new Date("2026-09-06T03:00:00.000Z"))).produced).toBe(0);

    setLlmForTests(createFakeLlm([post("Fired once.")]));
    expect((await tick(new Date("2026-09-06T04:00:01.000Z"))).produced).toBe(1);

    setLlmForTests(createFakeLlm([post("Should not run again.")]));
    expect((await tick(new Date("2026-09-06T06:00:00.000Z"))).produced).toBe(0);
    expect((await tick(new Date("2026-09-07T13:00:00.000Z"))).produced).toBe(0);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs).toHaveLength(1);
  });

  it("AS2: a doubled local midnight (America/Havana, 1 November 2026) resolves to the earlier instant and fires exactly once", async () => {
    const e = await standingSeriesEnv();
    await setProjectTimezone(e.project.id, "America/Havana");
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null })),
    );
    await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 0, month: 11, day: 1, year: null, nextTargetDate: "2026-11-01" }));

    // Local midnight on 1 November happens twice there (once at -04:00, again an hour later at
    // -05:00); the resolved due instant takes the earlier offset, 2026-11-01T04:00:00Z.
    setLlmForTests(createFakeLlm([post("Should not run.")]));
    expect((await tick(new Date("2026-11-01T03:00:00.000Z"))).produced).toBe(0);

    setLlmForTests(createFakeLlm([post("Fired once.")]));
    expect((await tick(new Date("2026-11-01T04:00:01.000Z"))).produced).toBe(1);

    setLlmForTests(createFakeLlm([post("Should not run again.")]));
    expect((await tick(new Date("2026-11-01T05:30:00.000Z"))).produced).toBe(0);
    expect((await tick(new Date("2026-11-02T13:00:00.000Z"))).produced).toBe(0);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs).toHaveLength(1);
  });

  it("AS7: changing the project's time zone resolves the next due date in the new zone, leaving fired occurrences unchanged", async () => {
    const e = await standingSeriesEnv();
    await setProjectTimezone(e.project.id, "America/Los_Angeles");
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null })),
    );
    const firedRow = await e.scope.datedRows.insert(
      seriesId,
      rowInput({
        ordinal: 0,
        month: 1,
        day: 10,
        year: 2026,
        keyValue: "Fired already",
        fields: { name: "Fired already" },
        nextTargetDate: "2026-01-10",
      }),
    );
    const pendingRow = await e.scope.datedRows.insert(
      seriesId,
      rowInput({ ordinal: 1, month: 3, day: 14, year: null, keyValue: "Pending", fields: { name: "Pending" }, nextTargetDate: "2026-03-14" }),
    );

    // Local midnight 10 January in Los Angeles (PST, UTC-8) is 2026-01-10T08:00:00Z.
    setLlmForTests(createFakeLlm([post("Already fired.")]));
    expect((await tick(new Date("2026-01-10T09:00:00.000Z"))).produced).toBe(1);
    const beforeSwitch = await getStandingSeries(e.scope, seriesId);
    const firedBefore = beforeSwitch.rows.items.find((r) => r.id === firedRow.id)!;
    expect(firedBefore.nextTargetDate).toBeNull();
    expect(firedBefore.lastOutcome).toBe("produced");

    await setProjectTimezone(e.project.id, "Pacific/Auckland");

    // 14 March local midnight in Los Angeles (PDT, UTC-7) would be 2026-03-14T07:00:00Z; in
    // Auckland (NZDT, UTC+13) it is a full day earlier, 2026-03-13T11:00:00Z.
    setLlmForTests(createFakeLlm([post("Fired in the new zone.")]));
    expect((await tick(new Date("2026-03-13T12:00:00.000Z"))).produced).toBe(1);

    setLlmForTests(createFakeLlm([post("Should not run again.")]));
    expect((await tick(new Date("2026-03-14T07:30:00.000Z"))).produced).toBe(0);

    const after = await getStandingSeries(e.scope, seriesId);
    const firedAfter = after.rows.items.find((r) => r.id === firedRow.id)!;
    expect(firedAfter.nextTargetDate).toBeNull();
    expect(firedAfter.lastOutcome).toBe("produced");
    const pendingAfter = after.rows.items.find((r) => r.id === pendingRow.id)!;
    expect(pendingAfter.lastOutcome).toBe("produced");
  });

  it("AS3/SC-004: a 29 February row fires on 28 February in a non-leap year, on 29 February in 2028, never 1 March", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null })),
    );
    await e.scope.datedRows.insert(
      seriesId,
      rowInput({ ordinal: 0, month: 2, day: 29, year: null, keyValue: "Leap day", fields: { name: "Leap day" }, nextTargetDate: "2027-02-28" }),
    );

    setLlmForTests(createFakeLlm([post("Should not run.")]));
    expect((await tick(new Date("2027-02-27T00:00:01.000Z"))).produced).toBe(0);

    setLlmForTests(createFakeLlm([post("Fired on 28 February, non-leap year.")]));
    expect((await tick(new Date("2027-02-28T00:00:01.000Z"))).produced).toBe(1);

    setLlmForTests(createFakeLlm([post("Should not run again.")]));
    expect((await tick(new Date("2027-03-01T00:00:01.000Z"))).produced).toBe(0);

    const detail = await getStandingSeries(e.scope, seriesId);
    const view = detail.rows.items.find((r) => r.fields.name === "Leap day")!;
    expect(view.nextTargetDate).toBe("2028-02-29");

    setLlmForTests(createFakeLlm([post("Should not run yet.")]));
    expect((await tick(new Date("2028-02-28T00:00:01.000Z"))).produced).toBe(0);

    setLlmForTests(createFakeLlm([post("Fired on the actual leap day.")]));
    expect((await tick(new Date("2028-02-29T00:00:01.000Z"))).produced).toBe(1);

    setLlmForTests(createFakeLlm([post("Should never run on 1 March.")]));
    expect((await tick(new Date("2028-03-01T00:00:01.000Z"))).produced).toBe(0);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs.map((r) => r.periodStart).sort()).toEqual(["2027-02-28", "2028-02-29"]);
  });

  it("AS6: two rows sharing a date each produce their own post", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null })),
    );
    await e.scope.datedRows.insert(
      seriesId,
      rowInput({ ordinal: 0, keyValue: "Ada Lovelace", fields: { name: "Ada Lovelace" }, nextTargetDate: "2026-03-14" }),
    );
    await e.scope.datedRows.insert(
      seriesId,
      rowInput({ ordinal: 1, keyValue: "Albert Einstein", fields: { name: "Albert Einstein" }, nextTargetDate: "2026-03-14" }),
    );

    setLlmForTests(createFakeLlm([post("Post for Ada."), post("Post for Albert.")]));
    const fired = await tick(new Date("2026-03-14T00:00:01.000Z"));
    expect(fired.produced).toBe(2);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs).toHaveLength(1);
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    expect(positions.filter((p) => p.status === "produced")).toHaveLength(2);
    const names = new Set<string>();
    for (const position of positions) {
      const p = await e.scope.posts.findByStandingSeriesPosition(position.id);
      expect(p).not.toBeNull();
      const dated = position.dated as { keyValue: string } | null;
      names.add(dated!.keyValue);
    }
    expect(names).toEqual(new Set(["Ada Lovelace", "Albert Einstein"]));
  });
});
