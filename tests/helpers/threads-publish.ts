import { and, eq } from "drizzle-orm";
import { postTargets } from "../../src/server/db/schema/posts";
import { createSchedulingRepos } from "../../src/server/dal/scope";
import { forSchedulerProject } from "../../src/server/dal/scheduler";
import { runTick } from "../../src/server/scheduler";
import { encryptCredentials } from "../../src/server/services/accounts";
import { atTime } from "./clock";
import { testDb } from "./db";
import type { FakeGraph, GraphReply } from "./fake-graph";
import { jpeg } from "./images";
import { createDueTarget } from "./scheduling";
import { createProjectWithMembers, createVideoAsset } from "./factories";
import type { MemoryStorage } from "./storage";

export const THREADS_USER_ID = "17841400000000001";
export const THREADS_TOKEN = "THQW-threads-token-0123456789abcdef";
/** Versioned Threads paths use this segment (research R1). */
export const V = "/v1.0";

export interface ThreadsSetupOptions {
  text?: string;
  /** Number of JPEG images attached to the post (0, 1 or N). */
  imageCount?: number;
  /** Width of each JPEG (default 400+index); above 1440 the Threads variant is a downscale. */
  imageWidth?: number;
  /** When the token expires; default 30 days after `Date.now()`. */
  expiresAt?: Date;
  /** When the token was issued; default now. */
  issuedAt?: Date;
}

/** A project with a connected Threads account (encrypted credentials) and one due target carrying `imageCount` JPEGs. */
export async function threadsSetup(storage: MemoryStorage, opts: ThreadsSetupOptions = {}) {
  const { text = "Hello from Docket", imageCount = 0 } = opts;
  const ctx = await createProjectWithMembers();
  const projectId = ctx.project.id;
  const issued = opts.issuedAt ?? new Date();
  const expires = opts.expiresAt ?? new Date(issued.getTime() + 30 * 86_400_000);
  const account = await forSchedulerProject(projectId).accounts.upsertConnected({
    providerKey: "threads",
    displayName: "@docket",
    externalAccountId: THREADS_USER_ID,
    settings: {},
    credentialsEncrypted: null,
    credentialsExpiresAt: null,
    connectedByUserId: null,
  });
  const credentials = {
    v: 1,
    accessToken: THREADS_TOKEN,
    issuedAt: issued.getTime(),
    expiresAt: expires.getTime(),
    expiryEstimated: false,
  };
  await forSchedulerProject(projectId).accounts.setCredentials(account.id, encryptCredentials(account.id, credentials), expires);
  const { post, target } = await createDueTarget(projectId, account.id, { baseText: text });
  const repos = createSchedulingRepos(testDb(), projectId);
  const ids: string[] = [];
  for (let i = 0; i < imageCount; i++) {
    const w = opts.imageWidth ?? 400 + i;
    const body = await jpeg(w, 300);
    const key = `projects/${projectId}/media/${i}/original`;
    await storage.put(key, body, "image/jpeg");
    const asset = await repos.media.insert({
      storageKey: key,
      publicUrl: storage.publicUrl(key),
      mimeType: "image/jpeg",
      byteSize: body.length,
      width: w,
      height: 300,
    });
    ids.push(asset.id);
  }
  if (ids.length) await repos.posts.setMedia(post.id, ids);

  /** One scheduler tick at the real clock, or at `when` on the engine clock. */
  const tick = async (when?: Date) => {
    const run = async () => (await runTick({ config: {} })).publishing.counts;
    return when ? atTime(when, run) : run();
  };
  const row = async () =>
    (await testDb().select().from(postTargets).where(and(eq(postTargets.projectId, projectId), eq(postTargets.id, target.id))))[0]!;
  /** The tick time that is `ms` after the target's next attempt. */
  const afterNext = async (ms: number) => new Date(((await row()).nextAttemptAt ?? new Date()).getTime() + ms);
  return { projectId, accountId: account.id, targetId: target.id, postId: post.id, tick, row, afterNext };
}

/** Scripts for the publishing endpoints of one Threads user. Each helper returns the fake for chaining. */
export function scriptThreads(fake: FakeGraph, userId = THREADS_USER_ID) {
  const api = {
    /** `POST /{user}/threads` answers these ids in order (the last repeats). */
    create(ids: string[]) {
      fake.on("POST", `${V}/${userId}/threads`, ids.map((id): GraphReply => ({ kind: "ok", body: { id } })));
      return api;
    },
    /** `GET /{container}` answers these statuses in order. */
    status(container: string, statuses: (string | { status: string; error_message?: string })[]) {
      fake.on(
        "GET",
        `${V}/${container}`,
        statuses.map((s): GraphReply => ({ kind: "ok", body: typeof s === "string" ? { status: s } : s })),
      );
      return api;
    },
    /** `GET /{user}/threads_publishing_limit`: used out of total. */
    quota(used: number, total = 250) {
      fake.on("GET", `${V}/${userId}/threads_publishing_limit`, {
        kind: "ok",
        body: { data: [{ quota_usage: used, config: { quota_total: total, quota_duration: 86400 } }] },
      });
      return api;
    },
    /** `POST /{user}/threads_publish`. */
    publish(reply: GraphReply | string) {
      fake.on("POST", `${V}/${userId}/threads_publish`, typeof reply === "string" ? { kind: "ok", body: { id: reply } } : reply);
      return api;
    },
  };
  return api;
}

/**
 * `threadsSetup`'s project, account and due target, carrying ready videos instead of images: `kinds` lists the post's
 * items in order (default one video). Videos come from `createVideoAsset` facts (1,080 × 1,920, 30 s, H.264/AAC); the
 * images are 400 × 300 JPEGs. `video` overrides the video facts.
 */
export async function threadsVideoSetup(
  storage: MemoryStorage,
  text: string,
  kinds: readonly ("image" | "video")[] = ["video"],
  opts: { video?: Parameters<typeof createVideoAsset>[1]; setup?: ThreadsSetupOptions } = {},
) {
  const base = await threadsSetup(storage, { ...opts.setup, text, imageCount: 0 });
  const { projectId, postId } = base;
  const repos = createSchedulingRepos(testDb(), projectId);
  const ids: string[] = [];
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] === "video") {
      const video = await createVideoAsset(projectId, { width: 1080, height: 1920, durationSeconds: 30, ...opts.video });
      await storage.put(video.storageKey, Buffer.from("not really a video"), "video/mp4"); // the engine checks the object exists
      ids.push(video.id);
    } else {
      const body = await jpeg(400 + i, 300);
      const key = `projects/${projectId}/media/${i}/original`;
      await storage.put(key, body, "image/jpeg");
      const asset = await repos.media.insert({
        storageKey: key,
        publicUrl: storage.publicUrl(key),
        mimeType: "image/jpeg",
        byteSize: body.length,
        width: 400 + i,
        height: 300,
      });
      ids.push(asset.id);
    }
  }
  await repos.posts.setMedia(postId, ids);
  return { ...base, mediaIds: ids };
}
