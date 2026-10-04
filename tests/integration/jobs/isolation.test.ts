import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setLlmForTests } from "../../../src/server/llm";
import { runTick } from "../../../src/server/scheduler";
import { createJob } from "../../../src/server/services/jobs";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { jobsEnv, modelOk, parkAllJobs, routeLlm } from "../../helpers/jobs-env";

beforeEach(parkAllJobs);
afterAll(async () => {
  setLlmForTests(null);
  setStorageForTests(undefined);
  await closeDb();
});

const tick = (at?: Date) => {
  const run = () => runTick({ config: { jobMaxItems: 5 } });
  return at ? atTime(at, run) : run();
};

async function itemsOf(e: Awaited<ReturnType<typeof jobsEnv>>, jobId: string) {
  return e.scope.jobItems.listForJob(jobId);
}

describe("one item never fails the job (US2, SC-003)", () => {
  it("fails item 2 of 5 as refused and finishes the others", async () => {
    const e = await jobsEnv();
    setLlmForTests(routeLlm((user) => (user.includes("alt_text: BAD") ? { fail: "refused" } : modelOk("Fine", 1))));
    const [a, b, ...rest] = [
      await e.asset({ altText: "ok 1" }),
      await e.asset({ altText: "BAD" }),
      await e.asset({ altText: "ok 3" }),
      await e.asset({ altText: "ok 4" }),
      await e.asset({ altText: "ok 5" }),
    ];
    expect([a, b, rest.length]).toBeTruthy();
    const { jobId } = await createJob(e.scope, e.input());
    for (let i = 0; i < 4; i++) await tick();

    const items = await itemsOf(e, jobId);
    const bad = items.find((i) => i.mediaAssetId === b!.id)!;
    expect(bad).toMatchObject({ status: "failed", lastErrorKind: "refused", lastError: "The model declined to write this post." });
    expect(await e.scope.posts.findByJobItemId(bad.id)).toBeNull();
    for (const item of items.filter((i) => i.id !== bad.id)) {
      expect(item.status).toBe("done");
      expect(await e.scope.posts.findByJobItemId(item.id)).not.toBeNull();
    }
    expect((await e.scope.jobs.get(jobId))!.status).toBe("completed_with_failures");
  }, 60_000);

  it("records an unexpected exception as internal while the sibling finishes", async () => {
    const e = await jobsEnv();
    setLlmForTests(routeLlm((user) => (user.includes("alt_text: EXPLODE") ? "throw" : modelOk("Fine", 1))));
    const boom = await e.asset({ altText: "EXPLODE" });
    await e.asset({ altText: "calm" });
    const { jobId } = await createJob(e.scope, e.input());
    await tick();
    const items = await itemsOf(e, jobId);
    const broken = items.find((i) => i.mediaAssetId === boom.id)!;
    expect(broken).toMatchObject({
      status: "queued",
      attemptCount: 1,
      lastErrorKind: "internal",
      lastError: "Something went wrong while generating this post.",
    });
    expect(JSON.stringify(broken)).not.toContain("boom");
    const sibling = items.find((i) => i.id !== broken.id)!;
    expect(sibling.status).toBe("done");
    expect(await e.scope.posts.findByJobItemId(sibling.id)).not.toBeNull();
  }, 60_000);

  it("backs off 60 s then 120 s for a temporary failure and fails at 3 attempts", async () => {
    const e = await jobsEnv();
    setLlmForTests(routeLlm(() => ({ fail: "unavailable" })));
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input());
    const t1 = new Date(Date.now() + 1_000);
    await tick(t1);
    let [item] = await itemsOf(e, jobId);
    expect(item).toMatchObject({ status: "queued", attemptCount: 1, lastErrorKind: "unavailable" });
    expect(item!.nextAttemptAt.getTime() - t1.getTime()).toBe(60_000);

    // Not due yet: nothing is claimed.
    expect((await tick(new Date(t1.getTime() + 30_000))).generation.counts.claimed).toBe(0);

    const t2 = new Date(t1.getTime() + 61_000);
    await tick(t2);
    [item] = await itemsOf(e, jobId);
    expect(item).toMatchObject({ status: "queued", attemptCount: 2 });
    expect(item!.nextAttemptAt.getTime() - t2.getTime()).toBe(120_000);

    await tick(new Date(t2.getTime() + 121_000));
    [item] = await itemsOf(e, jobId);
    expect(item).toMatchObject({ status: "failed", lastErrorKind: "unavailable" });
    expect((await e.scope.jobs.get(jobId))!.status).toBe("completed_with_failures");
  }, 60_000);

  it("fails a lasting failure at once", async () => {
    const e = await jobsEnv();
    setLlmForTests(routeLlm(() => ({ fail: "auth" })));
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input());
    await tick();
    const [item] = await itemsOf(e, jobId);
    expect(item).toMatchObject({ status: "failed", lastErrorKind: "auth", attemptCount: 0 });
  }, 60_000);
});
