import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { engagementDrafts, type EngagementDraftRow } from "../db/schema";
import { crossProject } from "./scope";

export interface ClaimedEngagementDraft {
  /** After the claim patch (`send_state = 'sending'`, the lease set). */
  draft: EngagementDraftRow;
  token: string;
}

/**
 * Claims drafts ready to send, across every project in one pass (`engagement_drafts_send_claim_idx`,
 * data-model.md §3): approved, `send_state IN ('waiting','sending')`, `send_not_before` past, longest
 * waiting first. `FOR UPDATE SKIP LOCKED` so a concurrent tick never waits on another's claim. Never
 * waits.
 */
export function claimDueEngagementSends(opts: { now: Date; limit: number; leaseMs: number }): Promise<ClaimedEngagementDraft[]> {
  return crossProject("scheduler: claim due engagement sends", async () => {
    if (opts.limit <= 0) return [];
    const { now } = opts;
    return getDb().transaction(async (tx) => {
      const exec = tx as unknown as Database;
      const rows = await exec
        .select()
        .from(engagementDrafts)
        .where(
          and(
            eq(engagementDrafts.reviewState, "approved"),
            sql`${engagementDrafts.sendState} IN ('waiting', 'sending')`,
            sql`(${engagementDrafts.sendNotBefore} IS NULL OR ${engagementDrafts.sendNotBefore} <= ${now})`,
            or(isNull(engagementDrafts.sendLeaseUntil), lte(engagementDrafts.sendLeaseUntil, now)),
          ),
        )
        .orderBy(asc(sql`${engagementDrafts.sendNotBefore} IS NULL`), asc(engagementDrafts.sendNotBefore), asc(engagementDrafts.id))
        .limit(opts.limit)
        .for("update", { of: engagementDrafts, skipLocked: true });

      const claimed: ClaimedEngagementDraft[] = [];
      for (const row of rows) {
        const token = randomUUID();
        const leaseUntil = new Date(now.getTime() + opts.leaseMs);
        const [updated] = await exec
          .update(engagementDrafts)
          .set({ sendState: "sending", sendLeaseOwner: token, sendLeaseUntil: leaseUntil, sendAttempts: row.sendAttempts + 1 })
          .where(eq(engagementDrafts.id, row.id))
          .returning();
        claimed.push({ draft: updated!, token });
      }
      return claimed;
    });
  });
}
