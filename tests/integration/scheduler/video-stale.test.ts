import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createVideoAsset } from "../../helpers/factories";
import { parkAllDueTargets } from "../../helpers/scheduling";
import { markReady, queueVersionFor, received } from "../../helpers/video-publish-setup";
import { versionRows, waitSetup } from "../../helpers/video-wait";

beforeEach(async () => {
  received.length = 0;
  await parkAllDueTargets();
});
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

describe("a version built for something that changed is never used (FR-023)", () => {
  it("waits for the new video's own version when the post's media changed", async () => {
    const t = await waitSetup();
    const { version } = await queueVersionFor(t);
    const key = `projects/${t.project.id}/video/a.mp4`;
    await t.storage.put(key, Buffer.from("adapted-a"), "video/mp4");
    await markReady(t.project.id, version.id, key, t.storage.publicUrl(key));

    const other = await createVideoAsset(t.project.id, { durationSeconds: 120 });
    await t.storage.put(other.storageKey, Buffer.from("other"), other.mimeType);
    await t.repos.posts.setMedia(t.post.id, [other.id]);

    const result = await runTick({ config: {} });
    expect(result.publishing.counts).toMatchObject({ waitingForVideo: 1, done: 0 });
    expect(received).toHaveLength(0);
    const rows = await versionRows(t.project.id);
    expect(rows.filter((r) => r.mediaAssetId === other.id)).toHaveLength(1);
  });

  it("never publishes an adapted file of a deleted video", async () => {
    const t = await waitSetup();
    const { version } = await queueVersionFor(t);
    const key = `projects/${t.project.id}/video/b.mp4`;
    await t.storage.put(key, Buffer.from("adapted-b"), "video/mp4");
    await markReady(t.project.id, version.id, key, t.storage.publicUrl(key));
    await t.repos.media.softDelete(t.asset.id, new Date());

    const result = await runTick({ config: {} });
    expect(received).toHaveLength(0);
    expect(result.publishing.counts).toMatchObject({ done: 0 });
    expect(await t.repos.targets.get(t.target.id)).toMatchObject({ status: "failed" });
  });
});
