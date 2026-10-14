import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { generationMetadataSchema, type GenerationRecord } from "@/lib/validation/generation";
import { setLlmForTests } from "../../../src/server/llm";
import { runStandingSeries, type StandingSeriesCounts } from "../../../src/server/scheduler/standing-series";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import { startSeries, writeSeriesPost } from "../../../src/server/services/generation/series";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { standingSeries } from "../../../src/server/db/schema";
import { closeDb } from "../../helpers/db";
import { atTime } from "../../helpers/clock";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
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

const post = (text: string): FakeStep => ({ ok: { variants: { mock: { text } } } });

function tick(at: Date): Promise<StandingSeriesCounts> {
  return atTime(at, () => runStandingSeries({ config: CONFIG, tickId: "test", startedAt: at }));
}

/** Strips the two fields the quickstart says are allowed to differ (mode and `series.id`). */
function normalizeRecord(r: GenerationRecord): unknown {
  return {
    ...r,
    mode: "SAME_MODE",
    inputs: { ...r.inputs, series: r.inputs.series ? { ...r.inputs.series, id: "SAME_SERIES_ID" } : null },
  };
}

describe("standing-series parity with a manual Generate (SC-003, FR-019)", () => {
  it("sends a byte-identical prompt and an identical record for the same brief/instructions/voice/accounts/angle", async () => {
    const e = await standingSeriesEnv();
    const brief = "Our new product line.";
    const instructions = "Keep it upbeat and brief.";
    const angle0 = { title: "Morning Routine", description: "How we start the day." };
    const angle1 = { title: "Behind the Scenes", description: "A peek into our process." };
    const approval = "review_required" as const;
    const scheduling = "leave_as_draft" as const;
    const created = new Date("2026-01-10T00:00:00.000Z");

    const firing = new Date("2026-01-11T00:00:01.000Z");
    setLlmForTests(createFakeLlm([post("Same post text.")]));
    const { seriesId: manualSeriesId } = await atTime(created, () =>
      startSeries(e.scope, {
        brief,
        instructions,
        sourceText: null,
        voiceProfileId: e.profile.id,
        targetAccountIds: [e.account.id],
        mediaIds: [],
        approval,
        scheduling,
        confirmUnreviewedQueue: false,
        count: 2,
        angles: [angle0, angle1],
      }),
    );
    const manualResult = await atTime(firing, () => writeSeriesPost(e.scope, manualSeriesId, 0));
    if (!manualResult.ok) throw new Error(`manual generate failed: ${manualResult.message}`);
    const manualPost = await e.scope.posts.get(manualResult.postId);

    const { seriesId: standingSeriesId } = await atTime(created, () =>
      createStandingSeries(
        e.scope,
        e.create({
          brief,
          template: instructions,
          voiceProfileId: e.profile.id,
          targetAccountIds: [e.account.id],
          cadence: { count: 2, period: "day" },
          media: { source: "none" },
          approval,
          scheduling,
          confirmUnreviewedQueue: false,
        }),
      ),
    );
    setLlmForTests(createFakeLlm([{ ok: { angles: [angle0, angle1] } }, post("Same post text.")]));
    const counts = await tick(firing);
    expect(counts.produced).toBe(1);
    const runs = await e.scope.standingSeriesRuns.listForSeries(standingSeriesId, { limit: 5 });
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    const standingPost = await e.scope.posts.findByStandingSeriesPosition(positions[0]!.id);

    expect(manualPost).not.toBeNull();
    expect(standingPost).not.toBeNull();
    const manualRecord = generationMetadataSchema.parse(manualPost!.generationMetadata).records.at(-1)!;
    const standingRecord = generationMetadataSchema.parse(standingPost!.generationMetadata).records.at(-1)!;

    // Byte-identical prompt composition for the same brief/instructions/voice/accounts/angle (FR-019).
    expect(standingRecord.prompt).toEqual(manualRecord.prompt);

    // The record differs only in mode and the series id it names.
    expect(manualRecord.mode).toBe("series_post");
    expect(standingRecord.mode).toBe("standing_series_post");
    expect(manualRecord.inputs.series!.id).toBe(manualSeriesId);
    expect(standingRecord.inputs.series!.id).toBe(runs[0]!.id);
    expect(normalizeRecord(standingRecord)).toEqual(normalizeRecord(manualRecord));

    // The post's reviewState, schedulingPolicy, targets and media are produced by the same call sites, not
    // a parallel standing-series-only path, so they come out identical too.
    expect(standingPost!.reviewState).toBe(manualPost!.reviewState);
    expect(standingPost!.schedulingPolicy).toBe(manualPost!.schedulingPolicy);
    const manualTargets = await e.scope.targets.listForPost(manualPost!.id);
    const standingTargets = await e.scope.targets.listForPost(standingPost!.id);
    expect(standingTargets.map((t) => t.status)).toEqual(manualTargets.map((t) => t.status));
    expect(await e.scope.posts.listMediaIds(standingPost!.id)).toEqual(await e.scope.posts.listMediaIds(manualPost!.id));
    // Both forced to review by the same policy, with the same decision recorded by `applyApprovalPolicy`.
    expect(standingRecord.policies.decision).toEqual(manualRecord.policies.decision);
  }, 60_000);
}, 60_000);
