import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { postingSlots, type PostingSlotRow } from "../db/schema";
import { ConflictError } from "./errors";

export type SlotRow = PostingSlotRow;

export interface SlotsRepo {
  get(id: string): Promise<SlotRow | null>;
  listForAccount(accountId: string): Promise<SlotRow[]>;
  /** Unpaused slots only: what allocation reads. */
  listActiveForAccount(accountId: string): Promise<SlotRow[]>;
  insert(accountId: string, weekday: number, localTime: string): Promise<SlotRow>;
  /** Changes a slot's weekday and local time in place. Targets are untouched: `slot_id` keeps pointing here. */
  move(id: string, weekday: number, localTime: string): Promise<SlotRow>;
  setPaused(id: string, paused: boolean): Promise<void>;
  delete(id: string): Promise<void>;
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

async function asSlotConflict<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("That account already has a slot at that time.", "localTime");
    }
    throw error;
  }
}

export function createSlotsRepo(db: Database, projectId: string): SlotsRepo {
  const forAccount = (accountId: string) =>
    and(eq(postingSlots.projectId, projectId), eq(postingSlots.socialAccountId, accountId));
  const order = [asc(postingSlots.weekday), asc(postingSlots.localTime)] as const;
  return {
    async get(id) {
      const [row] = await db
        .select()
        .from(postingSlots)
        .where(and(eq(postingSlots.projectId, projectId), eq(postingSlots.id, id)))
        .limit(1);
      return row ?? null;
    },
    async listForAccount(accountId) {
      return db.select().from(postingSlots).where(forAccount(accountId)).orderBy(...order);
    },
    async listActiveForAccount(accountId) {
      return db
        .select()
        .from(postingSlots)
        .where(and(forAccount(accountId), eq(postingSlots.paused, false)))
        .orderBy(...order);
    },
    async insert(accountId, weekday, localTime) {
      // A savepoint-free insert is fine here: the caller gets a ConflictError, not a retry.
      return asSlotConflict(async () => {
        const [row] = await db
          .insert(postingSlots)
          .values({ projectId, socialAccountId: accountId, weekday, localTime })
          .returning();
        return row!;
      });
    },
    async move(id, weekday, localTime) {
      return asSlotConflict(async () => {
        const [row] = await db
          .update(postingSlots)
          .set({ weekday, localTime })
          .where(and(eq(postingSlots.projectId, projectId), eq(postingSlots.id, id)))
          .returning();
        return row!;
      });
    },
    async setPaused(id, paused) {
      await db
        .update(postingSlots)
        .set({ paused })
        .where(and(eq(postingSlots.projectId, projectId), eq(postingSlots.id, id)));
    },
    async delete(id) {
      await db
        .delete(postingSlots)
        .where(and(eq(postingSlots.projectId, projectId), eq(postingSlots.id, id)));
    },
  };
}
