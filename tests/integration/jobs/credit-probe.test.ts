import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INSTALL_CREDENTIAL_OWNER } from "../../../src/server/dal/credential-owners";
import { claimDueJobItems } from "../../../src/server/dal/job-claims";
import { CREDIT_PROBE_INTERVAL_MS, clearCreditHold, readCreditHolds } from "../../../src/server/dal/credit-holds";
import { getEnv } from "../../../src/server/env";
import { setLlmForTests } from "../../../src/server/llm";
import { runTick } from "../../../src/server/scheduler";
import { schedulerConfig } from "../../../src/server/scheduler/config";
import { emptyGenerationCounts } from "../../../src/server/scheduler/generation";
import { processClaimedItem } from "../../../src/server/services/jobs/runner";
import { createJob } from "../../../src/server/services/jobs";
import { generateSingle } from "../../../src/server/services/generation/single";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { jobsEnv, modelOk, parkAllJobs, readHold, routeCredentialOwners, seedCreditHold } from "../../helpers/jobs-env";

beforeEach(parkAllJobs);
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  setLlmForTests(null);
  setStorageForTests(undefined);
  await closeDb();
});

const tickAt = (at: Date, over: Record<string, unknown> = {}) =>
  atTime(at, () => runTick({ config: { jobMaxItems: 5, ...over } }));

