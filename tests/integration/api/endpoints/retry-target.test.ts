import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as posts from "../../../../src/server/services/posts";
import * as slots from "../../../../src/server/services/slots";
import { api, createKey } from "../../../helpers/api";
import { atTime } from "../../../helpers/clock";
import { closeDb } from "../../../helpers/db";
import { breakAccount, LATER, outcomeTarget, setAccountStatus } from "../../../helpers/failures";
import { failedTarget, NEXT_MONDAY, pauseAllSlots } from "../../../helpers/retry";
import { parkAllDueTargets } from "../../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(closeDb);

async function setup() {
  const f = await failedTarget();
  const key = (await createKey(f.env.scope, ["read", "write_posts"], { rateLimitPerMinute: 1000 })).secret;
  const path = `/posts/${f.postId}/targets/${f.targetId}/retry`;
  const call = (body: unknown) => atTime(LATER, () => api("POST", path, { key, body, idem: crypto.randomUUID() }));
  return { ...f, key, path, call };
}

describe("POST /posts/{postId}/targets/{targetId}/retry", () => {
  it("retries now", async () => {
    const { call, postId, targetId } = await setup();
    const r = await call({ mode: "now" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ postId, targetId, status: "scheduled", mode: "now", slotId: null, changedFromPreview: false, warnings: [] });
  });

  it("requeues with no expected instant", async () => {
    const { call } = await setup();
    const r = await call({ mode: "requeue" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "scheduled", mode: "requeue", scheduledAt: NEXT_MONDAY, changedFromPreview: false });
    expect(r.json.slotId).toEqual(expect.any(String));
  });

  it("requeues with a matching expected instant", async () => {
    const { call } = await setup();
    const r = await call({ mode: "requeue", expected: NEXT_MONDAY });
    expect(r.json).toMatchObject({ status: "scheduled", changedFromPreview: false });
  });

  it("flags a differing offset-bearing expected instant", async () => {
    const { call } = await setup();
    const r = await call({ mode: "requeue", expected: "2026-10-05T11:00:00+02:00" });
    expect(r.json).toMatchObject({ status: "scheduled", changedFromPreview: true });
  });

  it("schedules at a future instant", async () => {
    const { call } = await setup();
    const r = await call({ mode: "at", at: "2026-10-07T09:00:00+00:00" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "scheduled", mode: "at", scheduledAt: "2026-10-07T09:00:00.000Z", slotId: null });
    expect(r.json.scheduledAtLocal).toEqual(expect.any(String));
  });

  it.each([
    ["missing mode", {}],
    ["unknown mode", { mode: "later" }],
    ["extra key", { mode: "now", extra: 1 }],
    ["at without offset", { mode: "at", at: "2026-10-07T09:00:00" }],
    ["non-RFC-3339 expected", { mode: "requeue", expected: "next monday" }],
  ])("rejects %s with validation_failed", async (_n, body) => {
    const { call } = await setup();
    const r = await call(body);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("validation_failed");
  });
});

