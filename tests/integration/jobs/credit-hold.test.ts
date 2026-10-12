import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptSecret } from "../../../src/server/crypto/secrets";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { generationJobItems, llmCreditHolds } from "../../../src/server/db/schema";
import { CREDIT_PROBE_INTERVAL_MS } from "../../../src/server/dal/credit-holds";
import { INSTALL_CREDENTIAL_OWNER } from "../../../src/server/dal/credential-owners";
import { claimDueJobItems } from "../../../src/server/dal/job-claims";
import { createProjectLlmRepo } from "../../../src/server/dal/project-llm";
import { llmFailureMessage } from "../../../src/server/llm/messages";
import { emptyGenerationCounts } from "../../../src/server/scheduler/generation";
import { schedulerConfig } from "../../../src/server/scheduler/config";
import { getEnv } from "../../../src/server/env";
import { setLlmFactoryForTests, setLlmForTests } from "../../../src/server/llm";
import type { LlmConfig } from "../../../src/server/llm/config";
import type { LlmProvider } from "../../../src/server/llm/types";
import { runTick } from "../../../src/server/scheduler";
import { processClaimedItem } from "../../../src/server/services/jobs/runner";
import { createJob } from "../../../src/server/services/jobs";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { jobsEnv, modelOk, parkAllJobs, readHold } from "../../helpers/jobs-env";

beforeEach(parkAllJobs);
afterEach(() => {
  setLlmFactoryForTests(null);
});
afterAll(async () => {
  setLlmForTests(null);
  setStorageForTests(undefined);
  await closeDb();
});

const tickAt = (at: Date, over: Record<string, unknown> = {}) =>
  atTime(at, () => runTick({ config: { jobMaxItems: 5, ...over } }));

describe("credit hold (US1)", () => {
  it("AS1: a billing refusal queues the item, due, unattempted, unleased, with its reason", async () => {
    const e = await jobsEnv();
    const fake = createFakeLlm([{ fail: "credit_exhausted" }]);
    setLlmForTests(fake);
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input());
    const t0 = new Date();
    const tick = await tickAt(t0);
    expect(tick.generation.counts).toMatchObject({ requeued: 1, failed: 0 });
    const [item] = await e.scope.jobItems.listForJob(jobId);
    expect(item).toMatchObject({
      status: "queued",
      attemptCount: 0,
      leaseOwner: null,
      leaseUntil: null,
      pendingRetry: null,
      lastErrorKind: "credit_exhausted",
      lastError: llmFailureMessage("credit_exhausted"),
    });
    expect(item!.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
  }, 60_000);

  it("AS2: the next tick inside the interval claims nothing and reports held", async () => {
    const e = await jobsEnv();
    const fake = createFakeLlm([{ fail: "credit_exhausted" }]);
    setLlmForTests(fake);
    await e.asset();
    await createJob(e.scope, e.input());
    const t0 = new Date();
    await tickAt(t0);
    expect(fake.requests).toHaveLength(1);

    const t1 = new Date(t0.getTime() + 60_000);
    const tick = await tickAt(t1);
    expect(tick.generation.counts).toMatchObject({ claimed: 0, held: 1, probed: 0 });
    expect(fake.requests).toHaveLength(1);
  }, 60_000);

  it("AS3: two items refused in one tick create exactly one hold row", async () => {
    const e = await jobsEnv();
    const fake = createFakeLlm([{ fail: "credit_exhausted" }, { fail: "credit_exhausted" }]);
    setLlmForTests(fake);
    await e.assets(2);
    await createJob(e.scope, e.input());
    const t0 = new Date();
    const tick = await tickAt(t0, { jobMaxItems: 2 });
    expect(tick.generation.counts.requeued).toBe(2);
    const hold = await readHold(INSTALL_CREDENTIAL_OWNER);
    expect(hold).not.toBeNull();
  }, 60_000);

  it("AS6: a non-billing 400/429 behaves exactly as today, with no hold created", async () => {
    const e = await jobsEnv();
    const fakeBad = createFakeLlm([{ fail: "bad_request" }]);
    setLlmForTests(fakeBad);
    await e.asset();
    const { jobId: badJobId } = await createJob(e.scope, e.input());
    await tickAt(new Date());
    const [badItem] = await e.scope.jobItems.listForJob(badJobId);
    expect(badItem).toMatchObject({ status: "failed", lastErrorKind: "bad_request" });
    expect(await readHold(INSTALL_CREDENTIAL_OWNER)).toBeNull();

    const e2 = await jobsEnv();
    const fakeRate = createFakeLlm([{ fail: "rate_limited" }]);
    setLlmForTests(fakeRate);
    await e2.asset();
    const { jobId: rateJobId } = await createJob(e2.scope, e2.input());
    await tickAt(new Date());
    const [rateItem] = await e2.scope.jobItems.listForJob(rateJobId);
    expect(rateItem).toMatchObject({ status: "queued", lastErrorKind: "rate_limited" });
    expect(await readHold(INSTALL_CREDENTIAL_OWNER)).toBeNull();
  }, 60_000);
});

