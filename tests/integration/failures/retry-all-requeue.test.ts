import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as posts from "../../../src/server/services/posts";
import * as slots from "../../../src/server/services/slots";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { LATER } from "../../helpers/failures";
import { failedTarget, NEXT_MONDAY, pauseAllSlots } from "../../helpers/retry";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(async () => {
  await closeDb();
});

type Env = Awaited<ReturnType<typeof failedTarget>>["env"];

const hour = (h: number) => new Date(`2026-10-05T${String(h).padStart(2, "0")}:00:00Z`);

/** A failed explicit-time target on the account, intended at `at`. */
async function failedAt(env: Env, accountId: string, at: Date, text: string) {
  const d = await posts.createDraft(env.scope, { baseText: text, targets: [{ accountId }] });
  const targetId = d.targets[0]!.id;
  await env.scope.targets.update(targetId, { status: "failed", lastError: "boom", scheduleKind: "explicit", scheduledAt: at, nextAttemptAt: at });
  return { postId: d.post.id, targetId };
}

const requeueEntries = async (env: Env, targetId: string) =>
  (await posts.listAttempts(env.scope, targetId)).filter((x) => x.outcome === "retry_requested");

describe("retryAllFailed — requeue", () => {
  it("gives each account its next free occurrences in intended-time order, never repeating one", async () => {
    const a = await failedTarget("A1");
    const a2 = await failedAt(a.env, a.account.id, hour(10), "A2");
    const a3 = await failedAt(a.env, a.account.id, hour(11), "A3");
    const accB = await a.env.account({ behaviour: "fatal" });
    const b1 = await failedAt(a.env, accB.id, hour(8), "B1");
    const b2 = await failedAt(a.env, accB.id, hour(9), "B2");

    const res = await atTime(LATER, () => posts.retryAllFailed(a.env.scope, { mode: "requeue" }));
    expect(res).toMatchObject({ changed: true, count: 5, mode: "requeue", inScope: 5, remaining: 0 });

    const at = async (id: string) => (await a.env.scope.targets.get(id))!.scheduledAt!.toISOString();
    const aTimes = [await at(a.targetId), await at(a2.targetId), await at(a3.targetId)];
    expect(aTimes[0]).toBe(NEXT_MONDAY);
    expect(aTimes).toEqual([...aTimes].sort());
    expect(new Set(aTimes).size).toBe(3);
    const bTimes = [await at(b1.targetId), await at(b2.targetId)];
    expect(bTimes[0]).toBe(NEXT_MONDAY);
    expect(bTimes[0]! < bTimes[1]!).toBe(true);
  });

  it("lets a target holding its own future occurrence keep it", async () => {
    const f = await failedTarget();
    const [slot] = await slots.listSlots(f.env.scope, f.account.id);
    await f.env.scope.targets.update(f.targetId, { slotOccurrenceAt: null, slotId: null });
    expect(await f.env.scope.targets.tryHoldOccurrence(f.targetId, new Date(NEXT_MONDAY), slot!.id)).toBe(true);
    const res = await atTime(LATER, () => posts.retryAllFailed(f.env.scope, { mode: "requeue" }));
    expect(res.count).toBe(1);
    expect((await f.env.scope.targets.get(f.targetId))!.scheduledAt!.toISOString()).toBe(NEXT_MONDAY);
  });

  it("counts a target beyond the free occurrences as no_free_slot with the D3 entry", async () => {
    const f = await failedTarget();
    const t2 = await failedAt(f.env, f.account.id, hour(10), "T2");
    const t3 = await failedAt(f.env, f.account.id, hour(11), "T3");
    const [slot] = await slots.listSlots(f.env.scope, f.account.id);
    // Leave only the first two upcoming occurrences free.
    for (let i = 2; i < 62; i++) {
      const at = new Date(Date.parse(NEXT_MONDAY) + i * 7 * 86_400_000);
      const d = await posts.createDraft(f.env.scope, { baseText: `fill ${i}`, targets: [{ accountId: f.account.id }] });
      const id = d.targets[0]!.id;
      await f.env.scope.targets.update(id, { status: "scheduled", scheduleKind: "slot", scheduledAt: at, nextAttemptAt: at });
      await f.env.scope.targets.tryHoldOccurrence(id, at, slot!.id);
    }
    const res = await atTime(LATER, () => posts.retryAllFailed(f.env.scope, { mode: "requeue" }));
    expect(res).toMatchObject({ count: 2, inScope: 3 });
    expect(res.skipped.no_free_slot).toBe(1);
    expect((await f.env.scope.targets.get(t2.targetId))!.status).toBe("scheduled");
    expect((await f.env.scope.targets.get(t3.targetId))!.status).toBe("failed");
    const [entry] = await requeueEntries(f.env, t3.targetId);
    expect(entry).toMatchObject({ error: "no_free_slot" });
    expect(entry!.requestSummary).toMatchObject({ mode: "requeue", reason: "no_free_occurrence" });
  });

  it("with no active slots writes one entry for the account, counts the rest, and still handles other accounts (D5)", async () => {
    const f = await failedTarget();
    const t2 = await failedAt(f.env, f.account.id, hour(10), "T2");
    const t3 = await failedAt(f.env, f.account.id, hour(11), "T3");
    const other = await f.env.account({ behaviour: "fatal" });
    const o = await failedAt(f.env, other.id, hour(8), "O");
    await pauseAllSlots(f.env, f.account.id);

    const res = await atTime(LATER, () => posts.retryAllFailed(f.env.scope, { mode: "requeue" }));
    expect(res).toMatchObject({ count: 1, inScope: 4, remaining: 0 });
    expect(res.skipped.no_free_slot).toBe(3);
    expect((await f.env.scope.targets.get(o.targetId))!.status).toBe("scheduled");

    const noted = [f.targetId, t2.targetId, t3.targetId];
    const counts = await Promise.all(noted.map(async (id) => (await requeueEntries(f.env, id)).filter((e) => e.error === "no_free_slot").length));
    expect(counts.reduce((n, c) => n + c, 0)).toBe(1);
    expect(counts[0]).toBe(1);
  });

  it("reports cannot_publish for requeue when content no longer validates, while now succeeds", async () => {
    const f = await failedTarget();
    await f.env.scope.targets.update(f.targetId, { overrideText: "x".repeat(200_000) });
    const before = (await posts.listAttempts(f.env.scope, f.targetId)).length;
    const res = await atTime(LATER, () => posts.retryAllFailed(f.env.scope, { mode: "requeue" }));
    expect(res).toMatchObject({ count: 0, inScope: 1 });
    expect(res.skipped.cannot_publish).toBe(1);
    expect((await posts.listAttempts(f.env.scope, f.targetId)).length).toBe(before);
    const now = await atTime(LATER, () => posts.retryAllFailed(f.env.scope, { mode: "now" }));
    expect(now.count).toBe(1);
  });

  it("writes the same requeue entry as a single requeue on a twin", async () => {
    const a = await failedTarget();
    const bAcc = await a.env.account({ behaviour: "fatal" });
    const b = await failedAt(a.env, bAcc.id, hour(9), "Twin");
    await atTime(LATER, () => posts.retryTarget(a.env.scope, a.targetId, { mode: "requeue" }));
    await atTime(LATER, () => posts.retryAllFailed(a.env.scope, { mode: "requeue" }));
    const [sa] = await requeueEntries(a.env, a.targetId);
    const [ba] = await requeueEntries(a.env, b.targetId);
    expect(Object.keys(ba!.requestSummary as object).sort()).toEqual(Object.keys(sa!.requestSummary as object).sort());
    expect((ba!.requestSummary as { slotId: string }).slotId).toBe((await a.env.scope.targets.get(b.targetId))!.slotId);
    expect(ba!.requestSummary).toMatchObject({ mode: "requeue", scheduledAt: NEXT_MONDAY });
    expect(ba!.actorUserId).toBe(sa!.actorUserId);
  });
});
