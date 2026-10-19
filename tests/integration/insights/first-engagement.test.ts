import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../../../src/server/db/client";
import { engagementItems, postMetricPollStates, targetFirstEngagement } from "../../../src/server/db/schema";
import { recordFirstEngagement } from "../../../src/server/services/insights/first-engagement";
import { firstEngagementFigure } from "../../../src/lib/insights/first-engagement";
import { buildFirstEngagement } from "../../../src/server/services/insights/view";
import { schedulerConfig } from "../../../src/server/scheduler/config";
import { getEnv } from "../../../src/server/env";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(closeDb);

const HOUR_MS = 3_600_000;
const config = () => schedulerConfig(getEnv(), { insightsPruneBatch: 1000 });

type Env = Awaited<ReturnType<typeof postsEnv>>;

async function publish(env: Pick<Env, "scope">, accountId: string, publishedAt: Date) {
  const post = await env.scope.posts.insert({ baseText: "A post." });
  const [target] = await env.scope.targets.insertMany([{ postId: post.id, socialAccountId: accountId }]);
  await env.scope.targets.update(target!.id, {
    status: "published",
    externalId: `ext-${post.id}`,
    publishedAt,
    scheduleKind: "now",
  });
  await env.scope.posts.setStatus(post.id, "published");
  return target!;
}

async function row(projectId: string, postTargetId: string) {
  const [r] = await getDb()
    .select()
    .from(targetFirstEngagement)
    .where(and(eq(targetFirstEngagement.projectId, projectId), eq(targetFirstEngagement.postTargetId, postTargetId)));
  return r ?? null;
}

async function freeze(projectId: string, socialAccountId: string, postTargetId: string, reason: "gone" | "expired" | "unqueryable") {
  await getDb()
    .insert(postMetricPollStates)
    .values({ postTargetId, projectId, socialAccountId, frozenAt: new Date(), frozenReason: reason })
    .onConflictDoUpdate({ target: postMetricPollStates.postTargetId, set: { frozenAt: new Date(), frozenReason: reason } });
}

