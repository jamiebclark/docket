import { afterAll, describe, expect, it } from "vitest";
import { setReviewState } from "../../../../src/server/services/posts";
import { api, createKey } from "../../../helpers/api";
import { atTime } from "../../../helpers/clock";
import { closeDb } from "../../../helpers/db";
import { postsEnv } from "../../../helpers/posts-env";

afterAll(closeDb);

// A Sunday, so the next Monday 09:00 slot is the next day.
const NOW = new Date("2026-11-01T12:00:00Z");

async function setup() {
  const env = await postsEnv();
  const key = (await createKey(env.scope, ["read", "write_posts"], { rateLimitPerMinute: 1000 })).secret;
  const account = await env.account({}, true);
  const bare = await env.account({}, false);
  const create = (body: Record<string, unknown>, idem?: string) =>
    api("POST", "/posts", { key, body: { text: "Hello world", accountIds: [account.id], ...body }, ...(idem ? { idem } : {}) });
  return { env, key, account, bare, create };
}

describe("POST /posts", () => {
  it("creates a draft with origin api, the key as creator, and per-target validation", async () => {
    const { key, account, create } = await setup();
    const r = await create({ overrides: { [account.id]: "Custom text" } });
    expect(r.status).toBe(201);
    expect(r.json.post).toMatchObject({ origin: "api", status: "draft", text: "Hello world" });
    expect(r.json.post.createdBy.type).toBe("api_key");
    expect(r.json.post.targets).toHaveLength(1);
    expect(r.json.post.targets[0]).toMatchObject({ accountId: account.id, overrideText: "Custom text", status: "draft" });
    expect(r.json.validation).toEqual([expect.objectContaining({ accountId: account.id, ok: true })]);
    const got = await api("GET", `/posts/${r.json.post.id}`, { key });
    expect(got.json.id).toBe(r.json.post.id);
    const target = await api("GET", `/posts/${r.json.post.id}/targets/${r.json.post.targets[0].id}`, { key });
    expect(target.json.id).toBe(r.json.post.targets[0].id);
  });

  it("reports a validation problem per target without refusing the draft", async () => {
    const { create } = await setup();
    const r = await create({ text: "x".repeat(600) });
    expect(r.status).toBe(201);
    expect(r.json.validation[0].ok).toBe(false);
    expect(r.json.validation[0].issues[0]).toMatchObject({ severity: "error" });
  });

  it("rejects bad input and unknown accounts", async () => {
    const { key, create } = await setup();
    expect((await create({ accountIds: [] })).json.error.code).toBe("validation_failed");
    expect((await create({ accountIds: ["00000000-0000-4000-8000-000000000000"] })).status).toBe(404);
    expect((await api("POST", "/posts", { key, body: { accountIds: [] } })).status).toBe(400);
  });

  it("returns 404 for a target that is not on that post", async () => {
    const { key, create } = await setup();
    const a = await create({});
    const b = await create({});
    const r = await api("GET", `/posts/${a.json.post.id}/targets/${b.json.post.targets[0].id}`, { key });
    expect(r.status).toBe(404);
  });

  it("shows no tokens or credentials in any shape", async () => {
    const { key, create } = await setup();
    const made = await create({});
    const texts = [
      made.text,
      (await api("GET", `/posts/${made.json.post.id}`, { key })).text,
      (await api("GET", "/accounts", { key })).text,
    ].join("\n");
    expect(texts).not.toMatch(/token|secret|credential|password/i);
  });
});

