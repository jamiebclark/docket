import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { listFailures, countNeedsDecision } from "../../../src/server/services/failures";
import { closeDb } from "../../helpers/db";
import { outcomeTarget } from "../../helpers/failures";
import { postsEnv } from "../../helpers/posts-env";
import { parkAllDueTargets } from "../../helpers/scheduling";
import * as posts from "../../../src/server/services/posts";

beforeEach(parkAllDueTargets);
afterAll(async () => {
  await closeDb();
});

describe("listFailures", () => {
  it("lists ambiguous first, then failed, with totals", async () => {
    const env = await postsEnv();
    const failed = await outcomeTarget(env, "fatal", "failed one");
    const amb = await outcomeTarget(env, "ambiguous", "ambiguous one");
    const list = await listFailures(env.scope);
    expect(list.rows.map((r) => r.targetId)).toEqual([amb.targetId, failed.targetId]);
    expect(list.rows.map((r) => r.status)).toEqual(["ambiguous", "failed"]);
    expect(list.totals).toEqual({ ambiguous: 1, failed: 1 });
    expect(list.filtered).toBe(2);
    expect(await countNeedsDecision(env.scope)).toBe(1);
  });

  it("narrows to one target with ?target= and an unknown target is empty", async () => {
    const env = await postsEnv();
    const a = await outcomeTarget(env, "fatal");
    await outcomeTarget(env, "ambiguous");
    expect((await listFailures(env.scope, { target: a.targetId })).rows.map((r) => r.targetId)).toEqual([a.targetId]);
    expect((await listFailures(env.scope, { target: "00000000-0000-4000-8000-000000000000" })).rows).toEqual([]);
    expect((await listFailures(env.scope, { target: "nope" })).rows).toHaveLength(2);
  });

  it("filters by status and account, and an unknown account is empty", async () => {
    const env = await postsEnv();
    const a = await outcomeTarget(env, "fatal");
    const b = await outcomeTarget(env, "ambiguous");
    expect((await listFailures(env.scope, { status: "failed" })).rows.map((r) => r.targetId)).toEqual([a.targetId]);
    expect((await listFailures(env.scope, { status: "ambiguous" })).rows.map((r) => r.targetId)).toEqual([b.targetId]);
    expect((await listFailures(env.scope, { account: b.account.id })).rows.map((r) => r.targetId)).toEqual([b.targetId]);
    const none = await listFailures(env.scope, { account: "00000000-0000-4000-8000-000000000000" });
    expect(none.rows).toEqual([]);
    expect(none.accounts).toHaveLength(2);
  });

  it("counts failed targets in the account filter, regardless of tab or page", async () => {
    const env = await postsEnv();
    const a = await outcomeTarget(env, "fatal");
    await outcomeTarget(env, "fatal");
    await outcomeTarget(env, "ambiguous");
    expect((await listFailures(env.scope)).failedInFilter).toBe(2);
    for (const status of ["all", "failed", "ambiguous"]) {
      expect((await listFailures(env.scope, { status })).failedInFilter).toBe(2);
      expect((await listFailures(env.scope, { status, account: a.account.id })).failedInFilter).toBe(1);
    }
    expect((await listFailures(env.scope, { page: 2, account: a.account.id })).failedInFilter).toBe(1);
  });

  it("falls back to the first page for malformed query values", async () => {
    const env = await postsEnv();
    await outcomeTarget(env, "fatal");
    const list = await listFailures(env.scope, { status: "bogus", page: "-4", account: "nope" });
    expect(list).toMatchObject({ page: 1, filtered: 1 });
  });

  it("pages at 25", async () => {
    const env = await postsEnv();
    const account = await env.account({ behaviour: "fatal" });
    for (let i = 0; i < 27; i++) {
      const d = await posts.createDraft(env.scope, { baseText: `p${i}`, targets: [{ accountId: account.id }] });
      await env.scope.targets.update(d.targets[0]!.id, { status: "failed", lastError: "x" });
    }
    const p1 = await listFailures(env.scope, { page: 1 });
    const p2 = await listFailures(env.scope, { page: 2 });
    expect([p1.rows.length, p2.rows.length, p1.filtered, p1.pageSize]).toEqual([25, 2, 27, 25]);
    expect(new Set([...p1.rows, ...p2.rows].map((r) => r.targetId)).size).toBe(27);
  });

  it("leaves out soft-deleted posts", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "fatal");
    await posts.deletePost(env.scope, t.postId);
    const list = await listFailures(env.scope);
    expect(list.rows).toEqual([]);
    expect(list.totals).toEqual({ ambiguous: 0, failed: 0 });
  });

  it("never shows another project's targets (SC-002)", async () => {
    const mine = await postsEnv();
    const theirs = await postsEnv();
    await outcomeTarget(theirs, "ambiguous");
    const list = await listFailures(mine.scope);
    expect(list.rows).toEqual([]);
    expect(await countNeedsDecision(mine.scope)).toBe(0);
    expect((await listFailures(theirs.scope)).rows).toHaveLength(1);
  });
});
