// US1: one video publishes as a Feed video or a Reel through the step machine, polled until Instagram finishes it.
// Mocked Graph only; the DB clock is pinned with `atTime`, never slept.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowanceUses } from "../../../src/server/db/schema/scheduler";
import { postTargets } from "../../../src/server/db/schema/posts";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { PAGE_TOKEN } from "../../helpers/facebook-publish";
import { createFakeGraph, type FakeGraph, type GraphReply } from "../../helpers/fake-graph";
import { IG_ID, instagramVideoSetup } from "../../helpers/instagram-publish";
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

const media = `/v26.0/${IG_ID}/media`;
const quota = `/v26.0/${IG_ID}/content_publishing_limit`;
const publish = `/v26.0/${IG_ID}/media_publish`;
const T0 = Date.now() + 60_000;
const tickAt = (seconds: number) => atTime(new Date(T0 + seconds * 1000), async () => (await runTick({ config: {} })).publishing.counts);

const creates = () => graph.requests.filter((r) => r.method === "POST" && r.path === media);
const publishes = () => graph.requests.filter((r) => r.path === publish);
const reads = () => graph.requests.filter((r) => r.method === "GET" && r.path === "/v26.0/r1");
const quotaOk: GraphReply = { kind: "ok", body: { data: [{ quota_usage: 3, config: { quota_total: 100 } }] } };

function script(statuses: GraphReply | GraphReply[]) {
  let n = 0;
  graph.on("POST", media, () => ({ kind: "ok", body: { id: `r${++n}` } }));
  graph.on("GET", "/v26.0/r1", statuses);
  graph.on("GET", quota, quotaOk);
  graph.on("POST", publish, { kind: "ok", body: { id: "ig_reel_1" } });
}
const inProgress: GraphReply = { kind: "ok", body: { status_code: "IN_PROGRESS" } };
const finished: GraphReply = { kind: "ok", body: { status_code: "FINISHED" } };

