import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { csvBuilder } from "../../helpers/factories";
import { atTime } from "../../helpers/clock";
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

async function datedSeries(e: Awaited<ReturnType<typeof standingSeriesEnv>>, over: Record<string, unknown> = {}) {
  const { seriesId } = await createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null, ...over }));
  return seriesId;
}

const file = (bytes: Buffer, name = "list.csv") => ({ name, bytes: new Uint8Array(bytes) });

describe("dated series import (US2 AS1-AS2, AS4; FR-021-FR-023)", () => {
  it("imports valid rows, storing the template fields and the key column first", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    await e.scope.standingSeries.update(seriesId, { template: "Write a birthday post for {{name}}." });
    const bytes = csvBuilder(["date", "name"], [["03-14", "Ada Lovelace"], ["04-01", "Grace Hopper"]]);
    const result = await importDatedList(e.scope, seriesId, file(bytes));
    expect(result.rowCount).toBe(2);
    expect(result.problems).toEqual([]);
    expect(result.added).toBe(2);
    const detail = await getStandingSeries(e.scope, seriesId);
    expect(detail.templateFields).toEqual(["name"]);
    expect(detail.rows.total).toBe(2);
  });

  it("every row-level problem class carries its exact line number", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    const bytes = csvBuilder(
      ["date", "name"],
      [
        ["3/14", "Bad Format"],
        ["02-30", "Impossible"],
        ["2020-01-01", "Already Passed"],
        ["03-15", ""],
        ["03-16", "Dup"],
        ["03-16", "Dup"],
      ],
    );
    const result = await importDatedList(e.scope, seriesId, file(bytes));
    expect(result.problems.map((p) => p.line)).toEqual([2, 3, 4, 5, 7]);
    expect(result.problems[0]!.message).toBe('Line 2: "3/14" is not a date. Use MM-DD or YYYY-MM-DD.');
    expect(result.problems[1]!.message).toBe("Line 3: 02-30 is not a real date.");
    expect(result.problems[2]!.message).toBe("Line 4: 2020-01-01 has already passed.");
    expect(result.problems[3]!.message).toBe('Line 5: "name" is empty.');
    expect(result.problems[4]!.message).toContain("are already on line 6.");
    expect(result.rowCount).toBe(1);
  });

  it("the eleventh row on one calendar date is refused", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    const rows = Array.from({ length: 11 }, (_, i) => ["03-14", `Person ${i}`]);
    const bytes = csvBuilder(["date", "name"], rows);
    const result = await importDatedList(e.scope, seriesId, file(bytes));
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!.message).toBe("Line 12: 03-14 already has 10 rows.");
    expect(result.rowCount).toBe(10);
  });

  it("review F3: the per-date cap counts an every-year and a year-specific row together", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    const rows = Array.from({ length: 10 }, (_, i) => ["03-14", `Person ${i}`]);
    rows.push(["2027-03-14", "Yearly Visitor"]);
    const bytes = csvBuilder(["date", "name"], rows);
    const result = await atTime(new Date("2026-01-01T00:00:00.000Z"), () => importDatedList(e.scope, seriesId, file(bytes)));
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!.message).toBe("Line 12: 2027-03-14 already has 10 rows.");
    expect(result.rowCount).toBe(10);
  });

  it("review F3: the leap-day collapse counts an every-year 02-29 row against 02-28", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    const rows = Array.from({ length: 10 }, (_, i) => ["02-28", `Person ${i}`]);
    rows.push(["02-29", "Leap Visitor"]);
    const bytes = csvBuilder(["date", "name"], rows);
    const result = await atTime(new Date("2026-01-01T00:00:00.000Z"), () => importDatedList(e.scope, seriesId, file(bytes)));
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!.message).toBe("Line 12: 02-29 already has 10 rows.");
    expect(result.rowCount).toBe(10);
  });

  it("a media reference is reported when missing, ambiguous or a video", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    await e.asset({ filename: "ada.jpg" });
    await e.asset({ filename: "dup.jpg" });
    await e.asset({ filename: "dup.jpg" });
    const bytes = csvBuilder(
      ["date", "name", "media"],
      [
        ["03-14", "Ada", "missing.jpg"],
        ["03-15", "Dup", "dup.jpg"],
      ],
    );
    const result = await importDatedList(e.scope, seriesId, file(bytes));
    expect(result.problems.map((p) => p.message)).toEqual([
      'Line 2: no image called "missing.jpg" is in the library.',
      'Line 3: more than one file is called "dup.jpg".',
    ]);
  });

  it("refuses a whole file missing a column the template uses (FR-021, FR-027)", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    await e.scope.standingSeries.update(seriesId, { template: "Write about {{missingField}}." });
    const bytes = csvBuilder(["date", "name"], [["03-14", "Ada"]]);
    await expect(importDatedList(e.scope, seriesId, file(bytes))).rejects.toMatchObject({ name: "ValidationIssuesError" });
    const detail = await getStandingSeries(e.scope, seriesId);
    expect(detail.rows.total).toBe(0);
  });

  it("refuses a whole file with a file-level CSV problem, leaving the list untouched (FR-021)", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    const bytes = csvBuilder(["date", "name"], [["03-14", "Ada"]]);
    await importDatedList(e.scope, seriesId, file(bytes));
    const noDateColumn = csvBuilder(["name"], [["Ada"]]);
    await expect(importDatedList(e.scope, seriesId, file(noDateColumn))).rejects.toMatchObject({ name: "ValidationIssuesError" });
    const detail = await getStandingSeries(e.scope, seriesId);
    expect(detail.rows.total).toBe(1);
  });
});
