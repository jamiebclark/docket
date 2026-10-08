// Spec US3: every way a Reel can fail, stall or be interrupted ends in the right state.
// Mocked Graph and rupload only; the DB clock is pinned with `atTime`, never slept.
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
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
const sentFinish = () => graph.requests.some((r) => r.path === reels && r.params.upload_phase === "finish");

const phases = (u: string, p: string, v: string, ps?: string, extra: Record<string, unknown> = {}): GraphReply => ({
  kind: "ok",
  body: { status: { video_status: v, uploading_phase: { status: u, ...extra }, processing_phase: { status: p }, publishing_phase: { status: "not_started", ...(ps ? { publish_status: ps } : {}) } } },
});
const uploading = phases("in_progress", "not_started", "upload_in_progress");
const uploadFailed = phases("error", "not_started", "error", undefined, { errors: [{ message: "bad bytes" }] });
const uploadDone = phases("complete", "not_started", "upload_complete");
const processing = phases("complete", "in_progress", "processing");
const processingError = phases("complete", "error", "error");
const expired = phases("complete", "complete", "expired");

interface Script {
  start?: GraphReply;
  upload?: GraphReply;
  finish?: GraphReply;
  reads: GraphReply | GraphReply[];
}
function script(s: Script) {
  graph.on("POST", reels, (req) =>
    req.params.upload_phase === "start"
      ? (s.start ?? { kind: "ok", body: { video_id: "77", upload_url: `https://rupload.facebook.com${upload}` } })
      : (s.finish ?? { kind: "ok", body: { success: true } }),
  );
  graph.on("POST", upload, s.upload ?? { kind: "ok", body: { success: true } });
  graph.on("GET", statusPath, s.reads);
}
const setup = (text = "A reel") => facebookVideoSetup(storage, text, { postType: "reel", video: { width: 1080, height: 1920 } });

/** Ticks one a second until `until` seconds; the engine itself decides what is due. */
async function drive(from: number, until: number, step = 61) {
  for (let s = from; s <= until; s += step) await tickAt(s);
}
const accountStatus = async (projectId: string, id: string) =>
  (await testDb().select().from(socialAccounts).where(and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.id, id))))[0]!.status;

describe("a Reel that fails before finish", () => {
  it("a failed upload check fails with the storage reminder and never finishes", async () => {
    script({ reads: uploadFailed });
    const { row } = await setup();
    await drive(0, 200);
    const after = await row();
    expect(after.status).toBe("failed");
    expect(after.lastError).toContain("could not receive the video");
    expect(sentFinish()).toBe(false);
  });

  it("an upload that never completes fails at 30 minutes after at most 10 checks", async () => {
    script({ reads: uploading });
    const { row } = await setup();
    await tickAt(0);
    await tickAt(1);
    await drive(62, 31 * 60);
    expect(reads().length).toBeLessThanOrEqual(10);
    const after = await row();
    expect(after.status).toBe("failed");
    expect(after.lastError).toContain("within 30 minutes");
    expect(sentFinish()).toBe(false);
  });

  it("a bad upload host makes no request to it and fails (SC-007)", async () => {
    script({ start: { kind: "ok", body: { video_id: "77", upload_url: "https://evil.example.com/video-upload/77" } }, reads: uploading });
    const { row } = await setup();
    await tickAt(0);
    await tickAt(1);
    expect(graph.requests.some((r) => r.host === "evil.example.com")).toBe(false);
    expect((await row()).status).toBe("failed");
  });

  it("a token rejected before finish is fatal, flags the account and sends nothing more", async () => {
    for (const at of ["start", "upload", "check"] as const) {
      graph.reset();
      await parkAllDueTargets();
      const denied: GraphReply = { kind: "graph_error", code: 190, message: "Invalid OAuth access token", status: 401 };
      script({
        ...(at === "start" ? { start: denied } : {}),
        ...(at === "upload" ? { upload: denied } : {}),
        reads: at === "check" ? denied : uploadDone,
      });
      const s = await setup(`reel ${at}`);
      await drive(0, 200);
      const row = await s.row();
      expect(row.status, at).toBe("failed");
      expect(await accountStatus(s.projectId, s.accountId), at).toBe("needs_reauth");
      expect(sentFinish(), at).toBe(false);
    }
  });
});

