// Spec US3 for Threads: only `publish` may have published, so only it turns an uncertain outcome into
// `ambiguous`; every other step retries, fails, or (check_quota) proceeds with the quota unknown.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { postTargets } from "../../../src/server/db/schema/posts";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import { encryptCredentials } from "../../../src/server/services/accounts";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { createFakeGraph, type FakeGraph, type GraphReply } from "../../helpers/fake-graph";
import { parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage, type MemoryStorage } from "../../helpers/storage";
import { THREADS_TOKEN, THREADS_USER_ID, threadsSetup, V } from "../../helpers/threads-publish";

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
const status = `${V}/1001`;
const quota = `${V}/${THREADS_USER_ID}/threads_publishing_limit`;
const publish = `${V}/${THREADS_USER_ID}/threads_publish`;
const T0 = Date.now() + 60_000;
const tickAt = (seconds: number) =>
  atTime(new Date(T0 + seconds * 1000), async () => (await runTick({ config: { providerTimeoutMs: 100 } })).publishing.counts);

type Expected = "ambiguous" | "retryable" | "fatal" | "continued";

const CASES: Array<{ name: string; reply: GraphReply; publishing: Expected; other: Expected }> = [
  { name: "timeout after send", reply: { kind: "hang" }, publishing: "ambiguous", other: "retryable" },
  { name: "connection reset", reply: { kind: "reset_mid_body" }, publishing: "ambiguous", other: "retryable" },
  { name: "HTTP 5xx", reply: { kind: "http", status: 503 }, publishing: "ambiguous", other: "retryable" },
  { name: "temporary Graph error (code 2)", reply: { kind: "graph_error", code: 2, message: "Temporary", status: 500 }, publishing: "ambiguous", other: "retryable" },
  { name: "unparseable 2xx", reply: { kind: "unparseable" }, publishing: "ambiguous", other: "retryable" },
  { name: "2xx missing id", reply: { kind: "missing_id" }, publishing: "ambiguous", other: "retryable" },
  { name: "rate limit", reply: { kind: "graph_error", code: 4, message: "Too many calls", status: 400 }, publishing: "retryable", other: "retryable" },
  { name: "validation rejection", reply: { kind: "graph_error", code: 100, message: "Invalid parameter", status: 400 }, publishing: "fatal", other: "fatal" },
  { name: "permission rejection", reply: { kind: "graph_error", code: 200, message: "Permissions error", status: 403 }, publishing: "fatal", other: "fatal" },
  { name: "invalid token (190)", reply: { kind: "graph_error", code: 190, message: "Invalid OAuth access token", status: 401 }, publishing: "fatal", other: "fatal" },
  { name: "failure before send", reply: { kind: "pre_send_failure" }, publishing: "retryable", other: "retryable" },
];

const OK = (id: string): GraphReply => ({ kind: "ok", body: { id } });

interface Step {
  step: string;
  images: number;
  /** Seconds at which each tick runs; the last one is the step under test. */
  at: number[];
  method: string;
  path: string;
  /** Replies to POST /threads, in order; `bad` stands for the reply under test. */
  creates?: (bad: GraphReply) => GraphReply[];
}
const STEPS: Step[] = [
  { step: "create_container", images: 0, at: [0], method: "POST", path: create, creates: (bad) => [bad] },
  { step: "create_item", images: 2, at: [0], method: "POST", path: create, creates: (bad) => [bad] },
  { step: "create_carousel", images: 2, at: [0, 1, 2], method: "POST", path: create, creates: (bad) => [OK("2001"), OK("2002"), bad] },
  { step: "check_status", images: 0, at: [0, 31], method: "GET", path: status },
  { step: "check_quota", images: 0, at: [0, 31, 32], method: "GET", path: quota },
  { step: "publish", images: 0, at: [0, 31, 32, 33], method: "POST", path: publish },
];

function scriptHappy(except: string) {
  if (except !== create) graph.on("POST", create, OK("1001"));
  if (except !== status) graph.on("GET", status, { kind: "ok", body: { status: "FINISHED" } });
  if (except !== quota) graph.on("GET", quota, { kind: "ok", body: { data: [{ quota_usage: 3, config: { quota_total: 250 } }] } });
  if (except !== publish) graph.on("POST", publish, OK("th_1"));
}

