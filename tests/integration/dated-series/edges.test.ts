import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setLlmForTests } from "../../../src/server/llm";
import { runStandingSeries, type StandingSeriesCounts } from "../../../src/server/scheduler/standing-series";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { createStandingSeries, deleteStandingSeries } from "../../../src/server/services/standing-series/manage";
import { getStandingSeries } from "../../../src/server/services/standing-series/read";
import { importDatedList } from "../../../src/server/services/standing-series/dated-import";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { standingSeries, projects } from "../../../src/server/db/schema";
import { closeDb } from "../../helpers/db";
import { atTime } from "../../helpers/clock";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { clearHolds } from "../../helpers/jobs-env";
import { standingSeriesEnv } from "../../helpers/standing-series-env";
import { csvBuilder } from "../../helpers/factories";

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

async function tick(at: Date, config: SchedulerConfig = CONFIG): Promise<StandingSeriesCounts> {
  return atTime(at, () => runStandingSeries({ config, tickId: "test", startedAt: at }));
}

async function datedSeries(e: Awaited<ReturnType<typeof standingSeriesEnv>>, over: Record<string, unknown> = {}) {
  const { seriesId } = await createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null, ...over }));
  return seriesId;
}

const file = (bytes: Buffer, name = "list.csv") => ({ name, bytes: new Uint8Array(bytes) });

