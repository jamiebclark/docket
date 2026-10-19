import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { engagementAccountStates, socialAccounts, type EngagementAccountStateRow, type SocialAccountRow } from "../db/schema";
import { accountHoldsScopes, accountMissingScopes } from "./scope-predicates";
import { crossProject } from "./scope";
import type { ClaimedAccount } from "./scheduler";

export interface ClaimedEngagementAccount {
  account: ClaimedAccount;
  state: EngagementAccountStateRow;
  token: string;
}

/** contracts/engagement-read-scopes.md §4 (G40). The claim's eligibility rule for one provider. */
export interface EngagementProviderRule {
  providerKey: string;
  /** Scopes the engagement read surface needs. Empty = no permission needed (Bluesky, mock). */
  readScopes: readonly string[];
}

function strip(row: SocialAccountRow): ClaimedAccount {
  const { credentialsEncrypted: _c, ...rest } = row;
  void _c;
  return rest;
}

/** FR-018 to FR-023, G40. An ineligible account never gets as far as a lease, a decrypt or a call. */
function eligible(rules: readonly EngagementProviderRule[]) {
  return or(
    ...rules.map((r) =>
      r.readScopes.length === 0
        ? eq(socialAccounts.providerKey, r.providerKey)
        : and(eq(socialAccounts.providerKey, r.providerKey), accountHoldsScopes(r.readScopes)),
    ),
  );
}

/**
 * Claims accounts due for an engagement read, across every project in one pass (data-model.md §5,
 * §7). `FOR UPDATE SKIP LOCKED` on `engagement_account_states` only, so a concurrent publish holding
 * the account row never blocks a read claim. Rows are created lazily for every active account on a
 * provider that declares engagement and has none yet.
 */
export function claimDueEngagementReads(opts: {
  now: Date;
  limit: number;
  leaseMs: number;
  minIntervalMs: number;
  providers: readonly EngagementProviderRule[];
}): Promise<ClaimedEngagementAccount[]> {
  return crossProject("scheduler: claim due engagement reads", async () => {
    if (opts.limit <= 0 || opts.providers.length === 0) return [];
    return getDb().transaction(async (tx) => {
      const exec = tx as unknown as Database;
      const rules = opts.providers;
      const missing = await exec
        .select({ id: socialAccounts.id, projectId: socialAccounts.projectId })
        .from(socialAccounts)
        .leftJoin(engagementAccountStates, eq(engagementAccountStates.socialAccountId, socialAccounts.id))
        .where(
          and(
            isNull(socialAccounts.removedAt),
            eq(socialAccounts.status, "active"),
            eligible(rules),
            isNull(engagementAccountStates.socialAccountId),
          ),
        );
      for (const row of missing) {
        await exec
          .insert(engagementAccountStates)
          .values({ socialAccountId: row.id, projectId: row.projectId })
          .onConflictDoNothing({ target: engagementAccountStates.socialAccountId });
      }
      const readyBefore = new Date(opts.now.getTime() - opts.minIntervalMs);
      const rows = await exec
        .select({ state: engagementAccountStates, account: socialAccounts })
        .from(engagementAccountStates)
        .innerJoin(socialAccounts, eq(socialAccounts.id, engagementAccountStates.socialAccountId))
        .where(
          and(
            isNull(socialAccounts.removedAt),
            eq(socialAccounts.status, "active"),
            eligible(rules),
            or(isNull(engagementAccountStates.readLeaseUntil), lte(engagementAccountStates.readLeaseUntil, opts.now)),
            or(isNull(engagementAccountStates.readNotBefore), lte(engagementAccountStates.readNotBefore, opts.now)),
            or(isNull(engagementAccountStates.lastReadAt), lte(engagementAccountStates.lastReadAt, readyBefore)),
          ),
        )
        .orderBy(asc(engagementAccountStates.readNotBefore), asc(socialAccounts.id))
        .limit(opts.limit)
        .for("update", { of: engagementAccountStates, skipLocked: true });

      const claimed: ClaimedEngagementAccount[] = [];
      for (const row of rows) {
        const token = randomUUID();
        const leaseUntil = new Date(opts.now.getTime() + opts.leaseMs);
        const [updated] = await exec
          .update(engagementAccountStates)
          .set({ readLeaseUntil: leaseUntil, readLeaseOwner: token })
          .where(eq(engagementAccountStates.socialAccountId, row.state.socialAccountId))
          .returning();
        claimed.push({ account: strip(row.account), state: updated!, token });
      }
      return claimed;
    });
  });
}

/**
 * Companion count for `accountsSkippedNoPermission` (contracts/engagement-read-scopes.md §4, G40):
 * the claim excludes an ineligible account, so the claim cannot report it. Counts an account
 * missing its declared scopes, deduplicated by account id, over providers that declare any.
 */
export function countAccountsMissingEngagementScopes(rules: readonly EngagementProviderRule[]): Promise<number> {
  return crossProject("scheduler: count engagement-ineligible accounts", async () => {
    const declared = rules.filter((r) => r.readScopes.length > 0);
    if (declared.length === 0) return 0;
    const [row] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(socialAccounts)
      .where(
        and(
          isNull(socialAccounts.removedAt),
          eq(socialAccounts.status, "active"),
          or(...declared.map((r) => and(eq(socialAccounts.providerKey, r.providerKey), accountMissingScopes(r.readScopes)))),
        ),
      );
    return row?.n ?? 0;
  });
}

/** research.md §3 Finding D3. Active accounts on a provider whose engagement is declared `unavailable`. */
export function countAccountsOnUnavailableEngagement(providerKeys: readonly string[]): Promise<number> {
  return crossProject("scheduler: count unavailable-engagement accounts", async () => {
    if (providerKeys.length === 0) return 0;
    const [row] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(socialAccounts)
      .where(and(isNull(socialAccounts.removedAt), eq(socialAccounts.status, "active"), or(...providerKeys.map((key) => eq(socialAccounts.providerKey, key)))));
    return row?.n ?? 0;
  });
}
