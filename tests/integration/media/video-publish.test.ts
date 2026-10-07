import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import {
  completeUploadAction,
  createUploadAction,
  signUploadPartsAction,
} from "../../../src/app/p/[projectSlug]/media/upload-actions";
import { crossProject } from "../../../src/server/dal/scope";
import { getDb } from "../../../src/server/db/client";
import { mediaAssets, mediaUploads } from "../../../src/server/db/schema";
import { runTick } from "../../../src/server/scheduler";
import * as posts from "../../../src/server/services/posts";
import { setStorageForTests } from "../../../src/server/storage";
import { markWorkerProcess } from "../../../src/server/video/guard";
import { processNext } from "../../../src/server/video/loop";
import { actAs } from "../../helpers/actions";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { requireFfmpeg } from "../../helpers/ffmpeg";
import { postsEnv } from "../../helpers/posts-env";
import { parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage } from "../../helpers/storage";
import { createVideoFixtures, type VideoFixtures } from "../../helpers/video-fixtures";

const signal = new AbortController().signal;
const BEFORE = new Date("2026-10-01T12:00:00Z");
const SLOT = new Date("2026-10-05T09:00:00Z");

afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});
afterEach(() => setStorageForTests(undefined));

requireFfmpeg()("publishing a video through the mock provider", () => {
  let fx: VideoFixtures;
  beforeAll(() => {
    fx = createVideoFixtures();
  });
  afterAll(() => fx?.cleanup());
  beforeEach(async () => {
    markWorkerProcess();
    await parkAllDueTargets();
    // The media claim is cross-project: retire anything an earlier file left queued.
    await crossProject("test: retire processing rows", async () =>
      await getDb().update(mediaAssets).set({ deletedAt: new Date() }).where(eq(mediaAssets.processingState, "processing")),
    );
  });

  /** Upload through the services, then let the worker loop make it ready. */
  async function uploadVideo(path: string) {
    const storage = createMemoryStorage();
    setStorageForTests(storage);
    const env = await postsEnv();
    actAs(env.owner);
    const body = readFileSync(path);
    const created = await createUploadAction(env.project.slug, { filename: "clip.mp4", kind: "video", declaredType: "video/mp4", bytes: body.length });
    if (!created.ok || !created.data.ok) throw new Error("create failed");
    const uploadId = created.data.upload.id;
    const [row] = await getDb()
      .select()
      .from(mediaUploads)
      .where(and(eq(mediaUploads.projectId, env.project.id), eq(mediaUploads.id, uploadId)));
    const signed = await signUploadPartsAction(env.project.slug, { uploadId, partNumbers: [1] });
    if (!signed.ok || !signed.data.ok) throw new Error("sign failed");
    await storage.uploadPart(row!.storageKey, row!.storageUploadId!, 1, body);
    const done = await completeUploadAction(env.project.slug, { uploadId });
    if (!done.ok || !done.data.ok) throw new Error("complete failed");
    expect(done.data.asset.status).toBe("processing");
    expect(await processNext({ signal })).toBe(true);
    return { env, assetId: done.data.asset.id };
  }

  async function queueVideoPost(env: Awaited<ReturnType<typeof postsEnv>>, assetId: string) {
    const account = await env.account({});
    const draft = await posts.createDraft(env.scope, {
      baseText: "Clip",
      targets: [{ accountId: account.id }],
      mediaIds: [assetId],
    });
    return { draft, account };
  }

  it("uploads, schedules and publishes through upload_video, check_video and publish", async () => {
    const { env, assetId } = await uploadVideo(fx.landscape);
    const { draft } = await queueVideoPost(env, assetId);
    const queued = await atTime(BEFORE, () => posts.addToQueue(env.scope, draft.post.id, {}));
    expect(queued.every((t) => t.ok)).toBe(true);

    // The check step asks to be called again after a second, so tick forward until the post settles.
    for (let i = 0; i < 6; i++) await atTime(new Date(SLOT.getTime() + i * 5000), () => runTick());

    const detail = await posts.getPost(env.scope, draft.post.id);
    expect(detail.targets[0]).toMatchObject({ status: "published" });
    const attempts = await posts.listAttempts(env.scope, detail.targets[0]!.id);
    // listAttempts is newest first.
    expect(attempts.map((a) => a.step)).toEqual(["publish", "check_video", "upload_video"]);
    expect(attempts[0]).toMatchObject({ outcome: "done" });
  });

  it("refuses an out-of-limits video at scheduling", async () => {
    const { env, assetId } = await uploadVideo(fx.long(70));
    const { draft } = await queueVideoPost(env, assetId);
    const queued = await atTime(BEFORE, () => posts.addToQueue(env.scope, draft.post.id, {}));
    expect(queued[0]).toMatchObject({ ok: false, code: "validation" });
    expect(queued[0]!.ok === false && queued[0]!.issues?.some((i) => i.code === "video_too_long")).toBe(true);
  });

  it("fails at publish time when the video no longer fits", async () => {
    const { env, assetId } = await uploadVideo(fx.landscape);
    const { draft } = await queueVideoPost(env, assetId);
    const queued = await atTime(BEFORE, () => posts.addToQueue(env.scope, draft.post.id, {}));
    expect(queued.every((t) => t.ok)).toBe(true);
    await crossProject("test: stretch the video", async () =>
      await getDb().update(mediaAssets).set({ durationMs: 120_000 }).where(eq(mediaAssets.id, assetId)),
    );
    for (let i = 0; i < 3; i++) await atTime(new Date(SLOT.getTime() + i * 5000), () => runTick());
    const detail = await posts.getPost(env.scope, draft.post.id);
    expect(detail.targets[0]).toMatchObject({ status: "failed" });
    const attempts = await posts.listAttempts(env.scope, detail.targets[0]!.id);
    expect(attempts.some((a) => a.step === "publish" && a.outcome === "done")).toBe(false);
  });
});
