import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError } from "../../../src/server/dal/errors";
import { listFailures } from "../../../src/server/services/failures";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { LATER, outcomeTarget, setAccountStatus } from "../../helpers/failures";
import { postsEnv } from "../../helpers/posts-env";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(async () => {
  await closeDb();
});

describe("retry", () => {
  it("re-arms a failed target on an active account and resets the count", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "fatal");
    const [row] = (await listFailures(env.scope)).rows;
    expect(row!.actions).toMatchObject({ canRetry: true, retryBlockedReason: null });
    await atTime(LATER, () => posts.retryTarget(env.scope, t.targetId));
    expect((await posts.getPost(env.scope, t.postId)).targets[0]).toMatchObject({ status: "scheduled", attemptCount: 0, lastError: null });
  });

  it("is refused with an actionable message when the account needs reconnecting", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "fatal");
    await setAccountStatus(env.project.id, t.account.id, "needs_reauth");
    const [row] = (await listFailures(env.scope)).rows;
    expect(row!.actions.canRetry).toBe(false);
    expect(row!.actions.retryBlockedReason).toMatch(/reconnected/);
    await expect(posts.retryTarget(env.scope, t.targetId)).rejects.toThrow(row!.actions.retryBlockedReason!);
  });

  it("is refused when the account was removed", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "fatal");
    expect(posts.retryBlockedReason(null, true)).toMatch(/removed/);
    expect(posts.retryBlockedReason({ displayName: "X", status: "active" } as never, false)).toMatch(/no longer available/);
    expect(posts.retryBlockedReason({ displayName: "X", status: "active" } as never, true)).toBeNull();
    expect(t.targetId).toBeTruthy();
  });

  it("a non-failed target gets the 'no longer failed' conflict", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "fatal");
    await atTime(LATER, () => posts.retryTarget(env.scope, t.targetId));
    await expect(posts.retryTarget(env.scope, t.targetId)).rejects.toBeInstanceOf(ConflictError);
  });
});
