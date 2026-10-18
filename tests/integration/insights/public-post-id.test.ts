import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { postMetricPollStates } from "../../../src/server/db/schema";
import { postTargets } from "../../../src/server/db/schema/posts";
import { publishAttempts } from "../../../src/server/db/schema/attempts";
import { claimDuePostMetricPolls, countPublishedWithoutExternalId, type InsightsProviderRule } from "../../../src/server/dal/insights-claims";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { closeDb } from "../../helpers/db";
import { createMockAccount } from "../../helpers/scheduling";
import { createProjectWithMembers } from "../../helpers/factories";
import { clearRecordedQueries } from "../../setup/scope-recorder";

afterAll(closeDb);

const MIGRATION_PATH = join(__dirname, "..", "..", "..", "drizzle", "0044_funny_lockheed.sql");
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf8");
const BACKFILL_SQL = MIGRATION_SQL.split("--> statement-breakpoint").pop()!.trim();

// The backfill runs once, across every project, exactly as the migration itself does — not scoped
// to a project_id, same as any other migration statement.
async function runBackfill(): Promise<void> {
  await getDb().execute(sql.raw(BACKFILL_SQL));
  clearRecordedQueries();
}

async function readTarget(id: string) {
  const [row] = await getDb().select().from(postTargets).where(eq(postTargets.id, id));
  clearRecordedQueries();
  return row;
}

async function publishedTargetWithAttempts(
  projectId: string,
  accountId: string,
  attempts: { createdAt: Date; publicPostIds?: unknown }[],
) {
  const repos = forSchedulerProject(projectId);
  const post = await repos.posts.insert({ baseText: "Hello" });
  const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: accountId }]);
  await repos.targets.update(target!.id, { status: "published", externalId: "ext-1", publishedAt: new Date() });
  const db = getDb();
  for (const a of attempts) {
    await db.insert(publishAttempts).values({
      projectId,
      postTargetId: target!.id,
      step: "publish",
      outcome: "done",
      responseSummary: a.publicPostIds === undefined ? {} : { publicPostIds: a.publicPostIds },
      createdAt: a.createdAt,
    });
  }
  clearRecordedQueries();
  return target!;
}

describe("the public_post_id backfill (data-model.md §3, FR-008, FR-009)", () => {
  it("grep -c tiktok on the migration file is 0 (contracts/public-post-id.md §4)", () => {
    const count = (MIGRATION_SQL.match(/tiktok/gi) ?? []).length;
    expect(count).toBe(0);
  });

  it("recovers the first id of the most recent attempt row that carries one", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const target = await publishedTargetWithAttempts(ctx.project.id, account.id, [
      { createdAt: new Date("2026-01-01T00:00:00Z"), publicPostIds: ["old-id"] },
      { createdAt: new Date("2026-01-02T00:00:00Z"), publicPostIds: ["new-id", "second-id"] },
    ]);

    await runBackfill();

    const row = await readTarget(target.id);
    expect(row?.publicPostId).toBe("new-id");
  });

  it("leaves the column null where no attempt row survives", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const target = await publishedTargetWithAttempts(ctx.project.id, account.id, [
      { createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);

    await runBackfill();

    const row = await readTarget(target.id);
    expect(row?.publicPostId).toBeNull();
  });

  it("never overwrites an existing value (idempotent on a second run)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const target = await publishedTargetWithAttempts(ctx.project.id, account.id, [
      { createdAt: new Date("2026-01-01T00:00:00Z"), publicPostIds: ["first-run-id"] },
    ]);

    await runBackfill();
    const after1 = await readTarget(target.id);
    expect(after1?.publicPostId).toBe("first-run-id");

    await getDb()
      .update(postTargets)
      .set({ publicPostId: "manually-set" })
      .where(eq(postTargets.id, target.id));
    clearRecordedQueries();

    await runBackfill();
    const after2 = await readTarget(target.id);
    expect(after2?.publicPostId).toBe("manually-set");
  });

  it("rejects an implausible (300-character) id without failing the backfill", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const tooLong = "x".repeat(300);
    const target = await publishedTargetWithAttempts(ctx.project.id, account.id, [
      { createdAt: new Date("2026-01-01T00:00:00Z"), publicPostIds: [tooLong] },
    ]);

    await expect(runBackfill()).resolves.not.toThrow();

    const row = await readTarget(target.id);
    expect(row?.publicPostId).toBeNull();
  });
});

