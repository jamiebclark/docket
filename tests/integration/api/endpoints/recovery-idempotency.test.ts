import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { hashBody } from "../../../../src/server/api/idempotency";
import { webhookEvents } from "../../../../src/server/db/schema";
import * as posts from "../../../../src/server/services/posts";
import { createEndpoint } from "../../../../src/server/services/webhooks";
import { api, createKey } from "../../../helpers/api";
import { atTime } from "../../../helpers/clock";
import { closeDb, testDb } from "../../../helpers/db";
import { LATER, outcomeTarget } from "../../../helpers/failures";
import { failedTarget } from "../../../helpers/retry";
import { parkAllDueTargets } from "../../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(closeDb);

type Env = Awaited<ReturnType<typeof failedTarget>>["env"];

async function observe(env: Env, targetId: string | null) {
  const events = Number(
    (await testDb().select({ n: sql`count(*)` }).from(webhookEvents).where(eq(webhookEvents.projectId, env.project.id)))[0]!.n,
  );
  const attempts = targetId ? (await posts.listAttempts(env.scope, targetId)).length : 0;
  const target = targetId ? await env.scope.targets.get(targetId) : null;
  return { events, attempts, status: target?.status, scheduledAt: target?.scheduledAt?.toISOString() };
}

async function common(env: Env) {
  await createEndpoint(env.scope, { url: "http://127.0.0.1:9/x", description: "", events: ["post.published", "post.failed"] });
  const key = await createKey(env.scope, ["read", "write_posts"], { rateLimitPerMinute: 1000 });
  return { key, post: (path: string, body: unknown, idem: string) => atTime(LATER, () => api("POST", path, { key: key.secret, body, idem })) };
}

async function retryCase() {
  const f = await failedTarget();
  const c = await common(f.env);
  const path = `/posts/${f.postId}/targets/${f.targetId}/retry`;
  return { ...f, ...c, path, body: { mode: "now" }, targetId: f.targetId as string | null, conflict: "not_failed", emits: 0 };
}

async function resolveCase() {
  const env = (await failedTarget()).env;
  const t = await outcomeTarget(env, "ambiguous", "Resolve");
  const c = await common(env);
  const path = `/posts/${t.postId}/targets/${t.targetId}/resolve`;
  return { env, ...t, ...c, path, body: { outcome: "published" }, targetId: t.targetId as string | null, conflict: "already_resolved", emits: 1 };
}

describe.each([
  ["retry", retryCase],
  ["resolve", resolveCase],
])("%s idempotency", (_name, make) => {
  it("replays a 200 with the same body and no new effect", async () => {
    const f = await make();
    const start = await observe(f.env, f.targetId);
    const first = await f.post(f.path, f.body, "k1");
    expect(first.status).toBe(200);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    const before = await observe(f.env, f.targetId);
    expect(before.events - start.events).toBe(f.emits);
    const again = await f.post(f.path, f.body, "k1");
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.json).toEqual(first.json);
    expect(await observe(f.env, f.targetId)).toEqual(before);
  });

  it("replays a stored 409 and a new key after success gets the 409", async () => {
    const f = await make();
    expect((await f.post(f.path, f.body, "k1")).status).toBe(200);
    const before = await observe(f.env, f.targetId);
    const refused = await f.post(f.path, f.body, "k2");
    expect(refused.status).toBe(409);
    expect(refused.json.error.details).toEqual({ reason: f.conflict });
    const again = await f.post(f.path, f.body, "k2");
    expect(again.status).toBe(409);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.json).toEqual(refused.json);
    expect(await observe(f.env, f.targetId)).toEqual(before);
  });

  it("422s the same key with a different body", async () => {
    const f = await make();
    await f.post(f.path, f.body, "k1");
    const other = "outcome" in f.body ? { outcome: "not_published", requeue: false } : { mode: "requeue" };
    const r = await f.post(f.path, other, "k1");
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("idempotency_key_reused");
  });

  it("409s with Retry-After while the claim is held, changing nothing", async () => {
    const f = await make();
    const before = await observe(f.env, f.targetId);
    const claim = await f.env.scope.idempotency.claim({
      apiKeyId: f.key.id,
      method: "POST",
      route: f.path,
      idemKey: "held",
      bodyHash: await hashBody(f.body),
      holdMs: 60_000,
    });
    expect(claim.kind).toBe("claimed");
    const r = await f.post(f.path, f.body, "held");
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("idempotency_in_progress");
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await observe(f.env, f.targetId)).toEqual(before);
  });

  it("stores no Idempotency-Key value in the response or attempt summaries", async () => {
    const f = await make();
    const r = await f.post(f.path, f.body, "secret-idem-value");
    expect(JSON.stringify(r.json)).not.toContain("secret-idem-value");
    const attempts = await posts.listAttempts(f.env.scope, f.targetId!);
    expect(JSON.stringify(attempts)).not.toContain("secret-idem-value");
  });
});

describe("retry-failed idempotency", () => {
  it("replays with no new retries, and a new key continues", async () => {
    const f = await failedTarget();
    const { post } = await common(f.env);
    const extra = [];
    for (let i = 0; i < 100; i++) {
      const at = new Date(Date.parse("2026-10-05T00:00:00Z") + (i + 1) * 1000);
      const d = await posts.createDraft(f.env.scope, { baseText: `Cap ${i}`, targets: [{ accountId: f.account.id }] });
      await f.env.scope.targets.update(d.targets[0]!.id, { status: "failed", lastError: "boom", scheduleKind: "explicit", scheduledAt: at, nextAttemptAt: at });
      extra.push(d.targets[0]!.id);
    }
    const first = await post("/targets/retry-failed", { mode: "now" }, "bulk");
    expect(first.json).toMatchObject({ retried: 100, remaining: 1 });
    const before = await observe(f.env, null);
    const replay = await post("/targets/retry-failed", { mode: "now" }, "bulk");
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.json).toEqual(first.json);
    expect(await observe(f.env, null)).toEqual(before);
    const next = await post("/targets/retry-failed", { mode: "now" }, "bulk-2");
    expect(next.json).toMatchObject({ retried: 1, remaining: 0 });
  }, 120_000);
});
