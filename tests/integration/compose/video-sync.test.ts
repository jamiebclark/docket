import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../../../src/server/db/client";
import { videoVersions } from "../../../src/server/db/schema";
import * as posts from "../../../src/server/services/posts";
import { approvePost } from "../../../src/server/services/review";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createPostInReview, createVideoAsset } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";

afterAll(closeDb);

const BEFORE = new Date("2026-10-01T12:00:00Z");
const SLOT = new Date("2026-10-05T09:00:00Z");

/** The mock allows 60 s; a 90 s clip is cut, so its plan is `derive`. */
const tooLong = { durationSeconds: 90 };

const ofAsset = (projectId: string, assetId: string) =>
  and(eq(videoVersions.projectId, projectId), eq(videoVersions.mediaAssetId, assetId));
const rowsOf = (projectId: string, assetId: string) => getDb().select().from(videoVersions).where(ofAsset(projectId, assetId));

async function setup(accounts = 1) {
  const env = await postsEnv();
  const video = await createVideoAsset(env.project.id, tooLong);
  const accts = [];
  for (let i = 0; i < accounts; i++) accts.push(await env.account({}));
  const draft = await posts.createDraft(env.scope, {
    baseText: "Clip",
    targets: accts.map((a) => ({ accountId: a.id })),
    mediaIds: [video.id],
  });
  return { env, video, accts, draft };
}

describe("video versions are queued when a post leaves draft", () => {
  it("queues nothing for a draft", async () => {
    const { env, video } = await setup();
    expect(await rowsOf(env.project.id, video.id)).toHaveLength(0);
  });

  it("queues one version on schedule, due at the target's time", async () => {
    const { env, video, draft } = await setup();
    const res = await atTime(BEFORE, () => posts.scheduleAt(env.scope, draft.post.id, { at: SLOT.toISOString() }));
    expect(res.every((r) => r.ok)).toBe(true);
    const rows = await rowsOf(env.project.id, video.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "full", state: "queued", attempts: 0 });
    expect(rows[0]!.dueAt?.getTime()).toBe(SLOT.getTime());
  });

  it("queues on addToQueue and on publishNow", async () => {
    const q = await setup();
    const queued = await atTime(BEFORE, () => posts.addToQueue(q.env.scope, q.draft.post.id, {}));
    expect(queued.every((r) => r.ok)).toBe(true);
    expect(await rowsOf(q.env.project.id, q.video.id)).toHaveLength(1);

    const n = await setup();
    const now = await atTime(BEFORE, () => posts.publishNow(n.env.scope, n.draft.post.id, {}));
    expect(now.every((r) => r.ok)).toBe(true);
    expect(await rowsOf(n.env.project.id, n.video.id)).toHaveLength(1);
  });

  it("shares one row between two targets with identical limits", async () => {
    const { env, video, draft } = await setup(2);
    await atTime(BEFORE, () => posts.scheduleAt(env.scope, draft.post.id, { at: SLOT.toISOString() }));
    expect(await rowsOf(env.project.id, video.id)).toHaveLength(1);
  });

  it("queues the new video's version when an edit swaps the media, and a fitting video queues none", async () => {
    const { env, video, draft } = await setup();
    await atTime(BEFORE, () => posts.scheduleAt(env.scope, draft.post.id, { at: SLOT.toISOString() }));
    const other = await createVideoAsset(env.project.id, { durationSeconds: 80 });
    const fits = await createVideoAsset(env.project.id, { durationSeconds: 20 });
    await atTime(BEFORE, () => posts.updatePost(env.scope, draft.post.id, { mediaIds: [other.id] }));
    expect(await rowsOf(env.project.id, other.id)).toHaveLength(1);
    await atTime(BEFORE, () => posts.updatePost(env.scope, draft.post.id, { mediaIds: [fits.id] }));
    expect(await rowsOf(env.project.id, fits.id)).toHaveLength(0);
    // The first video's row is not removed here: collection happens later, when nobody wants it.
    expect(await rowsOf(env.project.id, video.id)).toHaveLength(1);
  });

  it("puts a failed version back to queued when the post is scheduled again", async () => {
    const { env, video, draft } = await setup();
    await atTime(BEFORE, () => posts.scheduleAt(env.scope, draft.post.id, { at: SLOT.toISOString() }));
    await getDb()
      .update(videoVersions)
      .set({ state: "failed", attempts: 3, error: "Docket could not read the video." })
      .where(ofAsset(env.project.id, video.id));
    await atTime(BEFORE, () => posts.scheduleAt(env.scope, draft.post.id, { at: SLOT.toISOString() }));
    expect((await rowsOf(env.project.id, video.id))[0]).toMatchObject({ state: "queued", attempts: 0, error: null });
  });

  it("queues the version when approving a post into the queue", async () => {
    const env = await postsEnv();
    const video = await createVideoAsset(env.project.id, tooLong);
    const acct = await env.account({});
    const { post } = await createPostInReview(env.project.id, { accountIds: [acct.id], schedulingPolicy: "add_to_queue" });
    await env.scope.posts.setMedia(post.id, [video.id]);
    const res = await atTime(BEFORE, () => approvePost(env.scope, post.id));
    expect(res).toMatchObject({ ok: true });
    expect(await rowsOf(env.project.id, video.id)).toHaveLength(1);
  });
});
