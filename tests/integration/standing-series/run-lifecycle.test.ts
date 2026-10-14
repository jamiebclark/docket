import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { deriveRunOutcome, openOrResumeRun, shouldSelfPause } from "../../../src/server/services/standing-series/run";
import { createAccountsRepo } from "../../../src/server/dal/accounts";
import { createStandingSeriesRepo } from "../../../src/server/dal/standing-series";
import { createVoiceProfilesRepo } from "../../../src/server/dal/voice";
import { forJobRunner } from "../../../src/server/dal/scope";
import { getDb } from "../../../src/server/db/client";
import { closeDb } from "../../helpers/db";
import { createProject, createVoiceProfile } from "../../helpers/factories";

afterAll(async () => {
  await closeDb();
});

async function newAccount(projectId: string) {
  return createAccountsRepo(getDb(), projectId).upsertConnected({
    providerKey: "mock",
    displayName: "Acme",
    externalAccountId: randomUUID(),
    settings: {},
    credentialsEncrypted: null,
    credentialsExpiresAt: null,
    connectedByUserId: null,
  });
}

async function newSeries(opts: {
  projectId: string;
  voiceProfileId: string;
  targetAccountIds: string[];
  nextRunAt: Date;
  cadencePeriod?: "day" | "week" | "month";
}) {
  const repo = createStandingSeriesRepo(getDb(), opts.projectId);
  return repo.insert({
    name: `Series ${randomUUID().slice(0, 8)}`,
    brief: "Brief.",
    template: "Write about {{brief}}.",
    templateFields: [],
    voiceProfileId: opts.voiceProfileId,
    targetAccountIds: opts.targetAccountIds,
    cadenceCount: 1,
    cadencePeriod: opts.cadencePeriod ?? "day",
    mediaSource: "none",
    approvalPolicy: "review_required",
    schedulingPolicy: "leave_as_draft",
    nextRunAt: opts.nextRunAt,
  });
}

describe("deriveRunOutcome", () => {
  it("is incomplete whenever anything is still open, regardless of what was produced", () => {
    expect(deriveRunOutcome({ produced: 0, requested: 3, open: 1 })).toBe("incomplete");
    expect(deriveRunOutcome({ produced: 2, requested: 3, open: 1 })).toBe("incomplete");
  });
  it("is produced_none with nothing open and nothing produced", () => {
    expect(deriveRunOutcome({ produced: 0, requested: 3, open: 0 })).toBe("produced_none");
  });
  it("is produced_all when every requested post was produced", () => {
    expect(deriveRunOutcome({ produced: 3, requested: 3, open: 0 })).toBe("produced_all");
  });
  it("is produced_some otherwise", () => {
    expect(deriveRunOutcome({ produced: 1, requested: 3, open: 0 })).toBe("produced_some");
  });
});

describe("shouldSelfPause", () => {
  const r = (outcome: ReturnType<typeof deriveRunOutcome>, produced: number) => ({ outcome, produced });

  it("is false with fewer than three closed runs", () => {
    expect(shouldSelfPause([r("produced_none", 0), r("incomplete", 0)])).toBe(false);
  });
  it("is true when the three most recent each produced zero posts", () => {
    expect(shouldSelfPause([r("produced_none", 0), r("incomplete", 0), r("produced_none", 0)])).toBe(true);
    expect(shouldSelfPause([r("incomplete", 0), r("incomplete", 0), r("incomplete", 0), r("produced_all", 3)])).toBe(true);
  });
  it("is false once a run with any produced posts breaks the streak within the lookback", () => {
    expect(shouldSelfPause([r("produced_none", 0), r("produced_some", 1), r("produced_none", 0)])).toBe(false);
  });
  it("is false for an incomplete run that produced posts, even though it 'produced nothing' by outcome alone (review F7)", () => {
    expect(shouldSelfPause([r("incomplete", 2), r("incomplete", 0), r("incomplete", 0)])).toBe(false);
  });
});

