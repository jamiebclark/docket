import { afterAll, describe, expect, it } from "vitest";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import * as posts from "../../../src/server/services/posts";
import { applyDerivedStatus } from "../../../src/server/services/posts/status";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

describe("applyDerivedStatus", () => {
  it("re-derives from the targets and persists it", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const b = await env.account();
    const p = await posts.createDraft(env.scope, { baseText: "s", reviewState: "approved", targets: [{ accountId: a.id }, { accountId: b.id }] });
    const repos = forSchedulerProject(env.project.id);
    const [t1, t2] = p.targets;
    const live = { scheduleKind: "explicit" as const, scheduledAt: new Date(), nextAttemptAt: new Date() };
    await repos.targets.update(t1!.id, { ...live, status: "published", externalId: "x" });
    await repos.targets.update(t2!.id, { ...live, status: "failed" });
    expect(await repos.transaction((tx) => applyDerivedStatus(tx, p.post.id))).toBe("partially_failed");
    expect((await posts.getPost(env.scope, p.post.id)).post.status).toBe("partially_failed");
    await repos.targets.update(t2!.id, { status: "scheduled" });
    expect(await repos.transaction((tx) => applyDerivedStatus(tx, p.post.id))).toBe("scheduled");
    await repos.targets.update(t1!.id, { status: "cancelled" });
    await repos.targets.update(t2!.id, { status: "cancelled" });
    expect(await repos.transaction((tx) => applyDerivedStatus(tx, p.post.id))).toBe("approved");
  });

  it("returns null for a deleted post", async () => {
    const env = await postsEnv();
    const p = await posts.createDraft(env.scope, { baseText: "gone", targets: [] });
    await posts.deletePost(env.scope, p.post.id);
    expect(await forSchedulerProject(env.project.id).transaction((tx) => applyDerivedStatus(tx, p.post.id))).toBeNull();
  });
});
