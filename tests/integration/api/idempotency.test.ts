import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { hashBody } from "../../../src/server/api/idempotency";
import { defineOperation, OPERATIONS } from "../../../src/server/api/operations";
import { NotFoundError } from "../../../src/server/dal/errors";
import { apiIdempotencyKeys, posts } from "../../../src/server/db/schema";
import { createDraft } from "../../../src/server/services/posts";
import { api, createKey } from "../../helpers/api";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

// A test-only write operation until `POST /posts` lands: it creates a draft through the real service, so the
// effect is a real row that must commit or roll back together with the stored result.
const control = { boomOnce: false, gate: null as Promise<void> | null, entered: null as (() => void) | null };
const op = defineOperation({
  id: "testIdemPost",
  method: "POST",
  path: "/test/idem",
  permission: "write_posts",
  tag: "Test",
  summary: "Idempotent test write",
  responses: { 201: { description: "created" } },
  idempotent: true,
  body: {
    kind: "json",
    schema: z.object({ text: z.string().min(1), accountId: z.uuid(), mode: z.enum(["ok", "missing"]).default("ok") }),
  },
  async run(scope, { body }) {
    const post = await createDraft(scope, { baseText: body.text, targets: [{ accountId: body.accountId }], mediaIds: [] });
    if (control.boomOnce) {
      control.boomOnce = false;
      throw new Error("forced failure after the write");
    }
    if (control.gate) {
      control.entered?.();
      await control.gate;
    }
    if (body.mode === "missing") throw new NotFoundError();
    return { status: 201, body: { id: post.post.id } };
  },
});
const op2 = defineOperation({ ...op, id: "testIdemPost2", path: "/test/idem2" });

beforeAll(() => {
  (OPERATIONS as unknown as unknown[]).push(op, op2);
});
afterAll(async () => {
  for (const o of [op, op2]) (OPERATIONS as unknown as unknown[]).splice((OPERATIONS as unknown as unknown[]).indexOf(o), 1);
  await closeDb();
});

async function setup() {
  const env = await postsEnv();
  const account = await env.account({}, false);
  const key = await createKey(env.scope, ["read", "write_posts"]);
  const countPosts = async () =>
    Number((await testDb().select({ n: sql`count(*)` }).from(posts).where(eq(posts.projectId, env.project.id)))[0]!.n);
  const countKeys = async () =>
    Number(
      (await testDb().select({ n: sql`count(*)` }).from(apiIdempotencyKeys).where(eq(apiIdempotencyKeys.projectId, env.project.id)))[0]!.n,
    );
  const post = (idem: string | undefined, body: Record<string, unknown> = {}, path = "/test/idem", k = key.secret) =>
    api("POST", path, { key: k, idem, body: { text: "hello", accountId: account.id, ...body } });
  return { env, account, key, countPosts, countKeys, post };
}

