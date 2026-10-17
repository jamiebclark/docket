import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { nextPostPollAt } from "../../lib/insights/schedule";
import { getDb, type Database } from "../db/client";
import {
  accountMetricPollStates,
  postMetricPollStates,
  postTargets,
  socialAccounts,
  type AccountMetricPollStateRow,
  type PostMetricPollStateRow,
  type SocialAccountRow,
} from "../db/schema";
import { crossProject } from "./scope";
import type { ClaimedAccount } from "./scheduler";

export interface ClaimedAccountMetricPoll {
  account: ClaimedAccount;
  state: AccountMetricPollStateRow;
  token: string;
}

export interface ClaimedPostMetricPoll {
  state: PostMetricPollStateRow;
  externalId: string;
  publishedAt: Date;
  token: string;
}

function strip(row: SocialAccountRow): ClaimedAccount {
  const { credentialsEncrypted: _c, ...rest } = row;
  void _c;
  return rest;
}

/**
 * Claims accounts due for an account metrics read, across every project (data-model.md §5, §7).
 * `FOR UPDATE SKIP LOCKED` on `account_metric_poll_states` only, so a concurrent publish holding the
 * account row never blocks a claim (FR-032).
 */
export function claimDueAccountMetricPolls(opts: {
  now: Date;
  limit: number;
  leaseMs: number;
  providerKeys: readonly string[];
}): Promise<ClaimedAccountMetricPoll[]> {
  return crossProject("scheduler: claim due account metric polls", async () => {
    if (opts.limit <= 0 || opts.providerKeys.length === 0) return [];
    return getDb().transaction(async (tx) => {
      const exec = tx as unknown as Database;
      const providerKeys = [...opts.providerKeys];
      const missing = await exec
        .select({ id: socialAccounts.id, projectId: socialAccounts.projectId })
        .from(socialAccounts)
        .leftJoin(accountMetricPollStates, eq(accountMetricPollStates.socialAccountId, socialAccounts.id))
        .where(
          and(
            isNull(socialAccounts.removedAt),
            eq(socialAccounts.status, "active"),
            inArray(socialAccounts.providerKey, providerKeys),
            isNull(accountMetricPollStates.socialAccountId),
          ),
        );
      for (const row of missing) {
        await exec
          .insert(accountMetricPollStates)
          .values({ socialAccountId: row.id, projectId: row.projectId, nextPollAt: opts.now })
          .onConflictDoNothing({ target: accountMetricPollStates.socialAccountId });
      }
      const rows = await exec
        .select({ state: accountMetricPollStates, account: socialAccounts })
        .from(accountMetricPollStates)
        .innerJoin(socialAccounts, eq(socialAccounts.id, accountMetricPollStates.socialAccountId))
        .where(
          and(
            isNull(socialAccounts.removedAt),
            eq(socialAccounts.status, "active"),
            inArray(socialAccounts.providerKey, providerKeys),
            or(isNull(accountMetricPollStates.pollLeaseUntil), lte(accountMetricPollStates.pollLeaseUntil, opts.now)),
            isNotNull(accountMetricPollStates.nextPollAt),
            lte(accountMetricPollStates.nextPollAt, opts.now),
          ),
        )
        .orderBy(asc(accountMetricPollStates.nextPollAt), asc(accountMetricPollStates.socialAccountId))
        .limit(opts.limit)
        .for("update", { of: accountMetricPollStates, skipLocked: true });

      const claimed: ClaimedAccountMetricPoll[] = [];
      for (const row of rows) {
        const token = randomUUID();
        const leaseUntil = new Date(opts.now.getTime() + opts.leaseMs);
        const [updated] = await exec
          .update(accountMetricPollStates)
          .set({ pollLeaseUntil: leaseUntil, pollLeaseOwner: token })
          .where(eq(accountMetricPollStates.socialAccountId, row.state.socialAccountId))
          .returning();
        claimed.push({ account: strip(row.account), state: updated!, token });
      }
      return claimed;
    });
  });
}

/**
 * Claims published targets due for a post metrics read, across every project (data-model.md §5,
 * §7). `FOR UPDATE SKIP LOCKED` on `post_metric_poll_states` only, ordered oldest-due-first, bounded
 * by `opts.limit` (FR-032, FR-034).
 */
