import { and, eq } from "drizzle-orm";
import { mockProvider } from "../../src/providers/mock";
import type { PostContent, ProviderCapabilities, SocialProvider } from "../../src/providers/types";
import { createSchedulingRepos } from "../../src/server/dal/scope";
import { videoVersions } from "../../src/server/db/schema";
import { videoRecipeKey } from "../../src/server/media/hash";
import { planVideoFor } from "../../src/server/services/media-variants";
import { setStorageForTests } from "../../src/server/storage";
import { testDb } from "./db";
import { createProject, createVideoAsset, type VideoAssetOptions } from "./factories";
import { registerTestProvider } from "./provider-fixtures";
import { createDueTarget, createMockAccount } from "./scheduling";
import { createMemoryStorage } from "./storage";

/** What the spy provider was handed, in call order. Clear it in `beforeEach`. */
export const received: PostContent[] = [];

/** The mock's video limits (60 s, 9:16..16:9, 1920 px), recording the content `advance` receives. */
export const spyVideoProvider: SocialProvider = registerTestProvider({
  ...mockProvider,
  key: "spy-video",
  displayName: "Spy",
  advance: async (ctx) => {
    received.push(ctx.content);
    return { kind: "done", externalId: "x-1" };
  },
} as SocialProvider);

/** Small, strict video limits (1 s, square, 200 px, 10 fps, MP4, index first) that make an ordinary clip need adapting. */
export const STRICT_VIDEO: NonNullable<ProviderCapabilities["video"]> = {
  maxVideos: 1,
  containers: ["mp4"],
  videoCodecs: ["h264"],
  audioCodecs: ["aac"],
  maxDurationSeconds: 1,
  minAspectRatio: 1,
  maxAspectRatio: 1,
  maxWidth: 200,
  maxHeight: 200,
  maxFrameRate: 10,
  maxVideoBitrate: 1_000_000,
  indexAtFront: true,
  recommendedAspectRatio: 1,
};

/** What the strict spy provider was handed. Clear it in `beforeEach`. */
export const receivedStrict: PostContent[] = [];
export const strictVideoProvider: SocialProvider = registerTestProvider({
  ...mockProvider,
  key: "spy-video-strict",
  displayName: "Strict",
  capabilities: { ...mockProvider.capabilities, video: STRICT_VIDEO },
  advance: async (ctx) => {
    receivedStrict.push(ctx.content);
    return { kind: "done", externalId: "x-2" };
  },
} as SocialProvider);

/** A due target with one video on the spy provider; the original object is stored when `storeOriginal`. */
export async function videoTargetSetup(video: VideoAssetOptions, storeOriginal = true, providerKey = "spy-video", existing?: { project: { id: string }; storage: ReturnType<typeof createMemoryStorage>; asset: Awaited<ReturnType<typeof createVideoAsset>> }) {
  const storage = existing?.storage ?? createMemoryStorage();
  setStorageForTests(storage);
  const project = existing?.project ?? (await createProject());
  const repos = createSchedulingRepos(testDb(), project.id);
  const account = await createMockAccount(project.id, {}, { providerKey });
  const asset = existing?.asset ?? (await createVideoAsset(project.id, video));
  const original = Buffer.from("original-bytes-" + asset.id);
  if (storeOriginal && !existing) await storage.put(asset.storageKey, original, asset.mimeType);
  const { post, target } = await createDueTarget(project.id, account.id);
  await repos.posts.setMedia(post.id, [asset.id]);
  return { storage, project, repos, asset, original, post, target };
}

/** Inserts the version a `derive` plan asks for, `queued`, and returns its row. */
export async function queueVersionFor(t: Pick<Awaited<ReturnType<typeof videoTargetSetup>>, "repos" | "asset">, provider: SocialProvider = spyVideoProvider) {
  const [row] = await t.repos.media.getMany([t.asset.id]);
  const plan = planVideoFor(row!, provider.capabilities, "video", 0, provider.displayName);
  if (plan?.kind !== "derive") throw new Error("fixture precondition: the video should need adapting");
  const [version] = await t.repos.videoVersions.ensureQueued([
    { assetId: t.asset.id, kind: "full", key: videoRecipeKey("full", plan.recipe), recipe: plan.recipe, steps: plan.steps, dueAt: new Date() },
  ]);
  return { plan, version: version! };
}

/** Marks a version `ready` with the given object key, as the worker would after a build. */
export async function markReady(projectId: string, id: string, storageKey: string, publicUrl: string) {
  await testDb()
    .update(videoVersions)
    .set({
      state: "ready", storageKey, publicUrl, container: "mp4", width: 1280, height: 720, durationMs: 60_000, frameRate: 30,
      videoCodec: "h264", audioCodec: "aac", videoBitrate: 2_000_000, byteSize: 1234, finishedAt: new Date(),
    })
    .where(and(eq(videoVersions.projectId, projectId), eq(videoVersions.id, id)));
}
