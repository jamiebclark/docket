// Spec US6: a step that may have published is never retried after an ambiguous outcome; steps that
// cannot have published retry on anything transient; a refused rate-limited request is always safe to retry.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { facebookSetup, PAGE_ID } from "../../helpers/facebook-publish";
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

type Expected = "ambiguous" | "retryable" | "fatal";

const CASES: Array<{ name: string; reply: GraphReply; publishing: Expected; nonPublishing: Expected }> = [
  { name: "timeout after send", reply: { kind: "hang" }, publishing: "ambiguous", nonPublishing: "retryable" },
  { name: "connection reset", reply: { kind: "reset_mid_body" }, publishing: "ambiguous", nonPublishing: "retryable" },
  { name: "HTTP 5xx", reply: { kind: "http", status: 503 }, publishing: "ambiguous", nonPublishing: "retryable" },
  { name: "unparseable 2xx", reply: { kind: "unparseable" }, publishing: "ambiguous", nonPublishing: "retryable" },
  { name: "2xx missing id", reply: { kind: "missing_id" }, publishing: "ambiguous", nonPublishing: "retryable" },
  { name: "rate limit", reply: { kind: "graph_error", code: 4, message: "Too many calls", status: 400 }, publishing: "retryable", nonPublishing: "retryable" },
  { name: "validation rejection", reply: { kind: "graph_error", code: 100, message: "Invalid parameter", status: 400 }, publishing: "fatal", nonPublishing: "fatal" },
  { name: "permission rejection", reply: { kind: "graph_error", code: 200, message: "Permissions error", status: 403 }, publishing: "fatal", nonPublishing: "fatal" },
  { name: "invalid token (190)", reply: { kind: "graph_error", code: 190, message: "Invalid OAuth access token", status: 401 }, publishing: "fatal", nonPublishing: "fatal" },
  { name: "failure before send", reply: { kind: "pre_send_failure" }, publishing: "retryable", nonPublishing: "retryable" },
];

const STEPS: Array<{ step: string; images: number; path: string; kind: "publishing" | "nonPublishing" }> = [
  { step: "publish_feed", images: 0, path: `/v26.0/${PAGE_ID}/feed`, kind: "publishing" },
  { step: "publish_photo", images: 1, path: `/v26.0/${PAGE_ID}/photos`, kind: "publishing" },
  { step: "upload_photo", images: 2, path: `/v26.0/${PAGE_ID}/photos`, kind: "nonPublishing" },
];

describe("Facebook outcome matrix", () => {
  for (const { step, images, path, kind } of STEPS) {
    describe(step, () => {
      for (const c of CASES) {
        const expected = c[kind];
        it(`${c.name} → ${expected}`, async () => {
          graph.on("POST", path, c.reply);
          const { tick, row } = await facebookSetup(storage, "hello", images);
          const counts = (await runTick({ config: { providerTimeoutMs: 100 } })).publishing.counts;
          const r = await row();
          if (expected === "ambiguous") {
            expect(counts).toMatchObject({ ambiguous: 1 });
            expect(r.status).toBe("ambiguous");
            expect(r.nextAttemptAt).toBeNull();
            const sent = graph.requests.length;
            expect(await tick()).toMatchObject({ claimed: 0 });
            expect(graph.requests).toHaveLength(sent);
          } else if (expected === "retryable") {
            expect(counts).toMatchObject({ retried: 1 });
            expect(["ambiguous", "failed", "published"]).not.toContain(r.status);
            expect(r.nextAttemptAt).not.toBeNull();
          } else {
            expect(counts).toMatchObject({ failed: 1 });
            expect(r.status).toBe("failed");
          }
        });
      }
    });
  }
});
