import { afterAll, describe, expect, it } from "vitest";
import { ConflictError } from "../../../src/server/dal/errors";
import * as posts from "../../../src/server/services/posts";
import * as queue from "../../../src/server/services/queue";
import * as slots from "../../../src/server/services/slots";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const NOW = new Date("2026-10-01T12:00:00Z");
const MON = (n: number) => new Date(Date.UTC(2026, 9, 5 + 7 * n, 9)).toISOString(); // n=0 → 2026-10-05

type Env = Awaited<ReturnType<typeof postsEnv>>;
async function queued(env: Env, accountId: string) {
  const p = await posts.createDraft(env.scope, { baseText: "q", targets: [{ accountId }] });
  await atTime(NOW, () => posts.addToQueue(env.scope, p.post.id));
  return { postId: p.post.id, targetId: p.targets[0]!.id };
}
const when = async (env: Env, q: { postId: string }) => (await posts.getPost(env.scope, q.postId)).targets[0]!.scheduledAt?.toISOString();

describe("moveToNextFreeSlot", () => {
  it("moves to the next free occurrence, excluding its own, and frees the old one", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const t1 = await queued(env, a.id);
    const planned = await atTime(NOW, () => queue.moveToNextFreeSlot(env.scope, t1.targetId));
    expect(planned.scheduledAt).toBe(MON(1));
    expect(await when(env, t1)).toBe(MON(1));
    const t2 = await queued(env, a.id);
    expect(await when(env, t2)).toBe(MON(0)); // the old instant was free again
  });

  it("skips occurrences held by others", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const t1 = await queued(env, a.id);
    await queued(env, a.id);
    await atTime(NOW, () => queue.moveToNextFreeSlot(env.scope, t1.targetId));
    expect(await when(env, t1)).toBe(MON(2));
  });

  it("refuses a target that is not scheduled", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const p = await posts.createDraft(env.scope, { baseText: "d", targets: [{ accountId: a.id }] });
    await expect(queue.moveToNextFreeSlot(env.scope, p.targets[0]!.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("turns an explicit time into a queue slot", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const p = await posts.createDraft(env.scope, { baseText: "e", targets: [{ accountId: a.id }] });
    await atTime(NOW, () => posts.scheduleAt(env.scope, p.post.id, { at: "2026-10-03T00:00:00Z" }));
    await atTime(NOW, () => queue.moveToNextFreeSlot(env.scope, p.targets[0]!.id));
    expect((await posts.getPost(env.scope, p.post.id)).targets[0]).toMatchObject({ scheduleKind: "slot" });
  });
});

describe("swapQueuedTargets", () => {
  it("exchanges the instants atomically", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const t1 = await queued(env, a.id);
    const t2 = await queued(env, a.id);
    await queue.swapQueuedTargets(env.scope, t1.targetId, t2.targetId);
    expect(await when(env, t1)).toBe(MON(1));
    expect(await when(env, t2)).toBe(MON(0));
  });

  it("refuses different accounts, itself, and non-queued targets", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const b = await env.account();
    const t1 = await queued(env, a.id);
    const t2 = await queued(env, b.id);
    await expect(queue.swapQueuedTargets(env.scope, t1.targetId, t2.targetId)).rejects.toThrow(/same account/);
    await expect(queue.swapQueuedTargets(env.scope, t1.targetId, t1.targetId)).rejects.toBeInstanceOf(ConflictError);
    const d = await posts.createDraft(env.scope, { baseText: "d", targets: [{ accountId: a.id }] });
    await expect(queue.swapQueuedTargets(env.scope, t1.targetId, d.targets[0]!.id)).rejects.toThrow(/queued/);
    expect(await when(env, t1)).toBe(MON(0));
  });
});

describe("pullQueueForward", () => {
  it("closes gaps, keeps order, and never moves anything later", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const t1 = await queued(env, a.id);
    const t2 = await queued(env, a.id);
    const t3 = await queued(env, a.id);
    await posts.cancelTarget(env.scope, t1.targetId);
    const r = await atTime(NOW, () => queue.pullQueueForward(env.scope, a.id));
    expect(r.moved).toEqual([
      { targetId: t2.targetId, from: MON(1), to: MON(0) },
      { targetId: t3.targetId, from: MON(2), to: MON(1) },
    ]);
    expect(await when(env, t2)).toBe(MON(0));
    expect(await when(env, t3)).toBe(MON(1));
    expect((await atTime(NOW, () => queue.pullQueueForward(env.scope, a.id))).moved).toEqual([]);
  });

  it("never moves a target later when it holds an occurrence of a paused slot (F19)", async () => {
    const env = await postsEnv();
    const a = await env.account(); // Monday 09:00
    const tuesday = await slots.addSlot(env.scope, { accountId: a.id, weekday: 2, localTime: "09:00" });
    const t1 = await queued(env, a.id); // Mon 5th
    const t2 = await queued(env, a.id); // Tue 6th
    const before = [await when(env, t1), await when(env, t2)];
    const [monday] = (await slots.listSlots(env.scope, a.id)).filter((s) => s.id !== tuesday.id);
    await slots.setSlotPaused(env.scope, monday!.id, true);
    const r = await atTime(NOW, () => queue.pullQueueForward(env.scope, a.id));
    for (const m of r.moved) expect(new Date(m.to).getTime()).toBeLessThan(new Date(m.from).getTime());
    const after = [await when(env, t1), await when(env, t2)];
    expect(new Date(after[0]!).getTime()).toBeLessThanOrEqual(new Date(before[0]!).getTime());
    expect(new Date(after[1]!).getTime()).toBeLessThanOrEqual(new Date(before[1]!).getTime());
  });

  it("leaves explicit targets alone and does not touch other accounts", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const b = await env.account();
    const other = await queued(env, b.id);
    const ex = await posts.createDraft(env.scope, { baseText: "e", targets: [{ accountId: a.id }] });
    await atTime(NOW, () => posts.scheduleAt(env.scope, ex.post.id, { at: "2026-10-20T08:00:00Z" }));
    await queue.pullQueueForward(env.scope, a.id);
    expect(await when(env, { postId: ex.post.id })).toBe("2026-10-20T08:00:00.000Z");
    expect(await when(env, other)).toBe(MON(0));
  });
});

describe("freeing occurrences", () => {
  it("cancel and delete free the occurrence; nothing else moves", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const t1 = await queued(env, a.id);
    const t2 = await queued(env, a.id);
    const t3 = await queued(env, a.id);
    await posts.cancelTarget(env.scope, t1.targetId);
    await posts.deletePost(env.scope, t2.postId);
    expect(await when(env, t3)).toBe(MON(2));
    const t4 = await queued(env, a.id);
    expect(await when(env, t4)).toBe(MON(0));
  });

  it("moving to another slot frees the old occurrence", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const t1 = await queued(env, a.id);
    await atTime(NOW, () => queue.moveToNextFreeSlot(env.scope, t1.targetId));
    const t2 = await queued(env, a.id);
    expect(await when(env, t2)).toBe(MON(0));
  });
});
