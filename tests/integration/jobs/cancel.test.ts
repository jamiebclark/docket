import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { generationJobItems } from "../../../src/server/db/schema";
import { setLlmForTests } from "../../../src/server/llm";
import type { LlmProvider } from "../../../src/server/llm/types";
import { runTick } from "../../../src/server/scheduler";
import { cancelJob, createJob } from "../../../src/server/services/jobs";
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

/** A model whose `generate` waits for `release()`, so a test can act while an item is mid-call. */
function gatedLlm() {
  const inner = createFakeLlm(Array.from({ length: 6 }, () => modelOk("Late.", 1)));
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const llm = {
    name: inner.name,
    model: inner.model,
    async generate(request: Parameters<LlmProvider["generate"]>[0]) {
      entered();
      await gate;
      return inner.generate(request);
    },
  } as unknown as LlmProvider;
  return { llm, started, release: open, inner };
}

describe("cancelling a job (SC-007)", () => {
  it("cancels mid-run: the running item saves no post, queued items are cancelled, done items stay", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([modelOk("First", 1)]));
    await e.assets(3);
    const { jobId } = await createJob(e.scope, e.input());
    await runTick({ config: { jobMaxItems: 1 } });
    expect((await e.scope.jobItems.countByStatus(jobId)).done).toBe(1);

    const gated = gatedLlm();
    setLlmForTests(gated.llm);
    const tick = runTick({ config: { jobMaxItems: 1 } });
    await gated.started;
    const result = await cancelJob(e.scope, jobId);
    expect(result.changed).toBe(true);
    gated.release();
    const ticked = await tick;
    expect(ticked.generation.counts.cancelled).toBe(1);

    const counts = await e.scope.jobItems.countByStatus(jobId);
    expect(counts).toMatchObject({ done: 1, cancelled: 2, queued: 0, running: 0 });
    const items = await e.scope.jobItems.listForJob(jobId);
    const withPosts = [];
    for (const item of items) if (await e.scope.posts.findByJobItemId(item.id)) withPosts.push(item.status);
    expect(withPosts).toEqual(["done"]);
    expect((await e.scope.jobs.get(jobId))!).toMatchObject({ status: "cancelled" });

    const later = await runTick({ config: { jobMaxItems: 5 } });
    expect(later.generation.counts.claimed).toBe(0);
    expect((await e.scope.jobItems.countByStatus(jobId)).done).toBe(1);
  }, 60_000);

  it("cancels failed items too", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([]));
    await e.assets(2);
    const { jobId } = await createJob(e.scope, e.input());
    const [first] = await e.scope.jobItems.listForJob(jobId);
    await e.scope.media.softDelete(first!.mediaAssetId!, new Date());
    await runTick({ config: { jobMaxItems: 1 } });
    expect((await e.scope.jobItems.countByStatus(jobId))).toMatchObject({ failed: 1, queued: 1 });
    await cancelJob(e.scope, jobId);
    expect((await e.scope.jobItems.countByStatus(jobId))).toMatchObject({ failed: 0, queued: 0, cancelled: 2 });
  }, 60_000);

  it("leaves a saved post in review when the job is cancelled between save and policy", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([modelOk("Saved", 1)]));
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input({ approval: "auto_approve", scheduling: "leave_as_draft" }));
    await runTick({ config: { jobMaxItems: 1 } });
    const [item] = await e.scope.jobItems.listForJob(jobId);
    const post = (await e.scope.posts.findByJobItemId(item!.id))!;

    // Rewind to the instant after the save: policy not applied, item running on an expired lease.
    const record = (post.generationMetadata as { records: { policies: Record<string, unknown> }[] }).records[0]!;
    const { decision: _decision, ...policies } = record.policies;
    void _decision;
    await e.scope.posts.update(post.id, {
      reviewState: "needs_review",
      reviewedAt: null,
      generationMetadata: { v: 1, records: [{ ...record, policies }] } as never,
    });
    await e.scope.jobs.update(jobId, { status: "running", finishedAt: null });
    await runCrossProject("test: rewind item", () =>
      getDb()
        .update(generationJobItems)
        .set({ status: "running", leaseOwner: randomUUID(), leaseUntil: new Date(Date.now() - 1_000), finishedAt: null })
        .where(and(eq(generationJobItems.projectId, e.project.id), eq(generationJobItems.id, item!.id))),
    );

    await cancelJob(e.scope, jobId);
    await runTick({ config: { jobMaxItems: 5 } });
    expect((await e.scope.posts.get(post.id))!.reviewState).toBe("needs_review");
    // The item is finished, not left running on a cancelled job (F3).
    expect((await e.scope.jobItems.get(item!.id))!.status).toBe("done");
    expect(await e.scope.jobItems.countByStatus(jobId)).toMatchObject({ running: 0, done: 1 });
    expect((await e.scope.jobs.get(jobId))!.status).toBe("cancelled");
  }, 60_000);

  it("changes nothing on a second cancel or a cancel after completion", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([modelOk("Only", 1)]));
    await e.assets(1);
    const done = await createJob(e.scope, e.input());
    await runTick({ config: { jobMaxItems: 5 } });
    expect((await e.scope.jobs.get(done.jobId))!.status).toBe("completed");
    expect(await cancelJob(e.scope, done.jobId)).toMatchObject({ changed: false });
    expect((await e.scope.jobs.get(done.jobId))!.status).toBe("completed");

    await e.assets(2);
    const other = await createJob(e.scope, e.input());
    expect(await cancelJob(e.scope, other.jobId)).toMatchObject({ changed: true });
    const again = await cancelJob(e.scope, other.jobId);
    expect(again).toMatchObject({ changed: false, message: "This job is already cancelled." });
    expect((await e.scope.jobItems.countByStatus(other.jobId)).cancelled).toBe(2);
  }, 60_000);
});