export function claimDuePostMetricPolls(opts: {
  now: Date;
  limit: number;
  leaseMs: number;
  minIntervalMs: number;
  providerKeys: readonly string[];
}): Promise<ClaimedPostMetricPoll[]> {
  return crossProject("scheduler: claim due post metric polls", async () => {
    if (opts.limit <= 0 || opts.providerKeys.length === 0) return [];
    return getDb().transaction(async (tx) => {
      const exec = tx as unknown as Database;
      const providerKeys = [...opts.providerKeys];
      const missing = await exec
        .select({
          targetId: postTargets.id,
          projectId: postTargets.projectId,
          socialAccountId: postTargets.socialAccountId,
          publishedAt: postTargets.publishedAt,
        })
        .from(postTargets)
        .innerJoin(socialAccounts, eq(socialAccounts.id, postTargets.socialAccountId))
        .leftJoin(postMetricPollStates, eq(postMetricPollStates.postTargetId, postTargets.id))
        .where(
          and(
            eq(postTargets.status, "published"),
            isNotNull(postTargets.externalId),
            isNotNull(postTargets.publishedAt),
            isNull(socialAccounts.removedAt),
            eq(socialAccounts.status, "active"),
            inArray(socialAccounts.providerKey, providerKeys),
            isNull(postMetricPollStates.postTargetId),
          ),
        )
        .limit(opts.limit);
      for (const row of missing) {
        const nextPollAt = nextPostPollAt({ publishedAt: row.publishedAt!, lastCapturedAt: null, now: opts.now, minIntervalMs: opts.minIntervalMs });
        await exec
          .insert(postMetricPollStates)
          .values({ postTargetId: row.targetId, projectId: row.projectId, socialAccountId: row.socialAccountId, nextPollAt })
          .onConflictDoNothing({ target: postMetricPollStates.postTargetId });
      }
      const rows = await exec
        .select({ state: postMetricPollStates, externalId: postTargets.externalId, publishedAt: postTargets.publishedAt })
        .from(postMetricPollStates)
        .innerJoin(postTargets, eq(postTargets.id, postMetricPollStates.postTargetId))
        .innerJoin(socialAccounts, eq(socialAccounts.id, postMetricPollStates.socialAccountId))
        .where(
          and(
            isNull(socialAccounts.removedAt),
            eq(socialAccounts.status, "active"),
            inArray(socialAccounts.providerKey, providerKeys),
            or(isNull(postMetricPollStates.pollLeaseUntil), lte(postMetricPollStates.pollLeaseUntil, opts.now)),
            isNotNull(postMetricPollStates.nextPollAt),
            lte(postMetricPollStates.nextPollAt, opts.now),
          ),
        )
        .orderBy(asc(postMetricPollStates.nextPollAt), asc(postMetricPollStates.postTargetId))
        .limit(opts.limit)
        .for("update", { of: postMetricPollStates, skipLocked: true });

      const claimed: ClaimedPostMetricPoll[] = [];
      for (const row of rows) {
        const token = randomUUID();
        const leaseUntil = new Date(opts.now.getTime() + opts.leaseMs);
        const [updated] = await exec
          .update(postMetricPollStates)
          .set({ pollLeaseUntil: leaseUntil, pollLeaseOwner: token })
          .where(eq(postMetricPollStates.postTargetId, row.state.postTargetId))
          .returning();
        claimed.push({ state: updated!, externalId: row.externalId!, publishedAt: row.publishedAt!, token });
      }
      return claimed;
    });
  });
}

/**
 * Companion count for `targetsSkippedNoExternalId` (data-model.md §5, FR-039): a target published by
 * hand never gets a state row, so this is the only way to observe it.
 */
export function countPublishedWithoutExternalId(providerKeys: readonly string[]): Promise<number> {
  return crossProject("scheduler: count insights-eligible targets with no external id", async () => {
    if (providerKeys.length === 0) return 0;
    const [row] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(postTargets)
      .innerJoin(socialAccounts, eq(socialAccounts.id, postTargets.socialAccountId))
      .where(
        and(
          eq(postTargets.status, "published"),
          isNotNull(postTargets.resolvedAt),
          isNull(postTargets.externalId),
          isNull(socialAccounts.removedAt),
          inArray(socialAccounts.providerKey, [...providerKeys]),
        ),
      );
    return row?.n ?? 0;
  });
}
