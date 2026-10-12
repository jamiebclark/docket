import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptSecret } from "../../../src/server/crypto/secrets";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { projects } from "../../../src/server/db/schema";
import { clearCreditHold } from "../../../src/server/dal/credit-holds";
import { INSTALL_CREDENTIAL_OWNER } from "../../../src/server/dal/credential-owners";
import { createProjectLlmRepo } from "../../../src/server/dal/project-llm";
import { setLlmFactoryForTests, setLlmForTests } from "../../../src/server/llm";
import type { LlmConfig } from "../../../src/server/llm/config";
import type { LlmProvider } from "../../../src/server/llm/types";
import { runTick } from "../../../src/server/scheduler";
import { pruneOrphanHolds } from "../../../src/server/scheduler/housekeeping";
import { generationCreditHold } from "../../../src/server/services/jobs/read";
import { createJob } from "../../../src/server/services/jobs";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { clearHolds, jobsEnv, modelOk, parkAllJobs, readHold } from "../../helpers/jobs-env";

beforeEach(parkAllJobs);
afterEach(() => {
  setLlmFactoryForTests(null);
  setLlmForTests(null);
});
afterAll(async () => {
  await clearHolds();
  await closeDb();
});

const aadFor = (projectId: string) => `project_llm_credential:${projectId}`;
const PROJECT_OWNER = (projectId: string) => `project:${projectId}`;

async function saveCredential(projectId: string, apiKey: string) {
  await createProjectLlmRepo(getDb(), projectId).save({
    provider: "openai",
    model: "fake-model",
    keyCiphertext: encryptSecret(apiKey, { aad: aadFor(projectId) }),
    updatedByUserId: null,
  });
}

/**
 * Routes by apiKey: a provider is rebuilt per call (no caching for a project credential), so the fake for
 * each key must stay queued across calls rather than being consumed on the first build.
 */
function keyedFactory() {
  const llms = new Map<string, LlmProvider>();
  const queue = (apiKey: string, ...steps: FakeStep[]) => llms.set(apiKey, createFakeLlm(steps));
  setLlmFactoryForTests((config: LlmConfig): LlmProvider => llms.get(config.apiKey) ?? createFakeLlm([{ fail: "unavailable" }]));
  return { queue };
}

const tickAt = (at: Date, over: Record<string, unknown> = {}) =>
  atTime(at, () => runTick({ config: { jobMaxItems: 5, ...over } }));

