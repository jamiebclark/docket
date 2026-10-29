import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { normalizeGrantedScopes } from "../../lib/granted-scopes";
import { listProviders } from "../../providers/registry";
import type { Database } from "../db/client";
import { postTargets, posts, socialAccountStatus, socialAccounts, type SocialAccountRow } from "../db/schema";

export type AccountRow = SocialAccountRow;

/** What the stored enum can say: whether the credentials are believed good. Never mentions disabling. */
export type AuthStatus = (typeof socialAccountStatus.enumValues)[number];

/**
 * What every caller should branch on: the auth status, unless a member has switched the account off,
 * in which case `"disabled"` shadows it.
 *
 * Deriving it here rather than at each call site is deliberate. Around twenty places ask
 * `status !== "active"` before publishing, polling, replying, validating or offering an account, and
 * every one of them must also exclude a disabled account. Shadowing the field means they all do,
 * and `tsc` makes the handful that render a label handle the new value. The stored enum stays
 * reachable as `authStatus`, which is what makes enabling restore `needs_reauth` instead of
 * inventing `active` (`disabled_at` on the table says why).
 */
export type EffectiveStatus = AuthStatus | "disabled";

export type AccountRecord = Omit<AccountRow, "credentialsEncrypted" | "status"> & {
  status: EffectiveStatus;
  /** The stored enum, unshadowed. Only disable/enable and the refresh paths have any business reading it. */
  authStatus: AuthStatus;
  hasCredentials: boolean;
};

export interface UpsertConnected {
  providerKey: string;
  displayName: string;
  externalAccountId: string;
  settings: unknown;
  credentialsEncrypted: string | null;
  credentialsExpiresAt: Date | null;
  connectedByUserId: string | null;
  /** From `ConnectCandidate.grantedScopes` (G31). Absent/invalid normalizes to `null`. */
  grantedScopes?: readonly string[];
}

export interface RefreshPatch {
  credentialsEncrypted?: string;
  credentialsExpiresAt?: Date | null;
  lastRefreshedAt?: Date;
  status?: "active" | "needs_reauth";
  lastError?: string | null;
  displayName?: string;
  /** Keeps the account out of the scheduled claim until then (G11); the lease owner stays set to the releasing token because of the table's pair check. Default: released now. */
  refreshLeaseUntil?: Date;
  /** Already normalized by the caller (FR-011); present only when the refresh reported a list. */
  grantedScopes?: string[] | null;
}

export type RefreshLeaseResult =
  | { kind: "acquired" }
  | { kind: "changed" }
  | { kind: "busy" }
  | { kind: "unavailable" };

export interface AccountsRepo {
  /** Distinct non-deleted posts with a draft/scheduled/publishing target on the account. */
  countUnpublishedPosts(accountId: string): Promise<number>;
  /** Distinct non-deleted posts with a `scheduled` target on the account — what disabling would hold. */
  countQueuedPosts(accountId: string): Promise<number>;
  listNeedingReauth(): Promise<{ id: string; displayName: string; providerKey: string }[]>;
  list(): Promise<AccountRecord[]>;
  get(id: string): Promise<AccountRecord | null>;
  /** Row lock as its own statement; includes soft-deleted rows so callers can refuse them. */
  getForUpdate(id: string): Promise<AccountRecord | null>;
  /** Inserts, or updates in place (same provider + external id, not removed) and reactivates. */
  upsertConnected(input: UpsertConnected): Promise<AccountRecord>;
  /** Stores already-encrypted credentials (the AAD needs the row id, so this follows the upsert). */
  setCredentials(id: string, ciphertext: string, expiresAt: Date | null): Promise<AccountRecord>;
  updateSettings(id: string, settings: unknown): Promise<void>;
  /** Only while the account is not removed. */
  setPostingInstructions(id: string, text: string | null): Promise<void>;
  setLimit(id: string, limit: { count: number; windowSeconds: number } | null): Promise<void>;
  markRemoved(id: string, at: Date): Promise<void>;
  /**
   * Switches the account off (`at`) or back on (`null`), only while it is not removed and not already in
   * that state. Touches nothing else: credentials, `status` and `last_error` all survive, which is what
   * lets enabling hand back the `needs_reauth` the account had when it was switched off.
   */
  setDisabled(id: string, at: Date | null): Promise<boolean>;
  /**
   * Internal (token refresh): applies `patch` and clears the refresh lease, only while `token` still holds it.
   * Returns false when the lease was lost.
   */
  recordRefresh(id: string, token: string, patch: RefreshPatch): Promise<StatusChange>;
  /**
   * Internal (publish-time refresh): takes the refresh lease with one conditional UPDATE, only while the stored
   * ciphertext still equals `expectedCiphertext`. `changed` = someone refreshed; `busy` = leased; `unavailable` = removed, inactive, or no credentials.
   */
  acquireRefreshLease(
    id: string,
    token: string,
    opts: { now: Date; leaseMs: number; expectedCiphertext: string },
  ): Promise<RefreshLeaseResult>;
  /**
   * Internal (scheduler): flags the account `needs_reauth` with a secret-free reason, only while the stored
   * ciphertext still equals `expectedCiphertext` and the account is not removed. One conditional UPDATE; no lock held.
   * Returns whether the row changed.
   */
  markCredentialsInvalid(id: string, opts: { expectedCiphertext: string | null; reason: string }): Promise<StatusChange>;
  /** Internal: used only by the scheduler and token refresh. */
  getCredentialsCiphertext(id: string): Promise<string | null>;
  /** Distinct `provider_key` for live accounts in this project, registry order (data-model.md §4.9). */
  platformKeys(): Promise<string[]>;
}

