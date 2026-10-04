import { afterAll, describe, expect, it } from "vitest";
import { ConflictError } from "../../../src/server/dal/errors";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const NOW = new Date("2026-10-01T12:00:00Z");

describe("rejected posts", () => {
  it("cannot be queued, given an explicit time, or published now", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const created = await posts.createDraft(env.scope, { baseText: "nope", reviewState: "rejected", targets: [{ accountId: a.id }] });
    expect(created.post).toMatchObject({ reviewState: "rejected", status: "rejected" });
    const id = created.post.id;

    const queued = await atTime(NOW, () => posts.addToQueue(env.scope, id));
    expect(queued[0]).toMatchObject({ ok: false, code: "not_queueable", message: "This post was rejected." });
    const timed = await atTime(NOW, () => posts.scheduleAt(env.scope, id, { at: "2026-10-05T09:00:00.000Z" }));
    expect(timed[0]).toMatchObject({ ok: false, code: "not_queueable", message: "This post was rejected." });
    const now = await atTime(NOW, () => posts.publishNow(env.scope, id));
    expect(now[0]).toMatchObject({ ok: false, code: "not_queueable", message: "This post was rejected." });

    expect((await posts.getPost(env.scope, id)).targets[0]!.status).toBe("draft");
  });

  it("setReviewState refuses rejected", async () => {
    const env = await postsEnv();
    const created = await posts.createDraft(env.scope, { baseText: "x", targets: [] });
    await expect(posts.setReviewState(env.scope, created.post.id, "rejected")).rejects.toBeInstanceOf(ConflictError);
  });

  it("is listed and counted under the rejected status", async () => {
    const env = await postsEnv();
    await posts.createDraft(env.scope, { baseText: "r", reviewState: "rejected", targets: [] });
    const list = await posts.listPosts(env.scope, { status: "rejected" });
    expect(list.items.map((i) => i.status)).toEqual(["rejected"]);
    expect(list.counts.rejected).toBe(1);
  });

  it("generation-only create fields are stored", async () => {
    const env = await postsEnv();
    const requestId = crypto.randomUUID();
    const created = await posts.createDraft(env.scope, {
      baseText: "g", origin: "generated", reviewState: "needs_review", generationRequestId: requestId, schedulingPolicy: "add_to_queue", targets: [],
    });
    const row = await forSchedulerProject(env.project.id).posts.findByRequestId(requestId);
    expect(row).toMatchObject({ id: created.post.id, schedulingPolicy: "add_to_queue" });
  });
});
