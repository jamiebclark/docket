import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptSecret } from "../../../src/server/crypto/secrets";
import { INSTALL_CREDENTIAL_OWNER, projectCredentialOwner } from "../../../src/server/dal/credential-owners";
import { CREDIT_PROBE_INTERVAL_MS } from "../../../src/server/dal/credit-holds";
import { createProjectLlmRepo } from "../../../src/server/dal/project-llm";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { standingSeries } from "../../../src/server/db/schema";
import { setLlmFactoryForTests, setLlmForTests } from "../../../src/server/llm";
import type { LlmConfig } from "../../../src/server/llm/config";
import type { LlmProvider } from "../../../src/server/llm/types";
import { runStandingSeries, type StandingSeriesCounts } from "../../../src/server/scheduler/standing-series";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { clearHolds, readHold } from "../../helpers/jobs-env";
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

/** Parks every series left enabled by another test file, so this file's ticks claim only its own. */
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
  setLlmFactoryForTests(null);
  await clearHolds();
});
afterAll(async () => {
  await closeDb();
});

const post = (text: string): FakeStep => ({ ok: { variants: { mock: { text } } } });

async function tick(at: Date, over: Partial<SchedulerConfig> = {}): Promise<StandingSeriesCounts> {
  return atTime(at, () => runStandingSeries({ config: { ...CONFIG, ...over }, tickId: "test", startedAt: at }));
}

const aadFor = (projectId: string) => `project_llm_credential:${projectId}`;

async function saveCredential(projectId: string, apiKey: string) {
  await createProjectLlmRepo(getDb(), projectId).save({
    provider: "openai",
    model: "fake-model",
    keyCiphertext: encryptSecret(apiKey, { aad: aadFor(projectId) }),
    updatedByUserId: null,
  });
}

/** A provider rebuilt per call for a project credential: the fake must stay queued, not be consumed once. */
function keyedFactory() {
  const llms = new Map<string, LlmProvider>();
  const queue = (apiKey: string, ...steps: FakeStep[]) => llms.set(apiKey, createFakeLlm(steps));
  setLlmFactoryForTests((config: LlmConfig): LlmProvider => llms.get(config.apiKey) ?? createFakeLlm([{ fail: "unavailable" }]));
  return { queue };
}