const NOW2 = new Date("2026-03-01T00:00:00Z");

/** A rule standing in for TikTok's reader (G35): a post reader that needs `publicPostId`. */
function publicPostIdRule(providerKey: string): InsightsProviderRule {
  return {
    providerKey,
    postScopes: [],
    accountScopes: [],
    postIdSource: "publicPostId",
    missingPostId: { reason: "This post has no queryable id (contracts/public-post-id.md §5)." },
    postMetricsDeclared: true,
    accountMetricsDeclared: true,
    ephemeralPostTypes: [],
  };
}

async function pollStateFor(projectId: string, postTargetId: string) {
  const [state] = await getDb()
    .select()
    .from(postMetricPollStates)
    .where(and(eq(postMetricPollStates.projectId, projectId), eq(postMetricPollStates.postTargetId, postTargetId)));
  return state;
}

describe("the read path for a target with no public post id (contracts/public-post-id.md §5, FR-010, FR-015)", () => {
  it("is never claimed, and is lazily inserted already frozen unqueryable with the declaration's reason, with no provider call", async () => {
    const ctx = await createProjectWithMembers();
    const providerKey = "tiktok-like-public-post-id";
    const account = await createMockAccount(ctx.project.id, {}, { providerKey });
    const repos = forSchedulerProject(ctx.project.id);
    const post = await repos.posts.insert({ baseText: "Hello" });
    const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: account.id }]);
    await repos.targets.update(target!.id, { status: "published", externalId: "ext-no-public-id", publishedAt: NOW2 });
    clearRecordedQueries();

    const rule = publicPostIdRule(providerKey);
    const claimed = await claimDuePostMetricPolls({ now: NOW2, limit: 100, leaseMs: 60_000, minIntervalMs: 0, providers: [rule] });

    // Structural guarantee, not a mock: a target absent from the claimed set is one the caller never
    // hands to a provider's readPostMetrics — there is no code path that could call out for it.
    expect(claimed.some((c) => c.state.postTargetId === target!.id)).toBe(false);

    const state = await pollStateFor(ctx.project.id, target!.id);
    expect(state?.frozenReason).toBe("unqueryable");
    expect(state?.unavailableReason).toBe(rule.missingPostId!.reason);
    expect(state?.nextPollAt).toBeNull();
    expect(state?.pollLeaseOwner).toBeNull();
  });

  it("a target published by hand with no external_id at all is skipped and counted under targetsSkippedNoExternalId, never failed", async () => {
    const ctx = await createProjectWithMembers();
    const providerKey = "tiktok-like-by-hand";
    const account = await createMockAccount(ctx.project.id, {}, { providerKey });
    const repos = forSchedulerProject(ctx.project.id);
    const post = await repos.posts.insert({ baseText: "Hello" });
    const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: account.id }]);
    await repos.targets.update(target!.id, { status: "published", externalId: null, resolvedAt: NOW2, publishedAt: NOW2 });
    clearRecordedQueries();

    const rule = publicPostIdRule(providerKey);
    const claimed = await claimDuePostMetricPolls({ now: NOW2, limit: 100, leaseMs: 60_000, minIntervalMs: 0, providers: [rule] });
    expect(claimed.some((c) => c.state.postTargetId === target!.id)).toBe(false);

    const state = await pollStateFor(ctx.project.id, target!.id);
    expect(state).toBeUndefined();

    const skippedNoExternalId = await countPublishedWithoutExternalId([rule]);
    expect(skippedNoExternalId).toBeGreaterThanOrEqual(1);
  });
});
