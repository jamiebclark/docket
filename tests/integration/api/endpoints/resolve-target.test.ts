import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as posts from "../../../../src/server/services/posts";
import { createEndpoint } from "../../../../src/server/services/webhooks";
import { api, createKey } from "../../../helpers/api";
import { atTime } from "../../../helpers/clock";
import { closeDb } from "../../../helpers/db";
import { breakAccount, LATER, outcomeTarget } from "../../../helpers/failures";
import { NEXT_MONDAY, pauseAllSlots } from "../../../helpers/retry";
import { postsEnv } from "../../../helpers/posts-env";
import { parkAllDueTargets } from "../../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(closeDb);

async function setup() {
  const env = await postsEnv();
  const t = await outcomeTarget(env, "ambiguous");
  const key = (await createKey(env.scope, ["read", "write_posts"], { rateLimitPerMinute: 1000 })).secret;
  const path = `/posts/${t.postId}/targets/${t.targetId}/resolve`;
  const call = (body: unknown) => atTime(LATER, () => api("POST", path, { key, body, idem: crypto.randomUUID() }));
  const outcomes = async () => (await posts.listAttempts(env.scope, t.targetId)).map((a) => a.outcome);
  return { env, ...t, key, path, call, outcomes };
}

describe("POST /posts/{postId}/targets/{targetId}/resolve", () => {
  it("resolves as published without a url", async () => {
    const f = await setup();
    const r = await f.call({ outcome: "published" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ postId: f.postId, targetId: f.targetId, status: "published" });
    expect(await f.outcomes()).toContain("resolved_published");
  });

  it("resolves as published with a url and emits post.published", async () => {
    const f = await setup();
    const { endpoint } = await createEndpoint(f.env.scope, { url: "http://127.0.0.1:9/x", description: "", events: ["post.published"] });
    const r = await f.call({ outcome: "published", url: "https://example.com/p/1" });
    expect(r.status).toBe(200);
    expect((await f.env.scope.targets.get(f.targetId))!.externalUrl).toBe("https://example.com/p/1");
    const deliveries = await f.env.scope.webhooks.listDeliveries(endpoint.id, { limit: 10 });
    expect(deliveries).toHaveLength(1);
    expect((await f.env.scope.webhooks.getEvent(deliveries[0]!.eventId))!.type).toBe("post.published");
  });

  it("leaves a not-published target failed when not requeued", async () => {
    const f = await setup();
    const r = await f.call({ outcome: "not_published", requeue: false });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "failed", reason: "not_requeued" });
    expect(await f.outcomes()).toContain("resolved_failed");
  });

  it("requeues into the next free slot with resolved_not_published then requeued", async () => {
    const f = await setup();
    const r = await f.call({ outcome: "not_published", requeue: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "scheduled", scheduledAt: NEXT_MONDAY, changedFromPreview: false });
    expect(r.json.slotId).toEqual(expect.any(String));
    const attempts = await posts.listAttempts(f.env.scope, f.targetId);
    const at = (o: string) => attempts.find((a) => a.outcome === o)!.createdAt.getTime();
    expect(at("requeued")).toBeGreaterThan(at("resolved_not_published"));
  });

  it("normalises an offset expected instant to UTC", async () => {
    const f = await setup();
    const same = await f.call({ outcome: "not_published", requeue: true, expected: "2026-10-12T11:00:00+02:00" });
    expect(same.json).toMatchObject({ status: "scheduled", changedFromPreview: false });
    const g = await setup();
    const diff = await g.call({ outcome: "not_published", requeue: true, expected: "2026-10-12T12:00:00+02:00" });
    expect(diff.json).toMatchObject({ status: "scheduled", changedFromPreview: true });
  });

  it("reports no_free_slot as a 200 failed result", async () => {
    const f = await setup();
    await pauseAllSlots(f.env, f.account.id);
    const r = await f.call({ outcome: "not_published", requeue: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "failed", reason: "no_free_slot" });
    expect((await f.env.scope.targets.get(f.targetId))!.status).toBe("failed");
  });

  it("409 cannot_publish when the gate refuses, leaving the target ambiguous", async () => {
    const f = await setup();
    await breakAccount(f.env.project.id, f.account.id, "removed");
    const r = await f.call({ outcome: "not_published", requeue: true });
    expect(r.status).toBe(409);
    expect(r.json.error.details).toEqual({ reason: "cannot_publish" });
    expect((await f.env.scope.targets.get(f.targetId))!.status).toBe("ambiguous");
  });

  it("409 already_resolved for a failed target", async () => {
    const f = await setup();
    await f.env.scope.targets.update(f.targetId, { status: "failed" });
    const r = await f.call({ outcome: "published" });
    expect(r.status).toBe(409);
    expect(r.json.error.details).toEqual({ reason: "already_resolved" });
  });

  it("400s a bad url at path url", async () => {
    const f = await setup();
    const r = await f.call({ outcome: "published", url: "not a url" });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json.error)).toContain("url");
  });

  it("400s outcome failed", async () => {
    const f = await setup();
    const r = await f.call({ outcome: "failed" });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("validation_failed");
  });

  it("404s a wrong post/target pairing", async () => {
    const f = await setup();
    const other = await outcomeTarget(f.env, "ambiguous", "Other");
    const r = await atTime(LATER, () =>
      api("POST", `/posts/${f.postId}/targets/${other.targetId}/resolve`, { key: f.key, body: { outcome: "published" }, idem: crypto.randomUUID() }),
    );
    expect(r.status).toBe(404);
    expect((await f.env.scope.targets.get(other.targetId))!.status).toBe("ambiguous");
  });
});
