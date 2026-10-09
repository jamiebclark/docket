import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import { DEFAULT_VIDEO_EDIT } from "../../src/lib/video/edit";
import { tiktokPostingSchema } from "../../src/providers/tiktok/posting";
import { forSchedulerProject } from "../../src/server/dal/scheduler";
import { createSchedulingRepos } from "../../src/server/dal/scope";
import { mediaAssets } from "../../src/server/db/schema/media";
import { postTargets } from "../../src/server/db/schema/posts";
import { runTick } from "../../src/server/scheduler";
import { encryptCredentials } from "../../src/server/services/accounts";
import { consentFingerprint } from "../../src/server/services/posts/consent";
import { setStorageForTests } from "../../src/server/storage";
import { atTime } from "./clock";
import { testDb } from "./db";
import { createProjectWithMembers, createVideoAsset } from "./factories";
import { jpeg, png } from "./images";
import { rangeFetch } from "./bluesky-video";
import { createFakeTikTok } from "./fake-tiktok";
import { createDraftPost, parkAllDueTargets } from "./scheduling";
import { createMemoryStorage } from "./storage";

export const TT_ACCESS = "TT-ACCESS-0123456789";
export const TT_REFRESH = "TT-REFRESH-0123456789";
export const CREATOR = "/v2/post/publish/creator_info/query/";
export const VIDEO_INIT = "/v2/post/publish/video/init/";
export const PHOTO_INIT = "/v2/post/publish/content/init/";
export const STATUS = "/v2/post/publish/status/fetch/";
export const UPLOAD_HOST = "upload.tiktok.test";
export const UPLOAD_PATH = "/upload/abc";
export const UPLOAD_URL = `https://${UPLOAD_HOST}${UPLOAD_PATH}?upload_id=U1&sig=SIGSECRET`;

export interface TikTokPublishOptions {
  sizeBytes?: number;
  /** Merged over the schema defaults; the default is Followers with comments on. */
  values?: Record<string, unknown>;
  text?: string;
  durationSeconds?: number;
  audited?: boolean;
  /** Stored images (in post order) instead of a video; PNGs and wide JPEGs exercise the planner's conversion. */
  photos?: { format: "jpeg" | "png"; width: number; height: number }[];
}

/**
 * A TikTok account with fresh credentials, a ready video stored behind the byte-range media server, and a due target that
 * carries its posting values and consent. `fetch` is the fake TikTok plus the media server. Call `teardown()` in `afterEach`.
 */
export async function tiktokVideoSetup(opts: TikTokPublishOptions = {}) {
  await parkAllDueTargets();
  vi.stubEnv("TIKTOK_CLIENT_KEY", "CLIENT-KEY");
  vi.stubEnv("TIKTOK_CLIENT_SECRET", "CLIENT-SECRET-XYZ");
  vi.stubEnv("TIKTOK_APP_AUDITED", opts.audited === false ? "false" : "true");
  const sizeBytes = opts.sizeBytes ?? 20_000_000;
  const fake = createFakeTikTok().secrets(TT_ACCESS, TT_REFRESH, UPLOAD_URL);
  fake.install();
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const media = rangeFetch(storage, globalThis.fetch);
  vi.stubGlobal("fetch", media.fetch);

  const ctx = await createProjectWithMembers();
  const projectId = ctx.project.id;
  const repos = forSchedulerProject(projectId);
  const account = await repos.accounts.upsertConnected({
    providerKey: "tiktok",
    displayName: "Ada (@ada)",
    externalAccountId: "open-id-1",
    settings: { username: "ada", nickname: "Ada" },
    credentialsEncrypted: null,
    credentialsExpiresAt: null,
    connectedByUserId: null,
  });
  const nowMs = Date.now();
  const refreshExpiresAt = nowMs + 200 * 86_400_000;
  const creds = {
    v: 1, accessToken: TT_ACCESS, refreshToken: TT_REFRESH, accessExpiresAt: nowMs + 20 * 86_400_000,
    refreshIssuedAt: nowMs, refreshExpiresAt, refreshExpiryEstimated: false, openId: "open-id-1",
  };
  await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, creds), new Date(refreshExpiresAt));

  const assets: { id: string; storageKey: string }[] = [];
  let bytes = Buffer.alloc(0);
  if (opts.photos) {
    const repos2 = createSchedulingRepos(testDb(), projectId);
    for (const [i, p] of opts.photos.entries()) {
      const body = p.format === "png" ? await png(p.width, p.height) : await jpeg(p.width, p.height);
      const key = `projects/${projectId}/media/${i}/original`;
      const mimeType = p.format === "png" ? "image/png" : "image/jpeg";
      await storage.put(key, body, mimeType);
      const row = await repos2.media.insert({ storageKey: key, publicUrl: storage.publicUrl(key), mimeType, byteSize: body.length, width: p.width, height: p.height });
      await repos2.media.updateAlt(row.id, `Photo ${i + 1}`);
      assets.push(row);
    }
  } else {
    const asset = await createVideoAsset(projectId, { width: 1080, height: 1920, durationSeconds: opts.durationSeconds ?? 20, byteSize: sizeBytes });
    bytes = Buffer.alloc(sizeBytes);
    for (let i = 0; i < sizeBytes; i += 4096) bytes[i] = (i / 4096) % 251;
    await storage.put(asset.storageKey, bytes, "video/mp4");
    await testDb().update(mediaAssets).set({ publicUrl: storage.publicUrl(asset.storageKey) }).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.id, asset.id)));
    assets.push(asset);
  }
  const asset = assets[0]!;
  const mediaIds = assets.map((a) => a.id);

  const text = opts.text ?? "a tiktok video";
  const { post, targets } = await createDraftPost(projectId, { baseText: text, accountIds: [account.id], mediaIds });
  const values = tiktokPostingSchema.parse({ privacy: "FOLLOWER_OF_CREATOR", allowComments: true, ...opts.values });
  const due = new Date(Date.now() - 60_000);
  await repos.targets.update(targets[0]!.id, {
    status: "scheduled",
    scheduleKind: "explicit",
    scheduledAt: due,
    nextAttemptAt: due,
    postingFields: values,
    consentAt: new Date(Date.now() - 120_000),
    consentFingerprint: consentFingerprint({ text, mediaIds, videoEdits: opts.photos ? [] : [{ mediaId: asset.id, edit: DEFAULT_VIDEO_EDIT }], values, details: null }),
  });
  await repos.posts.setStatus(post.id, "scheduled");
  const target = targets[0]!;

  const tick = async (at?: Date) => {
    const run = async () => (await runTick({ config: {} })).publishing.counts;
    return at ? atTime(at, run) : run();
  };
  const row = async () => (await testDb().select().from(postTargets).where(and(eq(postTargets.projectId, projectId), eq(postTargets.id, target.id))))[0]!;
  return {
    ctx, fake, storage, projectId, accountId: account.id, asset, assets, bytes, post, target, tick, row, ranges: media.log,
    repos: createSchedulingRepos(testDb(), projectId),
    teardown: () => {
      fake.uninstall();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      setStorageForTests(undefined);
    },
  };
}
