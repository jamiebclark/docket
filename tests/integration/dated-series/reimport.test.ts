import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { csvBuilder } from "../../helpers/factories";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import { importDatedList } from "../../../src/server/services/standing-series/dated-import";
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
  return seriesId;
}

const file = (bytes: Buffer, name = "list.csv") => ({ name, bytes: new Uint8Array(bytes) });

describe("dated series re-import (US2 AS5-AS6, FR-024, FR-025)", () => {
  it("an unchanged re-import keeps fire history and fires nothing twice", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    const bytes = csvBuilder(["date", "name"], [["03-14", "Ada Lovelace"]]);
    await importDatedList(e.scope, seriesId, file(bytes));
    const before = await getStandingSeries(e.scope, seriesId);
    const rowId = before.rows.items[0]!.id;
    const originalNextTarget = before.rows.items[0]!.nextTargetDate;

    // Simulate the row having already settled this year, exactly as the engine would record it.
    await e.scope.datedOccurrences.recordMissed({ seriesId, rowId, year: 2026, targetDate: "2026-03-14", at: new Date() });
    await e.scope.datedRows.advance(rowId, "2027-03-14", originalNextTarget);

    const result = await importDatedList(e.scope, seriesId, file(bytes));
    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.removed).toBe(0);

    const after = await getStandingSeries(e.scope, seriesId);
    expect(after.rows.items[0]!.nextTargetDate).toBe("2027-03-14");
    const occurrences = await e.scope.datedOccurrences.listForRow(rowId, { limit: 10 });
    expect(occurrences).toHaveLength(1);
  });

  it("removing one row and adding another updates the stored set, keeping the surviving row's history", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    const first = csvBuilder(
      ["date", "name"],
      [
        ["03-14", "Ada Lovelace"],
        ["04-01", "Grace Hopper"],
      ],
    );
    await importDatedList(e.scope, seriesId, file(first));
    const before = await getStandingSeries(e.scope, seriesId);
    const survivor = before.rows.items.find((r) => r.keyValue === "Ada Lovelace")!;
    await e.scope.datedOccurrences.recordMissed({ seriesId, rowId: survivor.id, year: 2026, targetDate: "2026-03-14", at: new Date() });

    const second = csvBuilder(
      ["date", "name"],
      [
        ["03-14", "Ada Lovelace"],
        ["05-05", "Katherine Johnson"],
      ],
    );
    const result = await importDatedList(e.scope, seriesId, file(second));
    expect(result.added).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.removed).toBe(1);

    const after = await getStandingSeries(e.scope, seriesId);
    expect(after.rows.total).toBe(2);
    expect(after.rows.items.map((r) => r.keyValue).sort()).toEqual(["Ada Lovelace", "Katherine Johnson"]);
    const survivorOccurrences = await e.scope.datedOccurrences.listForRow(survivor.id, { limit: 10 });
    expect(survivorOccurrences).toHaveLength(1);
  });
});
