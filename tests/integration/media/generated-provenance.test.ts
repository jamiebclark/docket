import { afterAll, afterEach, describe, expect, it } from "vitest";

import { getDb } from "../../../src/server/db/client";
import { mediaAssets } from "../../../src/server/db/schema";
import { setImageProviderForTests } from "../../../src/server/llm/image-provider";
import * as media from "../../../src/server/services/media";
import * as mediaGenerate from "../../../src/server/services/media-generate";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
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

describe("generated provenance (US5)", () => {
  it("holds the prompt as typed after trimming, the provider, the model and generated_at", async () => {
    const t = await setup();
    setImageProviderForTests(createFakeImageProvider([{ bytes: await png(512, 512) }], { provider: "openai", model: "fake-image-model" }));
    const at = new Date("2026-02-01T10:00:00Z");
    const result = await atTime(at, () =>
      mediaGenerate.generateImage(t.scope, { prompt: "  a cat on a roof  ", aspect: "square" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await t.scope.media.get(result.mediaAssetId);
    expect(row).not.toBeNull();
    expect(row!.generationPrompt).toBe("a cat on a roof");
    expect(row!.generationProvider).toBe("openai");
    expect(row!.generationModel).toBe("fake-image-model");
    expect(row!.generatedAt?.getTime()).toBe(at.getTime());

    const view = await media.getMedia(t.scope, result.mediaAssetId);
    expect(view.generated).toEqual({ prompt: "a cat on a roof", provider: "openai", model: "fake-image-model", at });
  });

  it("leaves an uploaded asset's four provenance columns null, and no generated badge", async () => {
    const t = await setup();
    const uploaded = await media.uploadMedia(t.scope, { file: { name: "uploaded.png", bytes: await png(256, 256) } });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;
    const row = await t.scope.media.get(uploaded.asset.id);
    expect(row).not.toBeNull();
    expect(row!.generatedAt).toBeNull();
    expect(row!.generationPrompt).toBeNull();
    expect(row!.generationProvider).toBeNull();
    expect(row!.generationModel).toBeNull();
    const view = await media.getMedia(t.scope, uploaded.asset.id);
    expect(view.generated).toBeNull();
  });

  it("rejects a hand-built insert setting three of the four provenance columns", async () => {
    const t = await setup();
    await expect(
      getDb()
        .insert(mediaAssets)
        .values({
          projectId: t.project.id,
          storageKey: "k",
          publicUrl: "u",
          mimeType: "image/png",
          byteSize: 10,
          generatedAt: new Date(),
          generationPrompt: "a cat",
          generationProvider: "openai",
        }),
    ).rejects.toThrow();
  });

  it("isolates a generated asset and its prompt from another project by list, search, direct get and provenance read", async () => {
    const a = await setup();
    const b = await postsEnv();
    setImageProviderForTests(createFakeImageProvider([{ bytes: await png(256, 256) }]));
    const result = await mediaGenerate.generateImage(a.scope, { prompt: "a unique prompt phrase", aspect: "square" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const list = await media.listMedia(b.scope);
    expect(list.items.map((i) => i.id)).not.toContain(result.mediaAssetId);

    const found = await media.listMedia(b.scope, { q: "Generated image" });
    expect(found.items.map((i) => i.id)).not.toContain(result.mediaAssetId);

    expect(await b.scope.media.get(result.mediaAssetId)).toBeNull();
    await expect(media.getMedia(b.scope, result.mediaAssetId)).rejects.toThrow();
  });
});
