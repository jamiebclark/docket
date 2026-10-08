import { eq } from "drizzle-orm";
import { schedulerHeartbeats, videoVersions } from "../../src/server/db/schema";
import { forProject } from "../../src/server/dal/scope";
import { createMemoryStorage } from "./storage";
import { fakeSession } from "./auth";
import { testDb } from "./db";
import { createProjectWithMembers, createVideoAsset } from "./factories";
import { videoTargetSetup } from "./video-publish-setup";

/** A due target with one too-long video, in a project an owner scope can reach (for retry and the post view). */
export async function waitSetup() {
  const ctx = await createProjectWithMembers();
  const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
  const storage = createMemoryStorage();
  const asset = await createVideoAsset(ctx.project.id, { durationSeconds: 90 });
  await storage.put(asset.storageKey, Buffer.from("original-bytes-" + asset.id), asset.mimeType);
  const t = await videoTargetSetup({ durationSeconds: 90 }, true, "spy-video", { project: ctx.project, storage, asset });
  return { ...t, scope };
}

/** Records a `video` worker heartbeat at `at`, or removes it. */
export async function videoHeartbeat(at: Date | null) {
  await testDb().delete(schedulerHeartbeats).where(eq(schedulerHeartbeats.section, "video"));
  if (at) await testDb().insert(schedulerHeartbeats).values({ section: "video", lastSuccessAt: at, lastSummary: {}, updatedAt: at });
}

export const versionRows = (projectId: string) => testDb().select().from(videoVersions).where(eq(videoVersions.projectId, projectId));
