import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setLlmForTests } from "../../../src/server/llm";
import { runTick } from "../../../src/server/scheduler";
import { runGenerationJobs } from "../../../src/server/scheduler/generation";
import { schedulerConfig } from "../../../src/server/scheduler/config";
import { getEnv } from "../../../src/server/env";
import { createJob } from "../../../src/server/services/jobs";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { jobsEnv, modelOk } from "../../helpers/jobs-env";

afterAll(async () => {
  setLlmForTests(null);
  setStorageForTests(undefined);
  await closeDb();
});

const CONFIG = { timeBudgetMs: 4000, jobMinCallMs: 1000, jobPersistReserveMs: 500, jobMaxItems: 1 };

/** A complete config, for the tests below that call a section directly rather than through `runTick`. */
const SCHED_CONFIG = schedulerConfig(getEnv(), CONFIG);

describe("the tick time budget (SC-008)", () => {
  it("cuts a 6 s call off, ends the tick within the budget, and defers the retry without counting an attempt", async () => {
    const e = await jobsEnv();
    const fake = createFakeLlm([{ ...modelOk("Slow", 1), delayMs: 6000 }, modelOk("Next", 1)]);
    setLlmForTests(fake);
    await e.assets(1);
    const { jobId } = await createJob(e.scope, e.input());
    const t0 = Date.now();
    const tick = await runTick({ config: CONFIG });
    expect(Date.now() - t0).toBeLessThan(4500);
    expect(tick.generation.counts).toMatchObject({ claimed: 1, done: 0, deferred: 1 });
    const [item] = await e.scope.jobItems.listForJob(jobId);
    expect(item).toMatchObject({ status: "queued", attemptCount: 0 });
    expect(fake.requests).toHaveLength(1);

    const next = await runTick({ config: CONFIG });
    expect(next.generation.counts).toMatchObject({ claimed: 1, done: 1 });
    expect(fake.requests).toHaveLength(2);
  }, 60_000);

  it("defers the correction retry when too little time is left, without counting an attempt, then makes exactly one more call", async () => {
    const e = await jobsEnv();
    const fake = createFakeLlm([{ raw: "not json", delayMs: 3000 }, modelOk("Corrected", 1)]);
    setLlmForTests(fake);
    await e.assets(1);
    const { jobId } = await createJob(e.scope, e.input());

    const t0 = Date.now();
    const first = await runTick({ config: CONFIG });
    expect(Date.now() - t0).toBeLessThan(4500);
    expect(first.generation.counts).toMatchObject({ claimed: 1, deferred: 1, done: 0 });
    expect(fake.requests).toHaveLength(1);
    const [deferred] = await e.scope.jobItems.listForJob(jobId);
    expect(deferred).toMatchObject({ status: "queued", attemptCount: 0 });
    expect(deferred!.pendingRetry).not.toBeNull();

    const second = await runTick({ config: CONFIG });
    expect(second.generation.counts).toMatchObject({ claimed: 1, done: 1 });
    expect(fake.requests).toHaveLength(2);
    const [done] = await e.scope.jobItems.listForJob(jobId);
    expect(done).toMatchObject({ status: "done", attemptCount: 0 });
    expect(done!.pendingRetry).toBeNull();
  }, 60_000);

  it("leaves items queued when generation is not configured", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([]));
    await e.assets(2);
    const { jobId } = await createJob(e.scope, e.input());
    setLlmForTests(null);
    const tick = await runTick({ config: CONFIG });
    expect(tick.generation.counts).toMatchObject({ notConfigured: 1, claimed: 0 });
    expect(await e.scope.jobItems.countByStatus(jobId)).toMatchObject({ queued: 2, running: 0, done: 0 });
  }, 60_000);
});

describe("a section that skips says so (SC-008)", () => {
  // The whole point of `outOfBudget`: before it existed, this tick reported `claimed: 0` and `ok: true`,
  // which is byte-identical to "there was nothing due". A test waiting on a model call then hung until
  // its own timeout with nothing in the result or the log explaining why the call never came, and the
  // same silence on a loaded CI runner cost a day of flake-hunting (PR #129).
  it("reports outOfBudget rather than an empty success when no budget is left to start an item", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([modelOk("Never called", 1)]));
    await e.assets(1);
    const { jobId } = await createJob(e.scope, e.input());

    // The section is called directly with a `startedAt` already in the past, so its deadline is
    // definitively behind us. Going through `runTick` with `timeBudgetMs` merely EQUAL to
    // `minCallMs + persistReserveMs` does not work: the gate is `now + needed > deadline`, which with
    // those two equal reduces to `now > startedAt` — true on a machine where `clock.now()` costs a
    // database round trip, false on CI when both land on the same timestamp. That version of this test
    // failed on CI run 39015 shard 3 with `claimed: 1, outOfBudget: 0`, which is the very class of
    // wall-clock dependence this file's own fix is about.
    const config = { ...SCHED_CONFIG, jobMinCallMs: 1000, jobPersistReserveMs: 500, jobMaxItems: 1 };
    const counts = await runGenerationJobs({
      config,
      tickId: "test-out-of-budget",
      startedAt: new Date(Date.now() - 10 * SCHED_CONFIG.timeBudgetMs),
    });

    expect(counts).toMatchObject({ claimed: 0, outOfBudget: 1, notRunnable: 0 });
    // Nothing was touched: the item is still queued with no attempt against it.
    expect((await e.scope.jobItems.listForJob(jobId))[0]).toMatchObject({ status: "queued", attemptCount: 0 });
  }, 60_000);

  it("does not report outOfBudget when there was simply nothing due", async () => {
    await jobsEnv();
    setLlmForTests(createFakeLlm([]));
    const tick = await runTick({ config: CONFIG });
    expect(tick.generation.counts).toMatchObject({ claimed: 0, outOfBudget: 0 });
  }, 60_000);
});
