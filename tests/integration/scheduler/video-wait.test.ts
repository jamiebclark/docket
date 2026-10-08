import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { videoVersions } from "../../../src/server/db/schema";
import { runTick } from "../../../src/server/scheduler";
import * as posts from "../../../src/server/services/posts";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { parkAllDueTargets } from "../../helpers/scheduling";
import { markReady, queueVersionFor, received, videoTargetSetup } from "../../helpers/video-publish-setup";
import { versionRows, videoHeartbeat, waitSetup } from "../../helpers/video-wait";

beforeEach(async () => {
  received.length = 0;
  await parkAllDueTargets();
});
afterAll(async () => {
  setStorageForTests(undefined);
  await videoHeartbeat(null);
  await closeDb();
});

const later = (ms: number) => new Date(Date.now() + ms);
const setState = (projectId: string, id: string, set: Partial<typeof videoVersions.$inferInsert>) =>
  testDb().update(videoVersions).set(set).where(and(eq(videoVersions.projectId, projectId), eq(videoVersions.id, id)));

describe("a due target waits for its adapted video (US5)", () => {
  it("makes no provider call and no attempt row while the version is queued", async () => {
    const t = await waitSetup();
    await queueVersionFor(t);
    const first = await runTick({ config: {} });
    const second = await atTime(later(90_000), () => runTick({ config: {} }));
    expect(first.publishing.counts).toMatchObject({ waitingForVideo: 1, done: 0 });
    expect(second.publishing.counts).toMatchObject({ waitingForVideo: 1 });
    expect(received).toHaveLength(0);
    const target = await t.repos.targets.get(t.target.id);
    expect(target).toMatchObject({ status: "scheduled", attemptCount: 0 });
    expect(target!.videoWaitSince).not.toBeNull();
    expect(await t.repos.attempts.listForTarget(t.target.id)).toHaveLength(0);
    const view = await posts.getPost(t.scope, t.post.id);
    expect(view.targets[0]).toMatchObject({ preparingVideo: true });
  });

  it("publishes the version on the tick after it is ready and clears the wait", async () => {
    const t = await waitSetup();
    const { version } = await queueVersionFor(t);
    await runTick({ config: {} });
    const key = `projects/${t.project.id}/video/v.mp4`;
    await t.storage.put(key, Buffer.from("adapted"), "video/mp4");
    await markReady(t.project.id, version.id, key, t.storage.publicUrl(key));
    const result = await atTime(later(90_000), () => runTick({ config: {} }));
    expect(result.publishing.counts).toMatchObject({ done: 1 });
    expect(received[0]!.media[0]).toMatchObject({ url: t.storage.publicUrl(key) });
    expect((await t.repos.targets.get(t.target.id))!.videoWaitSince).toBeNull();
  });

  it("fails on a failed version with one engine-video attempt, and Retry queues it again", async () => {
    const t = await waitSetup();
    const { version } = await queueVersionFor(t);
    await setState(t.project.id, version.id, { state: "failed", error: "Docket could not read the video." });
    const result = await runTick({ config: {} });
    expect(result.publishing.counts).toMatchObject({ failed: 1 });
    expect(received).toHaveLength(0);
    const failed = await t.repos.targets.get(t.target.id);
    expect(failed).toMatchObject({ status: "failed", lastError: "The video could not be adapted for Spy: Docket could not read the video." });
    const attempts = await t.repos.attempts.listForTarget(t.target.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ step: "engine-video", outcome: "fatal_error" });

    await posts.retryTarget(t.scope, t.target.id, { mode: "now" });
    const [row] = (await versionRows(t.project.id)).filter((r) => r.id === version.id);
    expect(row).toMatchObject({ state: "queued", attempts: 0, error: null });
    expect(await t.repos.targets.get(t.target.id)).toMatchObject({ status: "scheduled", videoWaitSince: null });
  });

  it("fails after two hours: 'took too long' with a worker heartbeat, 'needs the worker' without", async () => {
    for (const alive of [true, false]) {
      await parkAllDueTargets();
      const t = await waitSetup();
      await queueVersionFor(t);
      await runTick({ config: {} });
      const end = later(2 * 60 * 60 * 1000 + 61_000);
      await videoHeartbeat(alive ? end : null);
      const result = await atTime(end, () => runTick({ config: {} }));
      expect(result.publishing.counts).toMatchObject({ failed: 1 });
      const target = await t.repos.targets.get(t.target.id);
      expect(target).toMatchObject({ status: "failed", videoWaitSince: null });
      expect(target!.lastError).toBe(
        `The video could not be adapted for Spy: ${alive ? "it took too long." : "video adapting needs the worker process, which is not running."}`,
      );
      expect(received).toHaveLength(0);
    }
  });

  it("queues a missing version itself and waits", async () => {
    const t = await waitSetup();
    expect(await versionRows(t.project.id)).toHaveLength(0);
    await runTick({ config: {} });
    const rows = await versionRows(t.project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "queued", mediaAssetId: t.asset.id });
    expect(received).toHaveLength(0);
  });

  it("leaves a video that needs no adapting alone", async () => {
    const t = await videoTargetSetup({ durationSeconds: 20 });
    const result = await runTick({ config: {} });
    expect(result.publishing.counts).toMatchObject({ done: 1, waitingForVideo: 0 });
    expect(await versionRows(t.project.id)).toHaveLength(0);
  });
});
