import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setLlmForTests } from "../../../src/server/llm";
import { runTick } from "../../../src/server/scheduler";
import { createJob } from "../../../src/server/services/jobs";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { jobsEnv, modelOk, parkAllJobs } from "../../helpers/jobs-env";

beforeEach(parkAllJobs);
afterAll(async () => {
  setLlmForTests(null);
  setStorageForTests(undefined);
  await closeDb();
});

const CONFIG = { timeBudgetMs: 4000, jobMinCallMs: 1000, jobPersistReserveMs: 500, jobMaxItems: 1 };

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
