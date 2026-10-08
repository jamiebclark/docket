import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createSchedulingRepos } from "../../../src/server/dal/scope";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { markWorkerProcess } from "../../../src/server/video/guard";
import { probeFile } from "../../../src/server/video/probe";
import { buildNext } from "../../../src/server/video/versions-loop";
import { closeDb, testDb } from "../../helpers/db";
import { createProject, createVideoAsset } from "../../helpers/factories";
import { requireFfmpeg } from "../../helpers/ffmpeg";
import { createMockAccount, createDueTarget, parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage } from "../../helpers/storage";
import { createVideoFixtures, type VideoFixtures } from "../../helpers/video-fixtures";
import { queueVersionFor, received, receivedStrict, strictVideoProvider } from "../../helpers/video-publish-setup";

const signal = new AbortController().signal;

beforeEach(async () => {
  received.length = 0;
  receivedStrict.length = 0;
  await parkAllDueTargets();
});
afterEach(() => setStorageForTests(undefined));
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

requireFfmpeg()("one video, two targets, one too strict for it", () => {
  let fx: VideoFixtures;
  beforeAll(() => {
    fx = createVideoFixtures();
  });
  afterAll(() => fx?.cleanup());

  it("publishes the original where it fits and a built version where it does not", async () => {
    markWorkerProcess();
    const storage = createMemoryStorage();
    setStorageForTests(storage);
    const project = await createProject();
    const repos = createSchedulingRepos(testDb(), project.id);
    const bytes = readFileSync(fx.landscape);
    const asset = await createVideoAsset(project.id, { width: 320, height: 180, durationSeconds: 2, frameRate: 15, byteSize: bytes.length });
    await storage.put(asset.storageKey, bytes, "video/mp4");

    const fits = await createMockAccount(project.id, {}, { providerKey: "spy-video" });
    const strict = await createMockAccount(project.id, {}, { providerKey: "spy-video-strict" });
    for (const account of [fits, strict]) {
      const { post } = await createDueTarget(project.id, account.id);
      await repos.posts.setMedia(post.id, [asset.id]);
    }
    const { version } = await queueVersionFor({ repos, asset }, strictVideoProvider);
    expect(await buildNext({ signal })).toBe(true);

    await runTick({ config: {} });

    // Fits: the stored original, byte for byte.
    expect(received).toHaveLength(1);
    expect(received[0]!.media[0]).toMatchObject({ url: asset.publicUrl });
    expect(await storage.get(asset.storageKey)).toEqual(bytes);

    // Does not fit: a version that meets the strict target's limits.
    expect(receivedStrict).toHaveLength(1);
    const item = receivedStrict[0]!.media[0]!;
    expect(item.url).not.toBe(asset.publicUrl);
    const [row] = await repos.videoVersions.getByKeys([{ assetId: asset.id, kind: "full", key: version.key }]);
    expect(row).toMatchObject({ state: "ready", publicUrl: item.url });
    const built = await storage.get(row!.storageKey!);
    const path = join(fx.dir, "published-version.mp4");
    writeFileSync(path, built!);
    const probed = await probeFile(path, signal);
    if ("error" in probed) throw new Error("version unreadable");
    expect(probed.width).toBe(probed.height);
    expect(probed.width).toBeLessThanOrEqual(200);
    expect(Math.abs(probed.durationSeconds - 1)).toBeLessThanOrEqual(0.1);
    expect(probed.frameRate ?? 0).toBeLessThanOrEqual(10.5);
    expect(probed.videoCodec).toBe("h264");
    expect(probed.audioCodec).toBe("aac");
  });
});
