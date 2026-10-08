import { afterAll, describe, expect, it } from "vitest";
import * as posts from "../../../src/server/services/posts";
import { closeDb } from "../../helpers/db";
import { createVideoAsset } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";
import { createMockAccount } from "../../helpers/scheduling";

afterAll(closeDb);

async function setup() {
  const env = await postsEnv();
  const account = await createMockAccount(env.project.id, {}, { providerKey: "instagram" });
  const video = await createVideoAsset(env.project.id, { width: 1080, height: 1920 });
  const draft = await posts.createDraft(env.scope, {
    baseText: "base",
    mediaIds: [video.id],
    targets: [{ accountId: account.id, postType: "reel" }],
  });
  const stored = async () => (await env.scope.targets.listForPost(draft.post.id))[0]!.chosenPostType;
  return { env, account, video, draft, stored };
}

describe("post type on update", () => {
  it("stores the choice at creation", async () => {
    const { stored } = await setup();
    expect(await stored()).toBe("reel");
  });

  it("keeps the stored choice when postType is absent", async () => {
    const { env, account, draft, stored } = await setup();
    await posts.updatePost(env.scope, draft.post.id, { targets: [{ accountId: account.id, overrideText: "new" }] });
    expect(await stored()).toBe("reel");
  });

  it("sets a new value and clears it with null", async () => {
    const { env, account, draft, stored } = await setup();
    await posts.updatePost(env.scope, draft.post.id, { targets: [{ accountId: account.id, postType: "video" }] });
    expect(await stored()).toBe("video");
    await posts.updatePost(env.scope, draft.post.id, { targets: [{ accountId: account.id, postType: null }] });
    expect(await stored()).toBeNull();
  });

  it("refuses a value the provider does not offer", async () => {
    const { env, account, draft, stored } = await setup();
    await expect(
      posts.updatePost(env.scope, draft.post.id, { targets: [{ accountId: account.id, postType: "story" }] }),
    ).rejects.toThrow(/video, reel/);
    expect(await stored()).toBe("reel");
  });

  it("updatePostVariants keeps the choice", async () => {
    const { env, account, draft, stored } = await setup();
    await posts.updatePostVariants(env.scope, draft.post.id, { edits: [{ accountIds: [account.id], text: "variant" }] });
    expect(await stored()).toBe("reel");
  });
});
