import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setLlmForTests } from "../../../src/server/llm";
import { setImageProviderForTests } from "../../../src/server/llm/image-provider";
import { NO_REAL_PEOPLE } from "../../../src/server/llm/image-generation";
import { runStandingSeries, type StandingSeriesCounts } from "../../../src/server/scheduler/standing-series";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import { listRecentFailures } from "../../../src/server/services/generation/failures";
import * as accounts from "../../../src/server/services/accounts";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { standingSeries } from "../../../src/server/db/schema";
import type { NewDatedRow } from "../../../src/server/dal/standing-series-dated";
import { closeDb } from "../../helpers/db";
import { atTime } from "../../helpers/clock";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { createFakeImageProvider } from "../../helpers/fake-image";
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
  setImageProviderForTests(null);
  await clearHolds();
});
afterAll(async () => {
  await closeDb();
});

const post = (text: string, variantKey = "mock", images = 0): FakeStep => ({
  ok: {
    variants: { [variantKey]: { text } },
    ...(images > 0 ? { imageAltTexts: Array.from({ length: images }, (_, i) => `Alt text ${i + 1}`) } : {}),
  },
});

async function tick(at: Date): Promise<StandingSeriesCounts> {
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

/** A pool image large enough for Instagram's capability declaration (minWidth 320, square aspect). */
async function igAsset(e: Awaited<ReturnType<typeof standingSeriesEnv>>) {
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

function rowInput(over: Partial<NewDatedRow> & { ordinal: number }): NewDatedRow {
  return {
    month: 3,
    day: 14,
    year: null,
    keyValue: `Row ${over.ordinal}`,
    fields: { name: `Row ${over.ordinal}` },
    mediaFilename: null,
    mediaAssetId: null,
    nextTargetDate: null,
    sourceLine: over.ordinal + 2,
    ...over,
  };
}

describe("dated series media resolution (SC-010, FR-016, FR-038-FR-040)", () => {
  it("SC-010: generate source never receives row data in the recorded prompt", async () => {
    const e = await standingSeriesEnv();
    const provider = createFakeImageProvider([{ bytes: await png(64, 64) }]);
    setImageProviderForTests(provider);
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null, media: { source: "generate", prompt: "A birthday cake" } })),
    );
    await e.scope.standingSeries.update(seriesId, { template: "Write about {{name}}.", templateFields: ["name"] });
    await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 0, keyValue: "Secret Name", fields: { name: "Secret Name" }, nextTargetDate: "2026-03-14" }));

    setLlmForTests(createFakeLlm([post("Happy birthday!", "mock", 1)]));
    expect((await tick(new Date("2026-03-14T00:00:01.000Z"))).produced).toBe(1);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.prompt).toBe(`A birthday cake\n\n${NO_REAL_PEOPLE}`);
    expect(provider.requests[0]!.prompt).not.toContain("Secret Name");
  });

  it("a named portrait's post carries it unreserved, not claimed, and reused the following year", async () => {
    const e = await standingSeriesEnv();
    const asset = await e.asset({ filename: "ada.png" });
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null, media: { source: "none" } })),
    );
    await e.scope.datedRows.insert(
      seriesId,
      rowInput({ ordinal: 0, keyValue: "Ada", nextTargetDate: "2026-03-14", mediaFilename: "ada.png", mediaAssetId: asset.id }),
    );

    setLlmForTests(createFakeLlm([post("Happy birthday!", "mock", 1)]));
    expect((await tick(new Date("2026-03-14T00:00:01.000Z"))).produced).toBe(1);
    const runs1 = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const positions1 = await e.scope.standingSeriesPositions.listForRun(runs1[0]!.id);
    expect(positions1[0]!.mediaAssetId).toBeNull();

    setLlmForTests(createFakeLlm([post("Again!", "mock", 1)]));
    expect((await tick(new Date("2027-03-14T00:00:01.000Z"))).produced).toBe(1);
    const runs2 = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const run2027 = runs2.find((r) => r.periodStart === "2027-03-14")!;
    const positions2 = await e.scope.standingSeriesPositions.listForRun(run2027.id);
    const post2 = await e.scope.posts.findByStandingSeriesPosition(positions2[0]!.id);
    expect(await e.scope.posts.listMediaIds(post2!.id)).toEqual([asset.id]);
  });

  it("two rows sharing the same named asset both produce their own post with it", async () => {
    const e = await standingSeriesEnv();
    const asset = await e.asset({ filename: "shared.png" });
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null, media: { source: "none" } })),
    );
    await e.scope.datedRows.insert(
      seriesId,
      rowInput({ ordinal: 0, keyValue: "First", nextTargetDate: "2026-03-14", mediaFilename: "shared.png", mediaAssetId: asset.id }),
    );
    await e.scope.datedRows.insert(
      seriesId,
      rowInput({ ordinal: 1, keyValue: "Second", nextTargetDate: "2026-03-14", mediaFilename: "shared.png", mediaAssetId: asset.id }),
    );

    setLlmForTests(createFakeLlm([post("Post one.", "mock", 1), post("Post two.", "mock", 1)]));
    expect((await tick(new Date("2026-03-14T00:00:01.000Z"))).produced).toBe(2);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    expect(positions.filter((p) => p.status === "produced")).toHaveLength(2);
    for (const p of positions) {
      const post1 = await e.scope.posts.findByStandingSeriesPosition(p.id);
      expect(await e.scope.posts.listMediaIds(post1!.id)).toEqual([asset.id]);
    }
  });

  it("a row's own reference wins over the series' source; a row naming none falls back to it", async () => {
    const e = await standingSeriesEnv();
    const namedAsset = await e.asset({ filename: "named.png" });
    const poolAsset = await e.asset({ filename: null });
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null, media: { source: "pool" } })),
    );
    await e.scope.datedRows.insert(
      seriesId,
      rowInput({ ordinal: 0, keyValue: "Named", nextTargetDate: "2026-03-14", mediaFilename: "named.png", mediaAssetId: namedAsset.id }),
    );
    await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 1, keyValue: "Unnamed", nextTargetDate: "2026-03-14" }));

    setLlmForTests(createFakeLlm([post("Named post.", "mock", 1), post("Unnamed post.", "mock", 1)]));
    expect((await tick(new Date("2026-03-14T00:00:01.000Z"))).produced).toBe(2);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    const named = positions.find((p) => (p.dated as { keyValue: string } | null)?.keyValue === "Named")!;
    const unnamed = positions.find((p) => (p.dated as { keyValue: string } | null)?.keyValue === "Unnamed")!;
    expect(named.mediaAssetId).toBeNull();
    const namedPost = await e.scope.posts.findByStandingSeriesPosition(named.id);
    expect(await e.scope.posts.listMediaIds(namedPost!.id)).toEqual([namedAsset.id]);
    expect(unnamed.mediaAssetId).toBe(poolAsset.id);
  });

  it("a deleted named asset skips with the media reason, not a failure", async () => {
    const e = await standingSeriesEnv();
    const ig = await connectInstagram(e.scope);
    const asset = await e.asset({ filename: "gone.png" });
    await e.scope.media.softDelete(asset.id, new Date());
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(
        e.scope,
        e.create({ targetAccountIds: [ig.id], occurrenceRule: "dated_list", cadence: null, media: { source: "none" } }),
      ),
    );
    await e.scope.datedRows.insert(
      seriesId,
      rowInput({ ordinal: 0, keyValue: "Gone", nextTargetDate: "2026-03-14", mediaFilename: "gone.png", mediaAssetId: asset.id }),
    );

    setLlmForTests(createFakeLlm([post("Should skip.")]));
    const counts = await tick(new Date("2026-03-14T00:00:01.000Z"));
    expect(counts.produced).toBe(0);
    expect(counts.skipped).toBe(1);
    expect(counts.failed).toBe(0);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    expect(positions[0]!.skipReason).toBe("media_unusable");
    expect(await listRecentFailures(e.scope)).toEqual([]);
  });

  it("an exhausted pool skips only the unnamed rows; named rows still fire on their own asset", async () => {
    const e = await standingSeriesEnv();
    const ig = await connectInstagram(e.scope);
    const named = await igAsset(e);
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(
        e.scope,
        e.create({ targetAccountIds: [ig.id], occurrenceRule: "dated_list", cadence: null, media: { source: "pool" } }),
      ),
    );
    await e.scope.datedRows.insert(
      seriesId,
      rowInput({ ordinal: 0, keyValue: "Named", nextTargetDate: "2026-03-14", mediaFilename: "named.png", mediaAssetId: named.id }),
    );
    await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 1, keyValue: "Unnamed one", nextTargetDate: "2026-03-14" }));
    await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 2, keyValue: "Unnamed two", nextTargetDate: "2026-03-14" }));

    setLlmForTests(createFakeLlm([post("Named post.", "instagram", 1)]));
    const counts = await tick(new Date("2026-03-14T00:00:01.000Z"));
    expect(counts.produced).toBe(1);
    expect(counts.skipped).toBe(2);
    expect(counts.failed).toBe(0);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    const skipped = positions.filter((p) => p.status === "skipped");
    expect(skipped).toHaveLength(2);
    for (const p of skipped) expect(p.skipReason).toBe("pool_exhausted");
    expect(await listRecentFailures(e.scope)).toEqual([]);
  });

  it("a media-required skip counts as no failure and no post", async () => {
    const e = await standingSeriesEnv();
    const ig = await connectInstagram(e.scope);
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(
        e.scope,
        e.create({ targetAccountIds: [ig.id], occurrenceRule: "dated_list", cadence: null, media: { source: "pool" } }),
      ),
    );
    await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 0, keyValue: "No pool", nextTargetDate: "2026-03-14" }));

    setLlmForTests(createFakeLlm([post("Should skip.")]));
    const counts = await tick(new Date("2026-03-14T00:00:01.000Z"));
    expect(counts.produced).toBe(0);
    expect(counts.skipped).toBe(1);
    expect(counts.failed).toBe(0);
    expect(await listRecentFailures(e.scope)).toEqual([]);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs[0]!.outcome).toBe("produced_none");
  });
});
