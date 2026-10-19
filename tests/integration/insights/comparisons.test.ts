import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../../../src/server/db/client";
import { posts } from "../../../src/server/db/schema";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { pruneClosedStandingSeriesRunsBefore } from "../../../src/server/dal/standing-series";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import { buildComparisons } from "../../../src/server/services/insights/view";
import { closeDb } from "../../helpers/db";
import { createVoiceProfile } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";
import { standingSeriesEnv } from "../../helpers/standing-series-env";

afterAll(closeDb);

const TIME_ZONE = "UTC";
const DAY_MS = 86_400_000;
const NOW = new Date("2026-10-18T12:00:00Z");

type Env = Awaited<ReturnType<typeof postsEnv>>;

async function publish(
  env: Pick<Env, "scope">,
  accountId: string,
  opts: {
    origin?: "manual" | "generated" | "api";
    generationMetadata?: unknown;
    scheduleKind?: "slot" | "explicit" | "now";
    slotOccurrenceAt?: Date | null;
    publishedAt?: Date;
    value?: number;
  } = {},
) {
  const post = await env.scope.posts.insert({
    baseText: "A post.",
    origin: opts.origin ?? "manual",
    generationMetadata: (opts.generationMetadata ?? null) as never,
  });
  const [target] = await env.scope.targets.insertMany([{ postId: post.id, socialAccountId: accountId }]);
  await env.scope.targets.update(target!.id, {
    status: "published",
    externalId: `ext-${post.id}`,
    publishedAt: opts.publishedAt ?? NOW,
    scheduleKind: opts.scheduleKind ?? "now",
    slotOccurrenceAt: opts.slotOccurrenceAt ?? null,
  });
  await env.scope.posts.setStatus(post.id, "published");
  await env.scope.postMetricSnapshots.insertIfAbsent({
    postTargetId: target!.id,
    socialAccountId: accountId,
    providerKey: "mock",
    capturedAt: opts.publishedAt ?? NOW,
    metrics: { likeCount: opts.value ?? 10 },
  });
  return { post, target: target! };
}

async function linkToPosition(postId: string, positionId: string): Promise<void> {
  // The runner links this in the same transaction as its own insert (`project_id` is implicit there);
  // a test reaching in afterwards does it the way housekeeping's own cross-project passes do.
  await runCrossProject("test: link post to standing-series position", async () => {
    await getDb().update(posts).set({ standingSeriesPositionId: positionId }).where(eq(posts.id, postId));
  });
}

const WIDE_RANGE = { from: new Date(NOW.getTime() - DAY_MS), to: new Date(NOW.getTime() + DAY_MS) };

