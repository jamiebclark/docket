import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { videoVersions } from "../../../src/server/db/schema";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb, testDb } from "../../helpers/db";
import { parkAllDueTargets } from "../../helpers/scheduling";
import { markReady, queueVersionFor, received, videoTargetSetup } from "../../helpers/video-publish-setup";

beforeEach(async () => {
  received.length = 0;
  await parkAllDueTargets();
});
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

const rowOf = async (projectId: string, id: string) =>
  (await testDb().select().from(videoVersions).where(and(eq(videoVersions.projectId, projectId), eq(videoVersions.id, id))))[0]!;

describe("publishing an adapted video", () => {
  it("requeues a ready version whose object is gone and publishes nothing", async () => {
    const t = await videoTargetSetup({ durationSeconds: 90 });
    const { version } = await queueVersionFor(t);
    await markReady(t.project.id, version.id, `projects/${t.project.id}/video/v.mp4`, "https://media.example.test/v.mp4");
    // The object was never stored: it has vanished.
    const result = await runTick({ config: {} });
    expect(result.publishing.counts).toMatchObject({ released: 1 });
    expect(received).toHaveLength(0);
    expect(await rowOf(t.project.id, version.id)).toMatchObject({ state: "queued", storageKey: null, attempts: 0 });
    expect(await t.repos.targets.get(t.target.id)).toMatchObject({ status: "scheduled" });
  });

  it("publishes the version's URL when its object exists", async () => {
    const t = await videoTargetSetup({ durationSeconds: 90 });
    const { version } = await queueVersionFor(t);
    const key = `projects/${t.project.id}/video/v.mp4`;
    await t.storage.put(key, Buffer.from("adapted"), "video/mp4");
    await markReady(t.project.id, version.id, key, t.storage.publicUrl(key));
    const result = await runTick({ config: {} });
    expect(result.publishing.counts).toMatchObject({ done: 1 });
    expect(received[0]!.media[0]).toMatchObject({ url: t.storage.publicUrl(key), mimeType: "video/mp4", bytes: 1234 });
  });

  it("waits, with no provider call, when no version exists yet", async () => {
    const t = await videoTargetSetup({ durationSeconds: 90 });
    const result = await runTick({ config: {} });
    expect(received).toHaveLength(0);
    expect(result.publishing.counts).toMatchObject({ waitingForVideo: 1 });
    expect(await t.repos.targets.get(t.target.id)).toMatchObject({ status: "scheduled" });
  });
});
