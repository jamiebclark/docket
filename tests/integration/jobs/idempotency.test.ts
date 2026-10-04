import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { posts } from "../../../src/server/db/schema";
import { setLlmForTests } from "../../../src/server/llm";
import { runTick } from "../../../src/server/scheduler";
import { createJob, retryFailedItems, retryItem } from "../../../src/server/services/jobs";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { jobsEnv, modelOk, parkAllJobs, routeLlm } from "../../helpers/jobs-env";

beforeEach(parkAllJobs);
afterAll(async () => {
  setLlmForTests(null);
  setStorageForTests(undefined);
  await closeDb();
});

const tick = () => runTick({ config: { jobMaxItems: 5 } });

describe("retries and concurrent ticks never duplicate posts (US2, SC-004)", () => {
  it("retry gives exactly one post, and a second retry changes nothing", async () => {
    const e = await jobsEnv();
    let healthy = false;
    setLlmForTests(routeLlm(() => (healthy ? modelOk("Now fine", 1) : { fail: "auth" })));
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input());
    await tick();
    const [failed] = await e.scope.jobItems.listForJob(jobId);
    expect(failed!.status).toBe("failed");
    expect((await e.scope.jobs.get(jobId))!.status).toBe("completed_with_failures");

    healthy = true;
    expect(await retryItem(e.scope, jobId, failed!.id)).toEqual({ changed: true, message: "Item 1 will be retried." });
    const [queued] = await e.scope.jobItems.listForJob(jobId);
    expect(queued).toMatchObject({ status: "queued", attemptCount: 0, lastErrorKind: "auth" });
    await tick();
    const [done] = await e.scope.jobItems.listForJob(jobId);
    expect(done!.status).toBe("done");
    expect(await e.scope.posts.findByJobItemId(done!.id)).not.toBeNull();
    expect((await e.scope.jobs.get(jobId))!.status).toBe("completed");

    expect(await retryItem(e.scope, jobId, failed!.id)).toEqual({ changed: false, message: "Only failed items can be retried." });
    expect(await retryFailedItems(e.scope, jobId)).toMatchObject({ changed: false, count: 0, message: "There are no failed items to retry." });
    await tick();
    const rows = await runCrossProject("test: count posts", () => getDb().select().from(posts).where(and(eq(posts.projectId, e.project.id), eq(posts.generationJobItemId, failed!.id))));
    expect(rows).toHaveLength(1);
  }, 60_000);

  it("retries every failed item in one call", async () => {
    const e = await jobsEnv();
    setLlmForTests(routeLlm(() => ({ fail: "auth" })));
    await e.assets(2);
    const { jobId } = await createJob(e.scope, e.input());
    await tick();
    expect(await retryFailedItems(e.scope, jobId)).toEqual({ changed: true, message: "2 items will be retried.", count: 2 });
    expect((await e.scope.jobs.get(jobId))!.status).toBe("running");
  }, 60_000);

  it("refuses to retry an item of a cancelled job", async () => {
    const e = await jobsEnv();
    setLlmForTests(routeLlm(() => ({ fail: "auth" })));
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input());
    await tick();
    await e.scope.jobs.update(jobId, { status: "cancelled", cancelledAt: new Date() });
    const [item] = await e.scope.jobItems.listForJob(jobId);
    expect(await retryItem(e.scope, jobId, item!.id)).toEqual({
      changed: false,
      message: "This job was cancelled; its items cannot be retried.",
    });
    expect((await e.scope.jobItems.get(item!.id))!.status).toBe("failed");
  }, 60_000);

  it("never double-processes an item across concurrent ticks", async () => {
    const e = await jobsEnv();
    const llm = routeLlm(() => modelOk("Once", 1));
    setLlmForTests(llm);
    await e.assets(6);
    const { jobId } = await createJob(e.scope, e.input());
    for (let i = 0; i < 3; i++) await Promise.all([tick(), tick()]);
    const items = await e.scope.jobItems.listForJob(jobId);
    expect(items.every((i) => i.status === "done")).toBe(true);
    expect(llm.requests).toHaveLength(6);
    for (const item of items) {
      const rows = await runCrossProject("test: count posts", () => getDb().select().from(posts).where(and(eq(posts.projectId, e.project.id), eq(posts.generationJobItemId, item.id))));
      expect(rows).toHaveLength(1);
    }
  }, 60_000);

  it("rejects a second live post for one item with 23505", async () => {
    const e = await jobsEnv();
    setLlmForTests(routeLlm(() => modelOk("Once", 1)));
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input());
    await tick();
    const [item] = await e.scope.jobItems.listForJob(jobId);
    const [row] = await runCrossProject("test: read post", () => getDb().select().from(posts).where(and(eq(posts.projectId, e.project.id), eq(posts.generationJobItemId, item!.id))));
    await expect(
      runCrossProject("test: duplicate post", () => getDb().insert(posts).values({ ...row!, id: randomUUID() })),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  }, 60_000);
});
