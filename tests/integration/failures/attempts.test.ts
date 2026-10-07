import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { listFailures, toAttemptViews } from "../../../src/server/services/failures";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { createKey } from "../../helpers/api";
import { closeDb } from "../../helpers/db";
import { LATER, outcomeTarget } from "../../helpers/failures";
import { postsEnv } from "../../helpers/posts-env";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(async () => {
  await closeDb();
});

describe("attempt logs in the failures list", () => {
  it("returns the full log in time order with actor names for user actions", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    const [row] = (await listFailures(env.scope)).rows;
    const outcomes = row!.attempts.flatMap((r) => r.entries.map((e) => e.outcome));
    expect(outcomes.length).toBeGreaterThan(0);
    const times = row!.attempts.flatMap((r) => r.entries.map((e) => e.at.getTime()));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(row!.attempts.flatMap((r) => r.entries).every((e) => e.actor.kind === "system")).toBe(true);

    await atTime(LATER, () => posts.resolveAmbiguous(env.scope, t.targetId, { outcome: "not_published", requeue: false }));
    const [after] = (await listFailures(env.scope)).rows;
    const user = after!.attempts.flatMap((r) => r.entries).find((e) => e.outcome === "resolved_failed");
    expect(user?.actor).toEqual({ kind: "member", name: env.owner.name });
  });

  it("collapses polling runs with a count and keeps every entry", async () => {
    const env = await postsEnv();
    const account = await env.account({ behaviour: "fatal" });
    const d = await posts.createDraft(env.scope, { baseText: "poll", targets: [{ accountId: account.id }] });
    const id = d.targets[0]!.id;
    await env.scope.targets.update(id, { status: "failed", lastError: "x" });
    const at = new Date("2026-10-05T09:00:00Z");
    for (let i = 0; i < 6; i++) {
      await env.scope.attempts.insert({ postTargetId: id, step: "poll", outcome: "continue", at: new Date(at.getTime() + i * 1000) });
    }
    await env.scope.attempts.insert({ postTargetId: id, step: "publish", outcome: "fatal_error", error: "bad", at: new Date(at.getTime() + 9000) });
    const [row] = (await listFailures(env.scope)).rows;
    expect(row!.attempts.map((r) => [r.step, r.count])).toEqual([["poll", 6], ["publish", 1]]);
    expect(row!.attempts[0]!.entries).toHaveLength(6);
    expect(row!.attemptCount).toBe(0);
  });

  it("names an API key's entries, and gives a null name when the key cannot be found", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    const key = await createKey(env.scope, ["read", "write_posts"], { name: "Nightly bot" });
    await env.scope.attempts.insert({ postTargetId: t.targetId, step: "publish", outcome: "resolved_failed", actorApiKeyId: key.id, actorUserId: env.owner.id, at: LATER });
    const rows = await env.scope.attempts.listForTarget(t.targetId);

    const named = await toAttemptViews(env.scope, rows);
    expect(named.find((e) => e.outcome === "resolved_failed")?.actor).toEqual({ kind: "api_key", name: "Nightly bot" });
    expect(named.filter((e) => e.outcome !== "resolved_failed").every((e) => e.actor.kind === "system")).toBe(true);

    const stub = { ...env.scope, apiKeys: { ...env.scope.apiKeys, get: async () => null } } as typeof env.scope;
    const unnamed = await toAttemptViews(stub, rows);
    expect(unnamed.find((e) => e.outcome === "resolved_failed")?.actor).toEqual({ kind: "api_key", name: null });
  });

  it("keeps member entries as members", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    await atTime(LATER, () => posts.resolveAmbiguous(env.scope, t.targetId, { outcome: "not_published", requeue: false }));
    const views = await toAttemptViews(env.scope, await env.scope.attempts.listForTarget(t.targetId));
    expect(views.find((e) => e.outcome === "resolved_failed")?.actor).toEqual({ kind: "member", name: env.owner.name });
  });
});
