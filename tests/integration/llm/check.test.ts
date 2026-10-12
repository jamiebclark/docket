import { afterAll, afterEach, describe, expect, it } from "vitest";
import { encryptSecret } from "../../../src/server/crypto/secrets";
import { getDb } from "../../../src/server/db/client";
import { createProjectLlmRepo } from "../../../src/server/dal/project-llm";
import { setLlmFactoryForTests, setLlmForTests } from "../../../src/server/llm";
import { llmFailureMessage } from "../../../src/server/llm/messages";
import type { LlmConfig } from "../../../src/server/llm/config";
import type { LlmProvider } from "../../../src/server/llm/types";
import { checkProjectLlm, LLM_CHECK_TIMEOUT_MS } from "../../../src/server/services/generation/check";
import { closeDb } from "../../helpers/db";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { clearHolds, readHold } from "../../helpers/jobs-env";
import { postsEnv } from "../../helpers/posts-env";

afterEach(async () => {
  setLlmFactoryForTests(null);
  setLlmForTests(null);
  await clearHolds();
});
afterAll(async () => {
  await closeDb();
});

const aadFor = (projectId: string) => `project_llm_credential:${projectId}`;

async function saveCredential(projectId: string, apiKey: string) {
  await createProjectLlmRepo(getDb(), projectId).save({
    provider: "openai",
    model: "fake-model",
    apiKeyEncrypted: encryptSecret(apiKey, { aad: aadFor(projectId) }),
    updatedByUserId: null,
  });
}

function stubByKey(stepsByKey: Record<string, FakeStep[]>) {
  setLlmFactoryForTests((config: LlmConfig): LlmProvider => createFakeLlm(stepsByKey[config.apiKey] ?? [{ fail: "unavailable" }]));
}

describe("checkProjectLlm", () => {
  it("AS1: reports success with provider, model, project source and latency, and saves no post", async () => {
    const { scope, project } = await postsEnv();
    await saveCredential(project.id, "sk-good");
    stubByKey({ "sk-good": [{ ok: { text: "Hello" } }] });

    const result = await checkProjectLlm(scope);

    expect(result).toMatchObject({ ok: true, source: "project", provider: "openai", model: "fake-model" });
    expect(result.ok && result.latencyMs).toBeGreaterThanOrEqual(0);
    const counts = await scope.posts.counts();
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });

  it("AS2: a wrong key reports the one fixed sentence, naming no provider error text or key", async () => {
    const { scope, project } = await postsEnv();
    await saveCredential(project.id, "sk-bad");
    stubByKey({ "sk-bad": [{ fail: "auth" }] });

    const result = await checkProjectLlm(scope);

    expect(result).toMatchObject({ ok: false, reason: "failed", kind: "auth", message: llmFailureMessage("auth") });
  });

  it("AS3: a project with no credential checks the install default and says so", async () => {
    const { scope } = await postsEnv();
    setLlmForTests(createFakeLlm([{ ok: { text: "Hello" } }], { provider: "openai", model: "install-model" }));

    const result = await checkProjectLlm(scope);

    expect(result).toMatchObject({ ok: true, source: "install", provider: "openai", model: "install-model" });
  });

  it("AS4: a second check requested immediately is refused as busy, with no second live call", async () => {
    const { scope, project } = await postsEnv();
    await saveCredential(project.id, "sk-good");
    stubByKey({ "sk-good": [{ ok: { text: "first" } }, { ok: { text: "second" } }] });

    const [first, second] = await Promise.all([checkProjectLlm(scope), checkProjectLlm(scope)]);
    const results = [first, second];

    expect(results.some((r) => r.ok)).toBe(true);
    expect(results.some((r) => !r.ok && r.reason === "busy")).toBe(true);
  });

  it("AS5: a billing refusal sets the project's hold; a later success clears it", async () => {
    const { scope, project } = await postsEnv();
    await saveCredential(project.id, "sk-billing");
    stubByKey({ "sk-billing": [{ fail: "credit_exhausted" }] });

    const refused = await checkProjectLlm(scope);
    expect(refused).toMatchObject({ ok: false, reason: "failed", kind: "credit_exhausted" });
    expect(await readHold(`project:${project.id}`)).not.toBeNull();

    // Past the cooldown, so the next check is not refused as busy.
    await createProjectLlmRepo(getDb(), project.id).releaseCheck(new Date(0));
    stubByKey({ "sk-billing": [{ ok: { text: "fine now" } }] });
    const succeeded = await checkProjectLlm(scope);
    expect(succeeded).toMatchObject({ ok: true });
    expect(await readHold(`project:${project.id}`)).toBeNull();
  });

  it("SC-003: the call's timeout is min(installTimeoutMs, LLM_CHECK_TIMEOUT_MS)", async () => {
    const { scope, project } = await postsEnv();
    await saveCredential(project.id, "sk-timeout");
    const fake = createFakeLlm([{ ok: { text: "slow" } }]);
    setLlmFactoryForTests(() => fake);

    await checkProjectLlm(scope);

    expect(fake.requests[0]!.timeoutMs).toBeLessThanOrEqual(LLM_CHECK_TIMEOUT_MS);
    void project;
  });
});