describe("retry refusals", () => {
  const attemptCount = async (f: Awaited<ReturnType<typeof setup>>) => (await posts.listAttempts(f.env.scope, f.targetId)).length;

  it("reports in_past as a 200 failed result", async () => {
    const f = await setup();
    const before = await attemptCount(f);
    const r = await f.call({ mode: "at", at: "2026-10-01T09:00:00+00:00" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "failed", reason: "in_past" });
    expect(await attemptCount(f)).toBe(before);
  });

  it("reports no_active_slots with the stored last_error and one attempt", async () => {
    const f = await setup();
    await pauseAllSlots(f.env, f.account.id);
    const before = await attemptCount(f);
    const r = await f.call({ mode: "requeue" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "failed", reason: "no_active_slots" });
    expect((await f.env.scope.targets.get(f.targetId))!.lastError).toBe(r.json.message);
    expect(await attemptCount(f)).toBe(before + 1);
  });

  it("reports no_free_occurrence with the stored last_error and one attempt", async () => {
    const f = await setup();
    const [slot] = await slots.listSlots(f.env.scope, f.account.id);
    for (let i = 0; i < 60; i++) {
      const at = new Date(Date.parse(NEXT_MONDAY) + i * 7 * 86_400_000);
      const d = await posts.createDraft(f.env.scope, { baseText: `fill ${i}`, targets: [{ accountId: f.account.id }] });
      const id = d.targets[0]!.id;
      await f.env.scope.targets.update(id, { status: "scheduled", scheduleKind: "slot", scheduledAt: at, nextAttemptAt: at });
      await f.env.scope.targets.tryHoldOccurrence(id, at, slot!.id);
    }
    const before = await attemptCount(f);
    const r = await f.call({ mode: "requeue" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "failed", reason: "no_free_occurrence" });
    expect((await f.env.scope.targets.get(f.targetId))!.lastError).toBe(r.json.message);
    expect(await attemptCount(f)).toBe(before + 1);
  });

  it("reports validation with issues and writes nothing", async () => {
    const f = await setup();
    await f.env.scope.targets.update(f.targetId, { overrideText: "x".repeat(200_000) });
    const before = await attemptCount(f);
    const r = await f.call({ mode: "requeue" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "failed", reason: "validation" });
    expect(r.json.issues.length).toBeGreaterThan(0);
    expect(await attemptCount(f)).toBe(before);
  });

  const states = [
    ["publishing", "publishing", async (f: Awaited<ReturnType<typeof setup>>) => f.env.scope.targets.update(f.targetId, { status: "publishing", nextAttemptAt: LATER, publishStartedAt: LATER })],
    ["not_failed", "scheduled", async (f: Awaited<ReturnType<typeof setup>>) => f.env.scope.targets.update(f.targetId, { status: "scheduled", nextAttemptAt: LATER })],
    ["not_failed", "published", async (f: Awaited<ReturnType<typeof setup>>) => f.env.scope.targets.update(f.targetId, { status: "published", externalId: "ext-1", publishedAt: LATER })],
    ["not_failed", "ambiguous", async (f: Awaited<ReturnType<typeof setup>>) => f.env.scope.targets.update(f.targetId, { status: "ambiguous" })],
    ["not_failed", "cancelled", async (f: Awaited<ReturnType<typeof setup>>) => f.env.scope.targets.update(f.targetId, { status: "cancelled" })],
    ["account_removed", "removed account", async (f: Awaited<ReturnType<typeof setup>>) => breakAccount(f.env.project.id, f.account.id, "removed")],
    ["needs_reconnecting", "needs_reauth account", async (f: Awaited<ReturnType<typeof setup>>) => setAccountStatus(f.env.project.id, f.account.id, "needs_reauth")],
    ["provider_unavailable", "missing provider", async (f: Awaited<ReturnType<typeof setup>>) => breakAccount(f.env.project.id, f.account.id, "provider_missing")],
  ] as const;

  it.each(states)("409 %s for a %s target, with no new attempts", async (reason, _name, apply) => {
    const f = await setup();
    await apply(f);
    const before = await attemptCount(f);
    const r = await f.call({ mode: "now" });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("conflict");
    expect(r.json.error.details).toEqual({ reason });
    expect(typeof r.json.error.message).toBe("string");
    expect(r.json.error.message.length).toBeGreaterThan(0);
    expect(await attemptCount(f)).toBe(before);
  });

  it("404s a wrong post/target pairing identically to an unknown id, writing nothing", async () => {
    const f = await setup();
    const other = await outcomeTarget(f.env, "fatal", "Other");
    const before = await attemptCount(f);
    const otherBefore = (await posts.listAttempts(f.env.scope, other.targetId)).length;
    const mismatched = await atTime(LATER, () =>
      api("POST", `/posts/${f.postId}/targets/${other.targetId}/retry`, { key: f.key, body: { mode: "now" }, idem: crypto.randomUUID() }),
    );
    const unknown = await atTime(LATER, () =>
      api("POST", `/posts/${f.postId}/targets/${crypto.randomUUID()}/retry`, { key: f.key, body: { mode: "now" }, idem: crypto.randomUUID() }),
    );
    expect(mismatched.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect({ ...mismatched.json.error, requestId: null }).toEqual({ ...unknown.json.error, requestId: null });
    expect(await attemptCount(f)).toBe(before);
    expect((await posts.listAttempts(f.env.scope, other.targetId)).length).toBe(otherBefore);
    expect((await f.env.scope.targets.get(other.targetId))!.status).toBe("failed");
  });

  it("404s a deleted post", async () => {
    const f = await setup();
    await posts.deletePost(f.env.scope, f.postId);
    const r = await f.call({ mode: "now" });
    expect(r.status).toBe(404);
  });

  it("lets one of two concurrent retries win and 409s the other", async () => {
    const f = await setup();
    const [a, b] = await Promise.all([f.call({ mode: "now" }), f.call({ mode: "now" })]);
    const sorted = [a, b].sort((x, y) => x.status - y.status);
    expect(sorted.map((r) => r.status)).toEqual([200, 409]);
    expect(sorted[1]!.json.error.details).toEqual({ reason: "not_failed" });
  });
});
