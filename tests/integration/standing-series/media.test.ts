import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setLlmForTests } from "../../../src/server/llm";
import { NO_REAL_PEOPLE } from "../../../src/server/llm/image-generation";
import { setImageProviderForTests } from "../../../src/server/llm/image-provider";
import { setStorageForTests } from "../../../src/server/storage";
import { runStandingSeries, type StandingSeriesCounts } from "../../../src/server/scheduler/standing-series";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import { listRecentFailures } from "../../../src/server/services/generation/failures";
import { createJob } from "../../../src/server/services/jobs";
import * as accounts from "../../../src/server/services/accounts";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { standingSeries } from "../../../src/server/db/schema";
import { closeDb } from "../../helpers/db";
import { atTime } from "../../helpers/clock";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { createFakeImageProvider } from "../../helpers/fake-image";
import { createVideoAsset } from "../../helpers/factories";
import { png } from "../../helpers/images";
import { clearHolds } from "../../helpers/jobs-env";
import { standingSeriesEnv } from "../../helpers/standing-series-env";
import { loadAccounts } from "../../../src/server/services/generation/single";
import { openOrResumeRun } from "../../../src/server/services/standing-series/run";
import { resolvePositionMedia } from "../../../src/server/services/standing-series/media";

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

const post = (text: string, variantKey = "instagram", images = 0): FakeStep => ({
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

/** A pool image large enough to satisfy Instagram's capability declaration (minWidth 320, square aspect). */
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
async function igAssets(e: Awaited<ReturnType<typeof standingSeriesEnv>>, n: number) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await igAsset(e));
  return out;
}

