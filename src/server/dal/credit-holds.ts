import { and, eq, inArray, lte } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { llmCreditHolds } from "../db/schema";

/** One item every five minutes while held. A documented constant, not an environment variable (FR-014). */
export const CREDIT_PROBE_INTERVAL_MS = 5 * 60_000;

export interface CreditHold {
  owner: string;
  heldSince: Date;
  lastRefusalAt: Date;
  nextProbeAt: Date;
}

const toHold = (row: typeof llmCreditHolds.$inferSelect): CreditHold => ({
  owner: row.owner,
  heldSince: row.heldSince,
  lastRefusalAt: row.lastRefusalAt,
  nextProbeAt: row.nextProbeAt,
});

/**
 * A billing refusal: create the owner's hold, or refresh an existing one and push the next probe out one
 * interval (FR-011, FR-016). `heldSince` is not moved by a refresh.
 */
export async function holdCredit(owner: string, now: Date): Promise<void> {
  const nextProbeAt = new Date(now.getTime() + CREDIT_PROBE_INTERVAL_MS);
  await getDb()
    .insert(llmCreditHolds)
    .values({ owner, heldSince: now, lastRefusalAt: now, nextProbeAt })
    .onConflictDoUpdate({
      target: llmCreditHolds.owner,
      set: { lastRefusalAt: now, nextProbeAt },
    });
}

/** Any other call outcome: the owner is spending again (FR-017). No-op when there is no hold. */
export async function clearCreditHold(owner: string): Promise<void> {
  await getDb().delete(llmCreditHolds).where(eq(llmCreditHolds.owner, owner));
}

/**
 * Inside the claim transaction (FR-015): who is held, and which of them won this tick's probe.
 * `probing ⊆ held`. A held owner whose row another tick already locked is in `held` and not in `probing`,
 * so this tick claims nothing for it.
 */
export async function gateCreditHolds(exec: Database, now: Date): Promise<{ held: string[]; probing: string[] }> {
  const all = await exec.select({ owner: llmCreditHolds.owner, nextProbeAt: llmCreditHolds.nextProbeAt }).from(llmCreditHolds);
  if (all.length === 0) return { held: [], probing: [] };
  const held = all.map((r) => r.owner);
  const dueOwners = all.filter((r) => r.nextProbeAt <= now).map((r) => r.owner);
  if (dueOwners.length === 0) return { held, probing: [] };

  const locked = await exec
    .select({ owner: llmCreditHolds.owner })
    .from(llmCreditHolds)
    .where(and(inArray(llmCreditHolds.owner, dueOwners), lte(llmCreditHolds.nextProbeAt, now)))
    .for("update", { skipLocked: true });
  const probing = locked.map((r) => r.owner);
  if (probing.length === 0) return { held, probing: [] };

  const nextProbeAt = new Date(now.getTime() + CREDIT_PROBE_INTERVAL_MS);
  await exec.update(llmCreditHolds).set({ nextProbeAt }).where(inArray(llmCreditHolds.owner, probing));
  return { held, probing };
}

/**
 * Give a granted probe's interval back, because no model call was made (FR-016, H7). Update only.
 * Pass the claim's own transaction handle when called from inside it (`gateCreditHolds` already holds
 * the row there; a second connection's plain `UPDATE` would wait on that lock forever).
 */
export async function rewindCreditProbe(owner: string, now: Date, exec: Database = getDb()): Promise<void> {
  await exec.update(llmCreditHolds).set({ nextProbeAt: now }).where(eq(llmCreditHolds.owner, owner));
}

/** For the screens and the tests. */
export async function readCreditHold(owner: string): Promise<CreditHold | null> {
  const [row] = await getDb().select().from(llmCreditHolds).where(eq(llmCreditHolds.owner, owner));
  return row ? toHold(row) : null;
}

export async function readCreditHolds(): Promise<CreditHold[]> {
  const rows = await getDb().select().from(llmCreditHolds);
  return rows.map(toHold);
}
