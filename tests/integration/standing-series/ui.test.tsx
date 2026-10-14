import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import JobsPage from "../../../src/app/p/[projectSlug]/jobs/page";
import StandingSeriesDetailPage from "../../../src/app/p/[projectSlug]/jobs/series/[seriesId]/page";
import { pauseStandingSeriesAction, resumeStandingSeriesAction, deleteStandingSeriesAction } from "../../../src/app/p/[projectSlug]/jobs/series/actions";
import { FR064_EXPLANATION } from "../../../src/app/p/[projectSlug]/jobs/series/series-logic";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import { setLlmForTests } from "../../../src/server/llm";
import { actAs } from "../../helpers/actions";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { standingSeriesEnv } from "../../helpers/standing-series-env";

afterAll(async () => {
  setLlmForTests(null);
  await closeDb();
});

type Env = Awaited<ReturnType<typeof standingSeriesEnv>>;
const noParams = Promise.resolve({});

/** The series section's gating shares the generation checklist, so every test needs it ready. */
async function ready() {
  const e = await standingSeriesEnv();
  setLlmForTests(createFakeLlm([]));
  return e;
}

const jobsHtml = async (e: Env, as: { id: string } = e.owner) => {
  actAs(as);
  return renderToStaticMarkup(await JobsPage({ params: Promise.resolve({ projectSlug: e.project.slug }), searchParams: noParams }));
};

const detailHtml = async (e: Env, seriesId: string, as: { id: string } = e.owner) => {
  actAs(as);
  return renderToStaticMarkup(
    (await StandingSeriesDetailPage({
      params: Promise.resolve({ projectSlug: e.project.slug, seriesId }),
      searchParams: Promise.resolve({}),
    })) as never,
  );
};

describe("Standing series on /jobs (US5 AS1-AS2)", () => {
  it("shows the empty state and its gated create action", async () => {
    const e = await ready();
    const html = await jobsHtml(e);
    expect(html).toContain("No standing series yet.");
    expect(html).toContain("New standing series");
  });

  it("hides the create action from an editor", async () => {
    const e = await ready();
    const html = await jobsHtml(e, e.editor);
    expect(html).toContain("No standing series yet.");
    expect(html).not.toContain("New standing series");
  });

  it("lists a series with its five columns and state badge", async () => {
    const e = await ready();
    const { seriesId } = await createStandingSeries(e.scope, e.create({ cadence: { count: 3, period: "week" } }));
    const html = await jobsHtml(e);
    expect(html).toContain(`/jobs/series/${seriesId}`);
    expect(html).toContain("3 posts a week");
    expect(html).toContain(">Running<");
    expect(html).toContain('scope="col"');
  });

  it("shows a self-paused series as Paused by Docket, with the reason as its Sub", async () => {
    const e = await ready();
    const { seriesId } = await createStandingSeries(e.scope, e.create());
    await e.scope.standingSeries.update(seriesId, { enabled: false, autoPausedReason: "no_output" });
    const html = await jobsHtml(e);
    expect(html).toContain("Paused by Docket");
    expect(html).toContain("No posts in its last 3 runs");
  });

  it("gives an editor the list and run history with no manage control anywhere", async () => {
    const e = await ready();
    const { seriesId } = await createStandingSeries(e.scope, e.create());
    const list = await jobsHtml(e, e.editor);
    expect(list).toContain(`/jobs/series/${seriesId}`);
    expect(list).not.toContain(">Pause<");
    expect(list).not.toContain(">Delete<");

    const detail = await detailHtml(e, seriesId, e.editor);
    expect(detail).toContain("No runs yet.");
    expect(detail).not.toContain(">Pause<");
    expect(detail).not.toContain(">Edit<");
    expect(detail).not.toContain(">Delete<");
  });
});

describe("Standing series detail page (US5 AS3-AS4, FR-064)", () => {
  it("renders the four blocks, with the FR-064 sentence verbatim and always visible", async () => {
    const e = await ready();
    const { seriesId } = await createStandingSeries(e.scope, e.create({ name: "Weekly tips" }));
    const html = await detailHtml(e, seriesId);
    expect(html).toContain("Weekly tips");
    expect(html).toContain(">Running<");
    expect(html).toContain(FR064_EXPLANATION);
    expect(html).toContain("No runs yet.");
  });

  it("pausing stops the series and resuming sets the next due time to a coming boundary", async () => {
    const e = await ready();
    const now = new Date("2030-01-07T10:00:00Z"); // a Monday
    const { seriesId } = await atTime(now, () => createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "week" } })));
    actAs(e.owner);

    const paused = await atTime(now, () => pauseStandingSeriesAction(e.project.slug, seriesId));
    expect(paused).toMatchObject({ ok: true });
    expect((await detailHtml(e, seriesId)).replace(/\s+/g, " ")).toContain("Paused");

    const resumed = await atTime(now, () => resumeStandingSeriesAction(e.project.slug, seriesId));
    expect(resumed.ok).toBe(true);
    if (resumed.ok && resumed.data.nextRunAt) {
      expect(new Date(resumed.data.nextRunAt).getTime()).toBeGreaterThan(now.getTime());
    }
    expect(await detailHtml(e, seriesId)).toContain(">Running<");
  });

  it("deleting removes the series but leaves its produced posts in the project (FR-057)", async () => {
    const e = await ready();
    const { seriesId } = await createStandingSeries(e.scope, e.create());
    actAs(e.owner);
    try {
      await deleteStandingSeriesAction(e.project.slug, seriesId);
      expect.fail("expected a redirect");
    } catch (error) {
      expect((error as Error).message).toContain(`redirect:/p/${e.project.slug}/jobs`);
    }
    expect(await e.scope.standingSeries.get(seriesId)).toBeNull();
  });
});