describe("standing-series credit hold (US6 AS1-AS3, FR-050-FR-052)", () => {
  it("AS1 (install-owned): a held owner's series is not claimed at all — nothing generated, no attempt, no failure, next_run_at unchanged, the open run left open, counts.held=1", async () => {
    const e = await standingSeriesEnv();
    setLlmForTests(createFakeLlm([{ fail: "credit_exhausted" }]));
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } })),
    );

    const t0 = new Date("2026-01-11T00:00:01.000Z");
    const first = await tick(t0);
    expect(first).toMatchObject({ requeued: 1, produced: 0, failed: 0 });
    expect(await readHold(INSTALL_CREDENTIAL_OWNER)).not.toBeNull();

    const runsAfterFirst = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runsAfterFirst).toHaveLength(1);
    expect(runsAfterFirst[0]!.closedAt).toBeNull();
    const positionsAfterFirst = await e.scope.standingSeriesPositions.listForRun(runsAfterFirst[0]!.id);
    expect(positionsAfterFirst[0]).toMatchObject({ status: "queued", attemptCount: 0, lastErrorKind: null, lastError: null });

    const seriesBefore = await e.scope.standingSeries.get(seriesId);
    const nextRunAtBefore = seriesBefore!.nextRunAt!.getTime();

    const t1 = new Date(t0.getTime() + 60_000); // well inside the hold interval, not the probe boundary
    const second = await tick(t1);
    expect(second).toMatchObject({ claimed: 0, held: 1 });

    const seriesAfter = await e.scope.standingSeries.get(seriesId);
    expect(seriesAfter!.nextRunAt!.getTime()).toBe(nextRunAtBefore);
    const runsAfterSecond = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runsAfterSecond[0]!.closedAt).toBeNull();
    const positionsAfterSecond = await e.scope.standingSeriesPositions.listForRun(runsAfterSecond[0]!.id);
    expect(positionsAfterSecond[0]).toMatchObject({ status: "queued", attemptCount: 0 });
  }, 60_000);

  it("AS1 (project-owned): the same hold suite, widened to a project's own credential", async () => {
    const e = await standingSeriesEnv();
    const KEY = "sk-standing-series-held";
    await saveCredential(e.project.id, KEY);
    const { queue } = keyedFactory();
    queue(KEY, { fail: "credit_exhausted" });
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } })),
    );

    const owner = projectCredentialOwner(e.project.id);
    const t0 = new Date("2026-01-11T00:00:01.000Z");
    const first = await tick(t0);
    expect(first).toMatchObject({ requeued: 1, produced: 0, failed: 0 });
    expect(await readHold(owner)).not.toBeNull();

    const t1 = new Date(t0.getTime() + 60_000);
    const second = await tick(t1);
    expect(second).toMatchObject({ claimed: 0, held: 1 });

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs[0]!.closedAt).toBeNull();
  }, 60_000);

  it("the hold clearing lets the next tick continue the same open run, with no retry, reset or manual step", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } })),
    );

    setLlmForTests(createFakeLlm([{ fail: "credit_exhausted" }]));
    const t0 = new Date("2026-01-11T00:00:01.000Z");
    await tick(t0);
    const runsAfterRefusal = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const runId = runsAfterRefusal[0]!.id;

    setLlmForTests(createFakeLlm([post("Posted once the hold cleared.")]));
    const t1 = new Date(t0.getTime() + CREDIT_PROBE_INTERVAL_MS);
    const third = await tick(t1);
    expect(third.produced).toBe(1);
    expect(await readHold(INSTALL_CREDENTIAL_OWNER)).toBeNull();

    const runsAfter = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runsAfter[0]!.id).toBe(runId); // the same run, resumed — not reset
    const positions = await e.scope.standingSeriesPositions.listForRun(runId);
    expect(positions[0]).toMatchObject({ status: "produced", attemptCount: 0 });
  }, 60_000);

  it("a mid-run billing refusal requeues the position with no attempt counted, refreshing the hold on the owner actually used", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 2, period: "day" } })),
    );
    const plan: FakeStep = { ok: { angles: [{ title: "Angle 1", description: "About thing 1" }, { title: "Angle 2", description: "About thing 2" }] } };
    setLlmForTests(createFakeLlm([plan, post("First post."), { fail: "credit_exhausted" }]));

    const t0 = new Date("2026-01-11T00:00:01.000Z");
    const counts = await tick(t0);
    expect(counts.produced).toBe(1);
    expect(counts.requeued).toBe(1);
    expect(await readHold(INSTALL_CREDENTIAL_OWNER)).not.toBeNull();

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs[0]!.closedAt).toBeNull();
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    const byStatus = positions.map((p) => p.status).sort();
    expect(byStatus).toEqual(["produced", "queued"]);
    const stillQueued = positions.find((p) => p.status === "queued")!;
    expect(stillQueued.attemptCount).toBe(0);
  }, 60_000);

  it("an unreadable stored key requeues the position with no attempt, producing no credential text anywhere", async () => {
    const e = await standingSeriesEnv();
    await createProjectLlmRepo(getDb(), e.project.id).save({
      provider: "openai",
      model: "fake-model",
      // Encrypted under a different project's AAD, so this project can never decrypt it.
      keyCiphertext: encryptSecret("sk-standing-series-unreadable", { aad: aadFor("00000000-0000-0000-0000-000000000000") }),
      updatedByUserId: null,
    });
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } })),
    );

    const t0 = new Date("2026-01-11T00:00:01.000Z");
    const counts = await tick(t0);
    expect(counts.notConfigured).toBe(1);
    expect(counts.produced).toBe(0);
    expect(counts.failed).toBe(0);
    expect(await readHold(projectCredentialOwner(e.project.id))).toBeNull();

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs[0]!.closedAt).toBeNull();
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    expect(positions[0]).toMatchObject({ status: "queued", attemptCount: 0, lastErrorKind: null, lastError: null });
    expect(JSON.stringify(positions[0])).not.toContain("sk-standing-series-unreadable");
  }, 60_000);
});
