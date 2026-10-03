import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PostContent, SocialProvider } from "../../../src/providers/types";
import { createSchedulingRepos } from "../../../src/server/dal/scope";
import { runTick } from "../../../src/server/scheduler";
import { prepareVariants } from "../../../src/server/services/media-variants";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb, testDb } from "../../helpers/db";
import { createProject } from "../../helpers/factories";
import { png } from "../../helpers/images";
import { instagramLikeProvider, registerTestProvider } from "../../helpers/provider-fixtures";
import { createDueTarget, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage } from "../../helpers/storage";

const received: PostContent[] = [];
const spy: SocialProvider = {
  ...instagramLikeProvider,
  key: "spy-media",
  displayName: "Spy",
  advance: async (ctx) => {
    received.push(ctx.content);
    return { kind: "done", externalId: "x-1" };
  },
};
registerTestProvider(spy);

beforeEach(async () => {
  received.length = 0;
  await parkAllDueTargets();
});
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

async function setup(storeOriginal = true) {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const project = await createProject();
  const repos = createSchedulingRepos(testDb(), project.id);
  const account = await createMockAccount(project.id, {}, { providerKey: "spy-media" });
  const body = await png(1000, 1000);
  const key = `projects/${project.id}/media/a/original.png`;
  if (storeOriginal) await storage.put(key, body, "image/png");
  const asset = await repos.media.insert({
    storageKey: key,
    publicUrl: storage.publicUrl(key),
    mimeType: "image/png",
    byteSize: body.length,
    width: 1000,
    height: 1000,
  });
  const { post, target } = await createDueTarget(project.id, account.id);
  await repos.posts.setMedia(post.id, [asset.id]);
  return { storage, project, repos, asset, post, target };
}

describe("publishing with adapted media", () => {
  it("regenerates a vanished variant before the provider is called", async () => {
    const t = await setup();
    await prepareVariants({ ...t.repos, project: { id: t.project.id } }, t.post.id);
    const [v] = await t.repos.media.listVariants(t.asset.id);
    await t.storage.delete(v!.storageKey);
    const result = await runTick({ config: {} });
    expect(result.publishing.counts).toMatchObject({ done: 1 });
    expect(await t.storage.exists(v!.storageKey)).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]!.media[0]).toMatchObject({ mimeType: "image/jpeg", url: v!.publicUrl });
  });

  it("fails the target with no provider call when the original is gone", async () => {
    const t = await setup();
    await t.repos.media.softDelete(t.asset.id, new Date());
    await runTick({ config: {} });
    expect(received).toHaveLength(0);
    const row = await t.repos.targets.get(t.target.id);
    expect(row).toMatchObject({ status: "failed" });
    expect(row!.lastError).toBe("Image 1 is no longer available.");
  });
});
