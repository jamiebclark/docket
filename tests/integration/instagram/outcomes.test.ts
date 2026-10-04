// Spec US6 for Instagram: only `publish` may have published, so only it turns an uncertain outcome
// into `ambiguous`; every other step retries, fails, or (check_quota) proceeds with the quota unknown.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { postTargets } from "../../../src/server/db/schema/posts";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
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
const status = "/v26.0/c1";
const quota = `/v26.0/${IG_ID}/content_publishing_limit`;
const publish = `/v26.0/${IG_ID}/media_publish`;
const T0 = Date.now() + 60_000;
const tickAt = (seconds: number) =>
  atTime(new Date(T0 + seconds * 1000), async () => (await runTick({ config: { providerTimeoutMs: 100 } })).publishing.counts);

type Expected = "ambiguous" | "retryable" | "fatal" | "continued";

const CASES: Array<{ name: string; reply: GraphReply; publishing: Expected; other: Expected }> = [
  { name: "timeout after send", reply: { kind: "hang" }, publishing: "ambiguous", other: "retryable" },
  { name: "connection reset", reply: { kind: "reset_mid_body" }, publishing: "ambiguous", other: "retryable" },
  { name: "HTTP 5xx", reply: { kind: "http", status: 503 }, publishing: "ambiguous", other: "retryable" },
  { name: "unparseable 2xx", reply: { kind: "unparseable" }, publishing: "ambiguous", other: "retryable" },
  { name: "2xx missing id", reply: { kind: "missing_id" }, publishing: "ambiguous", other: "retryable" },
  { name: "rate limit", reply: { kind: "graph_error", code: 4, message: "Too many calls", status: 400 }, publishing: "retryable", other: "retryable" },
  { name: "validation rejection", reply: { kind: "graph_error", code: 100, message: "Invalid parameter", status: 400 }, publishing: "fatal", other: "fatal" },
  { name: "permission rejection", reply: { kind: "graph_error", code: 200, message: "Permissions error", status: 403 }, publishing: "fatal", other: "fatal" },
  { name: "invalid token (190)", reply: { kind: "graph_error", code: 190, message: "Invalid OAuth access token", status: 401 }, publishing: "fatal", other: "fatal" },
  { name: "failure before send", reply: { kind: "pre_send_failure" }, publishing: "retryable", other: "retryable" },
];

/** Scripts every step happily except the one under test, then ticks up to and including that step. */
const STEPS = [
  { step: "create_container", at: [0], path: media, method: "POST" },
  { step: "check_status", at: [0, 11], path: status, method: "GET" },
  { step: "check_quota", at: [0, 11, 12], path: quota, method: "GET" },
  { step: "publish", at: [0, 11, 12, 13], path: publish, method: "POST" },
] as const;

function scriptHappy(except: string) {
  if (except !== media) graph.on("POST", media, { kind: "ok", body: { id: "c1" } });
  if (except !== status) graph.on("GET", status, { kind: "ok", body: { status_code: "FINISHED" } });
  if (except !== quota) graph.on("GET", quota, { kind: "ok", body: { data: [{ quota_usage: 3, config: { quota_total: 100 } }] } });
  if (except !== publish) graph.on("POST", publish, { kind: "ok", body: { id: "ig_m1" } });
}

describe("Instagram outcome matrix", () => {
  for (const s of STEPS) {
    describe(s.step, () => {
      for (const c of CASES) {
        const isPublish = s.step === "publish";
        // check_quota deliberately proceeds when the reading is unusable; only a dead token stops it.
        let expected: Expected = isPublish ? c.publishing : c.other;
        if (s.step === "check_quota" && expected !== "fatal") expected = "continued";
        if (s.step === "check_quota" && c.name.startsWith("validation")) expected = "continued";
        if (s.step === "check_quota" && c.name.startsWith("permission")) expected = "continued";
        it(`${c.name} → ${expected}`, async () => {
          scriptHappy(s.path);
          graph.on(s.method, s.path, c.reply);
          const { row } = await instagramSetup(storage, "hello", 1);
          let counts = {} as Awaited<ReturnType<typeof tickAt>>;
          for (const at of s.at) counts = await tickAt(at);
          const r = await row();
          if (expected === "ambiguous") {
            expect(counts).toMatchObject({ ambiguous: 1 });
            expect(r.status).toBe("ambiguous");
            expect(r.nextAttemptAt).toBeNull();
            const sent = graph.requests.length;
            expect(await tickAt(500)).toMatchObject({ claimed: 0 });
            expect(graph.requests).toHaveLength(sent);
          } else if (expected === "retryable") {
            expect(counts).toMatchObject({ retried: 1 });
            expect(["ambiguous", "failed", "published"]).not.toContain(r.status);
          } else if (expected === "continued") {
            expect(counts).toMatchObject({ continued: 1 });
            expect(["ambiguous", "failed", "published"]).not.toContain(r.status);
          } else {
            expect(counts).toMatchObject({ failed: 1 });
            expect(r.status).toBe("failed");
          }
        });
      }
    });
  }

  it("a container expired answer to publish is fatal and the container is never recreated", async () => {
    scriptHappy(publish);
    graph.on("POST", publish, { kind: "graph_error", code: 100, subcode: 2207006, message: "The media ID is not available", status: 400 });
    const { row } = await instagramSetup(storage, "hello", 1);
    for (const at of [0, 11, 12]) await tickAt(at);
    expect(await tickAt(13)).toMatchObject({ failed: 1 });
    expect((await row()).status).toBe("failed");
    expect(graph.requests.filter((r) => r.method === "POST" && r.path === media)).toHaveLength(1);
    expect(await tickAt(600)).toMatchObject({ claimed: 0 });
    expect(graph.requests.filter((r) => r.method === "POST" && r.path === media)).toHaveLength(1);
  });

  it("a publish step killed mid-flight is recovered as ambiguous, never retried", async () => {
    scriptHappy("");
    const { projectId, targetId, row } = await instagramSetup(storage, "hello", 1);
    const past = new Date(Date.now() - 60_000);
    await testDb()
      .update(postTargets)
      .set({
        status: "publishing",
        leaseOwner: randomUUID(),
        leaseUntil: past,
        inFlightStep: "publish",
        inFlightMayPublish: true,
        firstStepAt: past,
        publishStartedAt: past,
      })
      .where(and(eq(postTargets.projectId, projectId), eq(postTargets.id, targetId)));
    const counts = (await runTick({ config: {} })).publishing.counts;
    expect(counts).toMatchObject({ recovered: 1, ambiguous: 1, done: 0 });
    expect(await row()).toMatchObject({ status: "ambiguous", nextAttemptAt: null, leaseOwner: null });
    const outcomes = (await forSchedulerProject(projectId).attempts.listForTarget(targetId)).map((a) => a.outcome);
    expect(outcomes).toEqual(["recovered_ambiguous"]);
    expect(graph.requests).toHaveLength(0);
  });
});
