import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_VIDEO_EDIT } from "../../../src/lib/video/edit";
import { getDb } from "../../../src/server/db/client";
import { videoVersions } from "../../../src/server/db/schema";
import * as posts from "../../../src/server/services/posts";
import * as previews from "../../../src/server/services/video-previews";
import { closeDb } from "../../helpers/db";
import { createVideoAsset } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";

afterAll(closeDb);

/** The mock allows 60 s, so a 90 s clip is cut: an `encode` plan. */
async function setup(targets = 1) {
  const env = await postsEnv();
  const video = await createVideoAsset(env.project.id, { durationSeconds: 90 });
  const accts = [];
  for (let i = 0; i < targets; i++) accts.push(await env.account({}));
  const input = { baseText: "Clip", mediaIds: [video.id], targets: accts.map((a) => ({ accountId: a.id })) };
  return { env, video, accts, input };
}
const rowsOf = (projectId: string, assetId: string) =>
  getDb().select().from(videoVersions).where(and(eq(videoVersions.projectId, projectId), eq(videoVersions.mediaAssetId, assetId)));

describe("requesting previews", () => {
  it("creates exactly one preview row for an adapted video and reports it queued", async () => {
    const { env, video, input } = await setup();
    const { previews: out } = await previews.requestVideoPreviews(env.scope, input);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ state: "queued", url: null, error: null });
    const rows = await rowsOf(env.project.id, video.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "preview", key: out[0]!.key });
    expect(rows[0]!.dueAt).not.toBeNull();
    // The same request again changes nothing.
    await previews.requestVideoPreviews(env.scope, input);
    expect(await rowsOf(env.project.id, video.id)).toHaveLength(1);
  });

  it("shares one preview between targets with identical limits (US4 #4)", async () => {
    const { env, video, input } = await setup(2);
    const { previews: out } = await previews.requestVideoPreviews(env.scope, input);
    expect(out).toHaveLength(1);
    expect(await rowsOf(env.project.id, video.id)).toHaveLength(1);
  });

  it("gives a changed edit a new key and leaves the old row alone (US4 #2)", async () => {
    const { env, video, input } = await setup();
    const first = (await previews.requestVideoPreviews(env.scope, input)).previews[0]!;
    const edit = { ...DEFAULT_VIDEO_EDIT, trimStartMs: 5_000 };
    const second = (await previews.requestVideoPreviews(env.scope, { ...input, videoEdits: { [video.id]: edit } })).previews[0]!;
    expect(second.key).not.toBe(first.key);
    expect(await rowsOf(env.project.id, video.id)).toHaveLength(2);
  });

  it("writes nothing for a post with no video", async () => {
    const { env, input } = await setup();
    expect((await previews.requestVideoPreviews(env.scope, { ...input, mediaIds: [], targets: [] })).previews).toEqual([]);
  });
});

describe("preview status", () => {
  it("reports queued, then ready once the worker marks it, with the url", async () => {
    const { env, video, input } = await setup();
    const { key } = (await previews.requestVideoPreviews(env.scope, input)).previews[0]!;
    expect((await previews.videoPreviewStatus(env.scope, { keys: [key] })).previews[0]).toMatchObject({ key, state: "queued", url: null });

    await getDb()
      .update(videoVersions)
      .set({ state: "ready", storageKey: `p/vp/${key}.mp4`, publicUrl: `http://localhost:3000/p/vp/${key}.mp4`, finishedAt: new Date(),
        container: "mp4", width: 360, height: 640, durationMs: 60_000, frameRate: 30, videoCodec: "h264", audioCodec: "aac", videoBitrate: 500_000, byteSize: 1000 })
      .where(and(eq(videoVersions.projectId, env.project.id), eq(videoVersions.mediaAssetId, video.id)));
    expect((await previews.videoPreviewStatus(env.scope, { keys: [key] })).previews[0]).toMatchObject({ state: "ready", url: `http://localhost:3000/p/vp/${key}.mp4` });

    // The composer check now shows the render, and still writes nothing.
    const check = await posts.checkComposition(env.scope, input);
    expect(check.targets[0]!.videos[0]!.preview).toMatchObject({ kind: "render", key, state: "ready" });
  });

  it("ignores keys that match nothing and caps the list", async () => {
    const { env } = await setup();
    expect((await previews.videoPreviewStatus(env.scope, { keys: ["a".repeat(64)] })).previews).toEqual([]);
    await expect(previews.videoPreviewStatus(env.scope, { keys: Array.from({ length: 51 }, () => "a".repeat(64)) })).rejects.toThrow();
  });

  it("retries a failed preview only when asked", async () => {
    const { env, video, input } = await setup();
    const { key } = (await previews.requestVideoPreviews(env.scope, input)).previews[0]!;
    await getDb()
      .update(videoVersions)
      .set({ state: "failed", error: "Docket could not build it.", attempts: 3 })
      .where(and(eq(videoVersions.projectId, env.project.id), eq(videoVersions.mediaAssetId, video.id)));
    expect((await previews.requestVideoPreviews(env.scope, input)).previews[0]).toMatchObject({ state: "failed", error: "Docket could not build it." });
    expect((await previews.requestVideoPreviews(env.scope, { ...input, retry: true })).previews[0]).toMatchObject({ key, state: "queued", error: null });
  });
});

describe("a target that needs no render", () => {
  it("makes no preview row when the video fits as is", async () => {
    const env = await postsEnv();
    const video = await createVideoAsset(env.project.id, { durationSeconds: 20 });
    const a = await env.account({});
    const input = { baseText: "Clip", mediaIds: [video.id], targets: [{ accountId: a.id }] };
    expect((await previews.requestVideoPreviews(env.scope, input)).previews).toEqual([]);
    expect(await rowsOf(env.project.id, video.id)).toHaveLength(0);
    const check = await posts.checkComposition(env.scope, input);
    expect(check.targets[0]!.videos[0]).toMatchObject({ plan: "as_is", preview: { kind: "original" } });
  });
});
