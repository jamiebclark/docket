import { and, eq } from "drizzle-orm";
import { postTargets } from "../../src/server/db/schema/posts";
import { createSchedulingRepos } from "../../src/server/dal/scope";
import { forSchedulerProject } from "../../src/server/dal/scheduler";
import { runTick } from "../../src/server/scheduler";
import { encryptCredentials } from "../../src/server/services/accounts";
import { testDb } from "./db";
import type { PostType } from "../../src/providers/types";
import { createVideoAsset } from "./factories";
import { jpeg } from "./images";
import { createDueTarget } from "./scheduling";
import { createProjectWithMembers } from "./factories";
import type { MemoryStorage } from "./storage";

export const PAGE_ID = "1234567890";
export const PAGE_TOKEN = "EAAB-page-token-0123456789abcdef";

/** A project with a connected Facebook Page account and one due target carrying `imageCount` JPEGs. */
export function facebookSetup(storage: MemoryStorage, text: string, imageCount: number) {
  return metaSetup("facebook", PAGE_ID, storage, text, imageCount);
}

/** The same for any Meta provider; `externalId` is the Page or Instagram account id. */
export async function metaSetup(providerKey: "facebook" | "instagram", externalId: string, storage: MemoryStorage, text: string, imageCount: number) {
  const ctx = await createProjectWithMembers();
  const projectId = ctx.project.id;
  const account = await forSchedulerProject(projectId).accounts.upsertConnected({
    providerKey,
    displayName: providerKey === "facebook" ? "Docket Page" : "Docket Page · Instagram",
    externalAccountId: externalId,
    settings: {},
    credentialsEncrypted: null,
    credentialsExpiresAt: null,
    connectedByUserId: null,
  });
  await forSchedulerProject(projectId).accounts.setCredentials(account.id, encryptCredentials(account.id, { pageToken: PAGE_TOKEN }), null);
  const { post, target } = await createDueTarget(projectId, account.id, { baseText: text });
  const repos = createSchedulingRepos(testDb(), projectId);
  const ids: string[] = [];
  for (let i = 0; i < imageCount; i++) {
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
  if (ids.length) await repos.posts.setMedia(post.id, ids);
  const tick = async () => (await runTick({ config: {} })).publishing.counts;
  const row = async () =>
    (await testDb().select().from(postTargets).where(and(eq(postTargets.projectId, projectId), eq(postTargets.id, target.id))))[0]!;
  return { projectId, accountId: account.id, targetId: target.id, tick, row };
}

/**
 * A project with a connected Facebook Page and one due target carrying one ready landscape video (1920 × 1080, 20 s, H.264/AAC).
 * `video` overrides its facts; `postType` is the target's chosen post type, and `setPostType` changes it between ticks.
 */
export async function facebookVideoSetup(
  storage: MemoryStorage,
  text: string,
  opts: { postType?: PostType; video?: Parameters<typeof createVideoAsset>[1] } = {},
) {
  const base = await metaSetup("facebook", PAGE_ID, storage, text, 0);
  const { projectId, targetId } = base;
  const [target] = await testDb()
    .select({ postId: postTargets.postId })
    .from(postTargets)
    .where(and(eq(postTargets.projectId, projectId), eq(postTargets.id, targetId)));
  const postId = target!.postId;
  const video = await createVideoAsset(projectId, { width: 1920, height: 1080, durationSeconds: 20, ...opts.video });
  await storage.put(video.storageKey, Buffer.from("not really a video"), "video/mp4"); // the engine checks the object exists
  await createSchedulingRepos(testDb(), projectId).posts.setMedia(postId, [video.id]);
  const setPostType = async (type: PostType | null) => {
    await testDb()
      .update(postTargets)
      .set({ chosenPostType: type })
      .where(and(eq(postTargets.projectId, projectId), eq(postTargets.id, targetId)));
  };
  if (opts.postType) await setPostType(opts.postType);
  return { ...base, postId, video, setPostType };
}