describe("openOrResumeRun", () => {
  it("opens a run for the current period with no backfill, recording missed_periods but never iterating it", async () => {
    const project = await createProject();
    const voice = await createVoiceProfile(project.id);
    const scope = await forJobRunner(project.id, null);
    const account = await newAccount(project.id);
    const now = new Date("2026-01-10T00:00:00.000Z");
    const series = await newSeries({
      projectId: project.id,
      voiceProfileId: voice.id,
      targetAccountIds: [account.id],
      nextRunAt: new Date("2026-01-05T00:00:00.000Z"),
      cadencePeriod: "day",
    });

    const result = await openOrResumeRun(scope, series, now);
    expect(result).not.toBeNull();
    expect(result!.opened).toBe(true);
    expect(result!.run.periodStart).toBe("2026-01-10");
    // Five whole days (05 through 09) passed with no run; none were iterated into runs.
    expect(result!.run.missedPeriods).toBe(5);
    expect(result!.run.blockedReason).toBeNull();

    const positions = await scope.standingSeriesPositions.listForRun(result!.run.id);
    expect(positions).toHaveLength(1);
  });

  it("closes a still-open run as incomplete once the next boundary arrives, then opens the new one", async () => {
    const project = await createProject();
    const voice = await createVoiceProfile(project.id);
    const scope = await forJobRunner(project.id, null);
    const account = await newAccount(project.id);
    const first = new Date("2026-01-10T00:00:00.000Z");
    const series = await newSeries({
      projectId: project.id,
      voiceProfileId: voice.id,
      targetAccountIds: [account.id],
      nextRunAt: first,
      cadencePeriod: "day",
    });

    const opened = await openOrResumeRun(scope, series, first);
    expect(opened!.opened).toBe(true);

    const next = new Date("2026-01-11T00:00:00.000Z");
    const resumed = await openOrResumeRun(scope, series, next);
    expect(resumed!.opened).toBe(true);
    expect(resumed!.run.id).not.toBe(opened!.run.id);

    const stale = await scope.standingSeriesRuns.get(opened!.run.id);
    expect(stale!.closedAt).not.toBeNull();
    expect(stale!.outcome).toBe("incomplete");
  });

  it("immediately closes a run as blocked when the voice profile is missing", async () => {
    const project = await createProject();
    const voice = await createVoiceProfile(project.id);
    const scope = await forJobRunner(project.id, null);
    const account = await newAccount(project.id);
    const now = new Date("2026-01-10T00:00:00.000Z");
    const series = await newSeries({
      projectId: project.id,
      voiceProfileId: voice.id,
      targetAccountIds: [account.id],
      nextRunAt: now,
      cadencePeriod: "day",
    });
    await createVoiceProfilesRepo(getDb(), project.id).setArchived(voice.id, now);

    const result = await openOrResumeRun(scope, series, now);
    expect(result!.run.blockedReason).toBe("voice_profile_missing");
    expect(result!.run.closedAt).not.toBeNull();
    expect(result!.run.outcome).toBe("produced_none");
    const positions = await scope.standingSeriesPositions.listForRun(result!.run.id);
    expect(positions.every((p) => p.status === "skipped" && p.skipReason === "series_not_runnable")).toBe(true);
  });

  it("immediately closes a run as blocked when no target account is usable", async () => {
    const project = await createProject();
    const voice = await createVoiceProfile(project.id);
    const scope = await forJobRunner(project.id, null);
    const now = new Date("2026-01-10T00:00:00.000Z");
    const series = await newSeries({
      projectId: project.id,
      voiceProfileId: voice.id,
      targetAccountIds: [randomUUID()],
      nextRunAt: now,
      cadencePeriod: "day",
    });

    const result = await openOrResumeRun(scope, series, now);
    expect(result!.run.blockedReason).toBe("no_usable_target");
    expect(result!.run.droppedAccountIds).toEqual(series.targetAccountIds);
    expect(result!.run.closedAt).not.toBeNull();
  });
});
