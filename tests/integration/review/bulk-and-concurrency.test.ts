import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { regeneratePost } from "../../../src/server/services/generation/regenerate";
import { approvePost, bulkApprove } from "../../../src/server/services/review";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { createPostInReview, createVoiceProfile } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

describe("bulkApprove", () => {
  it("approves 19 of 20, notes the unscheduled account, and skips the blocking post", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const noSlot = await env.account({}, false);
    const ids: string[] = [];
    for (let i = 0; i < 18; i++) ids.push((await createPostInReview(env.project.id, { accountIds: [a.id] })).post.id);
    ids.push((await createPostInReview(env.project.id, { accountIds: [noSlot.id], schedulingPolicy: "add_to_queue" })).post.id);
    const blocking = await createPostInReview(env.project.id, { accountIds: [a.id], baseText: "x".repeat(501) });
    ids.push(blocking.post.id);

    const r = await bulkApprove(env.scope, { postIds: ids });
    expect(r.approved).toHaveLength(19);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.postId).toBe(blocking.post.id);
    expect(r.skipped[0]!.reason).toMatch(/characters|limit|long/i);
    const unscheduled = r.approved.filter((x) => x.unscheduled.length > 0);
    expect(unscheduled).toHaveLength(1);
    expect(unscheduled[0]!.unscheduled[0]).toMatchObject({ accountName: noSlot.displayName });
  });

  it("skips a missing or foreign id as Not found", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const other = await postsEnv();
    const theirs = await createPostInReview(other.project.id);
    const mine = await createPostInReview(env.project.id, { accountIds: [a.id] });
    const missing = randomUUID();
    const r = await bulkApprove(env.scope, { postIds: [theirs.post.id, missing, mine.post.id] });
    expect(r.approved.map((x) => x.postId)).toEqual([mine.post.id]);
    expect(r.skipped).toEqual([
      { postId: theirs.post.id, reason: "Not found" },
      { postId: missing, reason: "Not found" },
    ]);
  });

  it("rejects 0 and more than 100 ids", async () => {
    const env = await postsEnv();
    await expect(bulkApprove(env.scope, { postIds: [] })).rejects.toBeInstanceOf(ZodError);
    await expect(bulkApprove(env.scope, { postIds: Array.from({ length: 101 }, () => randomUUID()) })).rejects.toBeInstanceOf(ZodError);
  });
});

describe("concurrency", () => {
  it("20 parallel approvals produce one winner and one occupied slot per target", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const { post } = await createPostInReview(env.project.id, { accountIds: [a.id], schedulingPolicy: "add_to_queue" });
    const results = await Promise.all(Array.from({ length: 20 }, () => approvePost(env.scope, post.id)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "already_reviewed")).toHaveLength(19);
    const targets = await env.scope.targets.listForPost(post.id);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.status).toBe("scheduled");
  });
});

describe("regenerate from the review queue", () => {
  it("keeps the post in review", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const profile = await createVoiceProfile(env.project.id);
    const { post } = await createPostInReview(env.project.id, {
      accountIds: [a.id],
      record: { voiceProfile: { id: profile.id, versionId: profile.versionIds[0]!, version: 1, name: profile.name } },
    });
    const llm = createFakeLlm([{ ok: { variants: { mock: { text: "Fresh words" } } } }]);
    const res = await regeneratePost(env.scope, post.id, { instruction: "Shorter" }, llm);
    expect(res.ok).toBe(true);
    const row = (await env.scope.posts.get(post.id))!;
    expect(row.reviewState).toBe("needs_review");
  });
});