describe("a Reel after finish was sent", () => {
  async function finished(reads_: GraphReply | GraphReply[], text = "A reel") {
    script({ reads: reads_ });
    const s = await setup(text);
    await tickAt(0); // start
    await tickAt(1); // upload
    await tickAt(62); // check → complete
    await tickAt(63); // finish
    expect(sentFinish()).toBe(true);
    return s;
  }

  it("a processing error fails with the causes", async () => {
    const { row } = await finished([uploadDone, processingError]);
    await drive(125, 200);
    const after = await row();
    expect(after.status).toBe("failed");
    expect(after.lastError).toContain("could not process the Reel");
  });

  it("an expired video fails", async () => {
    const { row } = await finished([uploadDone, expired]);
    await drive(125, 200);
    expect((await row()).status).toBe("failed");
  });

  it("never confirming is ambiguous at 60 minutes after at most 16 checks", async () => {
    const { row } = await finished([uploadDone, processing]);
    await drive(125, 63 * 60);
    expect(reads().length - 1).toBeLessThanOrEqual(16);
    const after = await row();
    expect(after.status).toBe("ambiguous");
    expect(after.lastError).toContain("within 60 minutes");
  });

  it("dropped or unreadable status reads never fail the Reel (SC-003)", async () => {
    const bad: GraphReply[] = [
      { kind: "http", status: 503 },
      { kind: "unparseable" },
      { kind: "pre_send_failure" },
      { kind: "graph_error", code: 1, message: "Temporary", status: 500 },
      { kind: "reset_mid_body" },
    ];
    const { row } = await finished([uploadDone, ...bad, phases("complete", "complete", "ready", "published")]);
    for (let i = 0; i < bad.length; i++) {
      await tickAt(125 + i * 400);
      expect((await row()).status, `after read ${i}`).not.toBe("failed");
    }
    await tickAt(125 + bad.length * 400);
    expect(await row()).toMatchObject({ status: "published", externalId: "77" });
  });

  it("a rejected token is ambiguous and flags the account", async () => {
    const s = await finished([uploadDone, { kind: "graph_error", code: 190, message: "Invalid OAuth access token", status: 401 }]);
    await drive(125, 200);
    expect((await s.row()).status).toBe("ambiguous");
    expect(await accountStatus(s.projectId, s.accountId)).toBe("needs_reauth");
  });

  it("an account flagged by another Reel's rejected token leaves a finished Reel ambiguous, with no new request", async () => {
    const s = await finished([uploadDone, processing]);
    await testDb().update(socialAccounts).set({ status: "needs_reauth" }).where(and(eq(socialAccounts.projectId, s.projectId), eq(socialAccounts.id, s.accountId)));
    const before = graph.requests.length;
    await drive(125, 200);
    expect((await s.row()).status).toBe("ambiguous");
    expect(graph.requests).toHaveLength(before);
    expect(graph.requests.filter((r) => r.path === reels && r.params.upload_phase === "start")).toHaveLength(1);
  });

  it("an unreadable finish reply is ambiguous, never retried", async () => {
    script({ reads: uploadDone, finish: { kind: "unparseable" } });
    const { row } = await setup();
    await tickAt(0);
    await tickAt(1);
    await tickAt(62);
    await tickAt(63);
    await drive(125, 4000);
    expect((await row()).status).toBe("ambiguous");
    expect(graph.requests.filter((r) => r.params.upload_phase === "finish")).toHaveLength(1);
  });
});

describe("restarts and changed choices", () => {
  it("every tick resumes from the saved state: ticks spread over hours still publish once", async () => {
    script({ reads: [uploadDone, phases("complete", "complete", "ready", "published")] });
    const { row } = await setup();
    for (const s of [0, 3600, 7200, 10_800, 14_400, 18_000]) await tickAt(s);
    expect(await row()).toMatchObject({ status: "published", externalId: "77" });
    expect(graph.requests.filter((r) => r.params.upload_phase === "start")).toHaveLength(1);
    expect(graph.requests.filter((r) => r.params.upload_phase === "finish")).toHaveLength(1);
  });

  it("a choice changed before finish publishes as the new choice and never finishes the old Reel", async () => {
    graph.on("POST", `/v26.0/${PAGE_ID}/videos`, { kind: "ok", body: { id: "88" } });
    script({ reads: uploading });
    const s = await setup();
    await tickAt(0);
    await tickAt(1);
    await s.setPostType(null); // back to a Page video
    await drive(62, 300);
    expect(sentFinish()).toBe(false);
    const after = await s.row();
    expect(after).toMatchObject({ status: "published", externalId: "88" });
    expect(graph.requests.filter((r) => r.path === `/v26.0/${PAGE_ID}/videos`)).toHaveLength(1);
  });
});