describe("standing-series media (US4 AS1-AS5, FR-034-FR-041, SC-006)", () => {
  it("pool of 3 / cadence 3: 3 posts with 3 distinct images, invisible to a concurrent batch job or unused listing", async () => {
    const e = await standingSeriesEnv();
    const ig = await connectInstagram(e.scope);
    const pool = await igAssets(e, 3);
    const created = new Date("2026-01-10T00:00:00.000Z");
    await atTime(created, () =>
      createStandingSeries(
        e.scope,
        e.create({
          targetAccountIds: [ig.id],
          cadence: { count: 3, period: "day" },
          media: { source: "pool" },
        }),
      ),
    );
    setLlmForTests(
      createFakeLlm([
        { ok: { angles: [1, 2, 3].map((n) => ({ title: `Angle ${n}`, description: `About ${n}` })) } },
        post("Post one.", "instagram", 1),
        post("Post two.", "instagram", 1),
        post("Post three.", "instagram", 1),
      ]),
    );
    const counts = await tick(new Date("2026-01-11T00:00:01.000Z"));
    expect(counts.produced).toBe(3);

    const { rows } = await e.scope.standingSeries.list({ page: 1, pageSize: 10 });
    const runs = await e.scope.standingSeriesRuns.listForSeries(rows[0]!.id, { limit: 5 });
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    const usedIds = positions.map((p) => p.mediaAssetId);
    expect(new Set(usedIds).size).toBe(3);
    expect(usedIds.sort()).toEqual(pool.map((a) => a.id).sort());

    expect(await e.scope.media.listIdsForSelection({ unusedOnly: true, limit: 10 })).toEqual([]);

    setLlmForTests(createFakeLlm([]));
    await expect(createJob(e.scope, e.input())).rejects.toThrow("No unused images left to generate for");
  });

  it("pool of 1 / cadence 3: 1 produced, 2 skipped pool_exhausted naming the account, no failure, outcome produced_some", async () => {
    const e = await standingSeriesEnv();
    const ig = await connectInstagram(e.scope);
    const [onlyImage] = await igAssets(e, 1);
    const created = new Date("2026-01-10T00:00:00.000Z");
    await atTime(created, () =>
      createStandingSeries(
        e.scope,
        e.create({
          targetAccountIds: [ig.id],
          cadence: { count: 3, period: "day" },
          media: { source: "pool" },
        }),
      ),
    );
    setLlmForTests(
      createFakeLlm([
        { ok: { angles: [1, 2, 3].map((n) => ({ title: `Angle ${n}`, description: `About ${n}` })) } },
        post("Only post.", "instagram", 1),
      ]),
    );
    const counts = await tick(new Date("2026-01-11T00:00:01.000Z"));
    expect(counts.produced).toBe(1);
    expect(counts.skipped).toBe(2);
    expect(counts.failed).toBe(0);

    const { rows } = await e.scope.standingSeries.list({ page: 1, pageSize: 10 });
    const runs = await e.scope.standingSeriesRuns.listForSeries(rows[0]!.id, { limit: 5 });
    expect(runs[0]!.outcome).toBe("produced_some");
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    const skipped = positions.filter((p) => p.status === "skipped");
    expect(skipped).toHaveLength(2);
    for (const p of skipped) {
      expect(p.skipReason).toBe("pool_exhausted");
      expect(p.skipAccountId).toBe(ig.id);
      expect(p.attemptCount).toBe(0);
      expect(await e.scope.posts.findByStandingSeriesPosition(p.id)).toBeNull();
    }
    const produced = positions.find((p) => p.status === "produced")!;
    expect(produced.mediaAssetId).toBe(onlyImage!.id);
    expect(await listRecentFailures(e.scope)).toEqual([]);
  });

  it("media source generate with the stub provider: each post its own asset with provenance and the exact prompt body", async () => {
    const e = await standingSeriesEnv();
    const provider = createFakeImageProvider([{ bytes: await png(64, 64) }, { bytes: await png(64, 64) }]);
    setImageProviderForTests(provider);
    const created = new Date("2026-01-10T00:00:00.000Z");
    await atTime(created, () =>
      createStandingSeries(
        e.scope,
        e.create({
          cadence: { count: 2, period: "day" },
          media: { source: "generate", prompt: "A cool picture" },
        }),
      ),
    );
    setLlmForTests(
      createFakeLlm([
        { ok: { angles: [1, 2].map((n) => ({ title: `Angle ${n}`, description: `About ${n}` })) } },
        post("Post one.", "mock", 1),
        post("Post two.", "mock", 1),
      ]),
    );
    const counts = await tick(new Date("2026-01-11T00:00:01.000Z"));
    expect(counts.produced).toBe(2);
    expect(provider.requests).toHaveLength(2);
    for (const r of provider.requests) {
      expect(r.prompt).toBe(`A cool picture\n\n${NO_REAL_PEOPLE}`);
    }

    const { rows } = await e.scope.standingSeries.list({ page: 1, pageSize: 10 });
    const runs = await e.scope.standingSeriesRuns.listForSeries(rows[0]!.id, { limit: 5 });
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    const assetIds = positions.map((p) => p.mediaAssetId);
    expect(new Set(assetIds).size).toBe(2);
    for (const id of assetIds) {
      const [asset] = await e.scope.media.getMany([id!]);
      expect(asset!.generationPrompt).toBe("A cool picture");
      expect(asset!.generationProvider).toBe("openai");
    }
  });

  it("media source generate not configured: every position skipped, no post, series media_source unchanged", async () => {
    const e = await standingSeriesEnv();
    const ig = await connectInstagram(e.scope);
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(
        e.scope,
        e.create({
          targetAccountIds: [ig.id],
          cadence: { count: 2, period: "day" },
          media: { source: "generate", prompt: "A cool picture" },
        }),
      ),
    );
    setLlmForTests(
      createFakeLlm([{ ok: { angles: [1, 2].map((n) => ({ title: `Angle ${n}`, description: `About ${n}` })) } }]),
    );
    const counts = await tick(new Date("2026-01-11T00:00:01.000Z"));
    expect(counts.produced).toBe(0);
    expect(counts.skipped).toBe(2);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    for (const p of positions) {
      expect(p.skipReason).toBe("image_generation_not_configured");
      expect(await e.scope.posts.findByStandingSeriesPosition(p.id)).toBeNull();
    }
    const series = await e.scope.standingSeries.get(seriesId);
    expect(series!.mediaSource).toBe("generate");
  });

  it("a non-media-required account with media source none: text-only, nothing skipped", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" }, media: { source: "none" } })),
    );
    setLlmForTests(createFakeLlm([post("Text only.", "mock")]));
    const counts = await tick(new Date("2026-01-11T00:00:01.000Z"));
    expect(counts.produced).toBe(1);
    expect(counts.skipped).toBe(0);
  });

  it("storage not configured: creating a pool or generate series is refused", async () => {
    const e = await standingSeriesEnv();
    setStorageForTests(undefined);
    await expect(
      createStandingSeries(e.scope, e.create({ media: { source: "pool" } })),
    ).rejects.toThrow();
    await expect(
      createStandingSeries(e.scope, e.create({ media: { source: "generate", prompt: "A pic" } })),
    ).rejects.toThrow();
  });

  it("storage removed after creation: an existing generate series skips media_storage_not_configured rather than failing", async () => {
    const e = await standingSeriesEnv();
    const ig = await connectInstagram(e.scope);
    setImageProviderForTests(createFakeImageProvider([]));
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(
        e.scope,
        e.create({
          targetAccountIds: [ig.id],
          cadence: { count: 1, period: "day" },
          media: { source: "generate", prompt: "A pic" },
        }),
      ),
    );
    setStorageForTests(undefined);
    setLlmForTests(createFakeLlm([]));
    const counts = await tick(new Date("2026-01-11T00:00:01.000Z"));
    expect(counts.skipped).toBe(1);
    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    expect(positions[0]!.skipReason).toBe("media_storage_not_configured");
  });

  it("a restart between reserving and producing reuses the asset: the stub provider's call count stays 1", async () => {
    const e = await standingSeriesEnv();
    const provider = createFakeImageProvider([{ bytes: await png(64, 64) }]);
    setImageProviderForTests(provider);
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(
        e.scope,
        e.create({ cadence: { count: 1, period: "day" }, media: { source: "generate", prompt: "A pic" } }),
      ),
    );
    const runs0 = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    // Open the run and reserve the asset directly, as the producer would mid-run before a restart.
    const series = (await e.scope.standingSeries.get(seriesId))!;
    const opened = await openOrResumeRun(e.scope, series, new Date("2026-01-11T00:00:01.000Z"));
    const positions = await e.scope.standingSeriesPositions.listForRun(opened!.run.id);
    const position = positions[0]!;
    const config = opened!.run.config as { media: { source: "generate"; prompt: string } };
    const accountRows = await loadAccounts(e.scope, [e.account.id]);
    const first = await resolvePositionMedia(e.scope, position, config.media, accountRows);
    expect(first.ok).toBe(true);
    expect(provider.requests).toHaveLength(1);

    const reloaded = (await e.scope.standingSeriesPositions.listForRun(opened!.run.id)).find((p) => p.id === position.id)!;
    const second = await resolvePositionMedia(e.scope, reloaded, config.media, accountRows);
    expect(second.ok).toBe(true);
    expect(provider.requests).toHaveLength(1);
    expect(runs0).toBeDefined();
  });

  it("the same pool image wanted by a batch job and a standing series in one tick resolves to one winner", async () => {
    const e = await standingSeriesEnv();
    const [image] = await e.assets(1);
    const created = new Date("2026-01-10T00:00:00.000Z");
    await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" }, media: { source: "pool" } })),
    );
    const series = (await e.scope.standingSeries.get((await e.scope.standingSeries.list({ page: 1, pageSize: 1 })).rows[0]!.id))!;
    const opened = await openOrResumeRun(e.scope, series, new Date("2026-01-11T00:00:01.000Z"));
    const position = (await e.scope.standingSeriesPositions.listForRun(opened!.run.id))[0]!;
    const accountRows = await loadAccounts(e.scope, [e.account.id]);

    setLlmForTests(createFakeLlm([]));
    const [seriesClaim, jobClaim] = await Promise.allSettled([
      resolvePositionMedia(e.scope, position, { source: "pool" }, accountRows),
      createJob(e.scope, e.input({ source: { kind: "media", selection: { mode: "unused" }, includeUsed: false } })),
    ]);

    const seriesGotIt = seriesClaim.status === "fulfilled" && seriesClaim.value.ok && seriesClaim.value.assets.length > 0;
    const jobGotIt = jobClaim.status === "fulfilled";
    expect(seriesGotIt !== jobGotIt).toBe(true);
    expect(await e.scope.media.reservedAmong([image!.id])).toEqual([image!.id]);
  });

  it("a video asset is never eligible for pool media", async () => {
    const e = await standingSeriesEnv();
    await createVideoAsset(e.project.id, {});
    const [onlyImage] = await e.assets(1);
    const created = new Date("2026-01-10T00:00:00.000Z");
    await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" }, media: { source: "pool" } })),
    );
    setLlmForTests(createFakeLlm([post("Only post.", "mock", 1)]));
    const counts = await tick(new Date("2026-01-11T00:00:01.000Z"));
    expect(counts.produced).toBe(1);
    const { rows } = await e.scope.standingSeries.list({ page: 1, pageSize: 10 });
    const runs = await e.scope.standingSeriesRuns.listForSeries(rows[0]!.id, { limit: 5 });
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    expect(positions[0]!.mediaAssetId).toBe(onlyImage!.id);
  });
}, 60_000);