describe("credit probe (US2)", () => {
  it("AS1: a successful probe clears the hold and the next tick claims up to jobMaxItems", async () => {
    const e = await jobsEnv();
    const fake = createFakeLlm([{ fail: "credit_exhausted" }]);
    setLlmForTests(fake);
    await e.assets(3);
    const { jobId } = await createJob(e.scope, e.input());
    const t0 = new Date();
    await tickAt(t0, { jobMaxItems: 1 });
    expect(fake.requests).toHaveLength(1);

    const t1 = new Date(t0.getTime() + CREDIT_PROBE_INTERVAL_MS);
    setLlmForTests(createFakeLlm([modelOk("Back in business.", 1)]));
    const probeTick = await tickAt(t1, { jobMaxItems: 3 });
    expect(probeTick.generation.counts).toMatchObject({ claimed: 1, probed: 1 });
    expect(await readHold(INSTALL_CREDENTIAL_OWNER)).toBeNull();

    const t2 = new Date(t1.getTime() + 1_000);
    setLlmForTests(createFakeLlm([modelOk("a", 1), modelOk("b", 1)]));
    const resumedTick = await tickAt(t2, { jobMaxItems: 3 });
    expect(resumedTick.generation.counts.claimed).toBe(2);
    const items = await e.scope.jobItems.listForJob(jobId);
    expect(items.every((i) => i.status === "done")).toBe(true);
  }, 60_000);

  it("AS2: a non-billing probe failure also clears the hold and follows its own path", async () => {
    for (const kind of ["timeout", "invalid_output", "unavailable"] as const) {
      const e = await jobsEnv();
      setLlmForTests(createFakeLlm([{ fail: "credit_exhausted" }]));
      await e.asset();
      const { jobId } = await createJob(e.scope, e.input());
      const t0 = new Date();
      await tickAt(t0, { jobMaxItems: 1 });

      const t1 = new Date(t0.getTime() + CREDIT_PROBE_INTERVAL_MS);
      const retriesInRequest = kind === "unavailable" ? 1 : 2;
      setLlmForTests(createFakeLlm(Array.from({ length: retriesInRequest }, () => ({ fail: kind }))));
      const probeTick = await tickAt(t1, { jobMaxItems: 1 });
      expect(probeTick.generation.counts.probed).toBe(1);
      expect(await readHold(INSTALL_CREDENTIAL_OWNER)).toBeNull();

      const [item] = await e.scope.jobItems.listForJob(jobId);
      if (kind === "invalid_output") {
        expect(item).toMatchObject({ status: "failed", lastErrorKind: "invalid_output" });
      } else {
        expect(item).toMatchObject({ status: "queued", lastErrorKind: kind });
        expect(item!.attemptCount).toBeGreaterThan(0);
      }
    }
  }, 60_000);

  it("AS3: an interactive call clears the hold before the probe is due", async () => {
    const e = await jobsEnv();
    const fake = createFakeLlm([{ fail: "credit_exhausted" }]);
    setLlmForTests(fake);
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input());
    const t0 = new Date();
    await tickAt(t0, { jobMaxItems: 1 });
    expect(await readHold(INSTALL_CREDENTIAL_OWNER)).not.toBeNull();

    const t1 = new Date(t0.getTime() + 1_000);
    const interactiveLlm = createFakeLlm([modelOk("Interactive success.")]);
    const res = await atTime(t1, () =>
      generateSingle(
        e.scope,
        { requestId: randomUUID(), voiceProfileId: e.profile.id, brief: "An interactive post", targetAccountIds: [e.account.id] },
        interactiveLlm,
      ),
    );
    expect(res.ok).toBe(true);
    expect(await readHold(INSTALL_CREDENTIAL_OWNER)).toBeNull();

    const t2 = new Date(t1.getTime() + 1_000);
    setLlmForTests(createFakeLlm([modelOk("Resumed.", 1)]));
    const tick = await tickAt(t2, { jobMaxItems: 1 });
    expect(tick.generation.counts).toMatchObject({ claimed: 1, held: 0, probed: 0, done: 1 });
    const [item] = await e.scope.jobItems.listForJob(jobId);
    expect(item!.status).toBe("done");
  }, 60_000);

  it("AS4: a swapped key or provider needs no Docket action", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([{ fail: "credit_exhausted" }]));
    await e.asset();
    await createJob(e.scope, e.input());
    const t0 = new Date();
    await tickAt(t0, { jobMaxItems: 1 });
    expect(await readHold(INSTALL_CREDENTIAL_OWNER)).not.toBeNull();

    // The operator swaps the key/provider: the stub now succeeds.
    const t1 = new Date(t0.getTime() + CREDIT_PROBE_INTERVAL_MS);
    setLlmForTests(createFakeLlm([modelOk("Swapped key works.", 1)]));
    const probeTick = await tickAt(t1, { jobMaxItems: 1 });
    expect(probeTick.generation.counts.probed).toBe(1);
    expect(await readCreditHolds()).toHaveLength(0);
  }, 60_000);

  it("AS5: two concurrent ticks make exactly one probe call", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([{ fail: "credit_exhausted" }]));
    await e.asset();
    await createJob(e.scope, e.input());
    const t0 = new Date();
    await tickAt(t0, { jobMaxItems: 1 });
    const before = await readHold(INSTALL_CREDENTIAL_OWNER);
    expect(before).not.toBeNull();

    const t1 = new Date(t0.getTime() + CREDIT_PROBE_INTERVAL_MS);
    const probing = createFakeLlm([modelOk("One probe only.", 1)]);
    setLlmForTests(probing);
    await Promise.all([tickAt(t1, { jobMaxItems: 1 }), tickAt(t1, { jobMaxItems: 1 })]);
    expect(probing.requests).toHaveLength(1);
    const after = await readHold(INSTALL_CREDENTIAL_OWNER);
    expect(after).toBeNull();
  }, 60_000);

  it("AS6: refuse, clear, refuse again yields a fresh heldSince and still one row", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([{ fail: "credit_exhausted" }]));
    await e.assets(2);
    await createJob(e.scope, e.input());
    const t0 = new Date();
    await tickAt(t0, { jobMaxItems: 1 });
    const first = await readHold(INSTALL_CREDENTIAL_OWNER);
    expect(first).not.toBeNull();

    await clearCreditHold(INSTALL_CREDENTIAL_OWNER);
    expect(await readHold(INSTALL_CREDENTIAL_OWNER)).toBeNull();

    const t1 = new Date(t0.getTime() + 60_000);
    setLlmForTests(createFakeLlm([{ fail: "credit_exhausted" }]));
    await tickAt(t1, { jobMaxItems: 1 });
    const holds = await readCreditHolds();
    expect(holds).toHaveLength(1);
    expect(holds[0]!.heldSince.getTime()).toBe(t1.getTime());
    expect(holds[0]!.heldSince.getTime()).not.toBe(t0.getTime());
  }, 60_000);

  it("H7: a probe granted when the tick budget is too short to call the model leaves nextProbeAt<=now", async () => {
    const e = await jobsEnv();
    const fake = createFakeLlm([]);
    setLlmForTests(fake);
    await e.asset();
    await createJob(e.scope, e.input());
    const t0 = new Date();
    await seedCreditHold(INSTALL_CREDENTIAL_OWNER, { heldSince: t0, nextProbeAt: t0 });

    const claim = await atTime(t0, () => claimDueJobItems({ now: t0, limit: 5, leaseMs: 300_000, maxAttempts: 3 }));
    expect(claim.items).toHaveLength(1);
    const claimed = claim.items[0]!;
    expect(claimed.probe).toBe(true);

    const counts = emptyGenerationCounts();
    const config = schedulerConfig(getEnv());
    await atTime(t0, () => processClaimedItem(claimed, { config, deadline: t0.getTime() + 1, counts }));
    expect(fake.requests).toHaveLength(0);

    const hold = await readHold(INSTALL_CREDENTIAL_OWNER);
    expect(hold).not.toBeNull();
    expect(hold!.nextProbeAt.getTime()).toBeLessThanOrEqual(t0.getTime());
  }, 60_000);

  it("H7: a probe whose item already has a post (finish) does not spend the interval", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([modelOk("Already posted.", 1)]));
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input());
    const t0 = new Date();
    await tickAt(t0, { jobMaxItems: 1 });
    const [doneItem] = await e.scope.jobItems.listForJob(jobId);
    const job = await e.scope.jobs.get(jobId);
    expect(doneItem).toMatchObject({ status: "done" });

    const t1 = new Date(t0.getTime() + 60_000);
    await seedCreditHold(INSTALL_CREDENTIAL_OWNER, { heldSince: t1, nextProbeAt: t1 });
    const fake = createFakeLlm([]);
    setLlmForTests(fake);
    const counts = emptyGenerationCounts();
    const config = schedulerConfig(getEnv());
    await atTime(t1, () =>
      processClaimedItem(
        {
          item: doneItem!,
          job: job!,
          token: randomUUID(),
          kind: "finish",
          recovered: false,
          owner: INSTALL_CREDENTIAL_OWNER,
          probe: true,
        },
        { config, deadline: t1.getTime() + 300_000, counts },
      ),
    );
    expect(fake.requests).toHaveLength(0);
    const hold = await readHold(INSTALL_CREDENTIAL_OWNER);
    expect(hold).not.toBeNull();
    expect(hold!.nextProbeAt.getTime()).toBeLessThanOrEqual(t1.getTime());
  }, 60_000);

  it("H7: nextProbeAt far in the past (a clock jump) yields exactly one probe", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([{ fail: "credit_exhausted" }]));
    await e.asset();
    await createJob(e.scope, e.input());
    const t0 = new Date();
    await tickAt(t0, { jobMaxItems: 1 });

    const farPast = new Date(t0.getTime() - 10 * 24 * 60 * 60 * 1000);
    await seedCreditHold(INSTALL_CREDENTIAL_OWNER, { heldSince: farPast, nextProbeAt: farPast });

    const t1 = new Date(t0.getTime() + 60_000);
    setLlmForTests(createFakeLlm([modelOk("One probe, not a queue.", 1)]));
    const tick = await tickAt(t1, { jobMaxItems: 1 });
    expect(tick.generation.counts).toMatchObject({ claimed: 1, probed: 1 });
    expect(await readHold(INSTALL_CREDENTIAL_OWNER)).toBeNull();
  }, 60_000);

  it("F1: a held owner whose only due work is a lease-expired running item still probes", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([{ fail: "credit_exhausted" }]));
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input());
    const t0 = new Date();
    await tickAt(t0, { jobMaxItems: 1 });
    expect(await readHold(INSTALL_CREDENTIAL_OWNER)).not.toBeNull();

    const forceStuck = async (now: Date) => {
      const [item] = await e.scope.jobItems.listForJob(jobId);
      await e.scope.jobItems.update(item!.id, {
        status: "running",
        leaseOwner: randomUUID(),
        leaseUntil: new Date(now.getTime() - 1_000),
      });
    };

    let t = t0;
    for (let i = 0; i < 3; i++) {
      await forceStuck(t);
      t = new Date(t.getTime() + CREDIT_PROBE_INTERVAL_MS);
      const fake = createFakeLlm([{ fail: "credit_exhausted" }]);
      setLlmForTests(fake);
      await tickAt(t, { jobMaxItems: 1 });
      expect(fake.requests).toHaveLength(1);
      const [item] = await e.scope.jobItems.listForJob(jobId);
      expect(item!.attemptCount).toBe(0);
      expect(item!.lastErrorKind).not.toBe("interrupted");
      expect(await readHold(INSTALL_CREDENTIAL_OWNER)).not.toBeNull();
    }

    await forceStuck(t);
    t = new Date(t.getTime() + CREDIT_PROBE_INTERVAL_MS);
    setLlmForTests(createFakeLlm([modelOk("Recovered.", 1)]));
    await tickAt(t, { jobMaxItems: 1 });
    expect(await readHold(INSTALL_CREDENTIAL_OWNER)).toBeNull();
    const [done] = await e.scope.jobItems.listForJob(jobId);
    expect(done!.status).toBe("done");
  }, 60_000);

  it("SC-010: two owners, one held, yields nothing for it while the other is claimed at full budget", async () => {
    const SECOND_OWNER = "second-credential";
    const held = await jobsEnv();
    const open = await jobsEnv();
    routeCredentialOwners(SECOND_OWNER, [held.project.id]);

    setLlmForTests(createFakeLlm([]));
    await held.assets(3);
    const { jobId: heldJobId } = await createJob(held.scope, held.input());
    await open.assets(3);
    const { jobId: openJobId } = await createJob(open.scope, open.input());

    const t0 = new Date();
    await seedCreditHold(SECOND_OWNER, { heldSince: t0, nextProbeAt: new Date(t0.getTime() + CREDIT_PROBE_INTERVAL_MS) });

    setLlmForTests(createFakeLlm([modelOk("a", 1), modelOk("b", 1), modelOk("c", 1)]));
    const tick = await tickAt(t0, { jobMaxItems: 5 });
    expect(tick.generation.counts.claimed).toBe(3);

    const heldItems = await held.scope.jobItems.listForJob(heldJobId);
    expect(heldItems.every((i) => i.status === "queued")).toBe(true);
    const openItems = await open.scope.jobItems.listForJob(openJobId);
    expect(openItems.every((i) => i.status === "done")).toBe(true);
    expect(await readHold(SECOND_OWNER)).not.toBeNull();
  }, 60_000);
});
