import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { postPollDecision } from "../../lib/insights/schedule";
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
  chosenPostType: string | null;
  token: string;
}

function strip(row: SocialAccountRow): ClaimedAccount {
  const { credentialsEncrypted: _c, ...rest } = row;
  void _c;
  return rest;
}

/** data-model.md §4 (G33). The claim's eligibility rule for one provider. */
export interface InsightsProviderRule {
  providerKey: string;
  /** Empty = no permission needed (Bluesky, mock). Otherwise every one must be held. */
  requiredScopes: readonly string[];
  /** FR-038/FR-041: used by the lazy insert to freeze an already-expired subject with no call. */
  ephemeralPostTypes: readonly { postType: string; lifetimeMs: number }[];
}

/** FR-022/FR-023. An ineligible account never gets as far as a lease, a decrypt or a call. */
function eligible(rules: readonly InsightsProviderRule[]) {
  return or(
    ...rules.map((r) =>
      r.requiredScopes.length === 0
        ? eq(socialAccounts.providerKey, r.providerKey)
        : and(
            eq(socialAccounts.providerKey, r.providerKey),
            isNotNull(socialAccounts.grantedScopes),
            sql`${socialAccounts.grantedScopes} @> ${sql.param([...r.requiredScopes])}::text[]`,
          ),
    ),
  );
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
  providers: readonly InsightsProviderRule[];
}): Promise<ClaimedAccountMetricPoll[]> {
  return crossProject("scheduler: claim due account metric polls", async () => {
    if (opts.limit <= 0 || opts.providers.length === 0) return [];
    return getDb().transaction(async (tx) => {
      const exec = tx as unknown as Database;
      const rules = opts.providers;
      const missing = await exec
        .select({ id: socialAccounts.id, projectId: socialAccounts.projectId })
        .from(socialAccounts)
        .leftJoin(accountMetricPollStates, eq(accountMetricPollStates.socialAccountId, socialAccounts.id))
        .where(
          and(
            isNull(socialAccounts.removedAt),
            eq(socialAccounts.status, "active"),
            eligible(rules),
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
            eligible(rules),
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
  providers: readonly InsightsProviderRule[];
}): Promise<ClaimedPostMetricPoll[]> {
  return crossProject("scheduler: claim due post metric polls", async () => {
    if (opts.limit <= 0 || opts.providers.length === 0) return [];
    return getDb().transaction(async (tx) => {
      const exec = tx as unknown as Database;
      const rules = opts.providers;
      const rulesByProviderKey = new Map(rules.map((r) => [r.providerKey, r]));
      const missing = await exec
        .select({
          targetId: postTargets.id,
          projectId: postTargets.projectId,
          socialAccountId: postTargets.socialAccountId,
          publishedAt: postTargets.publishedAt,
          chosenPostType: postTargets.chosenPostType,
          providerKey: socialAccounts.providerKey,
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
            eligible(rules),
            isNull(postMetricPollStates.postTargetId),
          ),
        )
        .limit(opts.limit);
      for (const row of missing) {
        const rule = rulesByProviderKey.get(row.providerKey);
        const decision = postPollDecision({
          publishedAt: row.publishedAt!,
          lastCapturedAt: null,
          now: opts.now,
          minIntervalMs: opts.minIntervalMs,
          chosenPostType: row.chosenPostType,
          ephemeralPostTypes: rule?.ephemeralPostTypes,
        });
        await exec
          .insert(postMetricPollStates)
          .values(
            decision.kind === "due"
              ? { postTargetId: row.targetId, projectId: row.projectId, socialAccountId: row.socialAccountId, nextPollAt: decision.at }
              : { postTargetId: row.targetId, projectId: row.projectId, socialAccountId: row.socialAccountId, nextPollAt: null, frozenAt: opts.now, frozenReason: decision.reason },
          )
          .onConflictDoNothing({ target: postMetricPollStates.postTargetId });
      }
      const rows = await exec
        .select({ state: postMetricPollStates, externalId: postTargets.externalId, publishedAt: postTargets.publishedAt, chosenPostType: postTargets.chosenPostType })
        .from(postMetricPollStates)
        .innerJoin(postTargets, eq(postTargets.id, postMetricPollStates.postTargetId))
        .innerJoin(socialAccounts, eq(socialAccounts.id, postMetricPollStates.socialAccountId))
        .where(
          and(
            isNull(socialAccounts.removedAt),
            eq(socialAccounts.status, "active"),
            eligible(rules),
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
        claimed.push({ state: updated!, externalId: row.externalId!, publishedAt: row.publishedAt!, chosenPostType: row.chosenPostType, token });
      }
      return claimed;
    });
  });
}

/**
 * Companion count for `targetsSkippedNoExternalId` (data-model.md §5, FR-039): a target published by
 * hand never gets a state row, so this is the only way to observe it.
 */
export function countPublishedWithoutExternalId(providers: readonly InsightsProviderRule[]): Promise<number> {
  return crossProject("scheduler: count insights-eligible targets with no external id", async () => {
    if (providers.length === 0) return 0;
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
          eligible(providers),
        ),
      );
    return row?.n ?? 0;
  });
}

/**
 * Companion count for `accountsSkippedNoPermission` (data-model.md §4, FR-049): an ineligible account
 * is excluded by the claim, so the claim cannot report it.
 */
export function countAccountsMissingInsightsScopes(providers: readonly InsightsProviderRule[]): Promise<number> {
  return crossProject("scheduler: count insights-ineligible accounts", async () => {
    const rules = providers.filter((r) => r.requiredScopes.length > 0);
    if (rules.length === 0) return 0;
    const [row] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(socialAccounts)
      .where(
        and(
          isNull(socialAccounts.removedAt),
          eq(socialAccounts.status, "active"),
          or(
            ...rules.map((r) =>
              and(
                eq(socialAccounts.providerKey, r.providerKey),
                or(
                  isNull(socialAccounts.grantedScopes),
                  sql`NOT (${socialAccounts.grantedScopes} @> ${sql.param([...r.requiredScopes])}::text[])`,
                ),
              ),
            ),
          ),
        ),
      );
    return row?.n ?? 0;
  });
}
