// Spec US2: a target set to Reel runs start → upload → check → finish → check on the step machine.
// Mocked Graph and rupload only; the DB clock is pinned with `atTime`, never slept.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { facebookVideoSetup, PAGE_ID } from "../../helpers/facebook-publish";
import { createFakeGraph, type FakeGraph, type GraphReply } from "../../helpers/fake-graph";
import { parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage, type MemoryStorage } from "../../helpers/storage";

let graph: FakeGraph;
let storage: MemoryStorage;
beforeEach(async () => {
  await parkAllDueTargets();
  graph = createFakeGraph().install();
  storage = createMemoryStorage();
  setStorageForTests(storage);
});
afterEach(() => graph.uninstall());
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

const reels = `/v26.0/${PAGE_ID}/video_reels`;
const upload = "/video-upload/77";
const statusPath = "/v26.0/77";
const T0 = Date.now() + 60_000;
const tickAt = (seconds: number) => atTime(new Date(T0 + seconds * 1000), async () => (await runTick({ config: {} })).publishing.counts);

const reads = () => graph.requests.filter((r) => r.method === "GET" && r.path === statusPath);
const phases = (u: string, p: string, v: string, ps?: string): GraphReply => ({
  kind: "ok",
  body: { status: { video_status: v, uploading_phase: { status: u }, processing_phase: { status: p }, publishing_phase: { status: "not_started", ...(ps ? { publish_status: ps } : {}) } } },
});
const uploading = phases("in_progress", "not_started", "upload_in_progress");
const uploadDone = phases("complete", "not_started", "upload_complete");
const processing = phases("complete", "in_progress", "processing");
const published = phases("complete", "complete", "ready", "published");

function scriptReel(reads_: GraphReply[]) {
  graph.on("POST", reels, (req) =>
    req.params.upload_phase === "start"
      ? { kind: "ok", body: { video_id: "77", upload_url: `https://rupload.facebook.com${upload}` } }
      : { kind: "ok", body: { success: true } },
  );
  graph.on("GET", statusPath, reads_);
}

describe("Facebook Reel through the real scheduler", () => {
  it("runs the whole flow at the pace and publishes", async () => {
    scriptReel([uploading, uploading, uploadDone, processing, processing, processing, published]);
    const { tick, row } = await facebookVideoSetup(storage, "A reel", { postType: "reel", video: { width: 1080, height: 1920 } });
    void tick;

    expect(await tickAt(0)).toMatchObject({ claimed: 1 }); // start_reel
    expect(graph.requests.filter((r) => r.path === reels)).toHaveLength(1);
    expect(graph.requests[0]!.params).toMatchObject({ upload_phase: "start" });

    await tickAt(1); // upload_reel
    const up = graph.requests.find((r) => r.path === upload)!;
    expect(up.host).toBe("rupload.facebook.com");
    expect(up.headers.file_url).toMatch(/^http/);
    expect(up.bodyBytes).toBe(0);
    expect(up.hadToken).toBe(true);

    // The first status read is due one minute after the upload, not before.
    expect(await tickAt(30)).toMatchObject({ claimed: 0 });
    expect(reads()).toHaveLength(0);
    await tickAt(62); // uploading
    await tickAt(100); // not due (next at +60 s after 62)
    expect(reads()).toHaveLength(1);
    await tickAt(125); // uploading
    await tickAt(190); // complete
    expect(reads()).toHaveLength(3);

    await tickAt(191); // finish_reel (no wait after a complete upload)
    const finish = graph.requests.filter((r) => r.path === reels).at(-1)!;
    expect(finish.params).toMatchObject({ upload_phase: "finish", video_id: "77", video_state: "PUBLISHED", description: "A reel" });
    for (const k of ["title", "place", "scheduled_publish_time", "thumb", "offset", "file_size"]) expect(finish.params[k]).toBeUndefined();
    expect((await row()).status).not.toBe("published");

    await tickAt(200); // not due: first publish check is a minute after finish
    expect(reads()).toHaveLength(3);
    await tickAt(255); // processing
    await tickAt(320); // processing
    await tickAt(385); // processing
    expect((await row()).status).not.toBe("published");
    await tickAt(450); // published
    expect(await row()).toMatchObject({ status: "published", externalId: "77" });
    expect(reads()).toHaveLength(7);
    const flat = JSON.stringify(graph.requests);
    expect(flat).not.toContain("EAAB-page-token");
  });

  it("an upload that completes within five minutes advances within two ticks (SC-004)", async () => {
    scriptReel([uploadDone, processing]);
    const { row } = await facebookVideoSetup(storage, "A reel", { postType: "reel", video: { width: 1080, height: 1920 } });
    await tickAt(0); // start
    await tickAt(1); // upload
    await tickAt(62); // check → complete
    await tickAt(63); // finish
    const finish = graph.requests.filter((r) => r.path === reels).at(-1)!;
    expect(finish.params.upload_phase).toBe("finish");
    expect((await row()).status).not.toBe("failed");
  });

  it("a stuck upload makes at most 10 reads, then fails", async () => {
    scriptReel([uploading]);
    const { row } = await facebookVideoSetup(storage, "A reel", { postType: "reel", video: { width: 1080, height: 1920 } });
    await tickAt(0);
    await tickAt(1);
    for (let s = 62; s <= 31 * 60; s += 61) await tickAt(s);
    expect(reads().length).toBeLessThanOrEqual(10);
    expect(reads().length).toBeGreaterThanOrEqual(9);
    expect((await row()).status).toBe("failed");
  });

  it("a Reel that never confirms makes at most 16 reads, then is ambiguous (SC-005)", async () => {
    scriptReel([uploadDone, processing]);
    const { row } = await facebookVideoSetup(storage, "A reel", { postType: "reel", video: { width: 1080, height: 1920 } });
    await tickAt(0);
    await tickAt(1);
    await tickAt(62); // upload complete
    await tickAt(63); // finish
    for (let s = 125; s <= 63 * 60; s += 61) await tickAt(s);
    const publishReads = reads().length - 1;
    expect(publishReads).toBeLessThanOrEqual(16);
    expect(publishReads).toBeGreaterThanOrEqual(14);
    expect((await row()).status).toBe("ambiguous");
  });
});
