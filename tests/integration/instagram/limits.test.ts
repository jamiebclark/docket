// Spec US5 / SC-006: Docket's own rolling counter keeps Instagram at no more than 50 publishes (Meta's own quota of 100 is only read at run time) per 24 h.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { createSchedulingRepos } from "../../../src/server/dal/scope";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { jpeg } from "../../helpers/images";
import { createFakeGraph, type FakeGraph } from "../../helpers/fake-graph";
import { IG_ID, instagramSetup } from "../../helpers/instagram-publish";
import { createDueTarget, parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage, type MemoryStorage } from "../../helpers/storage";

let graph: FakeGraph;
let storage: MemoryStorage;
beforeEach(async () => {
  await parkAllDueTargets();
  graph = createFakeGraph().install();
  storage = createMemoryStorage();
  setStorageForTests(storage);
  graph.on("POST", `/v26.0/${IG_ID}/media`, { kind: "ok", body: { id: "c1" } });
  graph.on("GET", "/v26.0/c1", { kind: "ok", body: { status_code: "FINISHED" } });
  graph.on("GET", `/v26.0/${IG_ID}/content_publishing_limit`, { kind: "ok", body: { data: [{ quota_usage: 1, config: { quota_total: 100 } }] } });
  graph.on("POST", `/v26.0/${IG_ID}/media_publish`, { kind: "ok", body: { id: "ig_m" } });
});
afterEach(() => graph.uninstall());
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

const media = `/v26.0/${IG_ID}/media`;
const T0 = Date.now() + 60_000;
const tickAt = (seconds: number) =>
  atTime(new Date(T0 + seconds * 1000), async () =>
    (await runTick({ config: { providerTimeoutMs: 100, batchSize: 50, maxItems: 500, timeBudgetMs: 60_000 } })).publishing.counts,
  );
const creates = () => graph.requests.filter((r) => r.method === "POST" && r.path === media).length;
const publishes = () => graph.requests.filter((r) => r.path.endsWith("/media_publish")).length;

/** Extra due targets on the account of an existing setup. */
async function addTargets(projectId: string, accountId: string, n: number) {
  const repos = createSchedulingRepos(testDb(), projectId);
  const key = `projects/${projectId}/media/shared/original`;
  const body = await jpeg(400, 300);
  await storage.put(key, body, "image/jpeg");
  const asset = await repos.media.insert({
    storageKey: key,
    publicUrl: storage.publicUrl(key),
    mimeType: "image/jpeg",
    byteSize: body.length,
    width: 400,
    height: 300,
  });
  for (let i = 0; i < n; i++) {
    const { post } = await createDueTarget(projectId, accountId, { baseText: `extra ${i}` });
    await repos.posts.setMedia(post.id, [asset.id]);
  }
}

/** Ticks until nothing more is claimed (each target needs four steps, the status check is delayed 10 s). */
async function drain(from: number, ticks: number) {
  for (let i = 0; i < ticks; i++) await tickAt(from + i * 15);
}

describe("Instagram default publish limit", () => {
  it("never sends a 51st publish for 150 queued targets, and the rest wait with no provider call", async () => {
    const { projectId, accountId } = await instagramSetup(storage, "first", 1);
    await addTargets(projectId, accountId, 149);
    await drain(0, 12);
    expect(publishes()).toBe(50);
    expect(creates()).toBe(50);
    const before = graph.requests.length;
    await drain(200, 3);
    expect(graph.requests).toHaveLength(before);
  });

  it("an account-level override stricter than the default still applies", async () => {
    const { projectId, accountId } = await instagramSetup(storage, "first", 1);
    await forSchedulerProject(projectId).accounts.setLimit(accountId, { count: 2, windowSeconds: 3600 });
    await addTargets(projectId, accountId, 4);
    await drain(0, 10);
    expect(publishes()).toBe(2);
    expect(creates()).toBe(2);
  });
});
