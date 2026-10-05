import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ForbiddenError, NotFoundError } from "../../../src/server/dal/errors";
import type { ProjectScope } from "../../../src/server/dal/scope";
import * as posts from "../../../src/server/services/posts";
import { approvePost, listReviewQueue, rejectPost } from "../../../src/server/services/review";
import { closeDb } from "../../helpers/db";
import { createPostInReview, createProject } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";
import * as accounts from "../../../src/server/services/accounts";
import { generateSingle } from "../../../src/server/services/generation/single";
import { createFakeLlm } from "../../helpers/fake-llm";
import { createVoiceProfile } from "../../helpers/factories";
import { variantGroupsForPost } from "../../../src/server/services/posts/variant-groups";

afterAll(async () => {
  await closeDb();
});

const TOO_LONG = "x".repeat(501);

describe("listReviewQueue", () => {
  it("lists newest first with variants, voice, brief and policy, and excludes other projects", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const first = await createPostInReview(env.project.id, { accountIds: [a.id], baseText: "older" });
    const second = await createPostInReview(env.project.id, { accountIds: [a.id], baseText: "newer", schedulingPolicy: "add_to_queue" });
    const other = await createProject();
    await createPostInReview(other.id);

    const list = await listReviewQueue(env.scope, {});
    expect(list.items.map((i) => i.postId)).toEqual([second.post.id, first.post.id]);
    expect(list.total).toBe(2);
    const item = list.items[0]!;
    expect(item).toMatchObject({
      voice: { name: "Brand", version: 1 },
      brief: "A product launch",
      schedulingPolicy: "add_to_queue",
      blocking: false,
    });
    expect(item.variants[0]).toMatchObject({ providerKey: "mock", text: "newer", count: 5, limit: 500, accountNames: [a.displayName] });
  });

  it("paginates at 50 and flags blocking posts", async () => {
    const env = await postsEnv();
    const a = await env.account();
    for (let i = 0; i < 51; i++) await createPostInReview(env.project.id, { accountIds: [a.id] });
    const bad = await createPostInReview(env.project.id, { accountIds: [a.id], baseText: TOO_LONG });
    const page1 = await listReviewQueue(env.scope, { page: 1 });
    expect(page1.items).toHaveLength(50);
    expect(page1.total).toBe(52);
    expect(page1.items[0]!.postId).toBe(bad.post.id);
    expect(page1.items[0]!.blocking).toBe(true);
    expect(page1.items[0]!.variants[0]!.issues.some((i) => i.severity === "error")).toBe(true);
    expect((await listReviewQueue(env.scope, { page: 2 })).items).toHaveLength(2);
  });
});

