import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { encryptSecret } from "../../../src/server/crypto/secrets";
import { getDb } from "../../../src/server/db/client";
import { createProjectLlmRepo } from "../../../src/server/dal/project-llm";
import { setLlmFactoryForTests, setLlmForTests } from "../../../src/server/llm";
import type { LlmConfig } from "../../../src/server/llm/config";
import type { LlmProvider, LlmRequest, LlmResult } from "../../../src/server/llm/types";
import { runTick } from "../../../src/server/scheduler";
import { generateSingle } from "../../../src/server/services/generation/single";
import { planSeries } from "../../../src/server/services/generation/series";
import { regeneratePost } from "../../../src/server/services/generation/regenerate";
import { tryVoice } from "../../../src/server/services/voice";
import { createJob } from "../../../src/server/services/jobs";
import { api, createKey } from "../../helpers/api";
import { closeDb } from "../../helpers/db";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { clearHolds, parkAllJobs } from "../../helpers/jobs-env";
import { createVoiceProfile } from "../../helpers/factories";
import { png } from "../../helpers/images";
import { postsEnv } from "../../helpers/posts-env";
import { createMemoryStorage, type MemoryStorage } from "../../helpers/storage";
import { setStorageForTests } from "../../../src/server/storage";

afterEach(() => {
  setLlmFactoryForTests(null);
  setLlmForTests(null);
});
afterAll(async () => {
  setStorageForTests(undefined);
  await clearHolds();
  await closeDb();
});

const aadFor = (projectId: string) => `project_llm_credential:${projectId}`;

async function saveCredential(projectId: string, apiKey: string) {
  const repo = createProjectLlmRepo(getDb(), projectId);
  await repo.save({
    provider: "openai",
    model: "fake-model",
    apiKeyEncrypted: encryptSecret(apiKey, { aad: aadFor(projectId) }),
    updatedByUserId: null,
  });
}

/** Records which project's key handled each call, by apiKey. Steps are queued per key before each call. */
function trackedFactory() {
  const calls: { apiKey: string; label: string }[] = [];
  const pending = new Map<string, FakeStep[]>();
  const queue = (apiKey: string, step: FakeStep) => pending.set(apiKey, [...(pending.get(apiKey) ?? []), step]);
  setLlmFactoryForTests((config: LlmConfig): LlmProvider => {
    const steps = pending.get(config.apiKey) ?? [];
    pending.delete(config.apiKey);
    const fake = createFakeLlm(steps.length > 0 ? steps : [{ fail: "unavailable" }]);
    return {
      name: fake.name,
      model: fake.model,
      async generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
        calls.push({ apiKey: config.apiKey, label: request.label });
        return fake.generate(request);
      },
    };
  });
  return { calls, queue };
}

const ok = (variants: Record<string, string>): FakeStep => ({
  ok: { variants: Object.fromEntries(Object.entries(variants).map(([k, text]) => [k, { text }])) },
});
const okWithImage = (variants: Record<string, string>): FakeStep => ({
  ok: { variants: Object.fromEntries(Object.entries(variants).map(([k, text]) => [k, { text }])), imageAltTexts: ["A photo"] },
});
const planOk = (count: number): FakeStep => ({
  ok: { angles: Array.from({ length: count }, (_, i) => ({ title: `Angle ${i + 1}`, description: `About ${i + 1}` })) },
});

async function setupProject(apiKey: string, storage: MemoryStorage) {
  const env = await postsEnv();
  await saveCredential(env.project.id, apiKey);
  const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Warm and direct." } });
  const account = await env.account();
  const bytes = await png(64, 64);
  async function asset() {
    const key = `projects/${env.project.id}/media/${randomUUID()}/original.png`;
    await storage.put(key, bytes, "image/png");
    return env.scope.media.insert({
      storageKey: key,
      publicUrl: storage.publicUrl(key),
      mimeType: "image/png",
      byteSize: bytes.length,
      width: 64,
      height: 64,
      altText: "A photo",
      tags: ["cats"],
    });
  }
  const input = (over: Record<string, unknown> = {}) => ({
    source: { kind: "media", selection: { mode: "unused" }, includeUsed: false },
    voiceProfileId: profile.id,
    template: "Write about this photo. Mention {{tags}}.",
    targetAccountIds: [account.id],
    confirmUnreviewedQueue: false,
    ...over,
  });
  return { ...env, profile, account, asset, input };
}

