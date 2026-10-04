import { afterAll, describe, expect, it } from "vitest";
import { ConflictError } from "../../../src/server/dal/errors";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const NOW = new Date("2026-10-01T12:00:00Z");
type Env = Awaited<ReturnType<typeof postsEnv>>;

async function target(env: Env, status: "failed" | "ambiguous" | "scheduled" | "published" | "publishing") {
  const a = await env.account();
  const p = await posts.createDraft(env.scope, { baseText: "t", targets: [{ accountId: a.id }] });
  await atTime(NOW, () => posts.addToQueue(env.scope, p.post.id));
  const targetId = p.targets[0]!.id;
  if (status !== "scheduled") {
    await env.scope.targets.update(targetId, {
      status,
      ...(status === "published" ? { externalId: "x1", publishedAt: NOW } : {}),
    });
    await posts.applyDerivedStatus(env.scope, p.post.id);
  }
  return { postId: p.post.id, targetId };
}
const state = async (env: Env, t: { targetId: string }) => (await env.scope.targets.get(t.targetId))!;

describe("retryTarget", () => {
  it("requeues a failed target and logs the user step", async () => {
    const env = await postsEnv();
    const t = await target(env, "failed");
    await atTime(NOW, () => posts.retryTarget(env.scope, t.targetId));
    expect((await state(env, t)).status).toBe("scheduled");
    expect((await posts.listAttempts(env.scope, t.targetId)).map((a) => a.outcome)).toContain("retry_requested");
  });

  it("refuses anything but a failed target", async () => {
    const env = await postsEnv();
    const t = await target(env, "scheduled");
    await expect(posts.retryTarget(env.scope, t.targetId)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("cancelTarget", () => {
  it("cancels a scheduled target", async () => {
    const env = await postsEnv();
    const t = await target(env, "scheduled");
    await posts.cancelTarget(env.scope, t.targetId);
    expect((await state(env, t)).status).toBe("cancelled");
  });

  it("refuses a published target", async () => {
    const env = await postsEnv();
    const t = await target(env, "published");
    await expect(posts.cancelTarget(env.scope, t.targetId)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("resolveAmbiguous", () => {
  it("marks published with an optional url", async () => {
    const env = await postsEnv();
    const t = await target(env, "ambiguous");
    await atTime(NOW, () => posts.resolveAmbiguous(env.scope, t.targetId, { outcome: "published", url: "https://example.test/p/1" }));
    expect(await state(env, t)).toMatchObject({ status: "published", externalUrl: "https://example.test/p/1" });
  });

  it("marks failed, which can then be retried", async () => {
    const env = await postsEnv();
    const t = await target(env, "ambiguous");
    await atTime(NOW, () => posts.resolveAmbiguous(env.scope, t.targetId, { outcome: "failed" }));
    expect((await state(env, t)).status).toBe("failed");
    await atTime(NOW, () => posts.retryTarget(env.scope, t.targetId));
    expect((await state(env, t)).status).toBe("scheduled");
  });

  it("refuses a target that is not ambiguous", async () => {
    const env = await postsEnv();
    const t = await target(env, "scheduled");
    await expect(posts.resolveAmbiguous(env.scope, t.targetId, { outcome: "failed" })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("deletePost", () => {
  it("deletes a post with only scheduled targets and drops it from the list", async () => {
    const env = await postsEnv();
    const t = await target(env, "scheduled");
    await posts.deletePost(env.scope, t.postId);
    expect((await posts.listPosts(env.scope, {})).total).toBe(0);
  });

  for (const status of ["published", "publishing", "ambiguous"] as const) {
    it(`is refused while a target is ${status}`, async () => {
      const env = await postsEnv();
      const t = await target(env, status);
      await expect(posts.deletePost(env.scope, t.postId)).rejects.toBeInstanceOf(ConflictError);
      expect((await posts.getPostView(env.scope, t.postId)).deleteBlocked).toBe(true);
    });
  }
});
