import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { accountMetricSnapshots, postMetricPollStates, postMetricSnapshots } from "../../../src/server/db/schema";
import { schedulerConfig } from "../../../src/server/scheduler/config";
import { runHousekeeping } from "../../../src/server/scheduler/housekeeping";
import { getEnv } from "../../../src/server/env";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(closeDb);

const RETENTION_DAYS = 30;
const OLD = new Date(Date.now() - (RETENTION_DAYS + 1) * 86_400_000);
const RECENT = new Date(Date.now() - 1 * 86_400_000);
const config = (overrides: Record<string, unknown> = {}) =>
  schedulerConfig(getEnv(), { insightsRetentionDays: RETENTION_DAYS, insightsPruneBatch: 1000, ...overrides });

async function targetFor(env: Awaited<ReturnType<typeof postsEnv>>, accountId: string) {
  const post = await env.scope.posts.insert({ baseText: "Hi" });
  const [target] = await env.scope.targets.insertMany([{ postId: post.id, socialAccountId: accountId }]);
  return { post, target: target! };
}

describe("insights retention (FR-073, FR-074, US4-AS3)", () => {
  it("prunes an old post-metric snapshot, keeps a recent one, and reports it in its own count", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const { target } = await targetFor(env, account.id);
    await env.scope.postMetricSnapshots.insertIfAbsent({
      postTargetId: target.id,
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: OLD,
      metrics: { likeCount: 1 },
    });
    const { id: recentId } = await env.scope.postMetricSnapshots.insertIfAbsent({
      postTargetId: target.id,
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: RECENT,
      metrics: { likeCount: 2 },
    });

    const counts = await runHousekeeping(config());

    expect(counts.postMetricSnapshotsPruned).toBeGreaterThanOrEqual(1);
    expect(typeof counts.accountMetricSnapshotsPruned).toBe("number");
    const rows = await getDb().select().from(postMetricSnapshots).where(eq(postMetricSnapshots.postTargetId, target.id));
    expect(rows.map((r) => r.id)).toEqual([recentId]);
  });

  it("prunes an old account-metric snapshot, keeps a recent one, counted apart from post snapshots", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    await env.scope.accountMetricSnapshots.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: OLD,
      metrics: { followerCount: 10 },
    });
    const { id: recentId } = await env.scope.accountMetricSnapshots.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: RECENT,
      metrics: { followerCount: 11 },
    });

    const counts = await runHousekeeping(config());

    expect(counts.accountMetricSnapshotsPruned).toBeGreaterThanOrEqual(1);
    expect(typeof counts.postMetricSnapshotsPruned).toBe("number");
    const rows = await getDb().select().from(accountMetricSnapshots).where(eq(accountMetricSnapshots.socialAccountId, account.id));
    expect(rows.map((r) => r.id)).toEqual([recentId]);
  });

  it("deletes at most one bounded batch per call", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const { target } = await targetFor(env, account.id);
    const ages = [1, 2, 3].map((days) => new Date(OLD.getTime() - days * 1000));
    for (const capturedAt of ages) {
      await env.scope.postMetricSnapshots.insertIfAbsent({
        postTargetId: target.id,
        socialAccountId: account.id,
        providerKey: "mock",
        capturedAt,
        metrics: {},
      });
    }

    await runHousekeeping(config({ insightsPruneBatch: 2 }));

    const remaining = await getDb().select().from(postMetricSnapshots).where(eq(postMetricSnapshots.postTargetId, target.id));
    // The batch is bounded at 2 rows per call, cross-project — however many other old rows this run
    // also swept up, at least one of this test's own three old rows must survive the single call.
    expect(remaining.length).toBeGreaterThanOrEqual(1);
  });

  it("never deletes a poll state, target, post or account", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const { post, target } = await targetFor(env, account.id);
    await getDb().insert(postMetricPollStates).values({ postTargetId: target.id, projectId: env.project.id, socialAccountId: account.id, lastCapturedAt: OLD });
    await env.scope.postMetricSnapshots.insertIfAbsent({
      postTargetId: target.id,
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: OLD,
      metrics: {},
    });
    await env.scope.accountMetricSnapshots.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: OLD,
      metrics: {},
    });

    await runHousekeeping(config());

    const [state] = await getDb().select().from(postMetricPollStates).where(eq(postMetricPollStates.postTargetId, target.id));
    expect(state).toBeDefined();
    expect(await env.scope.targets.get(target.id)).not.toBeNull();
    expect(await env.scope.posts.get(post.id)).not.toBeNull();
    expect(await env.scope.accounts.get(account.id)).not.toBeNull();
  });

  it("a frozen target's state row survives its last snapshot being pruned", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const { target } = await targetFor(env, account.id);
    await env.scope.postMetricSnapshots.insertIfAbsent({
      postTargetId: target.id,
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: OLD,
      metrics: {},
    });
    await getDb()
      .insert(postMetricPollStates)
      .values({ postTargetId: target.id, projectId: env.project.id, socialAccountId: account.id, nextPollAt: null, frozenAt: OLD, frozenReason: "settled" });

    await runHousekeeping(config());

    const rows = await getDb().select().from(postMetricSnapshots).where(eq(postMetricSnapshots.postTargetId, target.id));
    expect(rows).toHaveLength(0);
    const [state] = await getDb().select().from(postMetricPollStates).where(eq(postMetricPollStates.postTargetId, target.id));
    expect(state).toBeDefined();
    expect(state!.frozenReason).toBe("settled");
  });
});
