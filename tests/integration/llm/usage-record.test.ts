import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../../src/server/db/client";
import { llmCallUsage, type LlmCallUsageRow } from "../../../src/server/db/schema";
import { setLlmFactoryForTests, setLlmForTests } from "../../../src/server/llm";
import { createProjectLlmRepo } from "../../../src/server/dal/project-llm";
import { encryptSecret } from "../../../src/server/crypto/secrets";
import { ValidationIssuesError } from "../../../src/server/dal/errors";
import { LlmNotConfiguredError } from "../../../src/server/llm";
import { runTick } from "../../../src/server/scheduler";
import { generateSingle } from "../../../src/server/services/generation/single";
import { planSeries, startSeries, writeSeriesPost } from "../../../src/server/services/generation/series";
import { regeneratePost } from "../../../src/server/services/generation/regenerate";
import { checkProjectLlm } from "../../../src/server/services/generation/check";
import { tryVoice } from "../../../src/server/services/voice";
import { createJob } from "../../../src/server/services/jobs";
import * as accounts from "../../../src/server/services/accounts";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { createVoiceProfile } from "../../helpers/factories";
import { jobsEnv, modelOk, parkAllJobs, tickConfig } from "../../helpers/jobs-env";
import { postsEnv } from "../../helpers/posts-env";

afterEach(() => {
  setLlmFactoryForTests(null);
  setLlmForTests(null);
});
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

async function rowsFor(projectId: string): Promise<LlmCallUsageRow[]> {
  return getDb().select().from(llmCallUsage).where(eq(llmCallUsage.projectId, projectId)).orderBy(llmCallUsage.calledAt);
}

async function setup() {
  const env = await postsEnv();
  const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Warm and direct." } });
  const account = await accounts.connectMock(env.scope, { displayName: "Mock", settings: {} });
  const input = (over: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    voiceProfileId: profile.id,
    brief: "Announce the spring sale",
    targetAccountIds: [account.id],
    ...over,
  });
  return { env, profile, account, input };
}

const ok = (text = "A post"): FakeStep => ({ ok: { variants: { mock: { text } } } });

describe("llm_call_usage: one row per call site, and only for real calls", () => {
  it("generate.single: one call records one row linked to the saved post", async () => {
    const t = await setup();
    const llm = createFakeLlm([ok()]);
    const res = await generateSingle(t.env.scope, t.input(), llm);
    expect(res.ok).toBe(true);
    const rows = await rowsFor(t.env.project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: "generate.single",
      ok: true,
      postId: res.ok ? res.postId : null,
      seriesId: null,
      generationJobId: null,
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it("an invalid_output retry writes two rows, the first marked failed", async () => {
    const t = await setup();
    const llm = createFakeLlm([{ raw: "not json" }, ok("Corrected")]);
    const res = await generateSingle(t.env.scope, t.input(), llm);
    expect(res.ok).toBe(true);
    const rows = await rowsFor(t.env.project.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ok: false, failureKind: "invalid_output" });
    expect(rows[1]).toMatchObject({ ok: true, postId: res.ok ? res.postId : null });
  });

  it("a stub reporting null counts writes a row with NULL token columns, not 0", async () => {
    const t = await setup();
    const llm = {
      name: "openai" as const,
      model: "fake-model",
      async generate() {
        return {
          ok: true as const,
          value: { variants: { mock: { text: "Hi" } } },
          rawText: JSON.stringify({ variants: { mock: { text: "Hi" } } }),
          usage: { inputTokens: null, outputTokens: null },
          latencyMs: 5,
          provider: "openai" as const,
          model: "fake-model",
        };
      },
    };
    const res = await generateSingle(t.env.scope, t.input(), llm as never);
    expect(res.ok).toBe(true);
    const rows = await rowsFor(t.env.project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inputTokens).toBeNull();
    expect(rows[0]!.outputTokens).toBeNull();
  });

  it("a series plan has no series link; each written post carries its series_id and position", async () => {
    const t = await setup();
    const plan = await planSeries(t.env.scope, t.input({ count: 2 }), createFakeLlm([{ ok: { angles: [{ title: "A", description: "a" }, { title: "B", description: "b" }] } }]));
    expect(plan.ok).toBe(true);
    const planRows = await rowsFor(t.env.project.id);
    expect(planRows).toHaveLength(1);
    expect(planRows[0]).toMatchObject({ purpose: "generate.series_plan", seriesId: null, postId: null });

    if (!plan.ok) return;
    const { seriesId } = await startSeries(t.env.scope, t.input({ count: 2, angles: plan.angles }));
    await writeSeriesPost(t.env.scope, seriesId, 0, createFakeLlm([ok("Post A")]));
    await writeSeriesPost(t.env.scope, seriesId, 1, createFakeLlm([ok("Post B")]));
    const rows = await rowsFor(t.env.project.id);
    expect(rows).toHaveLength(3);
    const postRows = rows.filter((r) => r.purpose === "generate.series_post");
    expect(postRows).toHaveLength(2);
    expect(postRows.map((r) => r.seriesPosition).sort()).toEqual([0, 1]);
    for (const r of postRows) {
      expect(r.seriesId).toBe(seriesId);
      expect(r.postId).not.toBeNull();
    }
  });

  it("regenerate writes one row with post_id set — the post existed before the call", async () => {
    const t = await setup();
    const first = await generateSingle(t.env.scope, t.input(), createFakeLlm([ok()]));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const res = await regeneratePost(t.env.scope, first.postId, {}, createFakeLlm([ok("Regenerated")]));
    expect(res.ok).toBe(true);
    const rows = await rowsFor(t.env.project.id);
    const regenRows = rows.filter((r) => r.purpose === "generate.regenerate");
    expect(regenRows).toHaveLength(1);
    expect(regenRows[0]!.postId).toBe(first.postId);
  });

  it("tryVoice writes one row with every link null", async () => {
    const t = await setup();
    await tryVoice(
      t.env.scope,
      { brief: "Sale", accountIds: [t.account.id], versionId: t.profile.versionIds[0] },
      createFakeLlm([ok()]),
    );
    const rows = await rowsFor(t.env.project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: "voice.try", postId: null, seriesId: null, generationJobId: null });
  });

  it("runLlmCheck writes one row with every link null", async () => {
    const { scope, project } = await postsEnv();
    const aad = `project_llm_credential:${project.id}`;
    await createProjectLlmRepo(getDb(), project.id).save({
      provider: "openai",
      model: "fake-model",
      keyCiphertext: encryptSecret("sk-good", { aad }),
      updatedByUserId: null,
    });
    setLlmFactoryForTests(() => createFakeLlm([{ ok: { text: "Hello" } }]));
    const result = await checkProjectLlm(scope);
    expect(result.ok).toBe(true);
    const rows = await rowsFor(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: "llm.check", postId: null, seriesId: null, generationJobId: null });
  });

  it("over the group limit: no call is made, so no row is written", async () => {
    const t = await setup();
    const second = await accounts.connectMock(t.env.scope, { displayName: "Mock 2", settings: {} });
    await accounts.setPostingInstructions(t.env.scope, second.id, { instructions: "Different rules." });
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const a = await accounts.connectMock(t.env.scope, { displayName: `A${i}`, settings: {} });
      await accounts.setPostingInstructions(t.env.scope, a.id, { instructions: `Rules ${i}` });
      ids.push(a.id);
    }
    await expect(generateSingle(t.env.scope, t.input({ targetAccountIds: ids }), createFakeLlm([]))).rejects.toBeInstanceOf(
      ValidationIssuesError,
    );
    expect(await rowsFor(t.env.project.id)).toHaveLength(0);
  });

  it("generation not configured: no call is made, so no row is written", async () => {
    const t = await setup();
    await expect(generateSingle(t.env.scope, t.input())).rejects.toBeInstanceOf(LlmNotConfiguredError);
    expect(await rowsFor(t.env.project.id)).toHaveLength(0);
  });
});

