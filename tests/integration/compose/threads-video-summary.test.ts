import { afterAll, describe, expect, it } from "vitest";
import * as accounts from "../../../src/server/services/accounts";
import * as posts from "../../../src/server/services/posts";
import { closeDb } from "../../helpers/db";
import { createVideoAsset } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";

afterAll(closeDb);

async function setup() {
  const env = await postsEnv();
  const account = await accounts.saveConnectedAccount(env.scope, {
    providerKey: "threads",
    externalAccountId: `t-${Math.random().toString(36).slice(2, 8)}`,
    displayName: "@threads",
    settings: {},
  });
  return { env, account };
}

describe("composer check for one video and a Threads account", () => {
  it("returns the video limits and no post type choice", async () => {
    const { env, account } = await setup();
    const v = await createVideoAsset(env.project.id, { width: 1080, height: 1920 });
    const res = await posts.checkComposition(env.scope, { baseText: "Hello", mediaIds: [v.id], targets: [{ accountId: account.id }] });
    const t = res.targets[0]!;
    expect(t.postType).toBe("video");
    expect(t.postTypeChoice).toBeNull();
    expect(t.requirements?.video).toMatchObject({ maxVideos: 1, postType: null });
    expect(t.requirements?.video.maxBytes?.label).toBe("1 GB");
    expect(t.requirements?.video.duration.max?.label).toBe("5 minutes");
    expect(t.canSchedule).toBe(true);
  });

  it("refuses a 6-minute video with the duration message, and addToQueue fails with validation", async () => {
    const { env, account } = await setup();
    const v = await createVideoAsset(env.project.id, { width: 1080, height: 1920, durationSeconds: 360 });
    const res = await posts.checkComposition(env.scope, { baseText: "Hello", mediaIds: [v.id], targets: [{ accountId: account.id }] });
    const t = res.targets[0]!;
    expect(t.canSchedule).toBe(false);
    const issue = t.issues.find((i) => i.code === "video_too_long");
    expect(issue?.message).toContain("6 minutes long; the limit is 5 minutes for Threads");

    const draft = await posts.createDraft(env.scope, { baseText: "Hello", mediaIds: [v.id], targets: [{ accountId: account.id }] });
    const queued = await posts.addToQueue(env.scope, draft.post.id);
    expect(queued[0]).toMatchObject({ ok: false, code: "validation" });
  });
});
