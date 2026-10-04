import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { projects } from "../../../../src/server/db/schema";
import { setLlmForTests } from "../../../../src/server/llm";
import { api, createKey, type ApiPermission } from "../../../helpers/api";
import { closeDb, testDb } from "../../../helpers/db";
import { createFakeLlm, type FakeStep } from "../../../helpers/fake-llm";
import { createVoiceProfile } from "../../../helpers/factories";
import { postsEnv } from "../../../helpers/posts-env";

afterAll(closeDb);
afterEach(() => setLlmForTests(null));

const good: FakeStep = { ok: { variants: { mock: { text: "A generated post" } } } };

async function setup(steps: FakeStep[] = [good], permissions: ApiPermission[] = ["read", "generate"]) {
  const env = await postsEnv();
  const account = await env.account({}, true);
  const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Warm and direct." } });
  const key = (await createKey(env.scope, permissions, { rateLimitPerMinute: 1000 })).secret;
  const llm = createFakeLlm(steps);
  setLlmForTests(llm);
  const body = { brief: "Announce the thing", accountIds: [account.id], voiceProfileId: profile.id };
  const call = (extra: Record<string, unknown> = {}, idem?: string, k = key) =>
    api("POST", "/generate", { key: k, body: { ...body, ...extra }, ...(idem ? { idem } : {}) });
  return { env, account, profile, key, llm, body, call };
}

describe("POST /generate", () => {
  it("generates a post: origin generated, creator is the key, left in review by default", async () => {
    const { call, key } = await setup();
    const r = await call();
    expect(r.status).toBe(201);
    expect(r.json.post).toMatchObject({ origin: "generated", text: "A generated post", reviewState: "needs_review" });
    expect(r.json.post.createdBy.type).toBe("api_key");
    expect(r.json.decision).toMatchObject({ reviewState: "needs_review", queue: false });
    expect(r.json.queued).toEqual([]);
    expect((await api("GET", `/posts/${r.json.post.id}`, { key })).json.generation.brief).toBe("Announce the thing");
  });

  it("replays an idempotent request without a second model call", async () => {
    const { call, llm } = await setup();
    const a = await call({}, "gen-1");
    const b = await call({}, "gen-1");
    expect(a.status).toBe(201);
    expect(b.json.post.id).toBe(a.json.post.id);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect(llm.requests).toHaveLength(1);
  });

  it("needs the auto_approve permission to auto-approve, unless that is the project default", async () => {
    const { call, env, key } = await setup([good, good, good]);
    const denied = await call({ approvalPolicy: "auto_approve" });
    expect(denied.status).toBe(403);
    expect(denied.json.error).toMatchObject({ code: "missing_permission", details: { permission: "auto_approve" } });

    const strong = (await createKey(env.scope, ["read", "generate", "auto_approve"])).secret;
    const ok = await call({ approvalPolicy: "auto_approve" }, undefined, strong);
    expect(ok.status).toBe(201);
    expect(ok.json.post.reviewState).toBe("approved");

    await testDb().update(projects).set({ defaultApprovalPolicy: "auto_approve" }).where(eq(projects.id, env.project.id));
    const byDefault = await call({}, undefined, key);
    expect(byDefault.status).toBe(201);
    expect(byDefault.json.post.reviewState).toBe("approved");
  });

  it("demands confirmUnreviewedQueue for auto_approve with add_to_queue", async () => {
    const { call, env } = await setup([good, good]);
    const strong = (await createKey(env.scope, ["read", "generate", "auto_approve"])).secret;
    const bare = await call({ approvalPolicy: "auto_approve", schedulingPolicy: "add_to_queue" }, undefined, strong);
    expect(bare.status).toBe(400);
    expect(bare.json.error.code).toBe("confirmation_required");
    const confirmed = await call(
      { approvalPolicy: "auto_approve", schedulingPolicy: "add_to_queue", confirmUnreviewedQueue: true },
      undefined,
      strong,
    );
    expect(confirmed.status).toBe(201);
    expect(confirmed.json.queued[0]).toMatchObject({ ok: true });
    expect(confirmed.json.post.targets[0].status).toBe("scheduled");
  });

  it("answers 503 generation_not_configured when no model is set up", async () => {
    const { call } = await setup();
    setLlmForTests(null);
    const r = await call();
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("generation_not_configured");
  });

  it("maps unusable output to 422 and a temporary failure to 503", async () => {
    const bad = await setup([{ fail: "invalid_output" }, { fail: "invalid_output" }]);
    const r422 = await bad.call();
    expect(r422.status).toBe(422);
    expect(r422.json.error).toMatchObject({ code: "generation_failed", details: { kind: "invalid_output" } });

    const down = await setup([{ fail: "unavailable" }, { fail: "unavailable" }]);
    const r503 = await down.call();
    expect(r503.status).toBe(503);
    expect(r503.json.error.code).toBe("generation_unavailable");
  });

  it("validates the body and the key's permission", async () => {
    const { call, env } = await setup();
    expect((await call({ brief: "" })).json.error.code).toBe("validation_failed");
    expect((await call({ accountIds: [] })).status).toBe(400);
    const readOnly = (await createKey(env.scope, ["read"])).secret;
    const r = await call({}, undefined, readOnly);
    expect(r.status).toBe(403);
    expect(r.json.error.details).toEqual({ permission: "generate" });
  });
});