describe("approvePost", () => {
  it("approves a valid post and records the reviewer", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const { post } = await createPostInReview(env.project.id, { accountIds: [a.id] });
    const r = await approvePost(env.scope, post.id);
    expect(r).toMatchObject({ ok: true, queued: [] });
    const row = (await env.scope.posts.get(post.id))!;
    expect(row).toMatchObject({ reviewState: "approved", reviewedByUserId: env.owner.id });
    expect(row.reviewedAt).toBeInstanceOf(Date);
    expect((await env.scope.targets.listForPost(post.id))[0]!.status).toBe("draft");
  });

  it("queues when the remembered policy is add_to_queue, matching the queue slots", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const { post } = await createPostInReview(env.project.id, { accountIds: [a.id], schedulingPolicy: "add_to_queue" });
    const r = await approvePost(env.scope, post.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.queued).toHaveLength(1);
    const [target] = await env.scope.targets.listForPost(post.id);
    expect(target).toMatchObject({ status: "scheduled" });
    const q = r.queued[0]!;
    expect(q.ok && q.scheduledAt).toBeTruthy();
    if (q.ok) expect(new Date(q.scheduledAt).getTime()).toBe(target!.scheduledAt!.getTime());
  });

  it("says already_reviewed the second time", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const { post } = await createPostInReview(env.project.id, { accountIds: [a.id] });
    await approvePost(env.scope, post.id);
    expect(await approvePost(env.scope, post.id)).toEqual({
      ok: false,
      code: "already_reviewed",
      message: "This post was already approved.",
    });
  });

  it("returns validation issues keyed by provider and stays in review", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const { post } = await createPostInReview(env.project.id, { accountIds: [a.id], baseText: TOO_LONG });
    const r = await approvePost(env.scope, post.id);
    expect(r).toMatchObject({ ok: false, code: "validation" });
    if (r.ok || !("issues" in r)) throw new Error("expected issues");
    expect(Object.keys(r.issues!)).toEqual(["mock"]);
    expect((await env.scope.posts.get(post.id))!.reviewState).toBe("needs_review");
  });

  it("save-and-approve with a valid edit approves, and queues", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const { post } = await createPostInReview(env.project.id, { accountIds: [a.id], baseText: TOO_LONG, schedulingPolicy: "add_to_queue" });
    const r = await approvePost(env.scope, post.id, { edits: [{ accountIds: [a.id], text: "Fixed up" }] });
    expect(r.ok).toBe(true);
    const [target] = await env.scope.targets.listForPost(post.id);
    expect(target).toMatchObject({ overrideText: "Fixed up", status: "scheduled" });
  });

  it("keeps an invalid edit and stays in review with the issues", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const { post } = await createPostInReview(env.project.id, { accountIds: [a.id] });
    const r = await approvePost(env.scope, post.id, { edits: [{ accountIds: [a.id], text: TOO_LONG }] });
    expect(r).toMatchObject({ ok: false, code: "validation" });
    expect((await env.scope.posts.get(post.id))!.reviewState).toBe("needs_review");
    expect((await env.scope.targets.listForPost(post.id))[0]!.overrideText).toBe(TOO_LONG);
  });

  it("approves when one account has no slots and queues the others", async () => {
    const env = await postsEnv();
    const withSlot = await env.account();
    const noSlot = await env.account({}, false);
    const { post } = await createPostInReview(env.project.id, { accountIds: [withSlot.id, noSlot.id], schedulingPolicy: "add_to_queue" });
    const r = await approvePost(env.scope, post.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bad = r.queued.find((q) => !q.ok);
    expect(bad).toMatchObject({ ok: false, accountId: noSlot.id, code: "no_active_slots" });
    expect(bad && !bad.ok && bad.message).toContain("no active posting slots");
    const targets = await env.scope.targets.listForPost(post.id);
    expect(targets.find((t) => t.socialAccountId === withSlot.id)!.status).toBe("scheduled");
    expect(targets.find((t) => t.socialAccountId === noSlot.id)!.status).toBe("draft");
    expect((await env.scope.posts.get(post.id))!.reviewState).toBe("approved");
  });

  it("refuses a role without permission and a missing post", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const { post } = await createPostInReview(env.project.id, { accountIds: [a.id] });
    const viewer = new Proxy(env.scope, {
      get: (t, k) => (k === "can" ? () => false : Reflect.get(t, k)),
    }) as ProjectScope;
    await expect(approvePost(viewer, post.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(rejectPost(viewer, post.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approvePost(env.scope, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    const editor = await env.as(env.editor);
    expect((await approvePost(editor, post.id)).ok).toBe(true);
  });
});

describe("rejectPost", () => {
  it("stores the reason, leaves targets draft and blocks scheduling", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const { post } = await createPostInReview(env.project.id, { accountIds: [a.id] });
    expect(await rejectPost(env.scope, post.id, { reason: "  Off brand  " })).toEqual({ ok: true });
    const row = (await env.scope.posts.get(post.id))!;
    expect(row).toMatchObject({ reviewState: "rejected", rejectionReason: "Off brand", status: "rejected" });
    expect((await env.scope.targets.listForPost(post.id))[0]!.status).toBe("draft");
    const queued = await posts.addToQueue(env.scope, post.id);
    expect(queued[0]).toMatchObject({ ok: false, message: "This post was rejected." });
    const timed = await posts.scheduleAt(env.scope, post.id, { at: "2099-01-05T09:00:00.000Z" });
    expect(timed[0]).toMatchObject({ ok: false, message: "This post was rejected." });
    const now = await posts.publishNow(env.scope, post.id);
    expect(now[0]).toMatchObject({ ok: false, message: "This post was rejected." });
    expect((await posts.listPosts(env.scope, { status: "rejected" })).items.map((i) => i.id)).toContain(post.id);
  });

  it("rejects without a reason, and refuses an approved post", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const one = await createPostInReview(env.project.id, { accountIds: [a.id] });
    expect(await rejectPost(env.scope, one.post.id)).toEqual({ ok: true });
    expect((await env.scope.posts.get(one.post.id))!.rejectionReason).toBeNull();
    const two = await createPostInReview(env.project.id, { accountIds: [a.id] });
    await approvePost(env.scope, two.post.id);
    expect(await rejectPost(env.scope, two.post.id)).toEqual({
      ok: false,
      code: "already_reviewed",
      message: "This post was already approved.",
    });
  });
});


describe("grouped variants", () => {
  async function generated() {
    const env = await postsEnv();
    const voice = await createVoiceProfile(env.project.id);
    const a = await accounts.connectMock(env.scope, { displayName: "Acme A", settings: {} });
    const b = await accounts.connectMock(env.scope, { displayName: "Acme B", settings: {} });
    await accounts.setPostingInstructions(env.scope, a.id, { instructions: "Formal." });
    await accounts.setPostingInstructions(env.scope, b.id, { instructions: "Casual." });
    const res = await generateSingle(
      env.scope,
      { requestId: randomUUID(), voiceProfileId: voice.id, brief: "Brief", targetAccountIds: [a.id, b.id] },
      createFakeLlm([{ ok: { variants: { mock_1: { text: "Formal text" }, mock_2: { text: "Casual text" } } } }]),
    );
    if (!res.ok) throw new Error("setup failed");
    return { env, a, b, postId: res.postId };
  }

  it("lists one entry per group with its own count and limit", async () => {
    const { env, a, b, postId } = await generated();
    const item = (await listReviewQueue(env.scope, {})).items.find((i) => i.postId === postId)!;
    expect(item.variants).toHaveLength(2);
    expect(item.variants[0]).toMatchObject({ key: "mock_1", text: "Formal text", count: 11, limit: 500, accountIds: [a.id], accountNames: ["Acme A"] });
    expect(item.variants[1]).toMatchObject({ key: "mock_2", text: "Casual text", count: 11, limit: 500, accountIds: [b.id] });
  });

  it("orders groups as recorded, whatever order the targets are stored in", async () => {
    const { env, a, b, postId } = await generated();
    const post = (await env.scope.posts.get(postId))!;
    const targets = await env.scope.targets.listForPost(postId);
    for (const order of [targets, [...targets].reverse()]) {
      const groups = await variantGroupsForPost(env.scope, post, order);
      expect(groups.map((g) => [g.key, g.accountIds])).toEqual([
        ["mock_1", [a.id]],
        ["mock_2", [b.id]],
      ]);
    }
  });

  it("editing one group changes only that group's targets", async () => {
    const { env, a, b, postId } = await generated();
    await posts.updatePostVariants(env.scope, postId, { edits: [{ accountIds: [b.id], text: "Edited casual" }] });
    const text = Object.fromEntries((await env.scope.targets.listForPost(postId)).map((t) => [t.socialAccountId, t.overrideText]));
    expect(text).toEqual({ [a.id]: "Formal text", [b.id]: "Edited casual" });
  });

  it("groups an old record without accounts by platform", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const b = await env.account();
    const { post } = await createPostInReview(env.project.id, { accountIds: [a.id, b.id] });
    const item = (await listReviewQueue(env.scope, {})).items.find((i) => i.postId === post.id)!;
    expect(item.variants).toHaveLength(1);
    expect(item.variants[0]!.key).toBe("mock");
    expect([...item.variants[0]!.accountIds].sort()).toEqual([a.id, b.id].sort());
  });
});