describe("comparisons and the floor, with a database (quickstart.md §4, US3, US4)", () => {
  it("groups 10 cadence posts against 9 dated_list posts as Evergreen vs Date-pegged, separate and counted (US4.1)", async () => {
    const e = await standingSeriesEnv();
    const cadence = await createStandingSeries(e.scope, e.create({ occurrenceRule: "cadence" }));
    const dated = await createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null }));

    for (let i = 0; i < 10; i++) {
      await publish(e, e.account.id, {
        origin: "generated",
        generationMetadata: { records: [{ standingSeries: { id: cadence.seriesId, name: "Cadence series", occurrenceRule: "cadence" } }] },
      });
    }
    for (let i = 0; i < 9; i++) {
      await publish(e, e.account.id, {
        origin: "generated",
        generationMetadata: { records: [{ standingSeries: { id: dated.seriesId, name: "Dated series", occurrenceRule: "dated_list" } }] },
      });
    }

    const comparisons = await buildComparisons({ projectId: e.project.id, timeZone: TIME_ZONE, range: WIDE_RANGE });
    const bySeriesKind = comparisons.find((c) => c.dimension === "series_kind" && c.metricKey === "likeCount");
    expect(bySeriesKind?.conclusion).toBe("ranked");
    expect(bySeriesKind?.groups.find((g) => g.label === "Evergreen")?.sampleSize).toBe(10);
    expect(bySeriesKind?.groups.find((g) => g.label === "Date-pegged")?.sampleSize).toBe(9);
  });

  it("a standing-series post whose run has been pruned falls back to the live join, then becomes a stated series_unrecorded exclusion once the run is gone (research.md §2.2)", async () => {
    const e = await standingSeriesEnv();
    const series = await createStandingSeries(e.scope, e.create({ occurrenceRule: "cadence" }));
    const run = await e.scope.standingSeriesRuns.openRun({
      seriesId: series.seriesId,
      period: "day",
      periodStart: "2026-07-01",
      periodStartAt: new Date("2026-07-01T00:00:00Z"),
      requestedCount: 4,
      config: {},
    });
    const positions = await e.scope.standingSeriesPositions.insertMany(run.id, 4, NOW);

    // No recorded `standingSeries` fact on any of these — they rely entirely on the live
    // position -> run -> series join (a post that predates this entry's recorded fact).
    for (const position of positions) {
      const { post } = await publish(e, e.account.id, { origin: "generated" });
      await linkToPosition(post.id, position.id);
    }

    const before = await buildComparisons({ projectId: e.project.id, timeZone: TIME_ZONE, range: WIDE_RANGE });
    const seriesKindBefore = before.find((c) => c.dimension === "series_kind" && c.metricKey === "likeCount");
    expect(seriesKindBefore?.groups.find((g) => g.label === "Evergreen")?.sampleSize).toBe(4);
    expect(seriesKindBefore?.exclusions.find((ex) => ex.reason === "series_unrecorded")).toBeUndefined();

    await e.scope.standingSeriesRuns.close(run.id, "produced_all", new Date(NOW.getTime() - 100 * DAY_MS));
    const pruned = await runCrossProject("test: prune closed standing-series runs", () =>
      pruneClosedStandingSeriesRunsBefore(new Date(), 100),
    );
    // Cross-project, like the prune itself: a worker's database carries closed runs left by other
    // files, so an absolute count asserts their isolation rather than this behaviour. That this
    // run in particular is gone is what the `series_unrecorded` exclusion below actually proves.
    expect(pruned).toBeGreaterThanOrEqual(1);

    const after = await buildComparisons({ projectId: e.project.id, timeZone: TIME_ZONE, range: WIDE_RANGE });
    const seriesKindAfter = after.find((c) => c.dimension === "series_kind" && c.metricKey === "likeCount");
    expect(seriesKindAfter?.groups.find((g) => g.label === "Evergreen")).toBeUndefined();
    expect(seriesKindAfter?.exclusions.find((ex) => ex.reason === "series_unrecorded")?.count).toBe(4);
  });

  it("a renamed voice profile shows its current name; an archived one is a stated removed group, from its recorded name (US4.4)", async () => {
    const e = await standingSeriesEnv();
    const renamed = await createVoiceProfile(e.project.id, { name: "Original Name" });
    const archived = await createVoiceProfile(e.project.id, { name: "To Archive" });

    for (let i = 0; i < 4; i++) {
      await publish(e, e.account.id, {
        origin: "generated",
        generationMetadata: { records: [{ voiceProfile: { id: renamed.id, versionId: renamed.versionIds[0], version: 1, name: "Original Name" } }] },
      });
    }
    for (let i = 0; i < 4; i++) {
      await publish(e, e.account.id, {
        origin: "generated",
        generationMetadata: { records: [{ voiceProfile: { id: archived.id, versionId: archived.versionIds[0], version: 1, name: "To Archive" } }] },
      });
    }

    await e.scope.voiceProfiles.rename(renamed.id, "New Name");
    await e.scope.voiceProfiles.setArchived(archived.id, NOW);

    const comparisons = await buildComparisons({ projectId: e.project.id, timeZone: TIME_ZONE, range: WIDE_RANGE });
    const byVoice = comparisons.find((c) => c.dimension === "voice_profile" && c.metricKey === "likeCount");
    const live = byVoice?.groups.find((g) => g.label === "New Name");
    const removed = byVoice?.groups.find((g) => g.label === "To Archive (removed)");
    expect(live?.removed).toBe(false);
    expect(removed?.removed).toBe(true);
  });

  it("manual, generated and api are three groups, api never folded into either (US4.5)", async () => {
    const env = await postsEnv();
    const account = await env.account();
    for (const origin of ["manual", "generated", "api"] as const) {
      for (let i = 0; i < 4; i++) await publish(env, account.id, { origin });
    }

    const comparisons = await buildComparisons({ projectId: env.project.id, timeZone: TIME_ZONE, range: WIDE_RANGE });
    const byOrigin = comparisons.find((c) => c.dimension === "origin" && c.metricKey === "likeCount");
    expect(byOrigin?.groups.map((g) => g.label).sort()).toEqual(["API", "Generated", "Manual"]);
    expect(byOrigin?.groups.every((g) => g.sampleSize === 4)).toBe(true);
  });

  it("buckets a 09:00 slot occurrence to its correct local weekday either side of a DST change, and re-buckets when the project's time zone changes (US3.6, US3.8)", async () => {
    const env = await postsEnv();
    const range = { from: new Date("2026-02-15T00:00:00Z"), to: new Date("2026-04-01T00:00:00Z") };

    // 2026-03-08 is the US spring-forward Sunday; 09:00 America/New_York before (EST) and after (EDT).
    for (let i = 0; i < 4; i++) {
      const account = await env.account();
      await publish(env, account.id, {
        scheduleKind: "slot",
        slotOccurrenceAt: new Date("2026-03-01T14:00:00Z"),
        publishedAt: new Date("2026-03-01T14:05:00Z"),
      });
    }
    for (let i = 0; i < 4; i++) {
      const account = await env.account();
      await publish(env, account.id, {
        scheduleKind: "slot",
        slotOccurrenceAt: new Date("2026-03-15T13:00:00Z"),
        publishedAt: new Date("2026-03-15T13:05:00Z"),
      });
    }

    const inET = await buildComparisons({ projectId: env.project.id, timeZone: "America/New_York", range });
    const byDayET = inET.find((c) => c.dimension === "day_of_week" && c.metricKey === "likeCount");
    expect(byDayET?.groups.find((g) => g.label === "Sunday")?.sampleSize).toBe(8);

    // A fourth group of posts at a fixed UTC instant: Monday 23:30 UTC is Monday evening in New
    // York but already Tuesday morning in Tokyo — the same rows re-bucket with the time zone.
    for (let i = 0; i < 4; i++) {
      const account = await env.account();
      await publish(env, account.id, {
        scheduleKind: "slot",
        slotOccurrenceAt: new Date("2026-03-23T23:30:00Z"),
        publishedAt: new Date("2026-03-23T23:35:00Z"),
      });
    }

    const tzRange = { from: new Date("2026-03-20T00:00:00Z"), to: new Date("2026-03-27T00:00:00Z") };
    const et = await buildComparisons({ projectId: env.project.id, timeZone: "America/New_York", range: tzRange });
    const tokyo = await buildComparisons({ projectId: env.project.id, timeZone: "Asia/Tokyo", range: tzRange });
    const etMonday = et.find((c) => c.dimension === "day_of_week" && c.metricKey === "likeCount")?.groups.find((g) => g.label === "Monday");
    const tokyoTuesday = tokyo
      .find((c) => c.dimension === "day_of_week" && c.metricKey === "likeCount")
      ?.groups.find((g) => g.label === "Tuesday");
    expect(etMonday?.sampleSize).toBe(4);
    expect(tokyoTuesday?.sampleSize).toBe(4);
  });
});