describe("llm_call_usage: the job runner", () => {
  beforeEach(parkAllJobs);

  it("a 2-item batch job writes two rows carrying generation_job_id and generation_job_item_id", async () => {
    const e = await jobsEnv();
    const fake = createFakeLlm([modelOk("One", 1), modelOk("Two", 1)]);
    setLlmForTests(fake);
    await e.assets(2);
    const { jobId } = await createJob(e.scope, e.input());
    const tick = await runTick(tickConfig({ jobMaxItems: 2 }));
    expect(tick.generation.counts.done).toBe(2);
    const rows = await rowsFor(e.project.id);
    const jobRows = rows.filter((r) => r.purpose === "generate.job_item");
    expect(jobRows).toHaveLength(2);
    for (const r of jobRows) {
      expect(r.generationJobId).toBe(jobId);
      expect(r.generationJobItemId).not.toBeNull();
    }
  }, 60_000);

  it("a deferred correction retry writes two rows, each with its own called_at — the first is not rewritten", async () => {
    const e = await jobsEnv();
    const fake = createFakeLlm([{ raw: "not json", delayMs: 3000 }, modelOk("Corrected", 1)]);
    setLlmForTests(fake);
    await e.assets(1);
    await createJob(e.scope, e.input());
    const CONFIG = { timeBudgetMs: 4000, jobMinCallMs: 1000, jobPersistReserveMs: 500, jobMaxItems: 1 };
    const first = await runTick(tickConfig(CONFIG));
    expect(first.generation.counts).toMatchObject({ deferred: 1 });
    const afterFirst = await rowsFor(e.project.id);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({ ok: false, failureKind: "invalid_output" });

    const second = await runTick(tickConfig(CONFIG));
    expect(second.generation.counts).toMatchObject({ done: 1 });
    const afterSecond = await rowsFor(e.project.id);
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond[0]!.calledAt.getTime()).toBe(afterFirst[0]!.calledAt.getTime());
    expect(afterSecond[1]).toMatchObject({ ok: true });
    expect(afterSecond[1]!.calledAt.getTime()).not.toBe(afterSecond[0]!.calledAt.getTime());
  }, 60_000);

  it("held on billing: the next tick inside the interval makes no call, so writes nothing", async () => {
    const e = await jobsEnv();
    const fake = createFakeLlm([{ fail: "credit_exhausted" }]);
    setLlmForTests(fake);
    await e.assets(1);
    await createJob(e.scope, e.input());
    await runTick(tickConfig({ jobMaxItems: 1 }));
    const afterFirst = await rowsFor(e.project.id);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({ ok: false, failureKind: "credit_exhausted" });

    const held = await runTick(tickConfig({ jobMaxItems: 1 }));
    expect(held.generation.counts).toMatchObject({ claimed: 0 });
    expect(await rowsFor(e.project.id)).toHaveLength(1);
  }, 60_000);
});

describe("llm_call_usage: counts read back exactly", () => {
  it("equals the number of stub invocations — none missing, none doubled", async () => {
    const t = await setup();
    await generateSingle(t.env.scope, t.input(), createFakeLlm([ok("A")]));
    await generateSingle(t.env.scope, t.input(), createFakeLlm([ok("B")]));
    const summary = await t.env.scope.llmUsage.summary({ from: null, to: null });
    expect(summary.calls).toBe(2);
  });
});
