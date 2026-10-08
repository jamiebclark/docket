import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const runTool = vi.hoisted(() => vi.fn());
vi.mock("../../../src/server/video/spawn", async (orig) => ({ ...(await orig<object>()), runTool }));

import { videoVersions } from "../../../src/server/db/schema";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb, testDb } from "../../helpers/db";
import { parkAllDueTargets } from "../../helpers/scheduling";
import { received, videoTargetSetup } from "../../helpers/video-publish-setup";
import { and } from "drizzle-orm";

beforeEach(async () => {
  received.length = 0;
  runTool.mockClear();
  await parkAllDueTargets();
});
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

describe("a video inside every limit", () => {
  it("reaches the provider as the stored original: same URL, same bytes, no version, no tool", async () => {
    const t = await videoTargetSetup({ durationSeconds: 20, width: 1280, height: 720 });
    const result = await runTick({ config: {} });
    expect(result.publishing.counts).toMatchObject({ done: 1 });
    expect(received).toHaveLength(1);
    expect(received[0]!.media[0]).toMatchObject({ url: t.asset.publicUrl, kind: "video" });
    expect(await t.storage.get(t.asset.storageKey)).toEqual(t.original);
    const rows = await testDb()
      .select()
      .from(videoVersions)
      .where(and(eq(videoVersions.projectId, t.project.id), eq(videoVersions.mediaAssetId, t.asset.id)));
    expect(rows).toHaveLength(0);
    expect(runTool).not.toHaveBeenCalled();
  });
});