describe("hold scope (US3)", () => {
  it("AS1/SC-006: only the refusing project's items are held; the other keeps completing", async () => {
    const dry = await jobsEnv();
    const funded = await jobsEnv();
    const KEY_DRY = "sk-dry-0123456789";
    const KEY_FUNDED = "sk-funded-9876543210";
    await saveCredential(dry.project.id, KEY_DRY);
    await saveCredential(funded.project.id, KEY_FUNDED);
    const { queue } = keyedFactory();

    await dry.asset();
    const { jobId: dryJobId } = await createJob(dry.scope, dry.input());
    await funded.assets(3);
    const { jobId: fundedJobId } = await createJob(funded.scope, funded.input());

    queue(KEY_DRY, { fail: "credit_exhausted" });
    queue(KEY_FUNDED, modelOk("a", 1), modelOk("b", 1), modelOk("c", 1));
    const t0 = new Date();
    const tick = await tickAt(t0, { jobMaxItems: 5 });
    expect(tick.generation.counts.claimed).toBe(4);

    const [dryItem] = await dry.scope.jobItems.listForJob(dryJobId);
    expect(dryItem).toMatchObject({ status: "queued", attemptCount: 0, lastErrorKind: "credit_exhausted" });
    const fundedItems = await funded.scope.jobItems.listForJob(fundedJobId);
    expect(fundedItems.every((i) => i.status === "done")).toBe(true);

    expect(await readHold(PROJECT_OWNER(dry.project.id))).not.toBeNull();
    expect(await readHold(PROJECT_OWNER(funded.project.id))).toBeNull();
  }, 60_000);

  it("AS2: projects on the install default are held together; a project with its own credential is not", async () => {
    const prevEnv = { ...process.env };
    process.env.LLM_PROVIDER = "openai";
    process.env.LLM_MODEL = "fake-model";
    const KEY_INSTALL = "sk-install-default";
    process.env.OPENAI_API_KEY = KEY_INSTALL;
    try {
      const installA = await jobsEnv();
      const installB = await jobsEnv();
      const { queue } = keyedFactory();
      // `getLlm()` caches the install provider by config fingerprint, so the fake for it must be queued
      // before anything (even `createJob`'s own configuration check) first builds one for this config.
      queue(KEY_INSTALL, { fail: "credit_exhausted" });

      await installA.asset();
      const { jobId: aJobId } = await createJob(installA.scope, installA.input());
      await installB.asset();
      const { jobId: bJobId } = await createJob(installB.scope, installB.input());

      const t0 = new Date();
      await tickAt(t0, { jobMaxItems: 1 });
      expect(await readHold(INSTALL_CREDENTIAL_OWNER)).not.toBeNull();

      // The own-key project's job is only created now, so it cannot win the first tick's one claim slot.
      const ownKey = await jobsEnv();
      const KEY_OWN = "sk-own-key";
      await saveCredential(ownKey.project.id, KEY_OWN);
      await ownKey.asset();
      const { jobId: ownJobId } = await createJob(ownKey.scope, ownKey.input());

      const t1 = new Date(t0.getTime() + 60_000);
      queue(KEY_OWN, modelOk("own key keeps going", 1));
      const tick = await tickAt(t1, { jobMaxItems: 5 });
      expect(tick.generation.counts.held).toBe(1);
      const [aItem] = await installA.scope.jobItems.listForJob(aJobId);
      const [bItem] = await installB.scope.jobItems.listForJob(bJobId);
      const [ownItem] = await ownKey.scope.jobItems.listForJob(ownJobId);
      expect(aItem).toMatchObject({ status: "queued" });
      expect(bItem).toMatchObject({ status: "queued" });
      expect(ownItem).toMatchObject({ status: "done" });
    } finally {
      process.env = prevEnv;
    }
  }, 60_000);

  it("AS3: each held project has its own probe schedule; one project's probe does not consume the other's", async () => {
    const a = await jobsEnv();
    const b = await jobsEnv();
    const KEY_A = "sk-probe-a";
    const KEY_B = "sk-probe-b";
    await saveCredential(a.project.id, KEY_A);
    await saveCredential(b.project.id, KEY_B);
    const { queue } = keyedFactory();

    await a.asset();
    await createJob(a.scope, a.input());
    await b.asset();
    await createJob(b.scope, b.input());

    queue(KEY_A, { fail: "credit_exhausted" });
    queue(KEY_B, { fail: "credit_exhausted" });
    const t0 = new Date();
    await tickAt(t0, { jobMaxItems: 5 });
    expect(await readHold(PROJECT_OWNER(a.project.id))).not.toBeNull();
    expect(await readHold(PROJECT_OWNER(b.project.id))).not.toBeNull();

    // Only A's probe interval has elapsed; A's probe must not spend B's hold.
    const CREDIT_PROBE_INTERVAL_MS = 5 * 60_000;
    const t1 = new Date(t0.getTime() + CREDIT_PROBE_INTERVAL_MS);
    queue(KEY_A, modelOk("a recovers", 1));
    const probeTick = await tickAt(t1, { jobMaxItems: 5 });
    expect(probeTick.generation.counts.probed).toBe(1);
    expect(await readHold(PROJECT_OWNER(a.project.id))).toBeNull();
    const bHold = await readHold(PROJECT_OWNER(b.project.id));
    expect(bHold).not.toBeNull();
    expect(bHold!.nextProbeAt.getTime()).toBe(t0.getTime() + CREDIT_PROBE_INTERVAL_MS);
  }, 60_000);

  it("AS4: clearing a held project's hold resumes its items on the next tick, with no probe wait or retry action", async () => {
    const e = await jobsEnv();
    const KEY = "sk-cleared";
    await saveCredential(e.project.id, KEY);
    const { queue } = keyedFactory();
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input());

    queue(KEY, { fail: "credit_exhausted" });
    const t0 = new Date();
    await tickAt(t0, { jobMaxItems: 1 });
    const owner = PROJECT_OWNER(e.project.id);
    expect(await readHold(owner)).not.toBeNull();

    // Stands in for an owner saving a new key (US4's saveProjectLlm clears the hold the same way).
    await clearCreditHold(owner);
    expect(await readHold(owner)).toBeNull();

    const t1 = new Date(t0.getTime() + 1_000);
    queue(KEY, modelOk("resumed", 1));
    const tick = await tickAt(t1, { jobMaxItems: 1 });
    expect(tick.generation.counts).toMatchObject({ claimed: 1, held: 0, probed: 0, done: 1 });
    const [item] = await e.scope.jobItems.listForJob(jobId);
    expect(item!.status).toBe("done");
  }, 60_000);

  it("AS5/AS6: the notice names whose account, and names the install elsewhere, with none in a different funded project", async () => {
    const held = await jobsEnv();
    const funded = await jobsEnv();
    const KEY_HELD = "sk-notice-held";
    const KEY_FUNDED = "sk-notice-funded";
    await saveCredential(held.project.id, KEY_HELD);
    await saveCredential(funded.project.id, KEY_FUNDED);
    const { queue } = keyedFactory();

    await held.asset();
    await createJob(held.scope, held.input());
    await funded.assets(1);
    await createJob(funded.scope, funded.input());

    queue(KEY_HELD, { fail: "credit_exhausted" });
    queue(KEY_FUNDED, modelOk("ok", 1));
    await tickAt(new Date(), { jobMaxItems: 5 });

    const heldNotice = await generationCreditHold(held.scope);
    expect(heldNotice).toMatchObject({ scope: "project" });

    const fundedNotice = await generationCreditHold(funded.scope);
    expect(fundedNotice).toBeNull();
  }, 60_000);

  it("AS7: deleting a project with a credential leaves no credential row and, once swept, no hold row", async () => {
    const e = await jobsEnv();
    const KEY = "sk-deleted";
    await saveCredential(e.project.id, KEY);
    const { queue } = keyedFactory();
    await e.asset();
    await createJob(e.scope, e.input());
    queue(KEY, { fail: "credit_exhausted" });
    await tickAt(new Date(), { jobMaxItems: 1 });
    const owner = PROJECT_OWNER(e.project.id);
    expect(await readHold(owner)).not.toBeNull();

    await runCrossProject("test: delete a project", () => testDb().delete(projects).where(eq(projects.id, e.project.id)));

    const pruned = await pruneOrphanHolds();
    expect(pruned).toBeGreaterThanOrEqual(1);
    expect(await readHold(owner)).toBeNull();
  }, 60_000);
});
