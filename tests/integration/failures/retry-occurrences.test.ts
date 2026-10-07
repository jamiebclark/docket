import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError } from "../../../src/server/dal/errors";
import { previewRequeue } from "../../../src/server/services/failures";
import * as posts from "../../../src/server/services/posts";
import * as slots from "../../../src/server/services/slots";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { LATER, SLOT } from "../../helpers/failures";
import { parkAllDueTargets } from "../../helpers/scheduling";
import { failedTarget, NEXT_MONDAY } from "../../helpers/retry";
import { sql } from "drizzle-orm";

beforeEach(parkAllDueTargets);
afterAll(async () => {
  await closeDb();
});

async function heldBy(projectId: string, accountId: string): Promise<string[]> {
  const rows = await testDb().execute(
    sql`select slot_occurrence_at from post_targets where project_id = ${projectId} and social_account_id = ${accountId} and slot_occurrence_at is not null order by 1`,
  );
  return (rows.rows as { slot_occurrence_at: Date }[]).map((r) => new Date(r.slot_occurrence_at).toISOString());
}

describe("retry occurrences: preview and retry agree", () => {
  it("(b) original past occurrence: freed after requeue, exactly one held", async () => {
    const { env, targetId, account } = await failedTarget();
    expect(await heldBy(env.project.id, account.id)).toEqual([SLOT.toISOString()]);
    const preview = await atTime(LATER, () => previewRequeue(env.scope, targetId));
    const res = await atTime(LATER, () => posts.retryTarget(env.scope, targetId, { mode: "requeue" }));
    expect(preview).toMatchObject({ ok: true, scheduledAt: NEXT_MONDAY });
    expect(res).toMatchObject({ status: "scheduled", scheduledAt: NEXT_MONDAY });
    expect(await heldBy(env.project.id, account.id)).toEqual([NEXT_MONDAY]);
  });

  it("(a) future free occurrence held by itself: the same instant is taken again", async () => {
    const { env, targetId, account } = await failedTarget();
    const [slot] = await slots.listSlots(env.scope, account.id);
    const future = new Date(NEXT_MONDAY);
    await env.scope.targets.update(targetId, { slotOccurrenceAt: null, slotId: null });
    expect(await env.scope.targets.tryHoldOccurrence(targetId, future, slot!.id)).toBe(true);
    const preview = await atTime(LATER, () => previewRequeue(env.scope, targetId));
    const res = await atTime(LATER, () => posts.retryTarget(env.scope, targetId, { mode: "requeue" }));
    expect(preview).toMatchObject({ ok: true, scheduledAt: NEXT_MONDAY });
    expect(res).toMatchObject({ status: "scheduled", scheduledAt: NEXT_MONDAY });
    expect(await heldBy(env.project.id, account.id)).toEqual([NEXT_MONDAY]);
  });

  it("(c) no hold and (d) explicit target both take the next free occurrence", async () => {
    for (const kind of ["none", "explicit"] as const) {
      const { env, targetId, account } = await failedTarget(kind);
      await env.scope.targets.update(targetId, {
        slotOccurrenceAt: null,
        slotId: null,
        ...(kind === "explicit" ? { scheduleKind: "explicit" as const, scheduledAt: SLOT } : {}),
      });
      const preview = await atTime(LATER, () => previewRequeue(env.scope, targetId));
      const res = await atTime(LATER, () => posts.retryTarget(env.scope, targetId, { mode: "requeue" }));
      expect(preview).toMatchObject({ ok: true, scheduledAt: NEXT_MONDAY });
      expect(res).toMatchObject({ status: "scheduled", scheduledAt: NEXT_MONDAY });
      expect(await heldBy(env.project.id, account.id)).toEqual([NEXT_MONDAY]);
      expect((await env.scope.targets.get(targetId))!.scheduleKind).toBe("slot");
    }
  });

  it("preview of a target that is no longer failed is a conflict", async () => {
    const { env, targetId } = await failedTarget();
    await atTime(LATER, () => posts.retryTarget(env.scope, targetId));
    await expect(previewRequeue(env.scope, targetId)).rejects.toThrow(new ConflictError("This post is no longer failed."));
  });
});
