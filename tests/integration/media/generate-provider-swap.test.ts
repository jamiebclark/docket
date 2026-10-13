import { afterAll, afterEach, describe, expect, it } from "vitest";

import * as media from "../../../src/server/services/media";
import * as mediaGenerate from "../../../src/server/services/media-generate";
import { setImageProviderForTests } from "../../../src/server/llm/image-provider";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
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

/**
 * A stub `ImageProvider` carrying none of OpenAI's vocabulary (no pixel size, output format, or
 * response field name) still produces a complete asset, proving the generator holds no vendor
 * knowledge above the adapter boundary (SC-007).
 */
function stubProvider(bytes: Buffer) {
  return {
    name: "openai" as const,
    model: "stub-image-model",
    async generate() {
      return {
        ok: true as const,
        bytes,
        mimeType: "image/png",
        usage: { inputTokens: null, outputTokens: null },
        latencyMs: 1,
        provider: "openai" as const,
        model: "stub-image-model",
      };
    },
  };
}

describe("generateImage with a non-OpenAI stub provider", () => {
  it("produces a complete asset with provenance via an arbitrary ImageProvider", async () => {
    const storage = createMemoryStorage();
    setStorageForTests(storage);
    const { scope } = await postsEnv();
    setImageProviderForTests(stubProvider(await png(256, 144)));

    const result = await mediaGenerate.generateImage(scope, { prompt: "a lighthouse at dusk", aspect: "landscape" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const asset = await media.getMedia(scope, result.mediaAssetId);
    expect(asset.generated).toMatchObject({ prompt: "a lighthouse at dusk", provider: "openai", model: "stub-image-model" });
    expect(storage.objects.size).toBe(2);
  });
});
