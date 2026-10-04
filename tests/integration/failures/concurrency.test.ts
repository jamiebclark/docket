import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { LATER, outcomeTarget } from "../../helpers/failures";
import { postsEnv } from "../../helpers/posts-env";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(async () => {
  await closeDb();
});

describe("parallel resolution (SC-003)", () => {
  it("exactly one of 20 mixed resolve/requeue calls wins", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    const inputs = Array.from({ length: 20 }, (_, i) =>
      i % 3 === 0
        ? { outcome: "published" }
        : i % 3 === 1
          ? { outcome: "not_published", requeue: true }
          : { outcome: "not_published", requeue: false },
    );
    const results = await atTime(LATER, () => Promise.allSettled(inputs.map((i) => posts.resolveAmbiguous(env.scope, t.targetId, i))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as Error).name).toBe("ConflictError");
    const outcomes = (await posts.listAttempts(env.scope, t.targetId)).map((a) => a.outcome);
    expect(outcomes.filter((o) => o.startsWith("resolved_"))).toHaveLength(1);
  });

  it("two ambiguous targets of one account never hold the same occurrence", async () => {
    const env = await postsEnv();
    const a = await outcomeTarget(env, "ambiguous", "one");
    const second = await posts.createDraft(env.scope, { baseText: "two", targets: [{ accountId: a.account.id }] });
    const sid = second.targets[0]!.id;
    await env.scope.targets.update(sid, { status: "ambiguous", scheduleKind: "explicit", scheduledAt: new Date("2026-10-05T09:00:00Z") });
    const results = await atTime(LATER, () =>
      Promise.all([a.targetId, sid].map((id) => posts.resolveAmbiguous(env.scope, id, { outcome: "not_published", requeue: true }))),
    );
    const at = results.map((r) => (r.status === "scheduled" ? r.scheduledAt : r.status));
    expect(new Set(at).size).toBe(2);
  });
});
