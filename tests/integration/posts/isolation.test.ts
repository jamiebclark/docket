import { afterAll, describe, expect, it } from "vitest";
import { NotFoundError } from "../../../src/server/dal/errors";
import * as posts from "../../../src/server/services/posts";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

describe("cross-project isolation", () => {
  it("another project's posts, targets and attempts behave as not found", async () => {
    const mine = await postsEnv();
    const theirs = await postsEnv();
    const a = await theirs.account();
    const p = await posts.createDraft(theirs.scope, { baseText: "secret", targets: [{ accountId: a.id }] });
    const targetId = p.targets[0]!.id;
    const nf = (promise: Promise<unknown>) => expect(promise).rejects.toBeInstanceOf(NotFoundError);
    await nf(posts.getPost(mine.scope, p.post.id));
    await nf(posts.validatePost(mine.scope, p.post.id));
    await nf(posts.previewQueue(mine.scope, p.post.id));
    await nf(posts.addToQueue(mine.scope, p.post.id));
    await nf(posts.scheduleAt(mine.scope, p.post.id, { at: "2030-01-01T00:00:00Z" }));
    await nf(posts.publishNow(mine.scope, p.post.id));
    await nf(posts.updatePost(mine.scope, p.post.id, { baseText: "x" }));
    await nf(posts.setReviewState(mine.scope, p.post.id, "approved"));
    await nf(posts.deletePost(mine.scope, p.post.id));
    await nf(posts.cancelTarget(mine.scope, targetId));
    await nf(posts.retryTarget(mine.scope, targetId));
    await nf(posts.resolveAmbiguous(mine.scope, targetId, { outcome: "failed" }));
    await nf(posts.listAttempts(mine.scope, targetId));
    // Nor can my post reference their account.
    await nf(posts.createDraft(mine.scope, { baseText: "x", targets: [{ accountId: a.id }] }));
    // Theirs is untouched.
    expect((await posts.getPost(theirs.scope, p.post.id)).post.baseText).toBe("secret");
  });
});
