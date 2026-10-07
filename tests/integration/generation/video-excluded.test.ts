// A video is never sent to the model and never a generator item (018 FR-045).
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { imagesForModel } from "../../../src/server/llm/images";
import { mediaSource } from "../../../src/server/services/jobs/sources/media";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";
import { createMemoryStorage } from "../../helpers/storage";
import { createMediaAsset } from "../../helpers/scheduling";

afterEach(() => setStorageForTests(undefined));
afterAll(closeDb);

describe("videos and the generator", () => {
  it("imagesForModel drops video rows", async () => {
    setStorageForTests(createMemoryStorage());
    const env = await postsEnv();
    const asset = await createMediaAsset(env.scope.project.id);
    const row = (await env.scope.media.getMany([asset.id]))[0]!;
    const res = await imagesForModel(env.scope, [{ ...row, kind: "video" }]);
    expect(res).toEqual({ ok: true, images: [], record: [] });
  });

  it("the media source skips a picked video", async () => {
    const env = await postsEnv();
    const asset = await createMediaAsset(env.scope.project.id);
    const row = (await env.scope.media.getMany([asset.id]))[0]!;
    const picked = { ...row, kind: "video" as const };
    const scope = { ...env.scope, media: { ...env.scope.media, getMany: async () => [picked] } } as typeof env.scope;
    const out = await mediaSource.prepare(scope, { selection: { mode: "pick", ids: [asset.id] }, includeUsed: false }, {});
    expect(out.items).toHaveLength(0);
  });
});
