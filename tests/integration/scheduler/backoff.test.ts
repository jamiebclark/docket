import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { forProject } from "../../../src/server/dal/scope";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import * as posts from "../../../src/server/services/posts";
import * as slots from "../../../src/server/services/slots";
import { fakeSession } from "../../helpers/auth";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);

afterAll(async () => {
  await closeDb();
});

// 2026-10-05 is a Monday; the project zone is UTC.
const BEFORE = new Date("2026-10-01T12:00:00Z");
const SLOT = new Date("2026-10-05T09:00:00Z");
const at = (seconds: number) => new Date(SLOT.getTime() + seconds * 1000);
const CONFIG = { maxAttempts: 3, backoffBaseMs: 60_000, backoffMaxMs: 600_000 };
const tick = (when: Date) => atTime(when, () => runTick({ config: CONFIG }));

async function queued(settings: Record<string, unknown>) {
  const ctx = await createProjectWithMembers();
  const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
  const account = await accounts.connectMock(scope, { displayName: "Mock", settings });
  await slots.addSlot(scope, { accountId: account.id, weekday: 1, localTime: "09:00" });
  const draft = await posts.createDraft(scope, { baseText: "Hello", targets: [{ accountId: account.id }] });
  await atTime(BEFORE, () => posts.addToQueue(scope, draft.post.id, {}));
  return { scope, postId: draft.post.id, targetId: draft.targets[0]!.id };
}

describe("retry with backoff (SC-008)", () => {
  it("retries at the computed times and stops after exactly maxAttempts", async () => {
    const { scope, postId, targetId } = await queued({ behaviour: "retryable" });

    expect((await tick(SLOT)).publishing.counts).toMatchObject({ claimed: 1, retried: 1 });
    // Attempt 1 failed: next try 60s later.
    expect((await tick(at(59))).publishing.counts.claimed).toBe(0);
    expect((await tick(at(60))).publishing.counts).toMatchObject({ claimed: 1, retried: 1 });
    // Attempt 2 failed at +60s: next try 120s after that.
    expect((await tick(at(60 + 119))).publishing.counts.claimed).toBe(0);
    expect((await tick(at(60 + 120))).publishing.counts).toMatchObject({ claimed: 1, failed: 1 });

    const detail = await posts.getPost(scope, postId);
    expect(detail.post.status).toBe("failed");
    expect(detail.targets[0]).toMatchObject({ status: "failed", attemptCount: 3 });
    const attempts = await posts.listAttempts(scope, targetId);
    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => a.outcome === "retryable_error")).toBe(true);

    expect((await tick(at(100_000))).publishing.counts.claimed).toBe(0);
    expect(await posts.listAttempts(scope, targetId)).toHaveLength(3);
  });

  it("succeeds once failTimes failures are spent", async () => {
    const { scope, postId, targetId } = await queued({ behaviour: "retryable", failTimes: 2 });
    await tick(SLOT);
    await tick(at(60));
    expect((await tick(at(180))).publishing.counts).toMatchObject({ done: 1 });
    expect((await posts.getPost(scope, postId)).post.status).toBe("published");
    expect((await posts.listAttempts(scope, targetId)).map((a) => a.outcome)).toEqual([
      "done",
      "retryable_error",
      "retryable_error",
    ]);
  });

  it("honours the provider's retryAfterSeconds over a shorter backoff", async () => {
    const { scope, targetId } = await queued({ behaviour: "rate_limited", retryAfterSeconds: 900 });
    await tick(SLOT);
    expect((await tick(at(600))).publishing.counts.claimed).toBe(0);
    expect((await tick(at(901))).publishing.counts.claimed).toBe(1);
    expect(await posts.listAttempts(scope, targetId)).toHaveLength(2);
  });

  it("fails a fatal rejection at once, without retrying", async () => {
    const { scope, postId, targetId } = await queued({ behaviour: "fatal" });
    expect((await tick(SLOT)).publishing.counts).toMatchObject({ failed: 1 });
    expect((await posts.getPost(scope, postId)).post.status).toBe("failed");
    expect((await tick(at(10_000))).publishing.counts.claimed).toBe(0);
    expect(await posts.listAttempts(scope, targetId)).toHaveLength(1);
  });
});
