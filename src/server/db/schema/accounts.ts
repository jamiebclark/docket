import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { projects } from "./projects";

export const socialAccountStatus = pgEnum("social_account_status", ["active", "needs_reauth"]);

/** A connection to one platform account in one project. Soft-deleted through `removed_at`. */
export const socialAccounts = pgTable(
  "social_accounts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    displayName: text("display_name").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    credentialsEncrypted: text("credentials_encrypted"),
    credentialsExpiresAt: timestamp("credentials_expires_at", { withTimezone: true }),
    status: socialAccountStatus("status").default("active").notNull(),
    lastError: text("last_error"),
    settings: jsonb("settings").default({}).notNull(),
    postingInstructions: text("posting_instructions"),
    publishLimitCount: integer("publish_limit_count"),
    publishLimitWindowSeconds: integer("publish_limit_window_seconds"),
    refreshLeaseUntil: timestamp("refresh_lease_until", { withTimezone: true }),
    refreshLeaseOwner: uuid("refresh_lease_owner"),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    connectedByUserId: uuid("connected_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    check(
      "social_accounts_posting_instructions_len",
      sql`${t.postingInstructions} IS NULL OR char_length(${t.postingInstructions}) BETWEEN 1 AND 2000`,
    ),
    check("social_accounts_limit_count_pos", sql`${t.publishLimitCount} > 0`),
    check("social_accounts_limit_window_pos", sql`${t.publishLimitWindowSeconds} > 0`),
    check(
      "social_accounts_limit_pair",
      sql`(${t.publishLimitCount} IS NULL) = (${t.publishLimitWindowSeconds} IS NULL)`,
    ),
    check(
      "social_accounts_refresh_lease_pair",
      sql`(${t.refreshLeaseUntil} IS NULL) = (${t.refreshLeaseOwner} IS NULL)`,
    ),
    uniqueIndex("social_accounts_external_uq")
      .on(t.projectId, t.providerKey, t.externalAccountId)
      .where(sql`${t.removedAt} IS NULL`),
    index("social_accounts_project_idx")
      .on(t.projectId)
      .where(sql`${t.removedAt} IS NULL`),
    index("social_accounts_expiry_idx")
      .on(t.credentialsExpiresAt)
      .where(
        sql`${t.removedAt} IS NULL AND ${t.status} = 'active' AND ${t.credentialsExpiresAt} IS NOT NULL`,
      ),
  ],
);

/** A weekly weekday + local time (in the project's zone) for one account. */
export const postingSlots = pgTable(
  "posting_slots",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    weekday: smallint("weekday").notNull(),
    localTime: time("local_time", { precision: 0 }).notNull(),
    paused: boolean("paused").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    check("posting_slots_weekday_range", sql`${t.weekday} BETWEEN 1 AND 7`),
    unique("posting_slots_account_time_uq").on(t.socialAccountId, t.weekday, t.localTime),
    index("posting_slots_project_account_idx").on(t.projectId, t.socialAccountId),
  ],
);

export type SocialAccountRow = typeof socialAccounts.$inferSelect;
export type PostingSlotRow = typeof postingSlots.$inferSelect;
