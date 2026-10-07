import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as posts from "../../../../src/server/services/posts";
import * as slots from "../../../../src/server/services/slots";
import { api, createKey } from "../../../helpers/api";
import { atTime } from "../../../helpers/clock";
import { closeDb } from "../../../helpers/db";
import { LATER } from "../../../helpers/failures";
import { failedTarget, NEXT_MONDAY } from "../../../helpers/retry";
import { parkAllDueTargets } from "../../../helpers/scheduling";
import { postsEnv } from "../../../helpers/posts-env";

beforeEach(parkAllDueTargets);
afterAll(closeDb);

type Env = Awaited<ReturnType<typeof failedTarget>>["env"];

const PATH = "/targets/retry-failed";
const SKIP_KEYS = ["account_removed", "cannot_publish", "needs_reconnecting", "no_free_slot", "no_longer_failed", "provider_unavailable"];
const hour = (h: number) => new Date(`2026-10-05T${String(h).padStart(2, "0")}:00:00Z`);

async function failedAt(env: Env, accountId: string, at: Date, text: string) {
  const d = await posts.createDraft(env.scope, { baseText: text, targets: [{ accountId }] });
  const targetId = d.targets[0]!.id;
  await env.scope.targets.update(targetId, { status: "failed", lastError: "boom", scheduleKind: "explicit", scheduledAt: at, nextAttemptAt: at });
  return { postId: d.post.id, targetId };
}

async function setup() {
  const f = await failedTarget();
  const key = (await createKey(f.env.scope, ["read", "write_posts"], { rateLimitPerMinute: 1000 })).secret;
  const call = (body: unknown, idem: string = crypto.randomUUID()) => atTime(LATER, () => api("POST", PATH, { key, body, idem }));
  return { ...f, key, call };
}

describe("POST /targets/retry-failed", () => {
  it("retries everything and the counts add up, with all six skip keys", async () => {
    const f = await setup();
    const other = await f.env.account({ behaviour: "fatal" });
    await failedAt(f.env, other.id, hour(8), "Other");
    const r = await f.call({ mode: "now" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ mode: "now", retried: 2, inScope: 2, remaining: 0 });
    expect(Object.keys(r.json.skipped).sort()).toEqual(SKIP_KEYS);
    const skippedSum = Object.values(r.json.skipped as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(r.json.retried + skippedSum + r.json.remaining).toBe(r.json.inScope);
    expect(r.json.accounts).toHaveLength(2);
    for (const a of r.json.accounts) expect(Object.keys(a.skipped).sort()).toEqual(SKIP_KEYS);
  });

  it("limits the run to one account", async () => {
    const f = await setup();
    const other = await f.env.account({ behaviour: "fatal" });
    const o = await failedAt(f.env, other.id, hour(8), "Other");
    const r = await f.call({ mode: "now", accountId: f.account.id });
    expect(r.json).toMatchObject({ retried: 1, inScope: 1 });
    expect((await f.env.scope.targets.get(o.targetId))!.status).toBe("failed");
  });

  it("answers an unknown and a foreign accountId identically", async () => {
    const f = await setup();
    const foreign = await postsEnv();
    const foreignAccount = await foreign.account({ behaviour: "fatal" });
    const unknown = await f.call({ mode: "now", accountId: crypto.randomUUID() });
    const theirs = await f.call({ mode: "now", accountId: foreignAccount.id });
    expect(unknown.status).toBe(200);
    expect(unknown.json).toMatchObject({ inScope: 0, retried: 0, remaining: 0, accounts: [], message: "There are no failed posts to retry." });
    expect(theirs.status).toBe(200);
    expect(theirs.json).toEqual(unknown.json);
    expect((await f.env.scope.targets.get(f.targetId))!.status).toBe("failed");
  });

  it("reports no_free_slot when requeue exhausts an account, earlier failures taking earlier slots", async () => {
    const f = await setup();
    const t2 = await failedAt(f.env, f.account.id, hour(10), "T2");
    const t3 = await failedAt(f.env, f.account.id, hour(11), "T3");
    const [slot] = await slots.listSlots(f.env.scope, f.account.id);
    for (let i = 2; i < 62; i++) {
      const at = new Date(Date.parse(NEXT_MONDAY) + i * 7 * 86_400_000);
      const d = await posts.createDraft(f.env.scope, { baseText: `fill ${i}`, targets: [{ accountId: f.account.id }] });
      const id = d.targets[0]!.id;
      await f.env.scope.targets.update(id, { status: "scheduled", scheduleKind: "slot", scheduledAt: at, nextAttemptAt: at });
      await f.env.scope.targets.tryHoldOccurrence(id, at, slot!.id);
    }
    const r = await f.call({ mode: "requeue" });
    expect(r.json).toMatchObject({ mode: "requeue", retried: 2, inScope: 3, remaining: 0 });
    expect(r.json.skipped.no_free_slot).toBe(1);
    const at = async (id: string) => (await f.env.scope.targets.get(id))!.scheduledAt!.toISOString();
    expect(await at(f.targetId)).toBe(NEXT_MONDAY);
    expect(await at(t2.targetId) > NEXT_MONDAY).toBe(true);
    expect((await f.env.scope.targets.get(t3.targetId))!.status).toBe("failed");
  });

  it("caps a run at 100 and tells the caller to use a new Idempotency-Key", async () => {
    const f = await setup();
    for (let i = 0; i < 100; i++) await failedAt(f.env, f.account.id, new Date(hour(0).getTime() + (i + 1) * 1000), `Cap ${i}`);
    const r = await f.call({ mode: "now" });
    expect(r.json).toMatchObject({ retried: 100, inScope: 101, remaining: 1 });
    expect(r.json.message).toContain("Call again with a new Idempotency-Key");
    expect(r.json.message).not.toContain("Press Retry all failed");
  });

  it.each([
    ["targetIds", { mode: "now", targetIds: [crypto.randomUUID()] }],
    ["an extra key", { mode: "now", extra: true }],
    ["missing mode", {}],
    ["invalid mode", { mode: "later" }],
    ["a bad accountId", { mode: "now", accountId: "nope" }],
  ])("rejects %s with 400", async (_name, body) => {
    const f = await setup();
    const r = await f.call(body);
    expect(r.status).toBe(400);
    expect((await f.env.scope.targets.get(f.targetId))!.status).toBe("failed");
  });
});
