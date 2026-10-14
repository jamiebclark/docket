import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { encryptSecret } from "../../../src/server/crypto/secrets";
import { createProjectLlmRepo } from "../../../src/server/dal/project-llm";
import { ForbiddenError } from "../../../src/server/dal/errors";
import { getDb } from "../../../src/server/db/client";
import { llmCallUsage, type LlmCallUsageRow } from "../../../src/server/db/schema";
import type { ImageProvider, ImageProviderResult } from "../../../src/server/llm/image-provider";
import { setImageProviderForTests } from "../../../src/server/llm/image-provider";
import { createImageGenerator, generateImage } from "../../../src/server/services/media-generate";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakeImageProvider } from "../../helpers/fake-image";
import { png } from "../../helpers/images";
import { postsEnv } from "../../helpers/posts-env";
import { createMemoryStorage } from "../../helpers/storage";

afterAll(async () => {
  setStorageForTests(undefined);
  setImageProviderForTests(null);
  await closeDb();
});
afterEach(() => {
  setStorageForTests(undefined);
  setImageProviderForTests(null);
});

async function rowsFor(projectId: string): Promise<LlmCallUsageRow[]> {
  return getDb().select().from(llmCallUsage).where(eq(llmCallUsage.projectId, projectId)).orderBy(llmCallUsage.calledAt);
}

async function setup() {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const env = await postsEnv();
  return { storage, ...env };
}

const reportingProvider = (result: ImageProviderResult): ImageProvider => ({
  name: "openai",
  model: result.model,
  async generate() {
    return result;
  },
});

describe("llm_call_usage: image generation (US5)", () => {
  it("writes one row for a successful call, with token counts when the stub reports them", async () => {
    const t = await setup();
    setImageProviderForTests(
      reportingProvider({
        ok: true,
        bytes: await png(256, 256),
        mimeType: "image/png",
        usage: { inputTokens: 12, outputTokens: 34 },
        latencyMs: 5,
        provider: "openai",
        model: "fake-image-model",
      }),
    );
    const result = await generateImage(t.scope, { prompt: "a cat", aspect: "square" });
    expect(result.ok).toBe(true);
    const rows = await rowsFor(t.project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: "image.generate",
      provider: "openai",
      model: "fake-image-model",
      ok: true,
      failureKind: null,
      credentialSource: "install",
      inputTokens: 12,
      outputTokens: 34,
    });
  });

  it("writes a failed row with null token counts when the stub reports none, never zero", async () => {
    const t = await setup();
    setImageProviderForTests(createFakeImageProvider([{ fail: "unavailable" }]));
    const result = await generateImage(t.scope, { prompt: "a cat", aspect: "square" });
    expect(result.ok).toBe(false);
    const rows = await rowsFor(t.project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: "image.generate", ok: false, failureKind: "unavailable" });
    expect(rows[0]!.inputTokens).toBeNull();
    expect(rows[0]!.outputTokens).toBeNull();
  });

  it("writes no row when there is no storage", async () => {
    const env = await postsEnv();
    const result = await generateImage(env.scope, { prompt: "a cat", aspect: "square" });
    expect(result.ok).toBe(false);
    expect(await rowsFor(env.project.id)).toHaveLength(0);
  });

  it("writes no row when no image provider is configured", async () => {
    const t = await setup();
    const result = await generateImage(t.scope, { prompt: "a cat", aspect: "square" });
    expect(result.ok).toBe(false);
    expect(await rowsFor(t.project.id)).toHaveLength(0);
  });

  it("writes no row for an over-length prompt", async () => {
    const t = await setup();
    setImageProviderForTests(createFakeImageProvider([]));
    await expect(generateImage(t.scope, { prompt: "a".repeat(1001), aspect: "square" })).rejects.toThrow();
    expect(await rowsFor(t.project.id)).toHaveLength(0);
  });

  it("writes no row for an editor", async () => {
    const t = await setup();
    setImageProviderForTests(createFakeImageProvider([]));
    const editorScope = await t.as(t.editor);
    await expect(generateImage(editorScope, { prompt: "a cat", aspect: "square" })).rejects.toThrow(ForbiddenError);
    expect(await rowsFor(t.project.id)).toHaveLength(0);
  });

  it("writes no row for a cross-project request", async () => {
    const a = await setup();
    const b = await postsEnv();
    setImageProviderForTests(createFakeImageProvider([]));
    const generator = createImageGenerator(a.scope);
    await expect(generator.generate({ projectId: b.project.id, prompt: "a cat", aspect: "square" })).rejects.toThrow(ForbiddenError);
    expect(await rowsFor(a.project.id)).toHaveLength(0);
    expect(await rowsFor(b.project.id)).toHaveLength(0);
  });

  it("writes no row for an undecryptable key", async () => {
    const prevEnv = { ...process.env };
    process.env.LLM_IMAGE_PROVIDER = "openai";
    process.env.LLM_IMAGE_MODEL = "install-image-model";
    process.env.OPENAI_API_KEY = "sk-install-image-key";
    try {
      const t = await setup();
      await createProjectLlmRepo(getDb(), t.project.id).save({
        provider: "openai",
        model: "fake-model",
        // Encrypted under a different project's AAD, so this project can never decrypt it.
        keyCiphertext: encryptSecret("sk-project-image-key", { aad: "project_llm_credential:00000000-0000-0000-0000-000000000000" }),
        updatedByUserId: null,
      });
      const result = await generateImage(t.scope, { prompt: "a cat", aspect: "square" });
      expect(result.ok).toBe(false);
      expect(await rowsFor(t.project.id)).toHaveLength(0);
    } finally {
      process.env = prevEnv;
    }
  });
});
