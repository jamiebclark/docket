import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setLlmForTests } from "../../../src/server/llm";
import type { LlmProvider } from "../../../src/server/llm/types";
import { runGenerationJobs } from "../../../src/server/scheduler/generation";
import { schedulerConfig } from "../../../src/server/scheduler/config";
import { getEnv } from "../../../src/server/env";
import { createJob } from "../../../src/server/services/jobs/create";
import { retryFailedItems } from "../../../src/server/services/jobs";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakeLlm, type FakeLlm } from "../../helpers/fake-llm";
import { jobsEnv, parkAllJobs, TICK_BUDGET_MS } from "../../helpers/jobs-env";

beforeEach(parkAllJobs);
afterAll(async () => {
  setLlmForTests(null);
  setStorageForTests(undefined);
  await closeDb();
});

const ok = () => ({ ok: { variants: { mock: { text: "A post." } } } });

async function setup() {
  const env = await jobsEnv();
  const apiInput = (items: { fields: Record<string, string>; externalId?: string; mediaId?: string }[]) =>
    env.input({ source: { kind: "api", fields: ["product"], items }, template: "Announce {{product}}." });
  return { ...env, apiInput };
}

function sideEffectLlm(fake: FakeLlm, onCall: () => Promise<void>): LlmProvider {
  return {
    name: fake.name,
    model: fake.model,
    async generate(request) {
      await onCall();
      return fake.generate(request);
    },
  } as LlmProvider;
}

// Drains the generation section, not whole ticks. `runTick` runs ten sections concurrently and nine
// are incidental to a job drain, which is the exposure that killed sibling files on a test timeout -
// see docs/decisions.md, "What the block-shaped CI flakes are not", for why the two database
// explanations were excluded by measurement and the remedy is to ask for less.
const DRAIN_CONFIG = (over: Record<string, unknown> = {}) =>
  schedulerConfig(getEnv(), { timeBudgetMs: TICK_BUDGET_MS, ...over });
const drainOnce = (over: Record<string, unknown> = {}) =>
  runGenerationJobs({ config: DRAIN_CONFIG(over), tickId: "test-drain", startedAt: new Date() });

describe("a late external-id claim caught by the runner (US2)", () => {
  it("skips the item, no post, job completes (not with_failures), and retry-failed ignores it (FR-021, FR-022, AS2.7)", async () => {
    const e = await setup();
    const image = await e.asset();
    setLlmForTests(createFakeLlm([ok()]));
    const { jobId } = await createJob(e.scope, e.apiInput([{ fields: { product: "Widget" }, externalId: "glen-1", mediaId: image.id }]));

    // Claimed by another submission after ingest, before the runner reaches it.
    await e.scope.externalClaims.insert({ sourceKey: "default", externalId: "glen-1", postId: (await e.scope.posts.insert({ baseText: "Other" })).id, claimedAt: new Date() });

    for (let i = 0; i < 20; i++) {
      await drainOnce({ jobMaxItems: 5 });
      const counts = await e.scope.jobItems.countByStatus(jobId);
      if (counts.skipped + counts.failed + counts.done > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const [item] = await e.scope.jobItems.listForJob(jobId);
    expect(item).toMatchObject({ status: "skipped" });
    expect(await e.scope.posts.findByJobItemId(item!.id)).toBeNull();
    expect((await e.scope.jobs.get(jobId))!.status).toBe("completed");
    expect(await e.scope.media.reservedAmong([image.id])).toEqual([]);

    const retried = await retryFailedItems(e.scope, jobId);
    expect(retried.count).toBe(0);
    expect((await e.scope.jobItems.get(item!.id))!.status).toBe("skipped");
  }, 30_000);

  it("a claim landing during the model call still ends as a skip (D7/D9)", async () => {
    const e = await setup();
    setLlmForTests(createFakeLlm([]));
    const { jobId } = await createJob(e.scope, e.apiInput([{ fields: { product: "Widget" }, externalId: "glen-2" }]));

    const winnerPost = await e.scope.posts.insert({ baseText: "Winner" });
    const fake = createFakeLlm([ok()]);
    const llm = sideEffectLlm(fake, async () => {
      await e.scope.externalClaims.insert({ sourceKey: "default", externalId: "glen-2", postId: winnerPost.id, claimedAt: new Date() });
    });
    setLlmForTests(llm);

    for (let i = 0; i < 20; i++) {
      await drainOnce({ jobMaxItems: 5 });
      const counts = await e.scope.jobItems.countByStatus(jobId);
      if (counts.skipped + counts.failed + counts.done > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const [item] = await e.scope.jobItems.listForJob(jobId);
    expect(item).toMatchObject({ status: "skipped" });
    expect(await e.scope.posts.findByJobItemId(item!.id)).toBeNull();
  }, 30_000);
});
