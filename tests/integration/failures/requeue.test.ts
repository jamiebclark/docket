import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError } from "../../../src/server/dal/errors";
import { previewRequeue } from "../../../src/server/services/failures";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { LATER, outcomeTarget, setAccountStatus } from "../../helpers/failures";
import { postsEnv } from "../../helpers/posts-env";
import { parkAllDueTargets } from "../../helpers/scheduling";
import * as slots from "../../../src/server/services/slots";

beforeEach(parkAllDueTargets);
afterAll(async () => {
  await closeDb();
});

const NEXT_MONDAY = "2026-10-12T09:00:00.000Z";

describe("mark not published and requeue", () => {
  it("takes the next free slot and logs resolved_not_published then requeued", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    const preview = await atTime(LATER, () => previewRequeue(env.scope, t.targetId));
    expect(preview).toMatchObject({ ok: true, scheduledAt: NEXT_MONDAY });

    const res = await atTime(LATER, () =>
      posts.resolveAmbiguous(env.scope, t.targetId, { outcome: "not_published", requeue: true, expected: NEXT_MONDAY }),
    );
    expect(res).toMatchObject({ status: "scheduled", scheduledAt: NEXT_MONDAY, changedFromPreview: false });
    const after = await posts.getPost(env.scope, t.postId);
    expect(after.targets[0]).toMatchObject({ status: "scheduled", attemptCount: 0, lastError: null });
    const attempts = (await posts.listAttempts(env.scope, t.targetId)).map((a) => a.outcome);
    expect(attempts.slice(0, 2)).toEqual(["requeued", "resolved_not_published"]);
    const requeued = (await posts.listAttempts(env.scope, t.targetId))[0]!;
    expect(requeued.requestSummary).toMatchObject({ scheduledAt: NEXT_MONDAY });
    expect(requeued.actorUserId).toBe(env.owner.id);
  });

  it("flags a slot that differs from the preview", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    const res = await atTime(LATER, () =>
      posts.resolveAmbiguous(env.scope, t.targetId, { outcome: "not_published", requeue: true, expected: "2026-10-05T09:00:00.000Z" }),
    );
    expect(res).toMatchObject({ status: "scheduled", changedFromPreview: true });
  });

  it("marks failed with no_free_slot when the account has no active slot", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    for (const s of await slots.listSlots(env.scope, t.account.id)) await slots.setSlotPaused(env.scope, s.id, true);
    const res = await atTime(LATER, () => posts.resolveAmbiguous(env.scope, t.targetId, { outcome: "not_published", requeue: true }));
    expect(res).toMatchObject({ status: "failed", reason: "no_free_slot" });
    const after = await posts.getPost(env.scope, t.postId);
    expect(after.targets[0]).toMatchObject({ status: "failed" });
    expect((await posts.listAttempts(env.scope, t.targetId))[0]).toMatchObject({ outcome: "resolved_not_published", error: "no_free_slot" });
  });

  it("leaves the target ambiguous when the gate refuses (conflict)", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    await setAccountStatus(env.project.id, t.account.id, "needs_reauth");
    await expect(
      atTime(LATER, () => posts.resolveAmbiguous(env.scope, t.targetId, { outcome: "not_published", requeue: true })),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await posts.getPost(env.scope, t.postId)).targets[0]!.status).toBe("ambiguous");
  });

  it("don't requeue marks failed and records resolved_failed", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    const res = await atTime(LATER, () => posts.resolveAmbiguous(env.scope, t.targetId, { outcome: "not_published", requeue: false }));
    expect(res).toMatchObject({ status: "failed", reason: "not_requeued" });
    expect((await posts.listAttempts(env.scope, t.targetId))[0]).toMatchObject({ outcome: "resolved_failed" });
  });
});
