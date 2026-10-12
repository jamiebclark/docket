import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { generationJobItems } from "../../../src/server/db/schema";
import { setLlmForTests } from "../../../src/server/llm";
import type { LlmProvider } from "../../../src/server/llm/types";
import { runTick } from "../../../src/server/scheduler";
import { appendItems, cancelJob, createJob, retryFailedItems } from "../../../src/server/services/jobs";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { INSTALL_CREDENTIAL_OWNER } from "../../../src/server/dal/credential-owners";
import { clearHolds, jobsEnv, modelOk, parkAllJobs, readHold, seedCreditHold } from "../../helpers/jobs-env";

beforeEach(parkAllJobs);
afterAll(async () => {
  setLlmForTests(null);
  setStorageForTests(undefined);
  // Worker databases are shared across the files a worker runs, and `parkAllJobs` only clears holds in
  // `beforeEach` — which protects the next test in this file, never the next file (review F6).
  await clearHolds();
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

  it("leaves a skipped item alone, not reverted to cancelled (F6)", async () => {
    const e = await jobsEnv();
    const apiInput = (items: { fields: Record<string, string>; externalId?: string }[]) =>
      e.input({ source: { kind: "api", fields: ["product"], items }, template: "Announce {{product}}." });
    setLlmForTests(createFakeLlm([modelOk("Only", 1)]));
    const { jobId } = await createJob(e.scope, apiInput([{ fields: { product: "A" }, externalId: "ext-skip" }]));
    const other = await e.scope.posts.insert({ baseText: "Already posted" });
    await e.scope.externalClaims.insert({ sourceKey: "default", externalId: "ext-skip", postId: other.id, claimedAt: new Date() });
    await runTick({ config: { jobMaxItems: 5 } });
    expect((await e.scope.jobItems.countByStatus(jobId)).skipped).toBe(1);

    await cancelJob(e.scope, jobId);
    const [item] = await e.scope.jobItems.listForJob(jobId);
    expect(item).toMatchObject({ status: "skipped" });
  }, 30_000);

  it("a cancelled or permanently failed item's external id is re-submittable (AS2.8)", async () => {
    const e = await jobsEnv();
    const apiInput = (items: { fields: Record<string, string>; externalId?: string; mediaId?: string }[], open = true) =>
      e.input({ source: { kind: "api", fields: ["product"], items, open }, template: "Announce {{product}}." });
    setLlmForTests(createFakeLlm([]));

    const cancelled = await createJob(e.scope, apiInput([{ fields: { product: "A" }, externalId: "ext-cancel" }]));
    await cancelJob(e.scope, cancelled.jobId);
    const resubmitted = await createJob(e.scope, apiInput([{ fields: { product: "A" }, externalId: "ext-cancel" }], false));
    expect(resubmitted).toMatchObject({ itemCount: 1, skippedAlreadyPosted: 0 });

    const img = await e.asset();
    const failJob = await createJob(e.scope, apiInput([{ fields: { product: "A" }, externalId: "ext-fail", mediaId: img.id }], false));
    await e.scope.media.softDelete(img.id, new Date());
    await runTick({ config: { jobMaxItems: 5 } });
    expect((await e.scope.jobItems.countByStatus(failJob.jobId)).failed).toBe(1);
    const afterFail = await createJob(e.scope, apiInput([{ fields: { product: "A" }, externalId: "ext-fail" }], false));
    expect(afterFail).toMatchObject({ itemCount: 1, skippedAlreadyPosted: 0 });
  }, 30_000);

  it("FR-038: cancelling a held job leaves the hold untouched and releases reserved images", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([]));
    const [asset] = await e.assets(1);
    const { jobId } = await createJob(e.scope, e.input());
    expect(await e.scope.media.reservedAmong([asset!.id])).toEqual([asset!.id]);

    await seedCreditHold(INSTALL_CREDENTIAL_OWNER, { heldSince: new Date(), nextProbeAt: new Date(Date.now() + 60_000) });

    const result = await cancelJob(e.scope, jobId);
    expect(result.changed).toBe(true);
    expect(await e.scope.media.reservedAmong([asset!.id])).toEqual([]);
    expect(await readHold(INSTALL_CREDENTIAL_OWNER)).not.toBeNull();
  }, 30_000);

  it("FR-038: retryFailedItems resets failed items to queued, and the next tick fails none of them while held", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([]));
    await e.assets(2);
    const { jobId } = await createJob(e.scope, e.input());
    const [first] = await e.scope.jobItems.listForJob(jobId);
    await e.scope.jobItems.update(first!.id, {
      status: "failed",
      leaseOwner: null,
      leaseUntil: null,
      lastErrorKind: "internal",
      lastError: "Something went wrong while generating this post.",
      finishedAt: new Date(),
    });
    expect((await e.scope.jobItems.countByStatus(jobId)).failed).toBe(1);

    await seedCreditHold(INSTALL_CREDENTIAL_OWNER, { heldSince: new Date(), nextProbeAt: new Date(Date.now() + 60_000) });

    const retry = await retryFailedItems(e.scope, jobId);
    expect(retry).toMatchObject({ changed: true, count: 1 });
    expect((await e.scope.jobItems.countByStatus(jobId)).queued).toBe(2);
    expect(await readHold(INSTALL_CREDENTIAL_OWNER)).not.toBeNull();

    const tick = await runTick({ config: { jobMaxItems: 5 } });
    expect(tick.generation.counts.held).toBe(1);
    expect((await e.scope.jobItems.countByStatus(jobId)).failed).toBe(0);
    expect(await readHold(INSTALL_CREDENTIAL_OWNER)).not.toBeNull();
  }, 30_000);

  it("FR-038: an open job still accepts items while held", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([]));
    const apiInput = (items: { fields: Record<string, string>; externalId?: string }[], open = true) =>
      e.input({ source: { kind: "api", fields: ["product"], items, open }, template: "Announce {{product}}." });
    const { jobId } = await createJob(e.scope, apiInput([{ fields: { product: "A" }, externalId: "ext-held-open" }]));

    await seedCreditHold(INSTALL_CREDENTIAL_OWNER, { heldSince: new Date(), nextProbeAt: new Date(Date.now() + 60_000) });

    const result = await appendItems(e.scope, jobId, { items: [{ fields: { product: "B" }, externalId: "ext-held-open-2" }] });
    expect(result).toMatchObject({ added: 1, itemCount: 2 });
    expect(await readHold(INSTALL_CREDENTIAL_OWNER)).not.toBeNull();
  }, 30_000);
});
