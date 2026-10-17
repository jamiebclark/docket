import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setLlmForTests } from "../../../src/server/llm";
import type { LlmProvider } from "../../../src/server/llm/types";
import { runTick } from "../../../src/server/scheduler";
import { createJob } from "../../../src/server/services/jobs/create";
import { retryFailedItems } from "../../../src/server/services/jobs";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakeLlm, type FakeLlm } from "../../helpers/fake-llm";
import { jobsEnv, tickConfig } from "../../helpers/jobs-env";

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

describe("a late external-id claim caught by the runner (US2)", () => {
  it("skips the item, no post, job completes (not with_failures), and retry-failed ignores it (FR-021, FR-022, AS2.7)", async () => {
    const e = await setup();
    const image = await e.asset();
    setLlmForTests(createFakeLlm([ok()]));
    const { jobId } = await createJob(e.scope, e.apiInput([{ fields: { product: "Widget" }, externalId: "glen-1", mediaId: image.id }]));

    // Claimed by another submission after ingest, before the runner reaches it.
    await e.scope.externalClaims.insert({ sourceKey: "default", externalId: "glen-1", postId: (await e.scope.posts.insert({ baseText: "Other" })).id, claimedAt: new Date() });

    for (let i = 0; i < 20; i++) {
      await runTick(tickConfig({ jobMaxItems: 5 }));
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
      await runTick(tickConfig({ jobMaxItems: 5 }));
      const counts = await e.scope.jobItems.countByStatus(jobId);
      if (counts.skipped + counts.failed + counts.done > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const [item] = await e.scope.jobItems.listForJob(jobId);
    expect(item).toMatchObject({ status: "skipped" });
    expect(await e.scope.posts.findByJobItemId(item!.id)).toBeNull();
  }, 30_000);
});
