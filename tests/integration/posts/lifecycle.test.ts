import { afterAll, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "../../../src/server/dal/errors";
import * as media from "../../../src/server/services/media";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const NOW = new Date("2026-10-01T12:00:00Z");
const MON1 = "2026-10-05T09:00:00.000Z";
const MON2 = "2026-10-12T09:00:00.000Z";

describe("post lifecycle", () => {
  it("creates a draft with media and targets and marks the asset used", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const asset = await media.registerAsset(env.scope, {
      storageKey: "k/1.png", publicUrl: "http://localhost:3000/m/1.png", mimeType: "image/png", byteSize: 100, altText: "cat",
    });
    const post = await posts.createDraft(env.scope, { baseText: "Hi", mediaIds: [asset.id], targets: [{ accountId: a.id, overrideText: "Hi there" }] });
    expect(post.post.status).toBe("draft");
    expect(post.mediaIds).toEqual([asset.id]);
    expect(post.targets[0]).toMatchObject({ status: "draft", overrideText: "Hi there", accountId: a.id });
    await expect(posts.createDraft(env.scope, { baseText: "x", targets: [{ accountId: crypto.randomUUID() }] })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("previewQueue writes nothing and reserves nothing", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const p1 = await posts.createDraft(env.scope, { baseText: "one", targets: [{ accountId: a.id }] });
    const p2 = await posts.createDraft(env.scope, { baseText: "two", targets: [{ accountId: a.id }] });
    const prev1 = await atTime(NOW, () => posts.previewQueue(env.scope, p1.post.id));
    const prev2 = await atTime(NOW, () => posts.previewQueue(env.scope, p2.post.id));
    expect(prev1[0]).toMatchObject({ ok: true, scheduledAt: MON1 });
    expect(prev2[0]).toMatchObject({ ok: true, scheduledAt: MON1 });
    expect((await posts.getPost(env.scope, p1.post.id)).targets[0]!.status).toBe("draft");
  });

  it("addToQueue allocates distinct occurrences and flags a changed preview", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const p1 = await posts.createDraft(env.scope, { baseText: "one", targets: [{ accountId: a.id }] });
    const p2 = await posts.createDraft(env.scope, { baseText: "two", targets: [{ accountId: a.id }] });
    const t2 = p2.targets[0]!.id;
    const preview = await atTime(NOW, () => posts.previewQueue(env.scope, p2.post.id));
    const first = await atTime(NOW, () => posts.addToQueue(env.scope, p1.post.id));
    const second = await atTime(NOW, () =>
      posts.addToQueue(env.scope, p2.post.id, { expected: { [t2]: (preview[0] as { scheduledAt: string }).scheduledAt } }),
    );
    expect(first[0]).toMatchObject({ ok: true, scheduledAt: MON1, changedFromPreview: false });
    expect(second[0]).toMatchObject({ ok: true, scheduledAt: MON2, changedFromPreview: true });
    expect((await posts.getPost(env.scope, p2.post.id)).post.status).toBe("scheduled");
  });

  it("scheduleAt sets an explicit time, rejects the past, and warns about neighbours", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const queued = await posts.createDraft(env.scope, { baseText: "q", targets: [{ accountId: a.id }] });
    await atTime(NOW, () => posts.addToQueue(env.scope, queued.post.id));
    const p = await posts.createDraft(env.scope, { baseText: "e", targets: [{ accountId: a.id }] });
    const past = await atTime(NOW, () => posts.scheduleAt(env.scope, p.post.id, { at: "2026-09-01T00:00:00Z" }));
    expect(past[0]).toMatchObject({ ok: false, code: "in_past" });
    const ok = await atTime(NOW, () => posts.scheduleAt(env.scope, p.post.id, { at: "2026-10-05T09:10:00Z" }));
    expect(ok[0]).toMatchObject({ ok: true });
    expect((ok[0] as { warnings: unknown[] }).warnings).toHaveLength(1);
    const detail = await posts.getPost(env.scope, p.post.id);
    expect(detail.targets[0]).toMatchObject({ status: "scheduled", scheduleKind: "explicit", slotId: null });
  });

  it("publishNow schedules for the clock's now", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    const p = await posts.createDraft(env.scope, { baseText: "now", targets: [{ accountId: a.id }] });
    await atTime(NOW, () => posts.publishNow(env.scope, p.post.id));
    expect((await posts.getPost(env.scope, p.post.id)).targets[0]).toMatchObject({ scheduleKind: "now", scheduledAt: NOW });
  });

  it("cancel frees the occurrence for the next post; an emptied post returns to draft", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const p1 = await posts.createDraft(env.scope, { baseText: "one", targets: [{ accountId: a.id }] });
    const p2 = await posts.createDraft(env.scope, { baseText: "two", targets: [{ accountId: a.id }] });
    await atTime(NOW, () => posts.addToQueue(env.scope, p1.post.id));
    await posts.setReviewState(env.scope, p1.post.id, "approved");
    await posts.cancelTarget(env.scope, p1.targets[0]!.id);
    const after = await posts.getPost(env.scope, p1.post.id);
    expect(after.post).toMatchObject({ status: "draft", reviewState: "draft" });
    const r = await atTime(NOW, () => posts.addToQueue(env.scope, p2.post.id));
    expect(r[0]).toMatchObject({ ok: true, scheduledAt: MON1 });
    await expect(posts.cancelTarget(env.scope, p1.targets[0]!.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("update and delete rules", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const p = await posts.createDraft(env.scope, { baseText: "one", targets: [{ accountId: a.id }] });
    const updated = await posts.updatePost(env.scope, p.post.id, { baseText: "edited" });
    expect(updated.post.baseText).toBe("edited");
    // A text-only patch must not touch targets or media.
    expect(updated.targets).toHaveLength(1);
    expect(updated.targets[0]!.status).toBe("draft");
    await posts.deletePost(env.scope, p.post.id);
    await expect(posts.getPost(env.scope, p.post.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("cancelling one draft target of a needs_review post keeps it in review (F22)", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const b = await env.account();
    const p = await posts.createDraft(env.scope, { baseText: "r", reviewState: "needs_review", targets: [{ accountId: a.id }, { accountId: b.id }] });
    await posts.cancelTarget(env.scope, p.targets[0]!.id);
    expect((await posts.getPost(env.scope, p.post.id)).post.reviewState).toBe("needs_review");
    const blocked = await atTime(NOW, () => posts.addToQueue(env.scope, p.post.id));
    expect(blocked.every((r) => !r.ok)).toBe(true);
    // Cancelling the last live target is "all cancelled", which does return to draft.
    await posts.cancelTarget(env.scope, p.targets[1]!.id);
    expect((await posts.getPost(env.scope, p.post.id)).post.reviewState).toBe("draft");
  });

  it("needs_review posts cannot be queued, and ambiguous/failed targets resolve and retry", async () => {
    const env = await postsEnv();
    const a = await env.account({ behaviour: "ambiguous" }, false);
    const p = await posts.createDraft(env.scope, { baseText: "r", reviewState: "needs_review", targets: [{ accountId: a.id }] });
    const blocked = await atTime(NOW, () => posts.addToQueue(env.scope, p.post.id));
    expect(blocked[0]).toMatchObject({ ok: false, code: "not_queueable" });
    await posts.setReviewState(env.scope, p.post.id, "approved");
    await atTime(NOW, () => posts.publishNow(env.scope, p.post.id));
    const { runTick } = await import("../../../src/server/scheduler");
    await atTime(NOW, () => runTick());
    const detail = await posts.getPost(env.scope, p.post.id);
    expect(detail.targets[0]!.status).toBe("ambiguous");
    await expect(posts.updatePost(env.scope, p.post.id, { baseText: "no" })).rejects.toBeInstanceOf(ConflictError);
    await expect(posts.deletePost(env.scope, p.post.id)).rejects.toBeInstanceOf(ConflictError);
    await posts.resolveAmbiguous(env.scope, p.targets[0]!.id, { outcome: "failed" });
    expect((await posts.getPost(env.scope, p.post.id)).post.status).toBe("failed");
    await posts.retryTarget(env.scope, p.targets[0]!.id);
    expect((await posts.getPost(env.scope, p.post.id)).targets[0]!.status).toBe("scheduled");
    const outcomes = (await posts.listAttempts(env.scope, p.targets[0]!.id)).map((x) => x.outcome);
    expect(outcomes).toEqual(["retry_requested", "resolved_failed", "ambiguous"]);
  });
});