describe("dated series edge cases (spec.md Edge Cases table)", () => {
  it("a date-only file, with no other column, leaves template_fields empty", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    const bytes = csvBuilder(["date"], [["03-14"], ["04-01"]]);
    const result = await importDatedList(e.scope, seriesId, file(bytes));
    expect(result.problems).toEqual([]);
    expect(result.rowCount).toBe(2);
    const detail = await getStandingSeries(e.scope, seriesId);
    expect(detail.templateFields).toEqual([]);
    expect(detail.rows.total).toBe(2);
  });

  it("a whitespace-only key-column value is reported and skipped (A18)", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    const bytes = csvBuilder(["date", "name"], [["03-14", "   "], ["04-01", "Grace Hopper"]]);
    const result = await importDatedList(e.scope, seriesId, file(bytes));
    expect(result.problems.map((p) => p.message)).toEqual(['Line 2: "name" is empty.']);
    expect(result.rowCount).toBe(1);
  });

  it("a date with leading or trailing spaces is trimmed, then parsed", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    const bytes = csvBuilder(["date", "name"], [["  03-14  ", "Ada Lovelace"]]);
    const result = await importDatedList(e.scope, seriesId, file(bytes));
    expect(result.problems).toEqual([]);
    expect(result.rowCount).toBe(1);
    const detail = await getStandingSeries(e.scope, seriesId);
    expect(detail.upcoming[0]!.target).toMatch(/-03-14$/);
  });

  it("a project whose zone is +05:45 (Asia/Kathmandu) still fires exactly once", async () => {
    const e = await standingSeriesEnv();
    await setProjectTimezone(e.project.id, "Asia/Kathmandu");
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null })),
    );
    await e.scope.datedRows.insert(seriesId, {
      month: 3,
      day: 14,
      year: null,
      keyValue: "Ada",
      fields: { name: "Ada" },
      mediaFilename: null,
      mediaAssetId: null,
      nextTargetDate: "2026-03-14",
      sourceLine: 2,
      ordinal: 0,
    });

    // Local midnight on 14 March in Kathmandu (UTC+05:45) is 2026-03-13T18:15:00Z.
    setLlmForTests(createFakeLlm([post("Should not run.")]));
    expect((await tick(new Date("2026-03-13T18:00:00.000Z"))).produced).toBe(0);

    setLlmForTests(createFakeLlm([post("Fired once.")]));
    expect((await tick(new Date("2026-03-13T18:16:00.000Z"))).produced).toBe(1);

    setLlmForTests(createFakeLlm([post("Should not run again.")]));
    expect((await tick(new Date("2026-03-14T06:00:00.000Z"))).produced).toBe(0);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs).toHaveLength(1);
  });

  it("a project whose zone is +10:30 (Australia/Lord_Howe standard time) still fires exactly once", async () => {
    const e = await standingSeriesEnv();
    await setProjectTimezone(e.project.id, "Australia/Lord_Howe");
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null })),
    );
    await e.scope.datedRows.insert(seriesId, {
      month: 7,
      day: 14,
      year: null,
      keyValue: "Ada",
      fields: { name: "Ada" },
      mediaFilename: null,
      mediaAssetId: null,
      nextTargetDate: "2026-07-14",
      sourceLine: 2,
      ordinal: 0,
    });

    // Lord Howe is on standard time (+10:30) in July; local midnight 14 July is 2026-07-13T13:30:00Z.
    setLlmForTests(createFakeLlm([post("Should not run.")]));
    expect((await tick(new Date("2026-07-13T13:00:00.000Z"))).produced).toBe(0);

    setLlmForTests(createFakeLlm([post("Fired once.")]));
    expect((await tick(new Date("2026-07-13T13:31:00.000Z"))).produced).toBe(1);

    setLlmForTests(createFakeLlm([post("Should not run again.")]));
    expect((await tick(new Date("2026-07-14T13:00:00.000Z"))).produced).toBe(0);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs).toHaveLength(1);
  });

  it("a series deleted while its dated run is open: rows, history and runs go; produced posts stay (W13)", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null })),
    );
    const row1 = await e.scope.datedRows.insert(seriesId, {
      month: 3, day: 14, year: null, keyValue: "First", fields: { name: "First" },
      mediaFilename: null, mediaAssetId: null, nextTargetDate: "2026-03-14", sourceLine: 2, ordinal: 0,
    });
    const row2 = await e.scope.datedRows.insert(seriesId, {
      month: 3, day: 14, year: null, keyValue: "Second", fields: { name: "Second" },
      mediaFilename: null, mediaAssetId: null, nextTargetDate: "2026-03-14", sourceLine: 3, ordinal: 1,
    });

    // Caps the tick at one produced post, leaving the second row's position queued and the run open.
    setLlmForTests(createFakeLlm([post("First fires.")]));
    const counts = await tick(new Date("2026-03-14T00:00:01.000Z"), { ...CONFIG, standingSeriesMaxPosts: 1 });
    expect(counts.produced).toBe(1);

    const runsBefore = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runsBefore).toHaveLength(1);
    expect(runsBefore[0]!.closedAt).toBeNull();
    const positionsBefore = await e.scope.standingSeriesPositions.listForRun(runsBefore[0]!.id);
    const producedPosition = positionsBefore.find((p) => p.status === "produced")!;
    const producedPost = await e.scope.posts.findByStandingSeriesPosition(producedPosition.id);
    expect(producedPost).not.toBeNull();

    await deleteStandingSeries(e.scope, seriesId);

    expect(await e.scope.standingSeries.get(seriesId)).toBeNull();
    expect(await e.scope.datedRows.get(row1.id)).toBeNull();
    expect(await e.scope.datedRows.get(row2.id)).toBeNull();
    expect(await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 })).toEqual([]);
    expect(await e.scope.datedOccurrences.listForRow(row1.id, { limit: 5 })).toEqual([]);

    const survivingPost = await e.scope.posts.get(producedPost!.id);
    expect(survivingPost).not.toBeNull();
    expect(survivingPost!.standingSeriesPositionId).toBeNull();
  });

  it("an instructions template edited to stop using a column leaves the column as a simply-unused field", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-01T00:00:00.000Z");
    const seriesId = await atTime(created, () => datedSeries(e));
    await e.scope.standingSeries.update(seriesId, { template: "Write about {{name}}." });
    const bytes = csvBuilder(["date", "name"], [["03-14", "Ada Lovelace"]]);
    await atTime(created, () => importDatedList(e.scope, seriesId, file(bytes)));
    let detail = await getStandingSeries(e.scope, seriesId);
    expect(detail.templateFields).toEqual(["name"]);

    await e.scope.standingSeries.update(seriesId, { template: "Write a short post." });
    detail = await getStandingSeries(e.scope, seriesId);
    expect(detail.templateFields).toEqual(["name"]);
    expect(detail.rows.total).toBe(1);

    setLlmForTests(createFakeLlm([post("A short post.")]));
    const counts = await tick(new Date("2026-03-14T00:00:01.000Z"));
    expect(counts.produced).toBe(1);
  });
});
