import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { generationRequestIdFor, hashBody } from "../../../src/server/api/idempotency";
import { defineOperation, OPERATIONS } from "../../../src/server/api/operations";
import { posts } from "../../../src/server/db/schema";
import { generateSingle } from "../../../src/server/services/generation/single";
import { api, createKey } from "../../helpers/api";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { createFakeLlm, type FakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { createVoiceProfile } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";

// A test-only `generate` operation until `POST /generate` lands: same shape as the real one, which derives the
// service's request id from the idempotency record and maps failures per research D11.
let llm: FakeLlm;
const op = defineOperation({
  id: "testIdemGenerate",
  method: "POST",
  path: "/test/generate",
  permission: "generate",
  tag: "Test",
  summary: "Idempotent generate",
  responses: { 200: { description: "ok" } },
  idempotent: true,
  idempotencyMode: "generate",
  body: {
    kind: "json",
    schema: z.object({ voiceProfileId: z.uuid(), brief: z.string().min(1), targetAccountIds: z.array(z.uuid()) }),
  },
  async run(scope, { body, requestId, idempotencyRecordId }) {
    const res = await generateSingle(
      scope,
      { ...body, requestId: idempotencyRecordId ? generationRequestIdFor(idempotencyRecordId) : requestId },
      llm,
    );
    if (res.ok) return { status: res.existing ? 200 : 201, body: { postId: res.postId } };
    const refused = ["invalid_output", "refused", "incomplete", "bad_request"].includes(res.kind);
    return refused
      ? { status: 422, body: { error: { code: "generation_failed", message: res.message, requestId } } }
      : { status: 503, body: { error: { code: "generation_unavailable", message: res.message, requestId } } };
  },
});

beforeAll(() => {
  (OPERATIONS as unknown as unknown[]).push(op);
});
afterAll(async () => {
  (OPERATIONS as unknown as unknown[]).splice((OPERATIONS as unknown as unknown[]).indexOf(op), 1);
  await closeDb();
});

const good = (providerKey: string, delayMs = 0): FakeStep => ({
  ok: { variants: { [providerKey]: { text: "A generated post" } } },
  delayMs,
});

async function setup(steps: FakeStep[]) {
  const env = await postsEnv();
  const account = await env.account({}, false);
  const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Warm and direct." } });
  const key = await createKey(env.scope, ["read", "generate"], { rateLimitPerMinute: 1000 });
  llm = createFakeLlm(steps.map((s) => s));
  const body = { voiceProfileId: profile.id, brief: "Announce it", targetAccountIds: [account.id] };
  const countPosts = async () =>
    Number((await testDb().select({ n: sql`count(*)` }).from(posts).where(eq(posts.projectId, env.project.id)))[0]!.n);
  const call = (idem: string) => api("POST", "/test/generate", { key: key.secret, idem, body });
  return { env, account, key, body, countPosts, call };
}

describe("idempotent generate", () => {
  it("makes one post and one model call for 20 parallel identical requests", async () => {
    const t = await setup([]);
    llm = createFakeLlm([good(t.account.providerKey, 50)]);
    const results = await Promise.all(Array.from({ length: 20 }, () => t.call("gen-1")));
    expect(await t.countPosts()).toBe(1);
    expect(llm.requests).toHaveLength(1);
    const ok = results.filter((r) => r.status === 201);
    expect(ok).toHaveLength(1);
    for (const r of results) {
      if (r.status === 409) expect(r.json.error.code).toBe("idempotency_in_progress");
      else expect(r.json.postId).toBe(ok[0]!.json.postId);
    }
    const replay = await t.call("gen-1");
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(llm.requests).toHaveLength(1);
  });

  it("returns the same post with 200 and no second model call when the process died between save and store", async () => {
    const t = await setup([]);
    llm = createFakeLlm([good(t.account.providerKey)]);
    // The state a killed process leaves: the claim held, the post saved under the key's request id, nothing stored.
    const claim = await t.env.scope.idempotency.claim({
      apiKeyId: t.key.id,
      method: "POST",
      route: "/test/generate",
      idemKey: "killed",
      bodyHash: await hashBody(t.body),
      holdMs: 1000,
    });
    if (claim.kind !== "claimed") throw new Error("expected a fresh claim");
    const saved = await generateSingle(
      t.env.scope,
      { ...t.body, requestId: generationRequestIdFor(claim.recordId) },
      llm,
    );
    expect(saved.ok).toBe(true);
    expect(llm.requests).toHaveLength(1);

    const retry = await atTime(new Date(Date.now() + 10 * 60_000), () => t.call("killed"));
    expect(retry.status).toBe(200);
    expect(retry.json.postId).toBe(saved.ok ? saved.postId : "");
    expect(llm.requests).toHaveLength(1);
    expect(await t.countPosts()).toBe(1);
    const again = await t.call("killed");
    expect(again.headers.get("idempotent-replayed")).toBe("true");
  });

  it("stores a refused generation as 422 and replays it without another model call", async () => {
    const t = await setup([]);
    llm = createFakeLlm([{ fail: "refused" }, { fail: "refused" }]);
    const first = await t.call("refused-1");
    expect(first.status).toBe(422);
    expect(first.json.error.code).toBe("generation_failed");
    const calls = llm.requests.length;
    const second = await t.call("refused-1");
    expect(second.status).toBe(422);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(llm.requests.length).toBeGreaterThanOrEqual(1);
    expect(llm.requests.length).toBe(calls);
    expect(await t.countPosts()).toBe(0);
  });

  it("does not store a timeout (503), so the same key runs again", async () => {
    const t = await setup([]);
    llm = createFakeLlm([{ fail: "timeout" }, { fail: "timeout" }, good(t.account.providerKey)]);
    const first = await t.call("timeout-1");
    expect(first.status).toBe(503);
    expect(first.json.error.code).toBe("generation_unavailable");
    const retry = await t.call("timeout-1");
    expect(retry.status).toBe(201);
    expect(retry.headers.get("idempotent-replayed")).toBeNull();
    expect(llm.requests.length).toBeGreaterThanOrEqual(2);
    expect(await t.countPosts()).toBe(1);
  });
});
