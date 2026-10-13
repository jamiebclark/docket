import { afterAll, afterEach, describe, expect, it } from "vitest";

import { mediaConstraintsOf } from "../../../src/providers/media";
import { instagramProvider } from "../../../src/providers/instagram";
import { listProviders } from "../../../src/providers/registry";
import { setImageProviderForTests } from "../../../src/server/llm/image-provider";
import * as media from "../../../src/server/services/media";
import * as mediaGenerate from "../../../src/server/services/media-generate";
import { fitOf } from "../../../src/server/services/media-fit";
import { ensureVariant } from "../../../src/server/services/media-variants";
import * as posts from "../../../src/server/services/posts";
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

async function setup() {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const env = await postsEnv();
  const bytes = await png(1024, 1024);
  setImageProviderForTests(createFakeImageProvider([{ bytes }]));
  const result = await mediaGenerate.generateImage(env.scope, { prompt: "a cat on a roof", aspect: "square" });
  if (!result.ok) throw new Error("generation failed");
  const generated = await env.scope.media.get(result.mediaAssetId);
  if (!generated) throw new Error("generated asset missing");
  const uploaded = await media.uploadMedia(env.scope, { file: { name: "uploaded.png", bytes: await png(1024, 1024) } });
  if (!uploaded.ok) throw new Error("upload failed");
  const uploadedRow = await env.scope.media.get(uploaded.asset.id);
  if (!uploadedRow) throw new Error("uploaded asset missing");
  return { ...env, storage, generated, uploadedRow };
}

describe("a generated image is an ordinary asset", () => {
  it("has the same fit as an uploaded image of identical dimensions, format and byte size, for every registered provider", async () => {
    const t = await setup();
    expect(t.generated.width).toBe(t.uploadedRow.width);
    expect(t.generated.height).toBe(t.uploadedRow.height);
    expect(t.generated.mimeType).toBe(t.uploadedRow.mimeType);
    expect(t.generated.byteSize).toBe(t.uploadedRow.byteSize);
    for (const provider of listProviders()) {
      expect(fitOf(t.generated, provider)).toEqual(fitOf(t.uploadedRow, provider));
    }
  });

  it("gets a derived, cached variant for a provider whose constraints need one", async () => {
    const t = await setup();
    const constraints = mediaConstraintsOf(instagramProvider.capabilities);
    const first = await ensureVariant(t.scope, t.generated, constraints);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.variant).not.toBeNull();
    const second = await ensureVariant(t.scope, t.generated, constraints);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.variant?.id).toBe(first.variant?.id);
  });

  it("appears in the Unused filter and in a filename search", async () => {
    const t = await setup();
    const unusedIds = await t.scope.media.listIdsForSelection({ unusedOnly: true, limit: 100 });
    expect(unusedIds).toContain(t.generated.id);
    const found = await media.listMedia(t.scope, { q: "Generated image" });
    expect(found.items.map((i) => i.id)).toContain(t.generated.id);
  });

  it("can be attached to a post", async () => {
    const t = await setup();
    const account = await t.account();
    const draft = await posts.createDraft(t.scope, {
      baseText: "hello",
      targets: [{ accountId: account.id }],
      mediaIds: [t.generated.id],
    });
    expect(await t.scope.posts.listMediaIds(draft.post.id)).toEqual([t.generated.id]);
  });

  it("is never treated as a video", async () => {
    const t = await setup();
    const view = await media.getMedia(t.scope, t.generated.id);
    expect(view.kind).toBe("image");
    expect(view.video).toBeNull();
  });

  it("is deleted by deleteMedia, with its provenance gone with the row", async () => {
    const t = await setup();
    await media.deleteMedia(t.scope, t.generated.id);
    expect(await t.scope.media.get(t.generated.id)).toBeNull();
    await expect(media.getMedia(t.scope, t.generated.id)).rejects.toThrow();
  });
});