describe("idempotency", () => {
  it("replays the stored result, ignoring key order, and runs the effect once", async () => {
    const t = await setup();
    const first = await api("POST", "/test/idem", { key: t.key.secret, idem: "k1", body: { text: "hello", accountId: t.account.id } });
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    const second = await api("POST", "/test/idem", { key: t.key.secret, idem: "k1", body: { accountId: t.account.id, text: "hello" } });
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(second.json).toEqual(first.json);
    expect(await t.countPosts()).toBe(1);
  });

  it("answers 422 idempotency_key_reused for the same key with a different body", async () => {
    const t = await setup();
    await t.post("k1");
    const r = await t.post("k1", { text: "changed" });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("idempotency_key_reused");
    expect(await t.countPosts()).toBe(1);
  });

  it("stores a 4xx answer and replays it, with the effect rolled back", async () => {
    const t = await setup();
    const first = await t.post("k1", { mode: "missing" });
    expect(first.status).toBe(404);
    expect(await t.countPosts()).toBe(0);
    const again = await t.post("k1", { mode: "missing" });
    expect(again.status).toBe(404);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
  });

  it("creates exactly one post for 20 parallel requests per key, the rest replay or get 409 with Retry-After", async () => {
    const t = await setup();
    const busy = await createKey(t.env.scope, ["read", "write_posts"], { rateLimitPerMinute: 1000 });
    const keys = ["a", "b", "c", "d", "e"];
    const perKey = await Promise.all(
      keys.map((k) => Promise.all(Array.from({ length: 20 }, () => t.post(k, {}, "/test/idem", busy.secret)))),
    );
    expect(await t.countPosts()).toBe(5);
    for (const results of perKey) {
      const created = results.filter((r) => r.status === 201 && r.headers.get("idempotent-replayed") === null);
      expect(created).toHaveLength(1);
      for (const r of results) {
        expect([201, 409]).toContain(r.status);
        if (r.status === 201) expect(r.json.id).toBe(created[0]!.json.id);
        else {
          expect(r.json.error.code).toBe("idempotency_in_progress");
          expect(Number(r.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it("scopes a key to the API key and the route", async () => {
    const t = await setup();
    const other = await createKey(t.env.scope, ["read", "write_posts"]);
    await t.post("same");
    await t.post("same", {}, "/test/idem2");
    await t.post("same", {}, "/test/idem", other.secret);
    expect(await t.countPosts()).toBe(3);
  });

  it("rolls the effect back on a 5xx, stores nothing and lets the key run again", async () => {
    const t = await setup();
    control.boomOnce = true;
    const failed = await t.post("k1");
    expect(failed.status).toBe(500);
    expect(await t.countPosts()).toBe(0);
    expect(await t.countKeys()).toBe(0);
    const retry = await t.post("k1");
    expect(retry.status).toBe(201);
    expect(retry.headers.get("idempotent-replayed")).toBeNull();
    expect(await t.countPosts()).toBe(1);
  });

  it("takes over a claim whose hold has expired", async () => {
    const t = await setup();
    const body = { text: "hello", accountId: t.account.id };
    const claim = await t.env.scope.idempotency.claim({
      apiKeyId: t.key.id,
      method: "POST",
      route: "/test/idem",
      idemKey: "stuck",
      bodyHash: await hashBody(body),
      holdMs: 1000,
    });
    expect(claim.kind).toBe("claimed");
    const during = await t.post("stuck");
    expect(during.status).toBe(409);
    expect(during.json.error.code).toBe("idempotency_in_progress");
    const later = await atTime(new Date(Date.now() + 10 * 60_000), () => t.post("stuck"));
    expect(later.status).toBe(201);
    expect(await t.countPosts()).toBe(1);
  });

  it("commits nothing when the hold was lost to a takeover", async () => {
    const t = await setup();
    let release!: () => void;
    control.gate = new Promise<void>((r) => (release = r));
    const entered = new Promise<void>((r) => (control.entered = r));
    const slow = t.post("contested");
    await entered;
    control.gate = null;
    const taker = await atTime(new Date(Date.now() + 10 * 60_000), () => t.post("contested"));
    expect(taker.status).toBe(201);
    release();
    const lost = await slow;
    expect(lost.status).toBe(409);
    expect(lost.json.error.code).toBe("idempotency_in_progress");
    expect(await t.countPosts()).toBe(1);
    const replay = await t.post("contested");
    expect(replay.json.id).toBe(taker.json.id);
  });

  it("stores nothing for requests refused before the claim", async () => {
    const t = await setup();
    const readOnly = await createKey(t.env.scope, ["read"]);
    expect((await t.post("k1", {}, "/test/idem", readOnly.secret)).status).toBe(403);
    expect((await api("POST", "/test/idem", { idem: "k1", body: {} })).status).toBe(401);
    expect((await t.post("bad keyé")).status).toBe(400);
    expect((await api("POST", "/test/idem", { key: t.key.secret, idem: "k1", body: "{", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await api("POST", "/test/idem", { key: t.key.secret, idem: "k1", body: "x", headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect(await t.countKeys()).toBe(0);
    // A 403 must not consume the key either.
    const ok = await t.post("k1");
    expect(ok.status).toBe(201);
  });
});