/** `changed` = a row was updated; `previousStatus` = the status it had before (read under a row lock, so call inside a transaction). */
export interface StatusChange {
  changed: boolean;
  previousStatus: "active" | "needs_reauth" | null;
}

/** The one place `disabled_at` becomes a status; see `EffectiveStatus`. */
export function effectiveStatus(row: Pick<AccountRow, "status" | "disabledAt">): EffectiveStatus {
  return row.disabledAt !== null ? "disabled" : row.status;
}

function strip(row: AccountRow): AccountRecord {
  const { credentialsEncrypted, ...rest } = row;
  return { ...rest, status: effectiveStatus(row), authStatus: row.status, hasCredentials: credentialsEncrypted !== null };
}

export function createAccountsRepo(db: Database, projectId: string): AccountsRepo {
  const mine = (id: string) => and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.id, id));
  const lockStatus = async (id: string): Promise<StatusChange["previousStatus"]> => {
    const [row] = await db
      .select({ status: socialAccounts.status })
      .from(socialAccounts)
      .where(mine(id))
      .limit(1)
      .for("update");
    return row?.status === "active" || row?.status === "needs_reauth" ? row.status : null;
  };
  return {
    async countUnpublishedPosts(accountId) {
      const [row] = await db
        .select({ n: sql<number>`count(DISTINCT ${posts.id})::int` })
        .from(postTargets)
        .innerJoin(
          posts,
          and(
            eq(posts.id, postTargets.postId),
            eq(posts.projectId, postTargets.projectId),
            isNull(posts.deletedAt),
          ),
        )
        .where(
          and(
            eq(postTargets.projectId, projectId),
            eq(postTargets.socialAccountId, accountId),
            sql`${postTargets.status} IN ('draft','scheduled','publishing')`,
          ),
        );
      return row?.n ?? 0;
    },
    async countQueuedPosts(accountId) {
      const [row] = await db
        .select({ n: sql<number>`count(DISTINCT ${posts.id})::int` })
        .from(postTargets)
        .innerJoin(
          posts,
          and(eq(posts.id, postTargets.postId), eq(posts.projectId, postTargets.projectId), isNull(posts.deletedAt)),
        )
        .where(
          and(
            eq(postTargets.projectId, projectId),
            eq(postTargets.socialAccountId, accountId),
            eq(postTargets.status, "scheduled"),
          ),
        );
      return row?.n ?? 0;
    },
    async listNeedingReauth() {
      return db
        .select({
          id: socialAccounts.id,
          displayName: socialAccounts.displayName,
          providerKey: socialAccounts.providerKey,
        })
        .from(socialAccounts)
        .where(
          and(
            eq(socialAccounts.projectId, projectId),
            isNull(socialAccounts.removedAt),
            // A disabled account is not asking to be reconnected: it was switched off on purpose.
            isNull(socialAccounts.disabledAt),
            eq(socialAccounts.status, "needs_reauth"),
          ),
        )
        .orderBy(asc(socialAccounts.createdAt), asc(socialAccounts.id));
    },
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
      const grantedScopes = normalizeGrantedScopes(input.grantedScopes);
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
            grantedScopes,
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
          grantedScopes,
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
    async setPostingInstructions(id, text) {
      await db
        .update(socialAccounts)
        .set({ postingInstructions: text })
        .where(and(mine(id), isNull(socialAccounts.removedAt)));
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
    async setDisabled(id, at) {
      const rows = await db
        .update(socialAccounts)
        .set({ disabledAt: at })
        .where(
          and(
            mine(id),
            isNull(socialAccounts.removedAt),
            // Guarded on being off or on, never on the instant: a second disable must keep the original
            // `disabled_at` (the card shows it) instead of quietly resetting it to now and auditing again.
            at === null ? sql`${socialAccounts.disabledAt} IS NOT NULL` : isNull(socialAccounts.disabledAt),
          ),
        )
        .returning({ id: socialAccounts.id });
      return rows.length > 0;
    },
    async recordRefresh(id, token, patch) {
      const previousStatus = await lockStatus(id);
      const rows = await db
        .update(socialAccounts)
        // The table requires lease_until and lease_owner to be both set or both null, so a held account keeps
        // the releasing token as its (inert) owner; the next claim overwrites it.
        .set({ ...patch, refreshLeaseUntil: patch.refreshLeaseUntil ?? null, refreshLeaseOwner: patch.refreshLeaseUntil ? token : null })
        .where(and(mine(id), eq(socialAccounts.refreshLeaseOwner, token)))
        .returning({ id: socialAccounts.id });
      return { changed: rows.length > 0, previousStatus: rows.length > 0 ? previousStatus : null };
    },
    async acquireRefreshLease(id, token, opts) {
      const leaseUntil = new Date(opts.now.getTime() + opts.leaseMs);
      const won = await db
        .update(socialAccounts)
        .set({ refreshLeaseUntil: leaseUntil, refreshLeaseOwner: token })
        .where(
          and(
            mine(id),
            eq(socialAccounts.status, "active"),
            isNull(socialAccounts.removedAt),
            isNull(socialAccounts.disabledAt),
            // No `or`: the scope check treats a disjunction as unable to pin the project.
            sql`coalesce(${socialAccounts.refreshLeaseUntil}, 'epoch'::timestamptz) <= ${opts.now}`,
            eq(socialAccounts.credentialsEncrypted, opts.expectedCiphertext),
          ),
        )
        .returning({ id: socialAccounts.id });
      if (won.length > 0) return { kind: "acquired" };
      const [row] = await db
        .select({
          status: socialAccounts.status,
          removedAt: socialAccounts.removedAt,
          disabledAt: socialAccounts.disabledAt,
          c: socialAccounts.credentialsEncrypted,
        })
        .from(socialAccounts)
        .where(mine(id))
        .limit(1);
      if (!row || row.removedAt !== null || row.disabledAt !== null || row.status !== "active" || row.c === null) {
        return { kind: "unavailable" };
      }
      return row.c !== opts.expectedCiphertext ? { kind: "changed" } : { kind: "busy" };
    },
    async markCredentialsInvalid(id, opts) {
      const previousStatus = await lockStatus(id);
      const rows = await db
        .update(socialAccounts)
        .set({ status: "needs_reauth", lastError: opts.reason })
        .where(
          and(
            mine(id),
            isNull(socialAccounts.removedAt),
            // Null-safe equality without `not`/`or` (the scope check treats those as unable to pin the project).
            sql`coalesce(${socialAccounts.credentialsEncrypted}, '') = ${opts.expectedCiphertext ?? ""}`,
          ),
        )
        .returning({ id: socialAccounts.id });
      return { changed: rows.length > 0, previousStatus: rows.length > 0 ? previousStatus : null };
    },
    async getCredentialsCiphertext(id) {
      const [row] = await db
        .select({ c: socialAccounts.credentialsEncrypted })
        .from(socialAccounts)
        .where(mine(id))
        .limit(1);
      return row?.c ?? null;
    },
    async platformKeys() {
      const rows = await db
        .selectDistinct({ providerKey: socialAccounts.providerKey })
        .from(socialAccounts)
        .where(and(eq(socialAccounts.projectId, projectId), isNull(socialAccounts.removedAt)));
      const live = new Set(rows.map((r) => r.providerKey));
      return listProviders()
        .map((p) => p.key)
        .filter((key) => live.has(key));
    },
  };
}
