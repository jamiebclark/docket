import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as posts from "../../../src/server/services/posts";
import { eventsFor } from "../../helpers/activity";
import { api, createKey } from "../../helpers/api";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { LATER, outcomeTarget } from "../../helpers/failures";
import { failedTarget, NEXT_MONDAY, pauseAllSlots } from "../../helpers/retry";
import { postsEnv } from "../../helpers/posts-env";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(closeDb);

/** Only the rows written after the scheduler's own failure/ambiguity event. */
const human = async (projectId: string) => (await eventsFor(projectId)).filter((e) => e.kind === "target_resolved");

describe("recovery actions write one target_resolved event", () => {
  it("retry now", async () => {
    const f = await failedTarget();
    await atTime(LATER, () => posts.retryTarget(f.env.scope, f.targetId, { mode: "now" }));
    const [e] = await human(f.env.project.id);
    expect(e).toMatchObject({
      outcome: "resolved",
      postTargetId: f.targetId,
      actorUserId: f.env.owner.id,
      actorApiKeyId: null,
      message: "Retry started now.",
      details: { action: "retry_now" },
    });
  });

  it("retry requeue and retry at", async () => {
    const a = await failedTarget();
    await atTime(LATER, () => posts.retryTarget(a.env.scope, a.targetId, { mode: "requeue" }));
    expect((await human(a.env.project.id)).map((e) => e.details)).toMatchObject([{ action: "retry_requeue", scheduledAt: NEXT_MONDAY }]);

    const b = await failedTarget();
    const when = "2026-10-20T10:00:00.000Z";
    await atTime(LATER, () => posts.retryTarget(b.env.scope, b.targetId, { mode: "at", at: when }));
    expect((await human(b.env.project.id)).map((e) => e.details)).toMatchObject([{ action: "retry_at", scheduledAt: when }]);
  });

  it("writes none when requeue finds no free slot", async () => {
    const f = await failedTarget();
    await pauseAllSlots(f.env, f.account.id);
    await atTime(LATER, () => posts.retryTarget(f.env.scope, f.targetId, { mode: "requeue" }));
    expect(await human(f.env.project.id)).toHaveLength(0);
  });

  it("bulk retry writes only for retried targets, with action bulk_retry", async () => {
    const f = await failedTarget();
    const second = await outcomeTarget(f.env, "fatal", "Twin");
    await atTime(LATER, () => posts.retryTarget(f.env.scope, second.targetId, { mode: "now" })); // no longer failed
    const before = (await human(f.env.project.id)).length;
    await atTime(LATER, () => posts.retryAllFailed(f.env.scope, { mode: "now" }));
    const added = (await human(f.env.project.id)).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ postTargetId: f.targetId, message: "Retried in bulk.", details: { action: "bulk_retry", mode: "now" } });
  });

  it("resolve: published, not published, requeued, no free slot", async () => {
    const resolve = (env: Awaited<ReturnType<typeof postsEnv>>, id: string, input: unknown) =>
      atTime(LATER, () => posts.resolveAmbiguous(env.scope, id, input));

    const env = await postsEnv();
    const p = await outcomeTarget(env, "ambiguous", "P");
    await resolve(env, p.targetId, { outcome: "published", url: "https://example.test/p/1" });
    const n = await outcomeTarget(env, "ambiguous", "N");
    await resolve(env, n.targetId, { outcome: "not_published", requeue: false });
    const r = await outcomeTarget(env, "ambiguous", "R");
    await resolve(env, r.targetId, { outcome: "not_published", requeue: true });
    const resolved = (await human(env.project.id)).map((e) => [e.details, e.message]);
    expect(resolved).toMatchObject([
      [{ action: "marked_published", url: "https://example.test/p/1" }, "Marked published."],
      [{ action: "marked_not_published" }, "Marked not published."],
      [{ action: "requeued" }, "Marked not published and requeued."],
    ]);

    const env2 = await postsEnv();
    const t = await outcomeTarget(env2, "ambiguous", "S");
    const acct = (await env2.scope.targets.get(t.targetId))!.socialAccountId;
    await pauseAllSlots(env2, acct);
    await resolve(env2, t.targetId, { outcome: "not_published", requeue: true });
    expect((await human(env2.project.id)).map((e) => [e.details, e.message])).toMatchObject([
      [{ action: "marked_not_published", requeue: "no_free_slot" }, "Marked not published. No free posting slot to requeue."],
    ]);
  });

  it("API actions carry the key as the actor", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    const key = await createKey(env.scope, ["read", "write_posts"], { rateLimitPerMinute: 1000 });
    const r = await atTime(LATER, () =>
      api("POST", `/posts/${t.postId}/targets/${t.targetId}/resolve`, { key: key.secret, body: { outcome: "published" }, idem: crypto.randomUUID() }),
    );
    expect(r.status).toBe(200);
    const [e] = await human(env.project.id);
    expect(e).toMatchObject({ actorApiKeyId: key.id, details: { action: "marked_published" } });
  });
});
