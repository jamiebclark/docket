// Spec US6 / SC-006: Docket's own rolling counter keeps Threads at no more than 250 publishes per 24 h,
// and the platform's own quota is read before every publish.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createFakeGraph, type FakeGraph, type GraphReply } from "../../helpers/fake-graph";
import { createDueTarget, parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage, type MemoryStorage } from "../../helpers/storage";
import { THREADS_USER_ID, threadsSetup, V } from "../../helpers/threads-publish";

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

const create = `${V}/${THREADS_USER_ID}/threads`;
const quota = `${V}/${THREADS_USER_ID}/threads_publishing_limit`;
const publish = `${V}/${THREADS_USER_ID}/threads_publish`;
const HOUR = 3600;
const T0 = Date.now() + 60_000;
const tickAt = (seconds: number, extra: Record<string, number> = {}) =>
  atTime(new Date(T0 + seconds * 1000), async () =>
    (await runTick({ config: { providerTimeoutMs: 100, batchSize: 50, maxItems: 500, timeBudgetMs: 60_000, ...extra } })).publishing.counts,
  );
const count = (path: string) => graph.requests.filter((r) => r.path === path).length;

function script(quotaReply: GraphReply | GraphReply[] = { kind: "ok", body: { data: [{ quota_usage: 1, config: { quota_total: 250 } }] } }) {
  graph.on("POST", create, { kind: "ok", body: { id: "1001" } });
  graph.on("GET", `${V}/1001`, { kind: "ok", body: { status: "FINISHED" } });
  graph.on("GET", quota, quotaReply);
  graph.on("POST", publish, { kind: "ok", body: { id: "th_1" } });
}

async function addTargets(projectId: string, accountId: string, n: number) {
  for (let i = 0; i < n; i++) await createDueTarget(projectId, accountId, { baseText: `extra ${i}` });
}

/** Four steps per target (the status check is delayed), so tick well apart. */
async function drain(from: number, ticks: number) {
  for (let i = 0; i < ticks; i++) await tickAt(from + i * 40);
}

async function summaries(projectId: string, targetId: string) {
  const attempts = await forSchedulerProject(projectId).attempts.listForTarget(targetId);
  return attempts.map((a) => JSON.stringify(a.responseSummary));
}

describe("Threads default publish limit", () => {
  it("never starts a 251st target in 24 h for 300 queued targets, and the rest wait with no provider call", async () => {
    script();
    const { projectId, accountId } = await threadsSetup(storage, { text: "first" });
    await addTargets(projectId, accountId, 299);
    await drain(0, 14);
    expect(count(publish)).toBe(250);
    expect(count(create)).toBe(250);
    const before = graph.requests.length;
    await drain(600, 3);
    expect(graph.requests).toHaveLength(before);
  }, 120_000);

  it("an account-level override stricter than the default still applies", async () => {
    script();
    const { projectId, accountId } = await threadsSetup(storage, { text: "first" });
    await forSchedulerProject(projectId).accounts.setLimit(accountId, { count: 2, windowSeconds: 3600 });
    await addTargets(projectId, accountId, 4);
    await drain(0, 8);
    expect(count(publish)).toBe(2);
    expect(count(create)).toBe(2);
  });
});

describe("Threads platform quota", () => {
  it("a full quota retries in at least an hour without a publish request and records the usage", async () => {
    script({ kind: "ok", body: { data: [{ quota_usage: 250, config: { quota_total: 250 } }] } });
    const { projectId, targetId, row } = await threadsSetup(storage, { text: "full" });
    await tickAt(0);
    await tickAt(31);
    expect(await tickAt(32)).toMatchObject({ retried: 1 });
    const wait = (await row()).nextAttemptAt!.getTime() - (T0 + 32_000);
    expect(wait).toBeGreaterThanOrEqual(HOUR * 1000);
    expect(wait).toBeLessThan(HOUR * 1000 + 60_000);
    expect(count(publish)).toBe(0);
    expect((await summaries(projectId, targetId)).some((s) => s.includes("250"))).toBe(true);
  });

  it.each([
    ["a failed request", { kind: "http", status: 500 } as GraphReply],
    ["an unreadable body", { kind: "ok", body: { data: [] } } as GraphReply],
  ])("%s leaves the quota unknown and publishes on the engine counter", async (_name, reply) => {
    script(reply);
    const { projectId, targetId, row } = await threadsSetup(storage, { text: "unknown" });
    for (const at of [0, 31, 32]) await tickAt(at);
    await tickAt(33);
    expect(count(publish)).toBe(1);
    expect((await row()).status).toBe("published");
    expect((await summaries(projectId, targetId)).some((s) => s.includes('"quota":"unknown"'))).toBe(true);
  });

  it("a container older than 23 h is recreated before publishing", async () => {
    script();
    const { row } = await threadsSetup(storage, { text: "aged" });
    // The engine's own publish-duration cap is lifted so the wait itself is what is under test.
    const long = { maxPublishDurationMs: 72 * HOUR * 1000 };
    await tickAt(0, long);
    await tickAt(31, long);
    await tickAt(24 * HOUR, long);
    expect(count(publish)).toBe(0);
    expect(count(quota)).toBe(0);
    for (const at of [31, 62, 63, 64].map((n) => 24 * HOUR + n)) await tickAt(at, long);
    expect(count(create)).toBe(2);
    expect(count(publish)).toBe(1);
    expect((await row()).status).toBe("published");
  });
});