describe("recordFirstEngagement (US6, contracts/first-engagement.md)", () => {
  it("a zero-engagement snapshot then a positive one bounds the first hour (US6.1)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const publishedAt = new Date("2026-01-01T10:00:00.000Z");
    const target = await publish(env, account.id, publishedAt);
    await env.scope.postMetricSnapshots.insertIfAbsent({
      postTargetId: target.id,
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: new Date(publishedAt.getTime() + HOUR_MS),
      metrics: { likeCount: 0 },
    });
    await env.scope.postMetricSnapshots.insertIfAbsent({
      postTargetId: target.id,
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: new Date(publishedAt.getTime() + 2 * HOUR_MS),
      metrics: { likeCount: 3 },
    });

    await recordFirstEngagement(config(), new Date());

    const stored = await row(env.project.id, target.id);
    expect(stored?.boundBeforeAt).toEqual(new Date(publishedAt.getTime() + 2 * HOUR_MS));
    expect(stored?.boundAfterAt).toEqual(new Date(publishedAt.getTime() + HOUR_MS));
    expect(stored?.exactFirstAt).toBeNull();
    const figure = firstEngagementFigure({
      publishedAt,
      exactFirstAt: stored!.exactFirstAt,
      boundBeforeAt: stored!.boundBeforeAt,
      boundAfterAt: stored!.boundAfterAt,
      scannedThrough: stored!.scannedThrough,
      frozenReason: null,
    });
    expect(figure).toEqual({ kind: "bounded", afterAtLeastMs: HOUR_MS, afterAtMostMs: 2 * HOUR_MS });
  });

  it("engagement already present in the very first snapshot is an upper bound only (US6.2)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const publishedAt = new Date("2026-01-02T10:00:00.000Z");
    const target = await publish(env, account.id, publishedAt);
    await env.scope.postMetricSnapshots.insertIfAbsent({
      postTargetId: target.id,
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: new Date(publishedAt.getTime() + HOUR_MS),
      metrics: { likeCount: 5 },
    });

    await recordFirstEngagement(config(), new Date());

    const stored = await row(env.project.id, target.id);
    expect(stored?.boundBeforeAt).toEqual(new Date(publishedAt.getTime() + HOUR_MS));
    expect(stored?.boundAfterAt).toBeNull();
    const figure = firstEngagementFigure({
      publishedAt,
      exactFirstAt: null,
      boundBeforeAt: stored!.boundBeforeAt,
      boundAfterAt: stored!.boundAfterAt,
      scannedThrough: stored!.scannedThrough,
      frozenReason: null,
    });
    expect(figure).toEqual({ kind: "within_first_reading", afterAtMostMs: HOUR_MS });
  });

  it("an inbox reply is preferred over an already-recorded snapshot bound (US6.3, FR-041)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const publishedAt = new Date("2026-01-03T10:00:00.000Z");
    const target = await publish(env, account.id, publishedAt);
    await env.scope.postMetricSnapshots.insertIfAbsent({
      postTargetId: target.id,
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: new Date(publishedAt.getTime() + 2 * HOUR_MS),
      metrics: { likeCount: 9 },
    });
    await recordFirstEngagement(config(), new Date());
    const afterBound = await row(env.project.id, target.id);
    expect(afterBound?.boundBeforeAt).not.toBeNull();
    expect(afterBound?.exactFirstAt).toBeNull();

    const saidAt = new Date(publishedAt.getTime() + 14 * 60_000);
    const { id: itemId } = await env.scope.engagementItems.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      kind: "comment",
      externalId: `item-${randomUUID()}`,
      text: "Nice post!",
      authorDisplayName: null,
      authorHandle: null,
      authorExternalId: null,
      authorUrl: null,
      authorIdentityStable: false,
      saidAt,
      ingestedAt: new Date(),
      parentExternalId: null,
      parentPostTargetId: target.id,
    });

    await recordFirstEngagement(config(), new Date());

    const afterExact = await row(env.project.id, target.id);
    expect(afterExact?.exactFirstAt).toEqual(saidAt);
    expect(afterExact?.boundBeforeAt).toEqual(afterBound!.boundBeforeAt);
    const figure = firstEngagementFigure({
      publishedAt,
      exactFirstAt: afterExact!.exactFirstAt,
      boundBeforeAt: afterExact!.boundBeforeAt,
      boundAfterAt: afterExact!.boundAfterAt,
      scannedThrough: afterExact!.scannedThrough,
      frozenReason: null,
    });
    expect(figure).toEqual({ kind: "exact", afterMs: 14 * 60_000 });

    // the inbox row is then pruned (deleted) and separately withdrawn-equivalent — the recorded figure must not move (US6.4, SC-006)
    await getDb()
      .delete(engagementItems)
      .where(and(eq(engagementItems.projectId, env.project.id), eq(engagementItems.id, itemId)));
    await recordFirstEngagement(config(), new Date());
    const afterPrune = await row(env.project.id, target.id);
    expect(afterPrune?.exactFirstAt).toEqual(saidAt);
  });

  it("a parentless mention is never the exact figure; a parented reply on the same run is (US2, FR-018, FR-021, SC-003)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const publishedAt = new Date("2026-01-03T12:00:00.000Z");
    const target = await publish(env, account.id, publishedAt);

    const mentionSaidAt = new Date(publishedAt.getTime() + 5 * 60_000);
    await env.scope.engagementItems.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      kind: "mention",
      externalId: `mention-${randomUUID()}`,
      text: "no parent here",
      authorDisplayName: null,
      authorHandle: null,
      authorExternalId: null,
      authorUrl: null,
      authorIdentityStable: false,
      saidAt: mentionSaidAt,
      ingestedAt: new Date(),
      parentExternalId: null,
      parentPostTargetId: null,
    });

    await recordFirstEngagement(config(), new Date());

    const afterMention = await row(env.project.id, target.id);
    expect(afterMention?.exactFirstAt).toBeNull();
    expect(afterMention?.boundBeforeAt).toBeNull();
    const mentionFigure = firstEngagementFigure({
      publishedAt,
      exactFirstAt: afterMention?.exactFirstAt ?? null,
      boundBeforeAt: afterMention?.boundBeforeAt ?? null,
      boundAfterAt: afterMention?.boundAfterAt ?? null,
      scannedThrough: afterMention?.scannedThrough ?? null,
      frozenReason: null,
    });
    expect(["none_yet", "not_examined"]).toContain(mentionFigure.kind);

    const replySaidAt = new Date(publishedAt.getTime() + 10 * 60_000);
    await env.scope.engagementItems.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      kind: "reply",
      externalId: `reply-${randomUUID()}`,
      text: "nice post",
      authorDisplayName: null,
      authorHandle: null,
      authorExternalId: null,
      authorUrl: null,
      authorIdentityStable: false,
      saidAt: replySaidAt,
      ingestedAt: new Date(),
      parentExternalId: null,
      parentPostTargetId: target.id,
    });

    await recordFirstEngagement(config(), new Date());

    const afterReply = await row(env.project.id, target.id);
    expect(afterReply?.exactFirstAt).toEqual(replySaidAt);
    const replyFigure = firstEngagementFigure({
      publishedAt,
      exactFirstAt: afterReply!.exactFirstAt,
      boundBeforeAt: afterReply!.boundBeforeAt,
      boundAfterAt: afterReply!.boundAfterAt,
      scannedThrough: afterReply!.scannedThrough,
      frozenReason: null,
    });
    expect(replyFigure).toEqual({ kind: "exact", afterMs: 10 * 60_000 });
  });

  it("a later, higher snapshot does not move the recorded bound (US6.8, FR-043)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const publishedAt = new Date("2026-01-04T10:00:00.000Z");
    const target = await publish(env, account.id, publishedAt);
    await env.scope.postMetricSnapshots.insertIfAbsent({
      postTargetId: target.id,
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: new Date(publishedAt.getTime() + HOUR_MS),
      metrics: { likeCount: 1 },
    });
    await recordFirstEngagement(config(), new Date());
    const first = await row(env.project.id, target.id);
    expect(first?.boundBeforeAt).toEqual(new Date(publishedAt.getTime() + HOUR_MS));

    await env.scope.postMetricSnapshots.insertIfAbsent({
      postTargetId: target.id,
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: new Date(publishedAt.getTime() + 5 * HOUR_MS),
      metrics: { likeCount: 50 },
    });
    await recordFirstEngagement(config(), new Date());
    const second = await row(env.project.id, target.id);
    expect(second?.boundBeforeAt).toEqual(first?.boundBeforeAt);
    expect(second?.boundAfterAt).toEqual(first?.boundAfterAt);
  });

  it("a target frozen gone with nothing ever observed is reported never observed (US6.7)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const publishedAt = new Date("2026-01-05T10:00:00.000Z");
    const target = await publish(env, account.id, publishedAt);
    await env.scope.postMetricSnapshots.insertIfAbsent({
      postTargetId: target.id,
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: new Date(publishedAt.getTime() + HOUR_MS),
      metrics: { likeCount: 0 },
    });
    await freeze(env.project.id, account.id, target.id, "gone");

    await recordFirstEngagement(config(), new Date());

    const stored = await row(env.project.id, target.id);
    expect(stored?.exactFirstAt).toBeNull();
    expect(stored?.boundBeforeAt).toBeNull();
    expect(stored?.scannedThrough).not.toBeNull();
    const figure = firstEngagementFigure({
      publishedAt,
      exactFirstAt: null,
      boundBeforeAt: null,
      boundAfterAt: null,
      scannedThrough: stored!.scannedThrough,
      frozenReason: "gone",
    });
    expect(figure).toEqual({ kind: "never_observed", asOf: stored!.scannedThrough, frozenReason: "gone" });
  });

  it("two concurrent recorder runs produce one figure with no double-count (FR-057)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const publishedAt = new Date("2026-01-06T10:00:00.000Z");
    const target = await publish(env, account.id, publishedAt);
    await env.scope.postMetricSnapshots.insertIfAbsent({
      postTargetId: target.id,
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: new Date(publishedAt.getTime() + HOUR_MS),
      metrics: { likeCount: 2 },
    });

    await Promise.all([recordFirstEngagement(config(), new Date()), recordFirstEngagement(config(), new Date())]);

    const rows = await getDb()
      .select()
      .from(targetFirstEngagement)
      .where(and(eq(targetFirstEngagement.projectId, env.project.id), eq(targetFirstEngagement.postTargetId, target.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.boundBeforeAt).toEqual(new Date(publishedAt.getTime() + HOUR_MS));
  });

  it("the comparison states that exact times exist only for platforms with an engagement reader (FR-045, US6.5)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const publishedAt = new Date("2026-01-07T10:00:00.000Z");
    const target = await publish(env, account.id, publishedAt);
    await env.scope.postMetricSnapshots.insertIfAbsent({
      postTargetId: target.id,
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: publishedAt,
      metrics: { likeCount: 1 },
    });
    await recordFirstEngagement(config(), new Date());

    const view = await buildFirstEngagement({
      projectId: env.project.id,
      timeZone: "UTC",
      range: { from: new Date(publishedAt.getTime() - HOUR_MS), to: new Date(publishedAt.getTime() + 10 * HOUR_MS) },
    });
    expect(view.exactCapablePlatforms.length).toBeGreaterThan(0);
    expect(view.entries.find((e) => e.targetId === target.id)).toBeDefined();
  });

  it("the table holds no text column at all (FR-064, FR-084)", async () => {
    const columns = await getDb().execute<{ column_name: string; data_type: string }>(
      sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'target_first_engagement'`,
    );
    const textColumns = columns.rows.filter((c) => c.data_type === "text" || c.data_type === "character varying");
    expect(textColumns).toHaveLength(0);
  });
});