describe("POST /posts/{id}/queue", () => {
  it("takes the next free slot and reports it per target", async () => {
    const { key, create } = await setup();
    const made = await create({});
    const r = await atTime(NOW, () => api("POST", `/posts/${made.json.post.id}/queue`, { key, body: {} }));
    expect(r.status).toBe(200);
    expect(r.json.results[0]).toMatchObject({ ok: true, scheduledAt: "2026-11-02T09:00:00.000Z" });
    expect(r.json.results[0].scheduledAtLocal).toEqual(expect.any(String));
    const after = await api("GET", `/posts/${made.json.post.id}`, { key });
    expect(after.json.targets[0]).toMatchObject({ status: "scheduled", scheduleKind: "slot" });
  });

  it("reports no_active_slots and not_queueable per target", async () => {
    const { env, key, bare, create } = await setup();
    const noSlots = await create({ accountIds: [bare.id] });
    const r1 = await api("POST", `/posts/${noSlots.json.post.id}/queue`, { key, body: {} });
    expect(r1.status).toBe(200);
    expect(r1.json.results[0]).toMatchObject({ ok: false, code: "no_active_slots" });

    const review = await create({});
    await setReviewState(env.scope, review.json.post.id, "needs_review");
    const r2 = await api("POST", `/posts/${review.json.post.id}/queue`, { key, body: {} });
    expect(r2.json.results[0]).toMatchObject({ ok: false, code: "not_queueable" });
  });

  it("answers 404 for an unknown post and replays an idempotent queue", async () => {
    const { key, create } = await setup();
    expect((await api("POST", "/posts/00000000-0000-4000-8000-000000000000/queue", { key, body: {} })).status).toBe(404);
    const made = await create({});
    const a = await atTime(NOW, () => api("POST", `/posts/${made.json.post.id}/queue`, { key, body: {}, idem: "q1" }));
    const b = await atTime(NOW, () => api("POST", `/posts/${made.json.post.id}/queue`, { key, body: {}, idem: "q1" }));
    expect(b.json).toEqual(a.json);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
  });
});

describe("POST /posts/{id}/schedule", () => {
  it("honours the offset in `at`", async () => {
    const { key, create } = await setup();
    const made = await create({});
    const r = await atTime(NOW, () =>
      api("POST", `/posts/${made.json.post.id}/schedule`, { key, body: { at: "2026-11-05T10:30:00+02:00" } }),
    );
    expect(r.status).toBe(200);
    expect(r.json.results[0]).toMatchObject({ ok: true, scheduledAt: "2026-11-05T08:30:00.000Z" });
    const t = await api("GET", `/posts/${made.json.post.id}`, { key });
    expect(t.json.targets[0]).toMatchObject({ status: "scheduled", scheduleKind: "explicit", scheduledAt: "2026-11-05T08:30:00.000Z" });
  });

  it("reports in_past per target and rejects a time without an offset", async () => {
    const { key, create } = await setup();
    const made = await create({});
    const past = await atTime(NOW, () =>
      api("POST", `/posts/${made.json.post.id}/schedule`, { key, body: { at: "2026-10-01T10:00:00Z" } }),
    );
    expect(past.status).toBe(200);
    expect(past.json.results[0]).toMatchObject({ ok: false, code: "in_past" });
    const naive = await api("POST", `/posts/${made.json.post.id}/schedule`, { key, body: { at: "2026-11-05T10:00:00" } });
    expect(naive.status).toBe(400);
  });

  it("warns when another post is scheduled close by", async () => {
    const { key, create } = await setup();
    const first = await create({});
    const second = await create({});
    const at = "2026-11-05T09:00:00Z";
    await atTime(NOW, () => api("POST", `/posts/${first.json.post.id}/schedule`, { key, body: { at } }));
    const r = await atTime(NOW, () =>
      api("POST", `/posts/${second.json.post.id}/schedule`, { key, body: { at: "2026-11-05T09:05:00Z" } }),
    );
    expect(r.json.results[0].ok).toBe(true);
    expect(r.json.results[0].warnings?.[0]).toMatchObject({ code: "near_queued_target" });
  });
});

describe("permissions", () => {
  it("refuses writes to a read-only key", async () => {
    const { env, account } = await setup();
    const ro = (await createKey(env.scope, ["read"])).secret;
    const r = await api("POST", "/posts", { key: ro, body: { text: "x", accountIds: [account.id] } });
    expect(r.status).toBe(403);
    expect(r.json.error.details).toEqual({ permission: "write_posts" });
  });
});
