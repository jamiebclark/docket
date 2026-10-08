import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { DEFAULT_VIDEO_EDIT, type VideoEdit } from "../../../src/lib/video/edit";
import { getDb } from "../../../src/server/db/client";
import { videoVersions } from "../../../src/server/db/schema";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createVideoAsset } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";

afterAll(closeDb);

const BEFORE = new Date("2026-10-01T12:00:00Z");
const SLOT = new Date("2026-10-05T09:00:00Z");

const crop: VideoEdit = { ...DEFAULT_VIDEO_EDIT, fit: "crop", focalX: 0.2, focalY: 0.5, recommendedShape: true };

async function setup(video: { durationSeconds?: number } = { durationSeconds: 90 }) {
  const env = await postsEnv();
  const asset = await createVideoAsset(env.project.id, video);
  const account = await env.account({});
  const input = { baseText: "Clip", targets: [{ accountId: account.id }], mediaIds: [asset.id] };
  return { env, asset, account, input };
}

/** The field a refused save points at. */
async function refusedAt(run: () => Promise<unknown>): Promise<string> {
  const err = await run().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ZodError);
  return (err as ZodError).issues[0]!.path.join(".");
}

describe("saving and reading video edits", () => {
  it("saves with the draft and reads back; a video without a row has the default", async () => {
    const { env, asset, input } = await setup();
    const draft = await posts.createDraft(env.scope, { ...input, videoEdits: { [asset.id]: crop } });
    expect((await env.scope.posts.listVideoEdits(draft.post.id)).get(asset.id)).toEqual(crop);

    const plain = await posts.createDraft(env.scope, input);
    expect((await env.scope.posts.listVideoEdits(plain.post.id)).size).toBe(0);
  });

  it("keeps stored edits when the patch has none, and an edit equal to the default deletes its row", async () => {
    const { env, asset, input } = await setup();
    const draft = await posts.createDraft(env.scope, { ...input, videoEdits: { [asset.id]: crop } });
    await posts.updatePost(env.scope, draft.post.id, { baseText: "New text" });
    expect((await env.scope.posts.listVideoEdits(draft.post.id)).get(asset.id)).toEqual(crop);

    await posts.updatePost(env.scope, draft.post.id, { videoEdits: { [asset.id]: DEFAULT_VIDEO_EDIT } });
    expect((await env.scope.posts.listVideoEdits(draft.post.id)).size).toBe(0);
  });

  it("normalises an end equal to the video's length to null", async () => {
    const { env, asset, input } = await setup({ durationSeconds: 90 });
    const draft = await posts.createDraft(env.scope, { ...input, videoEdits: { [asset.id]: { ...crop, trimEndMs: 90_000 } } });
    expect((await env.scope.posts.listVideoEdits(draft.post.id)).get(asset.id)?.trimEndMs).toBeNull();
  });

  it("removes an edit when its video is removed from the post", async () => {
    const { env, asset, input } = await setup();
    const other = await createVideoAsset(env.project.id, { durationSeconds: 30 });
    const draft = await posts.createDraft(env.scope, { ...input, videoEdits: { [asset.id]: crop } });
    await posts.updatePost(env.scope, draft.post.id, { mediaIds: [other.id] });
    expect((await env.scope.posts.listVideoEdits(draft.post.id)).size).toBe(0);
  });
});

