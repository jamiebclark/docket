import { afterAll, afterEach, describe, expect, it } from "vitest";

import * as media from "../../../src/server/services/media";
import * as mediaGenerate from "../../../src/server/services/media-generate";
import { setImageProviderForTests } from "../../../src/server/llm/image-provider";
import { imageFailureMessage } from "../../../src/server/llm/image-messages";
import { setStorageForTests } from "../../../src/server/storage";
import { LLM_FAILURE_KINDS } from "../../../src/server/llm/types";
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

async function setup() {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const env = await postsEnv();
  return { storage, ...env };
}

describe("generateImage", () => {
  it("generates an image and adds it to the library (happy path)", async () => {
    const { scope, storage } = await setup();
    setImageProviderForTests(createFakeImageProvider([{ bytes: await png(256, 256) }]));
    const result = await mediaGenerate.generateImage(scope, { prompt: "a cat on a roof", aspect: "square" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const asset = await media.getMedia(scope, result.mediaAssetId);
    expect(asset.generated).toMatchObject({ prompt: "a cat on a roof", provider: "openai", model: "fake-image-model" });
    expect(storage.objects.size).toBe(2);
  });

  it("defaults an omitted aspect to square", async () => {
    const { scope } = await setup();
    const provider = createFakeImageProvider([{ bytes: await png(256, 256) }]);
    setImageProviderForTests(provider);
    const result = await mediaGenerate.generateImage(scope, { prompt: "a cat on a roof" });
    expect(result).toMatchObject({ ok: true });
    expect(provider.requests[0]).toMatchObject({ aspect: "square" });
  });

  it("rejects an empty prompt before any provider call", async () => {
    const { scope } = await setup();
    setImageProviderForTests(createFakeImageProvider([]));
    await expect(mediaGenerate.generateImage(scope, { prompt: "   ", aspect: "square" })).rejects.toThrow();
  });

  it("rejects a prompt over 1000 characters before any provider call", async () => {
    const { scope } = await setup();
    setImageProviderForTests(createFakeImageProvider([]));
    await expect(mediaGenerate.generateImage(scope, { prompt: "x".repeat(1001), aspect: "square" })).rejects.toThrow();
  });

  it.each(LLM_FAILURE_KINDS)("returns the fixed sentence and writes nothing on a %s provider failure", async (kind) => {
    const { scope, storage } = await setup();
    setImageProviderForTests(createFakeImageProvider([{ fail: kind }]));
    const result = await mediaGenerate.generateImage(scope, { prompt: "a cat on a roof", aspect: "square" });
    expect(result).toEqual({ ok: false, message: imageFailureMessage(kind) });
    expect(storage.objects.size).toBe(0);
  });

  it("rejects oversized bytes from the provider without orphaning a storage object", async () => {
    const { scope, storage } = await setup();
    setImageProviderForTests(createFakeImageProvider([{ bytes: Buffer.alloc(21 * 1024 * 1024, 1) }]));
    const result = await mediaGenerate.generateImage(scope, { prompt: "a cat on a roof", aspect: "square" });
    expect(result.ok).toBe(false);
    expect(storage.objects.size).toBe(0);
  });
});
