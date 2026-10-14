import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createStandingSeriesPositionsRepo,
  createStandingSeriesRepo,
  createStandingSeriesRunsRepo,
  type NewStandingSeries,
  type NewStandingSeriesRun,
} from "../../../src/server/dal/standing-series";
import { getDb } from "../../../src/server/db/client";
import { closeDb } from "../../helpers/db";
import { createMediaAsset } from "../../helpers/scheduling";
import { createProject, createVoiceProfile } from "../../helpers/factories";

afterAll(async () => {
  await closeDb();
});

async function seriesInput(voiceProfileId: string, overrides: Partial<NewStandingSeries> = {}): Promise<NewStandingSeries> {
  return {
    name: `Series ${randomUUID().slice(0, 8)}`,
    brief: "What this series is about.",
    template: "Write one post about {{brief}}.",
    templateFields: [],
    voiceProfileId,
    targetAccountIds: [randomUUID()],
    cadenceCount: 1,
    cadencePeriod: "week",
    mediaSource: "none",
    approvalPolicy: "review_required",
    schedulingPolicy: "leave_as_draft",
    nextRunAt: new Date(),
    ...overrides,
  };
}

function runInput(seriesId: string, overrides: Partial<NewStandingSeriesRun> = {}): NewStandingSeriesRun {
  return {
    seriesId,
    period: "day",
    periodStart: "2026-01-01",
    periodStartAt: new Date("2026-01-01T00:00:00.000Z"),
    requestedCount: 2,
    config: { v: 1 },
    ...overrides,
  };
}