describe("refused edits", () => {
  it("refuses a key that is not a video on the post, naming the field", async () => {
    const { env, input } = await setup();
    const stranger = await createVideoAsset(env.project.id, { durationSeconds: 30 });
    const path = await refusedAt(() => posts.createDraft(env.scope, { ...input, videoEdits: { [stranger.id]: crop } }));
    expect(path).toBe(`videoEdits.${stranger.id}`);
  });

  it("refuses a trim outside the video, an end before the start, and a part under a second", async () => {
    const { env, asset, input } = await setup({ durationSeconds: 90 });
    const bad = (e: Partial<VideoEdit>) => posts.createDraft(env.scope, { ...input, videoEdits: { [asset.id]: { ...crop, ...e } } });
    expect(await refusedAt(() => bad({ trimEndMs: 95_000 }))).toBe(`videoEdits.${asset.id}.trimEndMs`);
    expect(await refusedAt(() => bad({ trimStartMs: 89_500 }))).toBe(`videoEdits.${asset.id}.trimStartMs`);
    expect(await refusedAt(() => bad({ trimStartMs: 20_000, trimEndMs: 10_000 }))).toBe(`videoEdits.${asset.id}.trimEndMs`);
    expect(await refusedAt(() => bad({ trimStartMs: 10_000, trimEndMs: 10_500 }))).toBe(`videoEdits.${asset.id}.trimEndMs`);
  });

  it("refuses a malformed edit and leaves the stored one", async () => {
    const { env, asset, input } = await setup();
    const draft = await posts.createDraft(env.scope, { ...input, videoEdits: { [asset.id]: crop } });
    await expect(posts.updatePost(env.scope, draft.post.id, { videoEdits: { [asset.id]: { ...crop, padColor: "red" } } })).rejects.toBeInstanceOf(ZodError);
    expect((await env.scope.posts.listVideoEdits(draft.post.id)).get(asset.id)).toEqual(crop);
  });

  it("refuses an edit after publishing has started", async () => {
    const { env, asset, input } = await setup();
    const draft = await posts.createDraft(env.scope, input);
    await atTime(BEFORE, () => posts.scheduleAt(env.scope, draft.post.id, { at: SLOT.toISOString() }));
    const [target] = await env.scope.targets.listForPost(draft.post.id);
    await env.scope.targets.update(target!.id, { status: "publishing" });
    await expect(posts.updatePost(env.scope, draft.post.id, { videoEdits: { [asset.id]: crop } })).rejects.toThrow(/no longer be edited/);
  });

  it("gives a person outside the project no scope to edit with", async () => {
    const { env } = await setup();
    const { forProject } = await import("../../../src/server/dal/scope");
    const { fakeSession } = await import("../../helpers/auth");
    const { createUser } = await import("../../helpers/factories");
    const outsider = await createUser();
    await expect(forProject(fakeSession(outsider.id), env.project.slug)).rejects.toThrow();
  });
});

describe("the check uses an unsaved edit", () => {
  it("plans with the edit the composer holds", async () => {
    const { env, asset, account } = await setup({ durationSeconds: 90 });
    const check = (videoEdits: Record<string, VideoEdit>) =>
      posts.checkComposition(env.scope, { baseText: "Clip", mediaIds: [asset.id], targets: [{ accountId: account.id }], videoEdits });
    const whole = (await check({})).targets[0]!.videos[0]!;
    expect(whole).toMatchObject({ plan: "adapted", index: 0, mediaId: asset.id });
    const cut = (await check({ [asset.id]: { ...DEFAULT_VIDEO_EDIT, trimEndMs: 30_000 } })).targets[0]!.videos[0]!;
    // 30 seconds fits the mock's 60 s limit, so the trim alone makes it fit as a cut; the output length follows the edit.
    expect(cut.output?.durationLabel).not.toBe(whole.output?.durationLabel);
  });

  it("rejects an edit for a video that is not on the post", async () => {
    const { env, asset, account } = await setup();
    const stranger = await createVideoAsset(env.project.id, { durationSeconds: 30 });
    const path = await refusedAt(() =>
      posts.checkComposition(env.scope, {
        baseText: "Clip",
        mediaIds: [asset.id],
        targets: [{ accountId: account.id }],
        videoEdits: { [stranger.id]: crop },
      }),
    );
    expect(path).toBe(`videoEdits.${stranger.id}`);
  });
});

describe("an edit change re-queues the version", () => {
  it("queues a version under a new key for the new recipe", async () => {
    const { env, asset, input } = await setup({ durationSeconds: 90 });
    const draft = await posts.createDraft(env.scope, input);
    await atTime(BEFORE, () => posts.scheduleAt(env.scope, draft.post.id, { at: SLOT.toISOString() }));
    const keys = async () =>
      (await getDb().select().from(videoVersions).where(and(eq(videoVersions.projectId, env.project.id), eq(videoVersions.mediaAssetId, asset.id)))).map((r) => r.key);
    const before = await keys();
    expect(before).toHaveLength(1);

    await atTime(BEFORE, () => posts.updatePost(env.scope, draft.post.id, { videoEdits: { [asset.id]: { ...DEFAULT_VIDEO_EDIT, trimStartMs: 5_000 } } }));
    const after = await keys();
    // The old row is collected later, once nothing wants it; the new key is queued now.
    expect(after).toHaveLength(2);
    expect(after.filter((k) => !before.includes(k))).toHaveLength(1);
  });
});
