import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { engagementAccountStates, socialAccounts, type EngagementAccountStateRow, type SocialAccountRow } from "../db/schema";
import { crossProject } from "./scope";
import type { ClaimedAccount } from "./scheduler";

export interface ClaimedEngagementAccount {
  account: ClaimedAccount;
  state: EngagementAccountStateRow;
  token: string;
}

function strip(row: SocialAccountRow): ClaimedAccount {
  const { credentialsEncrypted: _c, ...rest } = row;
  void _c;
  return rest;
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
  providerKeys: readonly string[];
}): Promise<ClaimedEngagementAccount[]> {
  return crossProject("scheduler: claim due engagement reads", async () => {
    if (opts.limit <= 0 || opts.providerKeys.length === 0) return [];
    return getDb().transaction(async (tx) => {
      const exec = tx as unknown as Database;
      const providerKeys = [...opts.providerKeys];
      const missing = await exec
        .select({ id: socialAccounts.id, projectId: socialAccounts.projectId })
        .from(socialAccounts)
        .leftJoin(engagementAccountStates, eq(engagementAccountStates.socialAccountId, socialAccounts.id))
        .where(
          and(
            isNull(socialAccounts.removedAt),
            eq(socialAccounts.status, "active"),
            inArray(socialAccounts.providerKey, providerKeys),
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
            inArray(socialAccounts.providerKey, providerKeys),
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