describe("standing-series DAL", () => {
  it("throws on the name unique index, case-insensitively", async () => {
    const project = await createProject();
    const voice = await createVoiceProfile(project.id);
    const repo = createStandingSeriesRepo(getDb(), project.id);
    const input = await seriesInput(voice.id, { name: "Weekly Tips" });
    await repo.insert(input);
    expect(await repo.nameTaken("weekly tips")).toBe(true);
    expect(await repo.nameTaken("Something Else")).toBe(false);
    await expect(repo.insert({ ...input, name: "weekly tips" })).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("nameTaken excludes the given id", async () => {
    const project = await createProject();
    const voice = await createVoiceProfile(project.id);
    const repo = createStandingSeriesRepo(getDb(), project.id);
    const series = await repo.insert(await seriesInput(voice.id, { name: "Daily Roundup" }));
    expect(await repo.nameTaken("Daily Roundup", series.id)).toBe(false);
    expect(await repo.nameTaken("Daily Roundup")).toBe(true);
  });

  it("throws on the period unique index: at most one run per series per period", async () => {
    const project = await createProject();
    const voice = await createVoiceProfile(project.id);
    const series = await createStandingSeriesRepo(getDb(), project.id).insert(await seriesInput(voice.id));
    const runs = createStandingSeriesRunsRepo(getDb(), project.id);
    const first = await runs.openRun(runInput(series.id));
    await runs.close(first.id, "produced_all", new Date());
    await expect(runs.openRun(runInput(series.id))).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("throws on the open-run unique index: at most one open run per series", async () => {
    const project = await createProject();
    const voice = await createVoiceProfile(project.id);
    const series = await createStandingSeriesRepo(getDb(), project.id).insert(await seriesInput(voice.id));
    const runs = createStandingSeriesRunsRepo(getDb(), project.id);
    await runs.openRun(runInput(series.id, { periodStart: "2026-01-01" }));
    await expect(runs.openRun(runInput(series.id, { periodStart: "2026-01-08" }))).rejects.toMatchObject({
      cause: { code: "23505" },
    });
  });

  it("setPlan writes only while plan is null", async () => {
    const project = await createProject();
    const voice = await createVoiceProfile(project.id);
    const series = await createStandingSeriesRepo(getDb(), project.id).insert(await seriesInput(voice.id));
    const runs = createStandingSeriesRunsRepo(getDb(), project.id);
    const run = await runs.openRun(runInput(series.id));
    expect(await runs.setPlan(run.id, { angles: [{ title: "First", description: "d" }] })).toBe(true);
    expect(await runs.setPlan(run.id, { angles: [{ title: "Second", description: "d" }] })).toBe(false);
    const reread = await runs.get(run.id);
    expect((reread!.plan as { angles: { title: string }[] }).angles[0]!.title).toBe("First");
  });

  it("recentClosedPlans and recentClosedOutcomes read only closed runs, newest first", async () => {
    const project = await createProject();
    const voice = await createVoiceProfile(project.id);
    const series = await createStandingSeriesRepo(getDb(), project.id).insert(await seriesInput(voice.id));
    const runs = createStandingSeriesRunsRepo(getDb(), project.id);
    const open = await runs.openRun(runInput(series.id, { periodStart: "2026-01-01" }));
    await runs.setPlan(open.id, { angles: [{ title: "Older", description: "d" }] });
    await runs.close(open.id, "produced_all", new Date("2026-01-02T00:00:00.000Z"));
    const second = await runs.openRun(runInput(series.id, { periodStart: "2026-01-08" }));
    await runs.setPlan(second.id, { angles: [{ title: "Newer", description: "d" }] });
    await runs.close(second.id, "produced_none", new Date("2026-01-09T00:00:00.000Z"));
    // A still-open run contributes nothing to either list.
    await runs.openRun(runInput(series.id, { periodStart: "2026-01-15" }));

    const plans = await runs.recentClosedPlans(series.id, 3);
    expect(plans.map((p) => p.angles[0]!.title)).toEqual(["Newer", "Older"]);
    const outcomes = await runs.recentClosedOutcomes(series.id, 3);
    expect(outcomes).toEqual(["produced_none", "produced_all"]);
  });

  it("claimMedia writes only while media_asset_id is null", async () => {
    const project = await createProject();
    const voice = await createVoiceProfile(project.id);
    const series = await createStandingSeriesRepo(getDb(), project.id).insert(await seriesInput(voice.id));
    const runs = createStandingSeriesRunsRepo(getDb(), project.id);
    const run = await runs.openRun(runInput(series.id, { requestedCount: 1, config: { v: 1 } }));
    const positions = createStandingSeriesPositionsRepo(getDb(), project.id);
    const [position] = await positions.insertMany(run.id, 1, new Date());
    const assetA = await createMediaAsset(project.id);
    const assetB = await createMediaAsset(project.id);
    expect(await positions.claimMedia(position!.id, assetA.id)).toBe(true);
    expect(await positions.claimMedia(position!.id, assetB.id)).toBe(false);
    const reread = await positions.update(position!.id, {});
    expect(reread!.mediaAssetId).toBe(assetA.id);
  });

  it("countByStatus tallies positions by status", async () => {
    const project = await createProject();
    const voice = await createVoiceProfile(project.id);
    const series = await createStandingSeriesRepo(getDb(), project.id).insert(await seriesInput(voice.id, { cadenceCount: 3 }));
    const runs = createStandingSeriesRunsRepo(getDb(), project.id);
    const run = await runs.openRun(runInput(series.id, { requestedCount: 3 }));
    const positions = createStandingSeriesPositionsRepo(getDb(), project.id);
    const made = await positions.insertMany(run.id, 3, new Date());
    expect(made).toHaveLength(3);
    await positions.update(made[0]!.id, { status: "produced", finishedAt: new Date() });
    await positions.update(made[1]!.id, { status: "failed", lastErrorKind: "interrupted", lastError: "oops" });
    const counts = await positions.countByStatus(run.id);
    expect(counts).toEqual({ queued: 1, running: 0, produced: 1, failed: 1, skipped: 0, missed: 0 });
  });

  it("nextDue finds the earliest queued-and-due or running position", async () => {
    const project = await createProject();
    const voice = await createVoiceProfile(project.id);
    const series = await createStandingSeriesRepo(getDb(), project.id).insert(await seriesInput(voice.id, { cadenceCount: 2 }));
    const runs = createStandingSeriesRunsRepo(getDb(), project.id);
    const run = await runs.openRun(runInput(series.id, { requestedCount: 2 }));
    const positions = createStandingSeriesPositionsRepo(getDb(), project.id);
    const [first, second] = await positions.insertMany(run.id, 2, new Date());
    const future = new Date(Date.now() + 3600_000);
    await positions.update(first!.id, { nextAttemptAt: future });
    expect((await positions.nextDue(run.id, new Date()))!.id).toBe(second!.id);
    await positions.update(second!.id, { status: "produced", finishedAt: new Date() });
    expect(await positions.nextDue(run.id, new Date())).toBeNull();
  });
});
