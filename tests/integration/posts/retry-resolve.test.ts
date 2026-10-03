import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError } from "../../../src/server/dal/errors";
import { runTick } from "../../../src/server/scheduler";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);

afterAll(async () => {
  await closeDb();
});

const BEFORE = new Date("2026-10-01T12:00:00Z");
const SLOT = new Date("2026-10-05T09:00:00Z");
const LATER = new Date("2026-10-05T09:30:00Z");

/** Queues one post across the given accounts and runs its slot tick. */
async function published(settings: Record<string, unknown>[]) {
  const env = await postsEnv();
  const accts = [];
  for (const s of settings) accts.push(await env.account(s));
  const draft = await posts.createDraft(env.scope, { baseText: "Hello", targets: accts.map((a) => ({ accountId: a.id })) });
  await atTime(BEFORE, () => posts.addToQueue(env.scope, draft.post.id, {}));
  await atTime(SLOT, () => runTick());
  const detail = await posts.getPost(env.scope, draft.post.id);
  return { env, postId: draft.post.id, detail, accts };
}

describe("retryTarget", () => {
  it("re-queues a failed target, resets its attempts and records the request", async () => {
    const { env, postId, detail } = await published([{ behaviour: "fatal" }]);
    const targetId = detail.targets[0]!.id;
    expect(detail.targets[0]).toMatchObject({ status: "failed" });

    await atTime(LATER, () => posts.retryTarget(env.scope, targetId));
    const after = await posts.getPost(env.scope, postId);
    expect(after.targets[0]).toMatchObject({ status: "scheduled", attemptCount: 0, lastError: null });
    expect(after.post.status).toBe("scheduled");
    const attempts = await posts.listAttempts(env.scope, targetId);
    expect(attempts.map((a) => a.outcome)).toEqual(["retry_requested", "fatal_error"]);
    expect(attempts[0]!.actorUserId).toBe(env.owner.id);
  });

  it.each([["published", {}], ["ambiguous", { behaviour: "ambiguous" }]] as const)("refuses a %s target", async (_kind, settings) => {
    const { env, detail } = await published([{ ...settings }]);
    await expect(posts.retryTarget(env.scope, detail.targets[0]!.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a scheduled target", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const d = await posts.createDraft(env.scope, { baseText: "x", targets: [{ accountId: a.id }] });
    await atTime(BEFORE, () => posts.addToQueue(env.scope, d.post.id, {}));
    await expect(posts.retryTarget(env.scope, d.targets[0]!.id)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("resolveAmbiguous", () => {
  it("marks an unconfirmed target published and re-derives the post", async () => {
    const { env, postId, detail } = await published([{ behaviour: "ambiguous" }]);
    const targetId = detail.targets[0]!.id;
    expect(detail.targets[0]).toMatchObject({ status: "ambiguous" });
    expect(detail.post.status).toBe("failed");

    await atTime(LATER, () => posts.resolveAmbiguous(env.scope, targetId, { outcome: "published", url: "https://example.test/p/1" }));
    const after = await posts.getPost(env.scope, postId);
    expect(after.targets[0]).toMatchObject({ status: "published", externalUrl: "https://example.test/p/1" });
    expect(after.post.status).toBe("published");
    expect((await posts.listAttempts(env.scope, targetId))[0]).toMatchObject({ outcome: "resolved_published" });
  });

  it("marks an unconfirmed target failed", async () => {
    const { env, postId, detail } = await published([{ behaviour: "ambiguous" }]);
    const targetId = detail.targets[0]!.id;
    await atTime(LATER, () => posts.resolveAmbiguous(env.scope, targetId, { outcome: "failed" }));
    const after = await posts.getPost(env.scope, postId);
    expect(after.targets[0]).toMatchObject({ status: "failed" });
    expect(after.post.status).toBe("failed");
    expect((await posts.listAttempts(env.scope, targetId))[0]).toMatchObject({ outcome: "resolved_failed" });
  });

  it("only resolves ambiguous targets", async () => {
    const { env, detail } = await published([{ behaviour: "fatal" }]);
    await expect(
      posts.resolveAmbiguous(env.scope, detail.targets[0]!.id, { outcome: "published" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("partially_failed", () => {
  it("is derived when one target publishes and another fails, and clears on retry success", async () => {
    const { env, postId, detail, accts } = await published([{}, { behaviour: "fatal" }]);
    expect(detail.post.status).toBe("partially_failed");
    const failed = detail.targets.find((t) => t.accountId === accts[1]!.id)!;
    expect(failed.status).toBe("failed");

    await atTime(LATER, () => posts.retryTarget(env.scope, failed.id));
    expect((await posts.getPost(env.scope, postId)).post.status).toBe("scheduled");
  });
});