describe("Threads outcome matrix", () => {
  for (const s of STEPS) {
    describe(s.step, () => {
      for (const c of CASES) {
        const isPublish = s.step === "publish";
        let expected: Expected = isPublish ? c.publishing : c.other;
        // check_quota deliberately proceeds when the reading is unusable; only a dead token stops it.
        if (s.step === "check_quota" && expected !== "fatal") expected = "continued";
        if (s.step === "check_quota" && (c.name.startsWith("validation") || c.name.startsWith("permission"))) expected = "continued";
        it(`${c.name} → ${expected}`, async () => {
          scriptHappy(s.path);
          graph.on(s.method, s.path, s.creates ? s.creates(c.reply) : c.reply);
          const { row } = await threadsSetup(storage, { text: "hello", imageCount: s.images });
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
            expect(graph.requests.filter((q) => q.path === publish)).toHaveLength(1);
          } else if (expected === "retryable") {
            expect(counts).toMatchObject({ retried: 1 });
            expect(["ambiguous", "failed", "published"]).not.toContain(r.status);
          } else if (expected === "continued") {
            expect(counts).toMatchObject({ continued: 1 });
            expect(["ambiguous", "failed", "published"]).not.toContain(r.status);
          } else {
            expect(counts).toMatchObject({ failed: 1 });
            expect(r.status).toBe("failed");
            expect(r.lastError ?? "").not.toContain(THREADS_TOKEN);
            if (c.name.includes("190")) expect(r.lastError).toMatch(/^Reconnect @docket to publish/);
          }
        });
      }
    });
  }

  it("a rate limit carries the platform's not-before when it gives one", async () => {
    scriptHappy(create);
    graph.on("POST", create, { kind: "graph_error", code: 4, message: "Too many calls", status: 429 });
    const { row } = await threadsSetup(storage, { text: "hello" });
    expect(await tickAt(0)).toMatchObject({ retried: 1 });
    expect((await row()).nextAttemptAt!.getTime()).toBeGreaterThan(T0);
  });

  it("an expired container answer to publish is fatal and the container is never recreated", async () => {
    scriptHappy(publish);
    graph.on("POST", publish, { kind: "graph_error", code: 24, subcode: 4279009, message: "The requested resource does not exist", status: 400 });
    const { row } = await threadsSetup(storage, { text: "hello" });
    for (const at of [0, 31, 32]) await tickAt(at);
    expect(await tickAt(33)).toMatchObject({ failed: 1 });
    expect((await row()).status).toBe("failed");
    expect(await tickAt(600)).toMatchObject({ claimed: 0 });
    expect(graph.requests.filter((r) => r.method === "POST" && r.path === create)).toHaveLength(1);
  });

  it("code 190 flags the account needs_reauth, fails the target, and tries no refresh", async () => {
    scriptHappy(status);
    graph.on("GET", status, { kind: "graph_error", code: 190, message: "Invalid OAuth access token", status: 401 });
    const { projectId, accountId, row } = await threadsSetup(storage, { text: "hello" });
    await tickAt(0);
    expect(await tickAt(31)).toMatchObject({ failed: 1, ambiguous: 0 });
    expect(await row()).toMatchObject({ status: "failed", nextAttemptAt: null });
    expect(await forSchedulerProject(projectId).accounts.get(accountId)).toMatchObject({ status: "needs_reauth" });
    expect(graph.requests.every((r) => !r.path.includes("refresh_access_token") && !r.path.includes("oauth"))).toBe(true);
    expect(graph.requests).toHaveLength(2);
  });

  it("code 190 after the credentials were rotated meanwhile does not flag the new credentials (G7)", async () => {
    scriptHappy(publish);
    const { projectId, accountId, row } = await threadsSetup(storage, { text: "hello" });
    for (const at of [0, 31, 32]) await tickAt(at);
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/threads_publish")) {
        const creds = { v: 1, accessToken: "THQW-rotated", issuedAt: Date.now(), expiresAt: Date.now() + 60 * 86_400_000, expiryEstimated: false };
        await forSchedulerProject(projectId).accounts.setCredentials(accountId, encryptCredentials(accountId, creds), new Date(creds.expiresAt));
        return new Response(JSON.stringify({ error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190 } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return inner(input, init);
    }) as typeof fetch;
    expect(await tickAt(33)).toMatchObject({ failed: 1 });
    expect((await row()).status).toBe("failed");
    expect(await forSchedulerProject(projectId).accounts.get(accountId)).toMatchObject({ status: "active", lastError: null });
  });

  it("a non-publishing step killed mid-flight is retried", async () => {
    scriptHappy("");
    const { projectId, targetId, row } = await threadsSetup(storage, { text: "hello" });
    const past = new Date(Date.now() - 60_000);
    await testDb()
      .update(postTargets)
      .set({ status: "publishing", leaseOwner: randomUUID(), leaseUntil: past, inFlightStep: "create_container", inFlightMayPublish: false, firstStepAt: past })
      .where(and(eq(postTargets.projectId, projectId), eq(postTargets.id, targetId)));
    const counts = (await runTick({ config: {} })).publishing.counts;
    expect(counts).toMatchObject({ recovered: 1, ambiguous: 0, done: 0 });
    expect((await row()).status).not.toBe("ambiguous");
    expect((await row()).status).not.toBe("failed");
  });

  it("a publish step killed mid-flight is recovered as ambiguous, never retried", async () => {
    scriptHappy("");
    const { projectId, targetId, row } = await threadsSetup(storage, { text: "hello" });
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