describe("a single video through the real scheduler", () => {
  for (const [label, postType, shareToFeed] of [
    ["Feed video", "video", "true"],
    ["Reel", "reel", "false"],
  ] as const) {
    it(`${label}: create, three IN_PROGRESS reads a minute apart, FINISHED, quota, one publish`, async () => {
      script([inProgress, inProgress, inProgress, finished]);
      const { row } = await instagramVideoSetup(storage, "watch this", ["video"], { postType });
      expect(await tickAt(0)).toMatchObject({ claimed: 1, continued: 1 });
      expect(creates()[0]!.params).toMatchObject({ media_type: "REELS", caption: "watch this", share_to_feed: shareToFeed });
      expect(creates()[0]!.params.video_url).toBeTruthy();
      expect((await row()).nextAttemptAt!.getTime() - T0).toBe(60_000);
      expect(await tickAt(30)).toMatchObject({ claimed: 0 });
      for (const at of [61, 122, 183]) {
        expect(await tickAt(at)).toMatchObject({ claimed: 1, continued: 1 });
        expect((await row()).nextAttemptAt!.getTime() - (T0 + at * 1000)).toBe(60_000);
      }
      expect(await tickAt(244)).toMatchObject({ claimed: 1, continued: 1 }); // FINISHED
      expect(await tickAt(245)).toMatchObject({ claimed: 1, continued: 1 }); // quota
      expect(await tickAt(246)).toMatchObject({ claimed: 1, done: 1 });
      expect(reads()).toHaveLength(4);
      expect(reads()[0]!.params.fields).toBe("status_code,status");
      expect(creates()).toHaveLength(1);
      expect(publishes()).toHaveLength(1);
      // Image posts store no link either (the provider reports the media id only), so parity is the contract.
      expect(await row()).toMatchObject({ status: "published", externalId: "ig_reel_1", externalUrl: null });
      for (const r of graph.requests) expect(JSON.stringify(r.params)).not.toContain('"VIDEO"');
    });
  }

  it("moves to the 5-minute pace after 5 minutes, and fails at 60 minutes within 16 reads", async () => {
    script(inProgress);
    const { row } = await instagramVideoSetup(storage, "slow", ["video"], { postType: "video" });
    await tickAt(0);
    let failed = false;
    for (let s = 60; s <= 66 * 60 && !failed; s += 60) {
      const counts = await tickAt(s);
      if (s === 300) expect((await row()).nextAttemptAt!.getTime() - (T0 + s * 1000)).toBe(300_000);
      failed = counts.failed === 1;
    }
    const final = await row();
    expect(final.status).toBe("failed");
    expect(final.lastError).toContain("did not finish processing the video within 60 minutes; nothing was published");
    expect(reads().length).toBeLessThanOrEqual(16);
    expect(publishes()).toHaveLength(0);
  });

  it("ERROR fails with the detail and none of the token", async () => {
    script({ kind: "ok", body: { status_code: "ERROR", status: `Error: unsupported codec ${PAGE_TOKEN}` } });
    const { row } = await instagramVideoSetup(storage, "bad", ["video"], { postType: "video" });
    await tickAt(0);
    expect(await tickAt(61)).toMatchObject({ claimed: 1, failed: 1 });
    const r = await row();
    expect(r.lastError).toContain("Instagram could not process the video: Error: unsupported codec [redacted]");
    expect(r.lastError).not.toContain(PAGE_TOKEN);
    expect(JSON.stringify(r)).not.toContain(PAGE_TOKEN);
    expect(publishes()).toHaveLength(0);
  });

  it("EXPIRED rebuilds the container up to twice, then fails", async () => {
    let n = 0;
    graph.on("POST", media, () => ({ kind: "ok", body: { id: `r${++n}` } }));
    for (const id of ["r1", "r2", "r3"]) graph.on("GET", `/v26.0/${id}`, { kind: "ok", body: { status_code: "EXPIRED" } });
    const { row } = await instagramVideoSetup(storage, "again", ["video"], { postType: "reel" });
    let s = 0;
    for (let round = 0; round < 2; round++) {
      await tickAt(s);
      s += 61;
      expect(await tickAt(s)).toMatchObject({ claimed: 1, continued: 1 });
      s += 1;
    }
    await tickAt(s);
    s += 61;
    expect(await tickAt(s)).toMatchObject({ claimed: 1, failed: 1 });
    expect(creates()).toHaveLength(3);
    expect(creates().every((r) => r.params.share_to_feed === "false")).toBe(true);
    expect((await row()).lastError).toContain("tried 3 times");
    expect(publishes()).toHaveLength(0);
  });

  for (const reply of [{ kind: "http", status: 503 }, { kind: "reset_mid_body" }] as GraphReply[]) {
    it(`a ${reply.kind} on create or check is retried, and on publish is ambiguous (never retried)`, async () => {
      // create
      graph.on("POST", media, [reply, { kind: "ok", body: { id: "r1" } }]);
      graph.on("GET", "/v26.0/r1", [reply, finished]);
      graph.on("GET", quota, quotaOk);
      graph.on("POST", publish, reply);
      const { row } = await instagramVideoSetup(storage, "flaky", ["video"], { postType: "video" });
      expect(await tickAt(0)).toMatchObject({ retried: 1 });
      expect(creates()).toHaveLength(1);
      let s = 1000;
      expect(await tickAt(s)).toMatchObject({ claimed: 1, continued: 1 }); // create succeeds
      s += 61;
      expect(await tickAt(s)).toMatchObject({ retried: 1 }); // check retried
      s += 1000;
      expect(await tickAt(s)).toMatchObject({ claimed: 1, continued: 1 }); // FINISHED
      s += 1;
      expect(await tickAt(s)).toMatchObject({ continued: 1 }); // quota
      s += 1;
      expect(await tickAt(s)).toMatchObject({ ambiguous: 1 });
      expect((await row()).status).toBe("ambiguous");
      const sent = graph.requests.length;
      expect(await tickAt(s + 5000)).toMatchObject({ claimed: 0 });
      expect(graph.requests).toHaveLength(sent);
      expect(publishes()).toHaveLength(1);
    });
  }

  it("a published-already status is ambiguous and nothing is published", async () => {
    script({ kind: "ok", body: { status_code: "PUBLISHED" } });
    await instagramVideoSetup(storage, "dup", ["video"], { postType: "video" });
    await tickAt(0);
    expect(await tickAt(61)).toMatchObject({ claimed: 1, ambiguous: 1 });
    expect(publishes()).toHaveLength(0);
  });

  it("switching to Reel before publish restarts at create_container with share_to_feed=false", async () => {
    script(finished);
    graph.on("GET", "/v26.0/r2", finished);
    const { row, setPostType } = await instagramVideoSetup(storage, "switch", ["video"], { postType: "video" });
    await tickAt(0);
    await tickAt(61); // FINISHED
    await tickAt(62); // quota
    await setPostType("reel");
    expect(await tickAt(63)).toMatchObject({ claimed: 1, continued: 1 });
    expect(creates()).toHaveLength(2);
    expect(creates().map((r) => r.params.share_to_feed)).toEqual(["true", "false"]);
    expect(publishes()).toHaveLength(0);
    await tickAt(125);
    await tickAt(126);
    expect(await tickAt(127)).toMatchObject({ done: 1 });
    expect(publishes()).toHaveLength(1);
    expect((await row()).status).toBe("published");
  });

  it("a create_container killed mid-flight is retried: one retry unit of allowance and exactly one publish", async () => {
    script([inProgress, finished]);
    const { projectId, targetId, row } = await instagramVideoSetup(storage, "killed", ["video"], { postType: "video" });
    const past = new Date(T0 - 60_000);
    await testDb()
      .update(postTargets)
      .set({ status: "publishing", leaseOwner: randomUUID(), leaseUntil: past, inFlightStep: "create_container", inFlightMayPublish: false, firstStepAt: past })
      .where(and(eq(postTargets.projectId, projectId), eq(postTargets.id, targetId)));
    expect(await tickAt(0)).toMatchObject({ recovered: 1, ambiguous: 0 });
    for (let s = 61; s <= 600 && (await row()).status !== "published"; s += 61) await tickAt(s);
    expect(await row()).toMatchObject({ status: "published", externalId: "ig_reel_1" });
    expect(creates()).toHaveLength(1);
    expect(publishes()).toHaveLength(1);
    const units = (await testDb().select().from(allowanceUses).where(eq(allowanceUses.projectId, projectId))).map((u) => u.units);
    expect(units).toEqual([1]);
  });
});
