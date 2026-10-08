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

  it("cuts a 6-minute video to the 5-minute limit instead of refusing it, and addToQueue gets past validation", async () => {
    const { env, account } = await setup();
    const v = await createVideoAsset(env.project.id, { width: 1080, height: 1920, durationSeconds: 360 });
    const res = await posts.checkComposition(env.scope, { baseText: "Hello", mediaIds: [v.id], targets: [{ accountId: account.id }] });
    const t = res.targets[0]!;
    // Was a refusal ("6 minutes long; the limit is 5 minutes for Threads"); the formatter now cuts it.
    expect(t.canSchedule).toBe(true);
    expect(t.issues.find((i) => i.code === "video_too_long")).toBeUndefined();
    expect(t.issues.some((i) => i.severity === "info" && i.message.includes("cut to the first 5:00"))).toBe(true);

    const draft = await posts.createDraft(env.scope, { baseText: "Hello", mediaIds: [v.id], targets: [{ accountId: account.id }] });
    const queued = await posts.addToQueue(env.scope, draft.post.id);
    // It passes validation; this account simply has no posting slots.
    expect(queued[0]).toMatchObject({ ok: false, code: "no_active_slots" });
  });
});
