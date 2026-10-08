import { and, eq } from "drizzle-orm";
import { postTargets } from "../../src/server/db/schema/posts";
import { createSchedulingRepos } from "../../src/server/dal/scope";
import type { PostType } from "../../src/providers/types";
import { testDb } from "./db";
import { createVideoAsset } from "./factories";
import { metaSetup } from "./facebook-publish";
import { jpeg } from "./images";
import type { MemoryStorage } from "./storage";

export const IG_ID = "17841400000000000";

/** A project with a connected Instagram account and one due target carrying `imageCount` JPEGs. */
export function instagramSetup(storage: MemoryStorage, text: string, imageCount: number) {
  return metaSetup("instagram", IG_ID, storage, text, imageCount);
}

/**
 * The same with media of the given kinds in post order: ready videos (9:16 alone, square inside a carousel; 20 s, H.264/AAC) and JPEGs.
 * `postType` is the target's chosen post type; `setPostType` changes it between ticks.
 */
export async function instagramVideoSetup(
  storage: MemoryStorage,
  text: string,
  kinds: readonly ("image" | "video")[],
  opts: { postType?: PostType } = {},
) {
  const base = await metaSetup("instagram", IG_ID, storage, text, 0);
  const { projectId, targetId } = base;
  const repos = createSchedulingRepos(testDb(), projectId);
  const [target] = await testDb()
    .select({ postId: postTargets.postId })
    .from(postTargets)
    .where(and(eq(postTargets.projectId, projectId), eq(postTargets.id, targetId)));
  const postId = target!.postId;
  const ids: string[] = [];
  for (const [i, kind] of kinds.entries()) {
    if (kind === "video") {
      const video = await createVideoAsset(
        projectId,
        kinds.length > 1 ? { width: 1080, height: 1080, durationSeconds: 20 } : { width: 720, height: 1280, durationSeconds: 20 },
      );
      await storage.put(video.storageKey, Buffer.from("not really a video"), "video/mp4"); // the engine checks the object exists
      ids.push(video.id);
      continue;
    }
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
  if (ids.length) await repos.posts.setMedia(postId, ids);
  const setPostType = async (type: PostType | null) => {
    await testDb()
      .update(postTargets)
      .set({ chosenPostType: type })
      .where(and(eq(postTargets.projectId, projectId), eq(postTargets.id, targetId)));
  };
  if (opts.postType) await setPostType(opts.postType);
  return { ...base, postId, setPostType };
}
