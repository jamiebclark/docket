import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import { addDatedRow, deleteDatedRow, updateDatedRow } from "../../../src/server/services/standing-series/dated-rows";
import { getStandingSeries } from "../../../src/server/services/standing-series/read";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { standingSeries } from "../../../src/server/db/schema";
import { closeDb } from "../../helpers/db";
import { clearHolds } from "../../helpers/jobs-env";
import { standingSeriesEnv } from "../../helpers/standing-series-env";

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
  await clearHolds();
});
afterAll(async () => {
  await closeDb();
});

async function datedSeries(e: Awaited<ReturnType<typeof standingSeriesEnv>>) {
  const { seriesId } = await createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null }));
  await e.scope.standingSeries.update(seriesId, { templateFields: ["name"] });
  return seriesId;
}

describe("dated series row CRUD", () => {
  it("adds a row, appending at the end with its field data", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    const { rowId } = await addDatedRow(e.scope, seriesId, { date: "03-14", media: null, fields: { name: "Ada Lovelace" } });
    const detail = await getStandingSeries(e.scope, seriesId);
    expect(detail.rows.total).toBe(1);
    expect(detail.rows.items[0]!.id).toBe(rowId);
    expect(detail.rows.items[0]!.keyValue).toBe("Ada Lovelace");
  });

  it("refuses a duplicate identity and an invalid date, with the field named on the error", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    await addDatedRow(e.scope, seriesId, { date: "03-14", media: null, fields: { name: "Ada Lovelace" } });
    await expect(addDatedRow(e.scope, seriesId, { date: "03-14", media: null, fields: { name: "Ada Lovelace" } })).rejects.toMatchObject({
      name: "ValidationIssuesError",
      issues: [expect.objectContaining({ field: "date" })],
    });
    await expect(addDatedRow(e.scope, seriesId, { date: "13-40", media: null, fields: { name: "Nobody" } })).rejects.toMatchObject({
      issues: [expect.objectContaining({ field: "date" })],
    });
  });

  it("enforces the per-date cap of 10 rows", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    for (let i = 0; i < 10; i += 1) {
      await addDatedRow(e.scope, seriesId, { date: "03-14", media: null, fields: { name: `Person ${i}` } });
    }
    await expect(addDatedRow(e.scope, seriesId, { date: "03-14", media: null, fields: { name: "Person 11" } })).rejects.toMatchObject({
      name: "ValidationIssuesError",
    });
  });

  it("edits a row, recomputing next_target_date only when the date changes", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    const { rowId } = await addDatedRow(e.scope, seriesId, { date: "03-14", media: null, fields: { name: "Ada Lovelace" } });
    const before = await getStandingSeries(e.scope, seriesId);
    const originalTarget = before.rows.items[0]!.nextTargetDate;

    await updateDatedRow(e.scope, seriesId, rowId, { date: "03-14", media: null, fields: { name: "Ada L." } });
    const sameDate = await getStandingSeries(e.scope, seriesId);
    expect(sameDate.rows.items[0]!.keyValue).toBe("Ada L.");
    expect(sameDate.rows.items[0]!.nextTargetDate).toBe(originalTarget);

    await updateDatedRow(e.scope, seriesId, rowId, { date: "04-01", media: null, fields: { name: "Ada L." } });
    const changedDate = await getStandingSeries(e.scope, seriesId);
    expect(changedDate.rows.items[0]!.date).toBe("04-01");
  });

  it("deletes a row, cascading its occurrences", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    const { rowId } = await addDatedRow(e.scope, seriesId, { date: "03-14", media: null, fields: { name: "Ada Lovelace" } });
    await e.scope.datedOccurrences.recordMissed({ seriesId, rowId, year: 2026, targetDate: "2026-03-14", at: new Date() });
    await deleteDatedRow(e.scope, seriesId, rowId);
    const detail = await getStandingSeries(e.scope, seriesId);
    expect(detail.rows.total).toBe(0);
    const occurrences = await e.scope.datedOccurrences.listForRow(rowId, { limit: 10 });
    expect(occurrences).toHaveLength(0);
  });
});