const aadFor = (projectId: string) => `project_llm_credential:${projectId}`;

async function saveCredential(projectId: string, apiKey: string) {
  await createProjectLlmRepo(getDb(), projectId).save({
    provider: "openai",
    model: "fake-model",
    keyCiphertext: encryptSecret(apiKey, { aad: aadFor(projectId) }),
    updatedByUserId: null,
  });
}

/** A provider rebuilt per call for a project credential: the fake must stay queued, not be consumed once. */
function keyedFactory() {
  const llms = new Map<string, LlmProvider>();
  const queue = (apiKey: string, ...steps: FakeStep[]) => llms.set(apiKey, createFakeLlm(steps));
  setLlmFactoryForTests((config: LlmConfig): LlmProvider => llms.get(config.apiKey) ?? createFakeLlm([{ fail: "unavailable" }]));
  return { queue };
}

/**
 * Entry 1's full hold suite, unchanged with a project's own credential as the widened owner (T034): a
 * credential owner is just a string key to every one of these mechanisms, and this is the proof.
 */
describe("credit hold (US1 suite, widened to a project owner — US3)", () => {
  it("AS1: a billing refusal queues the item, due, unattempted, unleased, with its reason — nothing fails while held", async () => {
    const e = await jobsEnv();
    const KEY = "sk-widened-as1";
    await saveCredential(e.project.id, KEY);
    const { queue } = keyedFactory();
    queue(KEY, { fail: "credit_exhausted" });
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input());
    const t0 = new Date();
    const tick = await tickAt(t0);
    expect(tick.generation.counts).toMatchObject({ requeued: 1, failed: 0 });
    const owner = `project:${e.project.id}`;
    const [item] = await e.scope.jobItems.listForJob(jobId);
    expect(item).toMatchObject({
      status: "queued",
      attemptCount: 0,
      leaseOwner: null,
      leaseUntil: null,
      pendingRetry: null,
      lastErrorKind: "credit_exhausted",
      lastError: llmFailureMessage("credit_exhausted"),
    });
    expect(await readHold(owner)).not.toBeNull();
  }, 60_000);

  it("probe single-flight: two concurrent ticks make exactly one probe call for a project owner", async () => {
    const e = await jobsEnv();
    const KEY = "sk-widened-probe";
    await saveCredential(e.project.id, KEY);
    const { queue } = keyedFactory();
    queue(KEY, { fail: "credit_exhausted" });
    await e.assets(3);
    await createJob(e.scope, e.input());
    const t0 = new Date();
    await tickAt(t0, { jobMaxItems: 1 });
    const owner = `project:${e.project.id}`;
    expect(await readHold(owner)).not.toBeNull();

    // Two more due jobs, each with its own item, so each concurrent tick can lock a *different* job row.
    await e.assets(2);
    await createJob(e.scope, e.input());
    await e.assets(2);
    await createJob(e.scope, e.input());

    const t1 = new Date(t0.getTime() + CREDIT_PROBE_INTERVAL_MS);
    queue(KEY, modelOk("One probe only.", 1));
    await Promise.all([tickAt(t1, { jobMaxItems: 1 }), tickAt(t1, { jobMaxItems: 1 })]);
    expect(await readHold(owner)).toBeNull();
  }, 60_000);

  it("rewind: a probe granted when the tick budget is too short leaves nextProbeAt<=now for a project owner", async () => {
    const e = await jobsEnv();
    const KEY = "sk-widened-rewind";
    await saveCredential(e.project.id, KEY);
    const owner = `project:${e.project.id}`;
    const fake = createFakeLlm([]);
    setLlmFactoryForTests((config: LlmConfig) => (config.apiKey === KEY ? fake : createFakeLlm([{ fail: "unavailable" }])));
    await e.asset();
    await createJob(e.scope, e.input());
    const t0 = new Date();
    await getDb()
      .insert(llmCreditHolds)
      .values({ owner, heldSince: t0, lastRefusalAt: t0, nextProbeAt: t0 });

    const claim = await atTime(t0, () => claimDueJobItems({ now: t0, limit: 5, leaseMs: 300_000, maxAttempts: 3 }));
    expect(claim.items).toHaveLength(1);
    const claimed = claim.items[0]!;
    expect(claimed.probe).toBe(true);
    expect(claimed.owner).toBe(owner);

    const counts = emptyGenerationCounts();
    const config = schedulerConfig(getEnv());
    await atTime(t0, () => processClaimedItem(claimed, { config, deadline: t0.getTime() + 1, counts }));
    expect(fake.requests).toHaveLength(0);

    const hold = await readHold(owner);
    expect(hold).not.toBeNull();
    expect(hold!.nextProbeAt.getTime()).toBeLessThanOrEqual(t0.getTime());
  }, 60_000);

  it("kill-recovery, no retry on a recovered lease: a held project owner's expired lease is never counted or marked interrupted", async () => {
    const e = await jobsEnv();
    const KEY = "sk-widened-kill";
    await saveCredential(e.project.id, KEY);
    const owner = `project:${e.project.id}`;
    const { queue } = keyedFactory();
    queue(KEY, { fail: "credit_exhausted" });
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input());
    const t0 = new Date();
    await tickAt(t0);
    const [item] = await e.scope.jobItems.listForJob(jobId);
    expect(item).toMatchObject({ status: "queued", attemptCount: 0, lastErrorKind: "credit_exhausted" });
    expect(await readHold(owner)).not.toBeNull();

    await runCrossProject("test: force item running with expired lease", async () => {
      await getDb()
        .update(generationJobItems)
        .set({ status: "running", leaseOwner: randomUUID(), leaseUntil: new Date(t0.getTime() - 1_000) })
        .where(eq(generationJobItems.id, item!.id));
    });
    // nextProbeAt stays well past every tick below, so this exercises the merely-held path, not the probe.
    const far = new Date(t0.getTime() + 10 * 300_000);
    await getDb()
      .update(llmCreditHolds)
      .set({ nextProbeAt: far })
      .where(eq(llmCreditHolds.owner, owner));

    for (let i = 1; i <= 3; i++) {
      const t = new Date(t0.getTime() + i * 300_000);
      const tick = await tickAt(t);
      expect(tick.generation.counts.claimed).toBe(0);
    }
    const [after] = await e.scope.jobItems.listForJob(jobId);
    expect(after).toMatchObject({ status: "running", attemptCount: 0 });
    expect(after!.lastErrorKind).not.toBe("interrupted");
  }, 60_000);
});
