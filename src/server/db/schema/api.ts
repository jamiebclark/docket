import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { projects } from "./projects";

export const apiKeyPermission = pgEnum("api_key_permission", [
  "read",
  "write_posts",
  "generate",
  "auto_approve",
  "manage_jobs",
]);
export const apiIdempotencyState = pgEnum("api_idempotency_state", ["in_progress", "completed"]);

/** The plaintext key is never stored: only its SHA-256 hash and the last four characters. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    last4: text("last4").notNull(),
    permissions: apiKeyPermission("permissions").array().notNull(),
    rateLimitPerMinute: integer("rate_limit_per_minute").default(60).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: uuid("revoked_by_user_id").references(() => user.id, { onDelete: "set null" }),
    rateWindowStart: timestamp("rate_window_start", { withTimezone: true }),
    rateWindowCount: integer("rate_window_count").default(0).notNull(),
  },
  (t) => [
    unique("api_keys_project_id_uq").on(t.projectId, t.id),
    unique("api_keys_key_hash_uq").on(t.keyHash),
    check("api_keys_name_len", sql`char_length(${t.name}) BETWEEN 1 AND 64`),
    check("api_keys_last4_len", sql`char_length(${t.last4}) = 4`),
    check("api_keys_permissions_card", sql`cardinality(${t.permissions}) >= 1`),
    check("api_keys_rate_limit_range", sql`${t.rateLimitPerMinute} BETWEEN 1 AND 1000`),
    check("api_keys_revoker_implies_revoked", sql`${t.revokedByUserId} IS NULL OR ${t.revokedAt} IS NOT NULL`),
    index("api_keys_project_created_idx").on(t.projectId, t.createdAt.desc()),
  ],
);

export const apiIdempotencyKeys = pgTable(
  "api_idempotency_keys",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    apiKeyId: uuid("api_key_id").notNull(),
    method: text("method").notNull(),
    route: text("route").notNull(),
    idemKey: text("idem_key").notNull(),
    bodyHash: text("body_hash").notNull(),
    state: apiIdempotencyState("state").notNull(),
    lockToken: uuid("lock_token"),
    holdUntil: timestamp("hold_until", { withTimezone: true }),
    responseStatus: smallint("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: "api_idempotency_keys_api_key_fk",
      columns: [t.projectId, t.apiKeyId],
      foreignColumns: [apiKeys.projectId, apiKeys.id],
    }).onDelete("cascade"),
    unique("api_idempotency_keys_uq").on(t.apiKeyId, t.method, t.route, t.idemKey),
    check("api_idempotency_keys_method", sql`${t.method} IN ('POST','PATCH','DELETE')`),
    check("api_idempotency_keys_route_len", sql`char_length(${t.route}) <= 512`),
    check("api_idempotency_keys_idem_key", sql`${t.idemKey} ~ '^[\x21-\x7E]{1,255}$'`),
    check(
      "api_idempotency_keys_lock_state",
      sql`(${t.state} = 'in_progress') = (${t.lockToken} IS NOT NULL AND ${t.holdUntil} IS NOT NULL)`,
    ),
    check(
      "api_idempotency_keys_completed_state",
      sql`(${t.state} = 'completed') = (${t.responseStatus} IS NOT NULL AND ${t.completedAt} IS NOT NULL)`,
    ),
    check("api_idempotency_keys_status_lt_500", sql`${t.responseStatus} IS NULL OR ${t.responseStatus} < 500`),
    index("api_idempotency_keys_expires_idx").on(t.expiresAt),
  ],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type ApiKeyPermission = ApiKeyRow["permissions"][number];
export type ApiIdempotencyRow = typeof apiIdempotencyKeys.$inferSelect;
