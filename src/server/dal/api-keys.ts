import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, getTableColumns, gt, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "../db/client";
import { apiKeys, projects, user, type ApiKeyPermission, type ApiKeyRow } from "../db/schema";
import { now } from "./clock";

export const API_KEY_PREFIX = "dkt_";
const KEY_PATTERN = /^dkt_[A-Za-z0-9_-]{43}$/;

/** 32 random bytes, base64url (43 characters), after the `dkt_` prefix. */
export function generateApiKey(): { key: string; keyHash: string; last4: string } {
  const key = API_KEY_PREFIX + randomBytes(32).toString("base64url");
  return { key, keyHash: hashApiKey(key), last4: key.slice(-4) };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function isWellFormedApiKey(v: unknown): v is string {
  return typeof v === "string" && KEY_PATTERN.test(v);
}

export type { ApiKeyPermission };
/** A key as the rest of the app sees it: never the hash. */
export type ApiKeyRecord = Omit<ApiKeyRow, "keyHash">;
export type ApiKeyStatus = "active" | "expired" | "revoked";

export function apiKeyStatus(k: Pick<ApiKeyRecord, "revokedAt" | "expiresAt">, at: Date): ApiKeyStatus {
  if (k.revokedAt) return "revoked";
  if (k.expiresAt && k.expiresAt.getTime() <= at.getTime()) return "expired";
  return "active";
}

export interface NewApiKey {
  name: string;
  keyHash: string;
  last4: string;
  permissions: ApiKeyPermission[];
  rateLimitPerMinute: number;
  expiresAt: Date | null;
  createdByUserId: string | null;
}

const { keyHash: _omit, ...publicColumns } = getTableColumns(apiKeys);
void _omit;

/** A key plus the names the settings list shows. `creatorIsMember` is false once the creator has left. */
export interface ApiKeyListRow extends ApiKeyRecord {
  creatorName: string | null;
  revokerName: string | null;
}

/**
 * "Not expired" without an `OR`: the scope check treats a disjunctive WHERE as not pinning the project,
 * so expiry is written as one comparison against `infinity`.
 */
function notExpired(at: Date) {
  return gt(sql`coalesce(${apiKeys.expiresAt}, 'infinity'::timestamptz)`, at);
}

export interface ApiKeysRepo {
  insert(input: NewApiKey): Promise<ApiKeyRecord>;
  list(): Promise<ApiKeyRecord[]>;
  listWithPeople(): Promise<ApiKeyListRow[]>;
  get(id: string): Promise<ApiKeyRecord | null>;
  countActive(): Promise<number>;
  /** Conditional UPDATE; returns the row only if this call revoked it. */
  revoke(id: string, byUserId: string | null): Promise<ApiKeyRecord | null>;
  /** True while the key can still authenticate (own statement, used to re-check inside a transaction). */
  isValid(id: string): Promise<boolean>;
}

export function createApiKeysRepo(db: Database, projectId: string): ApiKeysRepo {
  const mine = eq(apiKeys.projectId, projectId);
  return {
    async insert(input) {
      const [row] = await db
        .insert(apiKeys)
        .values({ ...input, projectId })
        .returning(publicColumns);
      return row!;
    },
    async list() {
      return db.select(publicColumns).from(apiKeys).where(mine).orderBy(desc(apiKeys.createdAt));
    },
    async listWithPeople() {
      const creator = alias(user, "creator");
      const revoker = alias(user, "revoker");
      const rows = await db
        .select({
          key: publicColumns,
          creatorName: creator.name,
          revokerName: revoker.name,
        })
        .from(apiKeys)
        .leftJoin(creator, eq(creator.id, apiKeys.createdByUserId))
        .leftJoin(revoker, eq(revoker.id, apiKeys.revokedByUserId))
        .where(mine)
        .orderBy(desc(apiKeys.createdAt));
      return rows.map((r) => ({
        ...r.key,
        creatorName: r.creatorName,
        revokerName: r.revokerName,
      }));
    },
    async get(id) {
      const rows = await db
        .select(publicColumns)
        .from(apiKeys)
        .where(and(mine, eq(apiKeys.id, id)))
        .limit(1);
      return rows[0] ?? null;
    },
    async countActive() {
      const at = await now(db);
      const rows = await db
        .select({ n: count() })
        .from(apiKeys)
        .where(and(mine, isNull(apiKeys.revokedAt), notExpired(at)));
      return Number(rows[0]?.n ?? 0);
    },
    async revoke(id, byUserId) {
      const at = await now(db);
      const rows = await db
        .update(apiKeys)
        .set({ revokedAt: at, revokedByUserId: byUserId })
        .where(and(mine, eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
        .returning(publicColumns);
      return rows[0] ?? null;
    },
    async isValid(id) {
      const at = await now(db);
      const rows = await db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(
          and(mine, eq(apiKeys.id, id), isNull(apiKeys.revokedAt), notExpired(at)),
        )
        .limit(1);
      return rows.length === 1;
    },
  };
}

export interface AuthenticatedKey {
  key: ApiKeyRecord;
  project: {
    id: string;
    slug: string;
    name: string;
    timezone: string;
    defaultApprovalPolicy: (typeof projects.$inferSelect)["defaultApprovalPolicy"];
    defaultSchedulingPolicy: (typeof projects.$inferSelect)["defaultSchedulingPolicy"];
    defaultVoiceProfileId: string | null;
  };
}

/** Looks a key up by hash across projects. Callers wrap this in `crossProject`. Valid keys only. */
export async function findActiveKeyByHash(db: Database, keyHash: string): Promise<AuthenticatedKey | null> {
  const at = await now(db);
  const rows = await db
    .select({
      key: publicColumns,
      project: {
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        timezone: projects.timezone,
        defaultApprovalPolicy: projects.defaultApprovalPolicy,
        defaultSchedulingPolicy: projects.defaultSchedulingPolicy,
        defaultVoiceProfileId: projects.defaultVoiceProfileId,
      },
    })
    .from(apiKeys)
    .innerJoin(projects, eq(projects.id, apiKeys.projectId))
    .where(
      and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt), notExpired(at)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Counts one request in the key's fixed one-minute window (research D4) and throttles `last_used_at` to once
 * a minute. Returns null when the key was revoked or expired meanwhile. Pinned to the key's project.
 */
export async function countRequest(
  db: Database,
  projectId: string,
  keyId: string,
): Promise<{ count: number; limit: number; resetAt: Date } | null> {
  const at = await now(db);
  const window = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  const rows = await db
    .update(apiKeys)
    .set({
      rateWindowStart: window,
      rateWindowCount: sql`CASE WHEN ${apiKeys.rateWindowStart} = ${window.toISOString()}::timestamptz THEN ${apiKeys.rateWindowCount} + 1 ELSE 1 END`,
      lastUsedAt: sql`CASE WHEN ${apiKeys.lastUsedAt} IS NULL OR ${apiKeys.lastUsedAt} < ${at.toISOString()}::timestamptz - interval '60 seconds' THEN ${at.toISOString()}::timestamptz ELSE ${apiKeys.lastUsedAt} END`,
    })
    .where(
      and(
        eq(apiKeys.projectId, projectId),
        eq(apiKeys.id, keyId),
        isNull(apiKeys.revokedAt),
        notExpired(at),
      ),
    )
    .returning({ count: apiKeys.rateWindowCount, limit: apiKeys.rateLimitPerMinute });
  const row = rows[0];
  if (!row) return null;
  return { count: row.count, limit: row.limit, resetAt: new Date(window.getTime() + 60_000) };
}
