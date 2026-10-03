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

// The test database is shared: park other tests' due targets so a tick only sees this test's.
beforeEach(parkAllDueTargets);

afterAll(async () => {
  await closeDb();
});

// 2026-10-05 is a Monday; the project zone is UTC.
const BEFORE = new Date("2026-10-01T12:00:00Z");
const SLOT = new Date("2026-10-05T09:00:00Z");
const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);

async function setup(settings: Record<string, unknown> = {}) {
  const ctx = await createProjectWithMembers();
  const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
  const account = await accounts.connectMock(scope, { displayName: "Mock", settings });
  await slots.addSlot(scope, { accountId: account.id, weekday: 1, localTime: "09:00" });
  const draft = await posts.createDraft(scope, { baseText: "Hello", targets: [{ accountId: account.id }] });
  return { scope, account, postId: draft.post.id, targetId: draft.targets[0]!.id };
}

describe("scheduler end to end (SC-001)", () => {
  it("publishes a queued post at its slot, once, with attempt rows", async () => {
    const { scope, postId, targetId } = await setup();
    const preview = await atTime(BEFORE, () => posts.previewQueue(scope, postId));
    expect(preview[0]).toMatchObject({ ok: true, scheduledAt: SLOT.toISOString() });
    const queued = await atTime(BEFORE, () => posts.addToQueue(scope, postId, {}));
    expect(queued[0]).toMatchObject({ ok: true, scheduledAt: SLOT.toISOString() });

    const early = await atTime(at(SLOT, -60), () => runTick());
    expect(early.publishing.counts.claimed).toBe(0);
    expect((await posts.getPost(scope, postId)).post.status).toBe("scheduled");

    const tick = await atTime(SLOT, () => runTick());
    expect(tick.publishing).toMatchObject({ ok: true, counts: { claimed: 1, done: 1 } });
    const detail = await posts.getPost(scope, postId);
    expect(detail.post.status).toBe("published");
    expect(detail.targets[0]).toMatchObject({ status: "published", externalUrl: expect.stringContaining("mock.invalid") });
    const attempts = await posts.listAttempts(scope, targetId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: "done", tickId: tick.tickId });

    const second = await atTime(at(SLOT, 5), () => runTick());
    expect(second.publishing.counts.claimed).toBe(0);
    expect(await posts.listAttempts(scope, targetId)).toHaveLength(1);
  });

  it("continues a multi-step publish across ticks, one step per tick", async () => {
    const { scope, postId, targetId } = await setup({ behaviour: "multi_step", steps: 2 });
    await atTime(BEFORE, () => posts.addToQueue(scope, postId, {}));
    const t1 = await atTime(SLOT, () => runTick());
    expect(t1.publishing.counts).toMatchObject({ continued: 1, done: 0 });
    expect((await posts.getPost(scope, postId)).post.status).toBe("publishing");
    const t2 = await atTime(at(SLOT, 1), () => runTick());
    expect(t2.publishing.counts).toMatchObject({ continued: 1, done: 0 });
    const t3 = await atTime(at(SLOT, 2), () => runTick());
    expect(t3.publishing.counts).toMatchObject({ done: 1 });
    expect((await posts.getPost(scope, postId)).post.status).toBe("published");
    expect((await posts.listAttempts(scope, targetId)).map((a) => a.outcome)).toEqual(["done", "continue", "continue"]);
  });

  it("honours notBefore from the provider before trying again", async () => {
    const { scope, postId, targetId } = await setup({ behaviour: "rate_limited", retryAfterSeconds: 300 });
    await atTime(BEFORE, () => posts.addToQueue(scope, postId, {}));
    const t1 = await atTime(SLOT, () => runTick());
    expect(t1.publishing.counts).toMatchObject({ retried: 1 });
    const soon = await atTime(at(SLOT, 120), () => runTick());
    expect(soon.publishing.counts.claimed).toBe(0);
    const later = await atTime(at(SLOT, 301), () => runTick());
    expect(later.publishing.counts.claimed).toBe(1);
    const attempts = await posts.listAttempts(scope, targetId);
    expect(attempts).toHaveLength(2);
    expect((await posts.getPost(scope, postId)).targets[0]!.attemptCount).toBe(2);
  });

  it("publishes a late target and records how late", async () => {
    const { scope, postId, targetId } = await setup();
    await atTime(BEFORE, () => posts.addToQueue(scope, postId, {}));
    await atTime(at(SLOT, 90), () => runTick());
    const [attempt] = await posts.listAttempts(scope, targetId);
    expect(attempt!.requestSummary).toMatchObject({ lateBySeconds: 90 });
    expect((await posts.getPost(scope, postId)).post.status).toBe("published");
  });
});
