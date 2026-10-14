import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { forProject } from "../../../src/server/dal/scope";
import { ForbiddenError, NotFoundError } from "../../../src/server/dal/errors";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import { importDatedList } from "../../../src/server/services/standing-series/dated-import";
import { addDatedRow, deleteDatedRow, updateDatedRow } from "../../../src/server/services/standing-series/dated-rows";
import { getStandingSeries } from "../../../src/server/services/standing-series/read";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { standingSeries } from "../../../src/server/db/schema";
import { csvBuilder, createUser } from "../../helpers/factories";
import { fakeSession } from "../../helpers/auth";
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
  await e.scope.standingSeries.update(seriesId, { templateFields: ["name"] });
  return seriesId;
}

const file = (bytes: Buffer, name = "list.csv") => ({ name, bytes: new Uint8Array(bytes) });
const csvFile = () => file(csvBuilder(["date", "name"], [["03-14", "Ada Lovelace"]]));

describe("dated-series list authorization (US6 AS1-AS4, FR-049-FR-051, SC-009)", () => {
  it("refuses an editor every list-changing call, leaving the list unchanged, while still allowing read", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    const { rowId } = await addDatedRow(e.scope, seriesId, { date: "03-14", media: null, fields: { name: "Ada Lovelace" } });
    const editorScope = await e.as(e.editor);

    await expect(importDatedList(editorScope, seriesId, csvFile())).rejects.toThrow(ForbiddenError);
    await expect(addDatedRow(editorScope, seriesId, { date: "04-01", media: null, fields: { name: "Grace Hopper" } })).rejects.toThrow(
      ForbiddenError,
    );
    await expect(
      updateDatedRow(editorScope, seriesId, rowId, { date: "03-14", media: null, fields: { name: "Edited" } }),
    ).rejects.toThrow(ForbiddenError);
    await expect(deleteDatedRow(editorScope, seriesId, rowId)).rejects.toThrow(ForbiddenError);

    const detail = await getStandingSeries(editorScope, seriesId);
    expect(detail.rows.total).toBe(1);
    expect(detail.rows.items[0]!.id).toBe(rowId);
    expect(detail.rows.items[0]!.keyValue).toBe("Ada Lovelace");
    expect(detail.upcoming).toBeDefined();
    expect(detail.lastImport).toBeNull();
  });

  it("refuses a non-member before a scope can even be built", async () => {
    const e = await standingSeriesEnv();
    await datedSeries(e);
    const outsider = await createUser();
    await expect(forProject(fakeSession(outsider.id), e.project.slug)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses every call against another project's series or row id, leaving each project's own list untouched", async () => {
    const a = await standingSeriesEnv();
    const b = await standingSeriesEnv();
    const aSeriesId = await datedSeries(a);
    const bSeriesId = await datedSeries(b);
    const { rowId: aRowId } = await addDatedRow(a.scope, aSeriesId, { date: "03-14", media: null, fields: { name: "Ada Lovelace" } });
    const { rowId: bRowId } = await addDatedRow(b.scope, bSeriesId, { date: "04-01", media: null, fields: { name: "Grace Hopper" } });

    const nf = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(NotFoundError);
    await nf(importDatedList(a.scope, bSeriesId, csvFile()));
    await nf(addDatedRow(a.scope, bSeriesId, { date: "05-01", media: null, fields: { name: "Someone" } }));
    await nf(updateDatedRow(a.scope, bSeriesId, bRowId, { date: "04-01", media: null, fields: { name: "Edited" } }));
    await nf(updateDatedRow(a.scope, aSeriesId, bRowId, { date: "04-01", media: null, fields: { name: "Edited" } }));
    await nf(deleteDatedRow(a.scope, bSeriesId, bRowId));
    await nf(deleteDatedRow(a.scope, aSeriesId, bRowId));
    await nf(getStandingSeries(a.scope, bSeriesId));

    const aDetail = await getStandingSeries(a.scope, aSeriesId);
    expect(aDetail.rows.total).toBe(1);
    expect(aDetail.rows.items[0]!.id).toBe(aRowId);
    const bDetail = await getStandingSeries(b.scope, bSeriesId);
    expect(bDetail.rows.total).toBe(1);
    expect(bDetail.rows.items[0]!.id).toBe(bRowId);
  });

  it("reports another project's media asset as unmatched on import, never crossing projects", async () => {
    const a = await standingSeriesEnv();
    const b = await standingSeriesEnv();
    const seriesId = await datedSeries(a);
    const otherAsset = await b.asset({ filename: "other-project.png" });
    const bytes = csvBuilder(["date", "name", "media"], [["03-14", "Ada Lovelace", "other-project.png"]]);
    const result = await importDatedList(a.scope, seriesId, file(bytes));
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!.message).toContain('no image called "other-project.png" is in the library.');
    expect(await a.scope.media.get(otherAsset.id)).toBeNull();
  });
});
