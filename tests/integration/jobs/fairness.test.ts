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

describe("fairness between jobs (SC-006)", () => {
  it("lets a small job started behind a 20-item job finish within two ticks", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm(Array.from({ length: 30 }, () => modelOk("Post.", 1))));
    await e.assets(20);
    const big = await createJob(e.scope, e.input());
    await e.assets(2, { used: false, tags: ["small"] });
    const small = await createJob(
      e.scope,
      e.input({ source: { kind: "media", selection: { mode: "filter", filter: { tag: "small" } }, includeUsed: false } }),
    );
    expect(small.jobId).not.toBe(big.jobId);

    for (let i = 0; i < 2; i++) await runTick({ config: { jobMaxItems: 2 } });
    expect(await e.scope.jobItems.countByStatus(small.jobId)).toMatchObject({ done: 2, queued: 0 });
    expect((await e.scope.jobs.get(small.jobId))!.status).toBe("completed");
    const bigCounts = await e.scope.jobItems.countByStatus(big.jobId);
    expect(bigCounts.queued).toBeGreaterThan(0);
  }, 120_000);
});
