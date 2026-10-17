import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { LLM_KEY_UNREADABLE } from "../../../src/lib/generation/llm-source";
import { encryptSecret } from "../../../src/server/crypto/secrets";
import * as creditHolds from "../../../src/server/dal/credit-holds";
import { INSTALL_CREDENTIAL_OWNER, projectCredentialOwner } from "../../../src/server/dal/credential-owners";
import { getDb } from "../../../src/server/db/client";
import { createProjectLlmRepo } from "../../../src/server/dal/project-llm";
import type { ImageProvider } from "../../../src/server/llm/image-provider";
import { setImageProviderForTests, setImageProviderFactoryForTests } from "../../../src/server/llm/image-provider";
import * as mediaGenerate from "../../../src/server/services/media-generate";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createFakeImageProvider } from "../../helpers/fake-image";
import { png } from "../../helpers/images";
import { readHold, seedCreditHold } from "../../helpers/jobs-env";
import { postsEnv } from "../../helpers/posts-env";
import { createMemoryStorage } from "../../helpers/storage";

afterEach(async () => {
  setImageProviderForTests(null);
  setImageProviderFactoryForTests(null);
  setStorageForTests(undefined);
  vi.restoreAllMocks();
});
afterAll(async () => {
  await closeDb();
});

async function setup() {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const env = await postsEnv();
  return { storage, ...env };
}

const aadFor = (projectId: string) => `project_llm_credential:${projectId}`;

async function saveCredential(projectId: string, apiKey: string) {
  await createProjectLlmRepo(getDb(), projectId).save({
    provider: "openai",
    model: "fake-model",
    keyCiphertext: encryptSecret(apiKey, { aad: aadFor(projectId) }),
    updatedByUserId: null,
  });
}

describe("image credit hold (US3)", () => {
  it("writes an install hold on credit_exhausted and returns the fixed sentence", async () => {
    const { scope } = await setup();
    setImageProviderForTests(createFakeImageProvider([{ fail: "credit_exhausted" }]));
    const result = await mediaGenerate.generateImage(scope, { prompt: "a cat", aspect: "square" });
    expect(result.ok).toBe(false);
    expect(await readHold(INSTALL_CREDENTIAL_OWNER)).not.toBeNull();
  });

  it("refreshes last_refusal_at and next_probe_at on a second refusal, without moving held_since", async () => {
    const { scope } = await setup();
    const heldSince = new Date("2026-01-01T00:00:00Z");
    await seedCreditHold(INSTALL_CREDENTIAL_OWNER, { heldSince, nextProbeAt: new Date("2026-01-01T00:05:00Z") });

    setImageProviderForTests(createFakeImageProvider([{ fail: "credit_exhausted" }]));
    const t1 = new Date("2026-01-01T00:10:00Z");
    await atTime(t1, () => mediaGenerate.generateImage(scope, { prompt: "a cat", aspect: "square" }));

    const hold = await readHold(INSTALL_CREDENTIAL_OWNER);
    expect(hold).not.toBeNull();
    expect(hold!.heldSince.getTime()).toBe(heldSince.getTime());
    expect(hold!.lastRefusalAt.getTime()).toBe(t1.getTime());
    expect(hold!.nextProbeAt.getTime()).toBeGreaterThan(t1.getTime());
  });

  it("clears an existing hold on a success", async () => {
    const { scope } = await setup();
    await seedCreditHold(INSTALL_CREDENTIAL_OWNER, { heldSince: new Date(), nextProbeAt: new Date() });
    setImageProviderForTests(createFakeImageProvider([{ bytes: await png(256, 256) }]));

    const result = await mediaGenerate.generateImage(scope, { prompt: "a cat", aspect: "square" });
    expect(result.ok).toBe(true);
    expect(await readHold(INSTALL_CREDENTIAL_OWNER)).toBeNull();
  });

  it("swallows a hold-write failure: a successful generation still returns ok and keeps its asset", async () => {
    const { scope, storage } = await setup();
    vi.spyOn(creditHolds, "clearCreditHold").mockRejectedValue(new Error("db is down"));
    setImageProviderForTests(createFakeImageProvider([{ bytes: await png(256, 256) }]));

    const result = await mediaGenerate.generateImage(scope, { prompt: "a cat", aspect: "square" });
    expect(result).toMatchObject({ ok: true });
    expect(storage.objects.size).toBe(2);
  });

  it("writes the hold for a project's own credential and spends that project's key, not the install's", async () => {
    const prevEnv = { ...process.env };
    process.env.LLM_IMAGE_PROVIDER = "openai";
    process.env.LLM_IMAGE_MODEL = "install-image-model";
    process.env.OPENAI_API_KEY = "sk-install-image-key";
    try {
      const { scope, project } = await setup();
      const PROJECT_KEY = "sk-project-image-key";
      await saveCredential(project.id, PROJECT_KEY);

      const seenKeys: string[] = [];
      setImageProviderFactoryForTests((config): ImageProvider => {
        seenKeys.push(config.apiKey);
        return createFakeImageProvider([{ fail: "credit_exhausted" }], { provider: config.provider, model: config.model });
      });

      const result = await mediaGenerate.generateImage(scope, { prompt: "a cat", aspect: "square" });
      expect(result.ok).toBe(false);
      expect(seenKeys).toEqual([PROJECT_KEY]);
      expect(await readHold(projectCredentialOwner(project.id))).not.toBeNull();
      expect(await readHold(INSTALL_CREDENTIAL_OWNER)).toBeNull();
    } finally {
      process.env = prevEnv;
    }
  });

  it("refuses an undecryptable project key with LLM_KEY_UNREADABLE and never falls back to the install key", async () => {
    const prevEnv = { ...process.env };
    process.env.LLM_IMAGE_PROVIDER = "openai";
    process.env.LLM_IMAGE_MODEL = "install-image-model";
    process.env.OPENAI_API_KEY = "sk-install-image-key";
    try {
      const { scope, project } = await setup();
      await createProjectLlmRepo(getDb(), project.id).save({
        provider: "openai",
        model: "fake-model",
        // Encrypted under a different project's AAD, so this project can never decrypt it.
        keyCiphertext: encryptSecret("sk-project-image-key", { aad: aadFor("00000000-0000-0000-0000-000000000000") }),
        updatedByUserId: null,
      });

      const seenKeys: string[] = [];
      setImageProviderFactoryForTests((config): ImageProvider => {
        seenKeys.push(config.apiKey);
        return createFakeImageProvider([{ bytes: Buffer.alloc(0) }], { provider: config.provider, model: config.model });
      });

      const result = await mediaGenerate.generateImage(scope, { prompt: "a cat", aspect: "square" });
      expect(result).toEqual({ ok: false, message: LLM_KEY_UNREADABLE });
      expect(seenKeys).toEqual([]);
    } finally {
      process.env = prevEnv;
    }
  });
});