describe("per-project resolution (US1, AS2)", () => {
  it("resolves each generation path to the calling project's own stored credential", async () => {
    await parkAllJobs();
    const storage = createMemoryStorage();
    setStorageForTests(storage);
    const KEY_A = "sk-fake-project-A-0123456789";
    const KEY_B = "sk-fake-project-B-9876543210";
    const a = await setupProject(KEY_A, storage);
    const b = await setupProject(KEY_B, storage);
    const { calls, queue } = trackedFactory();

    // Single generation
    queue(KEY_A, ok({ mock: "A single post" }));
    const singleA = await generateSingle(a.scope, {
      requestId: randomUUID(),
      voiceProfileId: a.profile.id,
      brief: "Announce",
      targetAccountIds: [a.account.id],
    });
    queue(KEY_B, ok({ mock: "B single post" }));
    const singleB = await generateSingle(b.scope, {
      requestId: randomUUID(),
      voiceProfileId: b.profile.id,
      brief: "Announce",
      targetAccountIds: [b.account.id],
    });
    expect(singleA.ok && singleB.ok).toBe(true);

    // Series plan
    queue(KEY_A, planOk(3));
    await planSeries(a.scope, { voiceProfileId: a.profile.id, brief: "Launch", targetAccountIds: [a.account.id], count: 3 });
    queue(KEY_B, planOk(3));
    await planSeries(b.scope, { voiceProfileId: b.profile.id, brief: "Launch", targetAccountIds: [b.account.id], count: 3 });

    // Regenerate (reuses the post created above)
    queue(KEY_A, ok({ mock: "A regenerated post" }));
    await regeneratePost(a.scope, (singleA as { postId: string }).postId, {});
    queue(KEY_B, ok({ mock: "B regenerated post" }));
    await regeneratePost(b.scope, (singleB as { postId: string }).postId, {});

    // "Try it"
    queue(KEY_A, ok({ mock: "A try it" }));
    await tryVoice(a.scope, { brief: "Hi", accountIds: [a.account.id], versionId: a.profile.versionIds[0] });
    queue(KEY_B, ok({ mock: "B try it" }));
    await tryVoice(b.scope, { brief: "Hi", accountIds: [b.account.id], versionId: b.profile.versionIds[0] });

    // Public API generation
    const keyA = (await createKey(a.scope, ["read", "generate"])).secret;
    const keyB = (await createKey(b.scope, ["read", "generate"])).secret;
    queue(KEY_A, ok({ mock: "A api post" }));
    const apiA = await api("POST", "/generate", {
      key: keyA,
      body: { brief: "From the API", accountIds: [a.account.id], voiceProfileId: a.profile.id },
    });
    expect(apiA.status).toBe(201);
    queue(KEY_B, ok({ mock: "B api post" }));
    const apiB = await api("POST", "/generate", {
      key: keyB,
      body: { brief: "From the API", accountIds: [b.account.id], voiceProfileId: b.profile.id },
    });
    expect(apiB.status).toBe(201);

    // Job item
    await a.asset();
    await b.asset();
    const { jobId: jobIdA } = await createJob(a.scope, a.input());
    const { jobId: jobIdB } = await createJob(b.scope, b.input());
    queue(KEY_A, okWithImage({ mock: "A job item post" }));
    queue(KEY_B, okWithImage({ mock: "B job item post" }));
    for (let i = 0; i < 10; i++) {
      const [ia, ib] = await Promise.all([a.scope.jobItems.countByStatus(jobIdA), b.scope.jobItems.countByStatus(jobIdB)]);
      if (ia.queued + ia.running === 0 && ib.queued + ib.running === 0) break;
      await runTick({ config: { jobMaxItems: 5 } });
    }

    const byKey = (key: string) => calls.filter((c) => c.apiKey === key);
    const otherKey = (key: string) => calls.filter((c) => c.apiKey !== key && c.apiKey !== "");

    expect(byKey(KEY_A).length).toBeGreaterThanOrEqual(6);
    expect(byKey(KEY_B).length).toBeGreaterThanOrEqual(6);
    // Every call recorded came from exactly one of the two projects' own keys — never the other's.
    expect(calls.every((c) => c.apiKey === KEY_A || c.apiKey === KEY_B)).toBe(true);
    expect(otherKey(KEY_A).every((c) => c.apiKey === KEY_B)).toBe(true);

    const jobA = (await a.scope.jobs.get(jobIdA))!;
    const jobB = (await b.scope.jobs.get(jobIdB))!;
    expect(jobA.status).toBe("completed");
    expect(jobB.status).toBe("completed");
  });
});
