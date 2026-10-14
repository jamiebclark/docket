import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setLlmForTests } from "../../../src/server/llm";
import { runStandingSeries, type StandingSeriesCounts } from "../../../src/server/scheduler/standing-series";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { NotFoundError } from "../../../src/server/dal/errors";
import {
  createStandingSeries,
  deleteStandingSeries,
  pauseStandingSeries,
  resumeStandingSeries,
  updateStandingSeries,
} from "../../../src/server/services/standing-series/manage";
import { getStandingSeries, listStandingSeries } from "../../../src/server/services/standing-series/read";
import { listRecentFailures } from "../../../src/server/services/generation/failures";
import * as accounts from "../../../src/server/services/accounts";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { standingSeries } from "../../../src/server/db/schema";
import { closeDb } from "../../helpers/db";
import { atTime } from "../../helpers/clock";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { png } from "../../helpers/images";
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

const post = (text: string): FakeStep => ({
  ok: { variants: { instagram: { text } }, imageAltTexts: ["A photo"] },
});

function tick(at: Date): Promise<StandingSeriesCounts> {
  return atTime(at, () => runStandingSeries({ config: CONFIG, tickId: "test", startedAt: at }));
}

async function connectInstagram(scope: Awaited<ReturnType<typeof standingSeriesEnv>>["scope"]) {
  return accounts.saveConnectedAccount(scope, {
    providerKey: "instagram",
    externalAccountId: `ig-${randomUUID().slice(0, 8)}`,
    displayName: "Insta",
    settings: {},
  });
}

async function poolAsset(e: Awaited<ReturnType<typeof standingSeriesEnv>>) {
  const key = `projects/${e.project.id}/media/${randomUUID()}/original.png`;
  const bytes = await png(640, 640);
  await e.storage.put(key, bytes, "image/png");
  return e.scope.media.insert({
    storageKey: key,
    publicUrl: e.storage.publicUrl(key),
    mimeType: "image/png",
    byteSize: bytes.length,
    width: 640,
    height: 640,
    altText: "A photo",
    tags: [],
  });
}

async function setUpDueSeries(e: Awaited<ReturnType<typeof standingSeriesEnv>>, createdAt: Date) {
  const ig = await connectInstagram(e.scope);
  const asset = await poolAsset(e);
  const { seriesId } = await atTime(createdAt, () =>
    createStandingSeries(e.scope, e.create({ targetAccountIds: [ig.id], media: { source: "pool" } })),
  );
  return { seriesId, account: ig, asset };
}

describe("standing-series cross-project isolation (SC-009)", () => {
  it("two projects' due series, runs, positions, posts and assets never cross under the same tick", async () => {
    const created = new Date("2026-02-01T00:00:00.000Z");
    const a = await standingSeriesEnv();
    const b = await standingSeriesEnv();
    const aSetup = await setUpDueSeries(a, created);
    const bSetup = await setUpDueSeries(b, created);

    setLlmForTests(createFakeLlm([post("Post one."), post("Post two."), post("Post three."), post("Post four.")]));
    const firingTime = new Date("2026-02-02T00:00:01.000Z");
    const counts = await tick(firingTime);
    expect(counts.produced).toBe(2);

    const aDetail = await getStandingSeries(a.scope, aSetup.seriesId);
    const bDetail = await getStandingSeries(b.scope, bSetup.seriesId);
    expect(aDetail.runs).toHaveLength(1);
    expect(bDetail.runs).toHaveLength(1);
    const aPostId = aDetail.runs[0]!.produced[0]!.postId;
    const bPostId = bDetail.runs[0]!.produced[0]!.postId;
    expect(aPostId).not.toBe(bPostId);

    // Neither service function nor the worker path exposes the other project's series.
    const nf = (promise: Promise<unknown>) => expect(promise).rejects.toBeInstanceOf(NotFoundError);
    await nf(getStandingSeries(a.scope, bSetup.seriesId));
    await nf(getStandingSeries(b.scope, aSetup.seriesId));
    await nf(updateStandingSeries(a.scope, bSetup.seriesId, b.create()));
    await nf(pauseStandingSeries(a.scope, bSetup.seriesId));
    await nf(resumeStandingSeries(a.scope, bSetup.seriesId));
    await nf(deleteStandingSeries(a.scope, bSetup.seriesId));

    const aList = await listStandingSeries(a.scope);
    expect(aList.items.map((i) => i.id)).toEqual([aSetup.seriesId]);
    const bList = await listStandingSeries(b.scope);
    expect(bList.items.map((i) => i.id)).toEqual([bSetup.seriesId]);

    // Posts, positions and assets are not reachable from the other project's scope.
    expect(await a.scope.posts.findByStandingSeriesPosition(bPostId)).toBeNull();
    expect(await b.scope.posts.findByStandingSeriesPosition(aPostId)).toBeNull();
    expect(await a.scope.media.get(bSetup.asset.id)).toBeNull();
    expect(await b.scope.media.get(aSetup.asset.id)).toBeNull();
    expect(await a.scope.accounts.get(bSetup.account.id)).toBeNull();
    expect(await b.scope.accounts.get(aSetup.account.id)).toBeNull();

    // A hand-built cross-project id — another project's real row id, used against a scope it does not belong to.
    await nf(getStandingSeries(a.scope, bSetup.seriesId));
    expect(await listRecentFailures(a.scope)).toEqual([]);
    expect(await listRecentFailures(b.scope)).toEqual([]);

    // Each project's own data is untouched and fully reachable from its own scope.
    expect(aDetail.runs[0]!.outcome).toBe("produced_all");
    expect(bDetail.runs[0]!.outcome).toBe("produced_all");
  }, 60_000);
});
