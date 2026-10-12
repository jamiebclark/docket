import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { INSTALL_CREDENTIAL_OWNER } from "../../../src/server/dal/credential-owners";
import { llmFailureMessage } from "../../../src/server/llm/messages";
import { setLlmForTests } from "../../../src/server/llm";
import { runTick } from "../../../src/server/scheduler";
import { createJob } from "../../../src/server/services/jobs";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { jobsEnv, parkAllJobs, readHold } from "../../helpers/jobs-env";

beforeEach(parkAllJobs);
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
