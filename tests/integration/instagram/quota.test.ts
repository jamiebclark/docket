// Spec US5 for Instagram: the platform's own publishing quota is read before every publish.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createFakeGraph, type FakeGraph, type GraphReply } from "../../helpers/fake-graph";
import { IG_ID, instagramSetup } from "../../helpers/instagram-publish";
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
const HOUR = 3600;
const T0 = Date.now() + 60_000;
const tickAt = (seconds: number, config: Record<string, number> = {}) =>
  atTime(new Date(T0 + seconds * 1000), async () => (await runTick({ config: { providerTimeoutMs: 100, ...config } })).publishing.counts);
const count = (path: string) => graph.requests.filter((r) => r.path === path).length;

function scriptUntilQuota(quotaReply: GraphReply | GraphReply[]) {
  graph.on("POST", media, { kind: "ok", body: { id: "c1" } });
  graph.on("GET", "/v26.0/c1", { kind: "ok", body: { status_code: "FINISHED" } });
  graph.on("GET", quota, quotaReply);
  graph.on("POST", publish, { kind: "ok", body: { id: "ig_m1" } });
}

async function summaries(projectId: string, targetId: string) {
  const attempts = await forSchedulerProject(projectId).attempts.listForTarget(targetId);
  return attempts.map((a) => JSON.stringify(a.responseSummary));
}

describe("Instagram platform quota", () => {
  it("a full quota retries in about an hour without a publish request and records the usage", async () => {
    scriptUntilQuota({ kind: "ok", body: { data: [{ quota_usage: 100, config: { quota_total: 100 } }] } });
    const { projectId, targetId, row } = await instagramSetup(storage, "full", 1);
    await tickAt(0);
    await tickAt(11);
    expect(await tickAt(12)).toMatchObject({ retried: 1 });
    const r = await row();
    const wait = r.nextAttemptAt!.getTime() - (T0 + 12_000);
    expect(wait).toBeGreaterThanOrEqual(HOUR * 1000);
    expect(wait).toBeLessThan(HOUR * 1000 + 60_000);
    expect(count(publish)).toBe(0);
    expect((await summaries(projectId, targetId)).some((s) => s.includes("100"))).toBe(true);
  });

  for (const [name, reply] of [
    ["an HTTP error", { kind: "http", status: 503 }],
    ["an unparseable body", { kind: "unparseable" }],
    ["a body without usage", { kind: "ok", body: { data: [] } }],
  ] as Array<[string, GraphReply]>) {
    it(`${name} on the quota read proceeds and says the quota is unknown`, async () => {
      scriptUntilQuota(reply);
      const { projectId, targetId, row } = await instagramSetup(storage, "unknown", 1);
      await tickAt(0);
      await tickAt(11);
      expect(await tickAt(12)).toMatchObject({ continued: 1 });
      expect(await tickAt(13)).toMatchObject({ done: 1 });
      expect(count(publish)).toBe(1);
      expect((await row()).status).toBe("published");
      expect((await summaries(projectId, targetId)).some((s) => s.includes("unknown"))).toBe(true);
    });
  }

  it("a quota that stays full fails the target after PUBLISH_MAX_ATTEMPTS refusals", async () => {
    scriptUntilQuota({ kind: "ok", body: { data: [{ quota_usage: 100, config: { quota_total: 100 } }] } });
    const { row } = await instagramSetup(storage, "stuck", 1);
    const config = { maxAttempts: 3, maxPublishDurationMs: 1000 * 24 * 3_600_000 };
    await tickAt(0, config);
    await tickAt(11, config);
    let at = 12;
    let last = {} as Awaited<ReturnType<typeof tickAt>>;
    for (let i = 0; i < 6 && (await row()).status !== "failed"; i++) {
      last = await tickAt(at, config);
      at += HOUR + 60;
    }
    expect(last).toMatchObject({ failed: 1 });
    expect((await row()).status).toBe("failed");
    expect(count(publish)).toBe(0);
  });

  it("a container older than 23 h is recreated at the quota step, before any publish request", async () => {
    scriptUntilQuota({ kind: "ok", body: { data: [{ quota_usage: 3, config: { quota_total: 100 } }] } });
    const { row } = await instagramSetup(storage, "aged", 1);
    const config = { maxPublishDurationMs: 1000 * 24 * 3_600_000 };
    await tickAt(0, config);
    await tickAt(11, config);
    const late = 23 * HOUR + 120;
    expect(await tickAt(late, config)).toMatchObject({ continued: 1 }); // the aged container is dropped
    expect(await tickAt(late + 1, config)).toMatchObject({ continued: 1 }); // and a fresh one is created
    expect(count(media)).toBe(2);
    expect(count(quota)).toBe(0);
    expect(count(publish)).toBe(0);
    expect((await row()).status).not.toBe("failed");
  });
});
