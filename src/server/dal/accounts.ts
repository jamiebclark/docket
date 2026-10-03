import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { socialAccounts, type SocialAccountRow } from "../db/schema";

export type AccountRow = SocialAccountRow;
export type AccountRecord = Omit<AccountRow, "credentialsEncrypted"> & { hasCredentials: boolean };

export interface UpsertConnected {
  providerKey: string;
  displayName: string;
  externalAccountId: string;
  settings: unknown;
  credentialsEncrypted: string | null;
  credentialsExpiresAt: Date | null;
  connectedByUserId: string | null;
}

export interface RefreshPatch {
  credentialsEncrypted?: string;
  credentialsExpiresAt?: Date | null;
  lastRefreshedAt?: Date;
  status?: "active" | "needs_reauth";
  lastError?: string | null;
}

export interface AccountsRepo {
  list(): Promise<AccountRecord[]>;
  get(id: string): Promise<AccountRecord | null>;
  /** Row lock as its own statement; includes soft-deleted rows so callers can refuse them. */
  getForUpdate(id: string): Promise<AccountRecord | null>;
  /** Inserts, or updates in place (same provider + external id, not removed) and reactivates. */
  upsertConnected(input: UpsertConnected): Promise<AccountRecord>;
  /** Stores already-encrypted credentials (the AAD needs the row id, so this follows the upsert). */
  setCredentials(id: string, ciphertext: string, expiresAt: Date | null): Promise<AccountRecord>;
  updateSettings(id: string, settings: unknown): Promise<void>;
  setLimit(id: string, limit: { count: number; windowSeconds: number } | null): Promise<void>;
  markRemoved(id: string, at: Date): Promise<void>;
  /**
   * Internal (token refresh): applies `patch` and clears the refresh lease, only while `token` still holds it.
   * Returns false when the lease was lost.
   */
  recordRefresh(id: string, token: string, patch: RefreshPatch): Promise<boolean>;
  /** Internal: used only by the scheduler and token refresh. */
  getCredentialsCiphertext(id: string): Promise<string | null>;
}

function strip(row: AccountRow): AccountRecord {
  const { credentialsEncrypted, ...rest } = row;
  return { ...rest, hasCredentials: credentialsEncrypted !== null };
}

export function createAccountsRepo(db: Database, projectId: string): AccountsRepo {
  const mine = (id: string) => and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.id, id));
  return {
    async list() {
      const rows = await db
        .select()
        .from(socialAccounts)
        .where(and(eq(socialAccounts.projectId, projectId), isNull(socialAccounts.removedAt)))
        .orderBy(asc(socialAccounts.createdAt), asc(socialAccounts.id));
      return rows.map(strip);
    },
    async get(id) {
      const [row] = await db
        .select()
        .from(socialAccounts)
        .where(and(mine(id), isNull(socialAccounts.removedAt)))
        .limit(1);
      return row ? strip(row) : null;
    },
    async getForUpdate(id) {
      const [row] = await db.select().from(socialAccounts).where(mine(id)).limit(1).for("update");
      return row ? strip(row) : null;
    },
    async upsertConnected(input) {
      const [existing] = await db
        .select({ id: socialAccounts.id })
        .from(socialAccounts)
        .where(
          and(
            eq(socialAccounts.projectId, projectId),
            eq(socialAccounts.providerKey, input.providerKey),
            eq(socialAccounts.externalAccountId, input.externalAccountId),
            isNull(socialAccounts.removedAt),
          ),
        )
        .limit(1);
      if (existing) {
        const [row] = await db
          .update(socialAccounts)
          .set({
            displayName: input.displayName,
            settings: input.settings ?? {},
            credentialsEncrypted: input.credentialsEncrypted,
            credentialsExpiresAt: input.credentialsExpiresAt,
            status: "active",
            lastError: null,
            connectedByUserId: input.connectedByUserId,
          })
          .where(mine(existing.id))
          .returning();
        return strip(row!);
      }
      const [row] = await db
        .insert(socialAccounts)
        .values({
          projectId,
          providerKey: input.providerKey,
          displayName: input.displayName,
          externalAccountId: input.externalAccountId,
          settings: input.settings ?? {},
          credentialsEncrypted: input.credentialsEncrypted,
          credentialsExpiresAt: input.credentialsExpiresAt,
          connectedByUserId: input.connectedByUserId,
        })
        .returning();
      return strip(row!);
    },
    async setCredentials(id, ciphertext, expiresAt) {
      const [row] = await db
        .update(socialAccounts)
        .set({ credentialsEncrypted: ciphertext, credentialsExpiresAt: expiresAt })
        .where(mine(id))
        .returning();
      return strip(row!);
    },
    async updateSettings(id, settings) {
      await db
        .update(socialAccounts)
        .set({ settings: settings ?? {} })
        .where(mine(id));
    },
    async setLimit(id, limit) {
      await db
        .update(socialAccounts)
        .set({
          publishLimitCount: limit?.count ?? null,
          publishLimitWindowSeconds: limit?.windowSeconds ?? null,
        })
        .where(mine(id));
    },
    async markRemoved(id, at) {
      await db
        .update(socialAccounts)
        .set({ removedAt: at, credentialsEncrypted: null, credentialsExpiresAt: null })
        .where(mine(id));
    },
    async recordRefresh(id, token, patch) {
      const rows = await db
        .update(socialAccounts)
        .set({ ...patch, refreshLeaseUntil: null, refreshLeaseOwner: null })
        .where(and(mine(id), eq(socialAccounts.refreshLeaseOwner, token)))
        .returning({ id: socialAccounts.id });
      return rows.length > 0;
    },
    async getCredentialsCiphertext(id) {
      const [row] = await db
        .select({ c: socialAccounts.credentialsEncrypted })
        .from(socialAccounts)
        .where(mine(id))
        .limit(1);
      return row?.c ?? null;
    },
  };
}
