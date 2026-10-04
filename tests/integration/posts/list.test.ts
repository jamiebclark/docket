import { afterAll, describe, expect, it } from "vitest";
import * as media from "../../../src/server/services/media";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const NOW = new Date("2026-10-01T12:00:00Z");

async function draft(env: Awaited<ReturnType<typeof postsEnv>>, accountId: string, baseText = "hello") {
  return posts.createDraft(env.scope, { baseText, targets: [{ accountId }] });
}

describe("listPosts", () => {
  it("filters by status and needs_decision, with counts", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const d = await draft(env, a.id, "just a draft");
    const q = await draft(env, a.id, "queued");
    await atTime(NOW, () => posts.addToQueue(env.scope, q.post.id));
    const amb = await draft(env, a.id, "unsure");
    await atTime(NOW, () => posts.addToQueue(env.scope, amb.post.id));
    await env.scope.targets.update(amb.targets[0]!.id, { status: "ambiguous" });
    await posts.applyDerivedStatus(env.scope, amb.post.id);

    const all = await posts.listPosts(env.scope, {});
    expect(all.total).toBe(3);
    expect(all.counts.draft).toBe(1);
    expect(all.counts.needs_decision).toBe(1);

    const drafts = await posts.listPosts(env.scope, { status: "draft" });
    expect(drafts.items.map((i) => i.id)).toEqual([d.post.id]);

    const decide = await posts.listPosts(env.scope, { status: "needs_decision" });
    expect(decide.items.map((i) => i.id)).toEqual([amb.post.id]);
    expect(decide.items[0]).toMatchObject({ needsDecision: true });
    expect(decide.items[0]!.targets[0]).toMatchObject({ accountName: a.displayName, status: "ambiguous" });
  });

  it("pages 25 at a time and clips the excerpt to 140 graphemes", async () => {
    const env = await postsEnv();
    const a = await env.account();
    for (let i = 0; i < 26; i++) await draft(env, a.id, i === 0 ? "👨‍👩‍👧".repeat(150) : `p${i}`);
    const first = await posts.listPosts(env.scope, { page: 1 });
    const second = await posts.listPosts(env.scope, { page: 2 });
    expect(first.items).toHaveLength(25);
    expect(second.items).toHaveLength(1);
    expect(first.total).toBe(26);
    const long = [...first.items, ...second.items].find((i) => i.excerpt.startsWith("👨"))!;
    expect([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(long.excerpt)]).toHaveLength(141);
    expect(long.excerpt.endsWith("…")).toBe(true);
  });

  it("never shows another project's posts", async () => {
    const mine = await postsEnv();
    const other = await postsEnv();
    await draft(other, (await other.account()).id, "theirs");
    expect((await posts.listPosts(mine.scope, {})).total).toBe(0);
  });
});

describe("getPostView", () => {
  it("returns targets with their attempts and a user step after a retry", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const p = await draft(env, a.id);
    await atTime(NOW, () => posts.addToQueue(env.scope, p.post.id));
    const tid = p.targets[0]!.id;
    await env.scope.targets.update(tid, { status: "failed", lastError: "boom" });
    await atTime(NOW, () => posts.retryTarget(env.scope, tid));
    const view = await posts.getPostView(env.scope, p.post.id);
    expect(view.targets).toHaveLength(1);
    expect(view.targets[0]).toMatchObject({ accountName: a.displayName, status: "scheduled", inProgress: false });
    expect(view.targets[0]!.attempts.map((x) => x.outcome)).toEqual(["retry_requested"]);
    expect(view.deleteBlocked).toBe(false);
  });

  it("shows a deleted image as { id, deleted: true }", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const asset = await media.registerAsset(env.scope, {
      storageKey: "k",
      publicUrl: "https://example.test/k.png",
      mimeType: "image/png",
      width: 10,
      height: 10,
      byteSize: 10,
      altText: "alt",
    });
    const p = await posts.createDraft(env.scope, { baseText: "x", mediaIds: [asset.id], targets: [{ accountId: a.id }] });
    expect((await posts.getPostView(env.scope, p.post.id)).media[0]).toMatchObject({ id: asset.id, deleted: false });
    await env.scope.media.softDelete(asset.id, NOW); // the service detaches drafts; the view must cope with a dangling row
    expect((await posts.getPostView(env.scope, p.post.id)).media).toEqual([{ id: asset.id, deleted: true }]);
  });

  it("is not found for a post in another project", async () => {
    const mine = await postsEnv();
    const other = await postsEnv();
    const p = await draft(other, (await other.account()).id);
    await expect(posts.getPostView(mine.scope, p.post.id)).rejects.toThrow();
  });
});
