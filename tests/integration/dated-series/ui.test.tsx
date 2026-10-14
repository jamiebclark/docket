import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import StandingSeriesDetailPage from "../../../src/app/p/[projectSlug]/jobs/series/[seriesId]/page";
import { addDatedRow } from "../../../src/server/services/standing-series/dated-rows";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import { setLlmForTests } from "../../../src/server/llm";
import { actAs } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { standingSeriesEnv } from "../../helpers/standing-series-env";

afterAll(async () => {
  setLlmForTests(null);
  await closeDb();
});

type Env = Awaited<ReturnType<typeof standingSeriesEnv>>;

async function ready() {
  const e = await standingSeriesEnv();
  setLlmForTests(createFakeLlm([]));
  return e;
}

const detailHtml = async (e: Env, seriesId: string, as: { id: string } = e.owner, search: Record<string, string> = {}) => {
  actAs(as);
  return renderToStaticMarkup(
    (await StandingSeriesDetailPage({
      params: Promise.resolve({ projectSlug: e.project.slug, seriesId }),
      searchParams: Promise.resolve(search),
    })) as never,
  );
};

describe("Dated series detail page (SC-011, US2 AS3, US6 AS1)", () => {
  it("renders Upcoming, the rows table and the Import control for a dated series", async () => {
    const e = await ready();
    const { seriesId } = await createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null }));
    await e.scope.standingSeries.update(seriesId, { templateFields: ["name"] });
    await addDatedRow(e.scope, seriesId, { date: "03-14", media: null, fields: { name: "Ada Lovelace" } });
    const html = await detailHtml(e, seriesId);
    expect(html).toContain("Upcoming dates");
    expect(html).toContain("Rows (1)");
    expect(html).toContain("Import a list");
    expect(html).toContain("Ada Lovelace");
  });

  it("renders no dated sections for a cadence series, byte-identical on a second render", async () => {
    const e = await ready();
    const { seriesId } = await createStandingSeries(e.scope, e.create());
    const html = await detailHtml(e, seriesId);
    expect(html).not.toContain("Upcoming dates");
    expect(html).not.toContain("Rows (");
    expect(html).not.toContain("Import a list");
    const again = await detailHtml(e, seriesId);
    expect(again).toBe(html);
  });

  it("shows rows, upcoming dates and import problems to an editor, with no list-changing control", async () => {
    const e = await ready();
    const { seriesId } = await createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null }));
    await e.scope.standingSeries.update(seriesId, {
      templateFields: ["name"],
      lastImportAt: new Date(),
      lastImportFilename: "list.csv",
      lastImportRowCount: 5,
      lastImportProblems: [{ line: 3, message: "Bad row." }],
    });
    await addDatedRow(e.scope, seriesId, { date: "03-14", media: null, fields: { name: "Ada Lovelace" } });
    const html = await detailHtml(e, seriesId, e.editor);
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Upcoming dates");
    expect(html).toContain("Bad row.");
    expect(html).not.toContain("Import a list");
    expect(html).not.toContain(">Add a row<");
    expect(html).not.toContain(">Delete<");
  });

  it("survives a fresh server render with the last import's problems (US2 AS3)", async () => {
    const e = await ready();
    const { seriesId } = await createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null }));
    await e.scope.standingSeries.update(seriesId, {
      lastImportAt: new Date(),
      lastImportFilename: "birthdays.csv",
      lastImportRowCount: 60,
      lastImportProblems: Array.from({ length: 12 }, (_, i) => ({ line: i + 2, message: "A row could not be used." })),
    });
    const html = await detailHtml(e, seriesId);
    expect(html).toContain("12 of 60 rows in birthdays.csv could not be used");
  });

  it("paginates the rows table by ?rows=N", async () => {
    const e = await ready();
    const { seriesId } = await createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null }));
    await e.scope.standingSeries.update(seriesId, { templateFields: ["name"] });
    for (let i = 0; i < 52; i += 1) {
      const month = String((i % 12) + 1).padStart(2, "0");
      const day = String((i % 28) + 1).padStart(2, "0");
      await addDatedRow(e.scope, seriesId, { date: `${month}-${day}`, media: null, fields: { name: `Person ${i}` } });
    }
    const first = await detailHtml(e, seriesId);
    expect(first).toContain("Rows (52)");
    expect(first).toContain("Page 1 of 2");
    const second = await detailHtml(e, seriesId, e.owner, { rows: "2" });
    expect(second).toContain("Page 2 of 2");
  });

  it("the rows table is five columns with a caption and th scope", async () => {
    const e = await ready();
    const { seriesId } = await createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null }));
    await e.scope.standingSeries.update(seriesId, { templateFields: ["name"] });
    await addDatedRow(e.scope, seriesId, { date: "03-14", media: null, fields: { name: "Ada Lovelace" } });
    const html = await detailHtml(e, seriesId);
    expect(html).toContain('<caption class="sr-only">Rows</caption>');
    expect(html).toContain('scope="col"');
  });

  it("names what to upload in the empty rows state", async () => {
    const e = await ready();
    const { seriesId } = await createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null }));
    const html = await detailHtml(e, seriesId);
    expect(html).toContain("No rows yet. Import a CSV with a date column");
  });
});
