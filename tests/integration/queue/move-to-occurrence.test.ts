import { afterAll, describe, expect, it, vi } from "vitest";

// Its own pool of 20 so the contenders run on real parallel connections (SC-005).
vi.hoisted(() => {
  process.env.DATABASE_POOL_MAX = "20";
});

import { and, eq } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { postTargets } from "../../../src/server/db/schema";
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

type Env = Awaited<ReturnType<typeof postsEnv>>;
async function queued(env: Env, accountId: string) {
  const p = await posts.createDraft(env.scope, { baseText: "q", targets: [{ accountId }] });
  await atTime(NOW, () => posts.addToQueue(env.scope, p.post.id));
  return { postId: p.post.id, targetId: p.targets[0]!.id };
}
let current: Env;
const row = async (targetId: string) => (await current.scope.targets.get(targetId))!;
const move = (env: Env, targetId: string, slotId: string, at: Date) =>
  atTime(NOW, () => queue.moveTargetToOccurrence(env.scope, { targetId, slotId, scheduledAt: at.toISOString() }));

async function slotOf(env: Env, accountId: string) {
  return (await slots.listSlots(env.scope, accountId))[0]!;
}

describe("moveTargetToOccurrence", () => {
  it("moves into a free occurrence of the slot and frees the one it held", async () => {
    const env = await postsEnv();
    current = env;
    const a = await env.account();
    const slot = await slotOf(env, a.id);
    const t1 = await queued(env, a.id);
    const held = (await row(t1.targetId)).slotOccurrenceAt!;
    const target = new Date(held.getTime() + 14 * 86_400_000);
    const planned = await move(env, t1.targetId, slot.id, target);
    expect(planned.scheduledAt).toBe(target.toISOString());
    expect((await row(t1.targetId)).slotOccurrenceAt?.toISOString()).toBe(target.toISOString());
    const t2 = await queued(env, a.id);
    expect((await row(t2.targetId)).slotOccurrenceAt?.toISOString()).toBe(held.toISOString());
  });

  it("refuses another account's slot, a paused slot, a non-occurrence time and a passed time", async () => {
    const env = await postsEnv();
    current = env;
    const a = await env.account();
    const b = await env.account();
    const t1 = await queued(env, a.id);
    const held = (await row(t1.targetId)).slotOccurrenceAt!;
    const next = new Date(held.getTime() + 7 * 86_400_000);
    const slotA = await slotOf(env, a.id);
    const slotB = await slotOf(env, b.id);
    await expect(move(env, t1.targetId, slotB.id, next)).rejects.toThrow("That slot belongs to another account.");
    await expect(move(env, t1.targetId, slotA.id, new Date(next.getTime() + 60_000))).rejects.toThrow(
      "That is not one of this slot's times.",
    );
    await expect(move(env, t1.targetId, slotA.id, new Date(NOW.getTime() - 86_400_000))).rejects.toThrow("That time has passed.");
    await slots.setSlotPaused(env.scope, slotA.id, true);
    await expect(move(env, t1.targetId, slotA.id, next)).rejects.toThrow("That slot is paused.");
    // Nothing changed.
    expect((await row(t1.targetId)).slotOccurrenceAt?.toISOString()).toBe(held.toISOString());
  });

  it("refuses a cancelled or deleted post and a target being published", async () => {
    const env = await postsEnv();
    current = env;
    const a = await env.account();
    const slot = await slotOf(env, a.id);
    const t1 = await queued(env, a.id);
    const t2 = await queued(env, a.id);
    const t3 = await queued(env, a.id);
    const at = new Date((await row(t1.targetId)).slotOccurrenceAt!.getTime() + 21 * 86_400_000);

    await getDb()
      .update(postTargets)
      .set({ leaseOwner: crypto.randomUUID(), leaseUntil: new Date(NOW.getTime() + 60_000) })
      .where(and(eq(postTargets.projectId, env.project.id), eq(postTargets.id, t1.targetId)));
    await expect(move(env, t1.targetId, slot.id, at)).rejects.toThrow("Publishing in progress. Try again in a moment.");

    await atTime(NOW, () => posts.cancelTarget(env.scope, t2.targetId));
    await expect(move(env, t2.targetId, slot.id, at)).rejects.toThrow("Only a scheduled post can be moved.");

    await atTime(NOW, () => posts.deletePost(env.scope, t3.postId));
    await expect(move(env, t3.targetId, slot.id, at)).rejects.toThrow();
  });

  it("20 races for one empty occurrence: exactly one wins, the other hears it was taken", async () => {
    for (let i = 0; i < 20; i++) {
      const env = await postsEnv();
    current = env;
      const a = await env.account();
      const slot = await slotOf(env, a.id);
      const t1 = await queued(env, a.id);
      const t2 = await queued(env, a.id);
      const free = new Date((await row(t2.targetId)).slotOccurrenceAt!.getTime() + 7 * 86_400_000);
      const results = await Promise.allSettled([move(env, t1.targetId, slot.id, free), move(env, t2.targetId, slot.id, free)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason.message).toBe("That slot was just taken.");
      const [r1, r2] = [await row(t1.targetId), await row(t2.targetId)];
      expect([r1, r2].filter((r) => r.slotOccurrenceAt?.getTime() === free.getTime())).toHaveLength(1);
      // The loser kept what it had.
      expect(new Set([r1.slotOccurrenceAt?.getTime(), r2.slotOccurrenceAt?.getTime()]).size).toBe(2);
    }
  }, 300_000);
});
