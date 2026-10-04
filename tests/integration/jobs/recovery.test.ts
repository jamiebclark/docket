import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { posts } from "../../../src/server/db/schema";
import { claimDueJobItems } from "../../../src/server/dal/job-claims";
import { setLlmForTests } from "../../../src/server/llm";
import { JOB_PERSIST_RESERVE_MS } from "../../../src/server/scheduler/config";
import { runTick } from "../../../src/server/scheduler";
import { createJob } from "../../../src/server/services/jobs";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { jobsEnv, modelOk, parkAllJobs } from "../../helpers/jobs-env";

beforeEach(parkAllJobs);
afterAll(async () => {
  setLlmForTests(null);
  setStorageForTests(undefined);
  await closeDb();
});

const LEASE_MS = 300_000;
const claim = (now: Date) => claimDueJobItems({ now, limit: 5, leaseMs: LEASE_MS, maxAttempts: 3 });
const later = (ms: number) => new Date(Date.now() + ms);
const tickAt = (at: Date) => atTime(at, () => runTick({ config: { jobMaxItems: 5 } }));

describe("recovering an interrupted tick (US2 scenarios 6–7)", () => {
  it("runs an item killed before save once its lease expires, with exactly one post", async () => {
    const e = await jobsEnv();
    const fake = createFakeLlm([modelOk("Recovered", 1)]);
    setLlmForTests(fake);
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input());
    const [first] = await claim(new Date());
    expect(first).toMatchObject({ kind: "run", recovered: false });

    const t = later(LEASE_MS + 1_000);
    const tick = await tickAt(t);
    expect(tick.generation.counts).toMatchObject({ claimed: 1, recovered: 1, done: 1 });
    const [item] = await e.scope.jobItems.listForJob(jobId);
    expect(item).toMatchObject({ status: "done", attemptCount: 1 });
    expect(fake.requests).toHaveLength(1);
    const rows = await runCrossProject("test: posts", () =>
      getDb().select().from(posts).where(and(eq(posts.projectId, e.project.id), eq(posts.generationJobItemId, item!.id))),
    );
    expect(rows).toHaveLength(1);
  }, 60_000);

  it("finishes an item killed after save before policy without a model call", async () => {
    const e = await jobsEnv();
    const fake = createFakeLlm([modelOk("Saved", 1)]);
    setLlmForTests(fake);
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input({ approval: "auto_approve", scheduling: "leave_as_draft" }));
    await runTick({ config: { jobMaxItems: 5 } });
    const [item] = await e.scope.jobItems.listForJob(jobId);
    const post = (await e.scope.posts.findByJobItemId(item!.id))!;
    expect(post.reviewState).toBe("approved");
    expect(fake.requests).toHaveLength(1);

    // Rewind to the instant after the save: policy not applied, item still running on a lease that has expired.
    const meta = post.generationMetadata as { v: 1; records: { policies: Record<string, unknown> }[] };
    const record = meta.records[0]!;
    const { decision: _decision, ...policies } = record.policies;
    void _decision;
    await e.scope.posts.update(post.id, {
      reviewState: "needs_review",
      reviewedAt: null,
      generationMetadata: { v: 1, records: [{ ...record, policies }] } as never,
    });
    await e.scope.jobs.update(jobId, { status: "running", finishedAt: null });
    await runCrossProject("test: rewind item", async () => {
      const { generationJobItems } = await import("../../../src/server/db/schema");
      await getDb()
        .update(generationJobItems)
        .set({ status: "running", leaseOwner: randomUUID(), leaseUntil: new Date(Date.now() - 1_000), finishedAt: null })
        .where(eq(generationJobItems.id, item!.id));
    });

    const tick = await runTick({ config: { jobMaxItems: 5 } });
    expect(tick.generation.counts).toMatchObject({ claimed: 1, finishing: 1, done: 1 });
    expect(fake.requests).toHaveLength(1);
    expect((await e.scope.jobItems.get(item!.id))!.status).toBe("done");
    expect((await e.scope.posts.get(post.id))!.reviewState).toBe("approved");
  }, 60_000);

  it("fails an item interrupted three times", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([]));
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input());
    let t = Date.now();
    expect(await claim(new Date(t))).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      t += LEASE_MS + 1_000;
      const [again] = await claim(new Date(t));
      expect(again).toMatchObject({ recovered: true, kind: "run" });
    }
    t += LEASE_MS + 1_000;
    expect(await claim(new Date(t))).toHaveLength(0);
    const [item] = await e.scope.jobItems.listForJob(jobId);
    expect(item).toMatchObject({
      status: "failed",
      lastErrorKind: "interrupted",
      lastError: "Generation was interrupted too many times.",
    });
    expect((await e.scope.jobs.get(jobId))!.status).toBe("completed_with_failures");
  }, 60_000);

  it("never recovers a live lease", async () => {
    const e = await jobsEnv();
    const fake = createFakeLlm([]);
    setLlmForTests(fake);
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input());
    expect(await claim(new Date())).toHaveLength(1);
    const tick = await tickAt(later(60_000));
    expect(tick.generation.counts.claimed).toBe(0);
    expect((await e.scope.jobItems.listForJob(jobId))[0]!.status).toBe("running");
    expect(fake.requests).toHaveLength(0);
  }, 60_000);

  it("keeps the smallest lease longer than the largest tick budget plus the persist reserve", () => {
    const MIN_LEASE_S = 60;
    const MAX_BUDGET_S = 25;
    expect(MIN_LEASE_S * 1000).toBeGreaterThan(MAX_BUDGET_S * 1000 + JOB_PERSIST_RESERVE_MS);
  });
});
