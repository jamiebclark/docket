import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { ACTIVITY_KINDS, ACTIVITY_OUTCOMES, KIND_OUTCOME } from "../../../lib/activity/outcomes";
import { apiKeys } from "./api";
import { user } from "./auth";
import { projects } from "./projects";

export const activityEventKind = pgEnum("activity_event_kind", ACTIVITY_KINDS);
export const activityOutcome = pgEnum("activity_outcome", ACTIVITY_OUTCOMES);

const kindOutcomePairs = ACTIVITY_KINDS.map((k) => `(kind = '${k}' AND outcome = '${KIND_OUTCOME[k]}')`).join(" OR ");

/**
 * One row per publish outcome worth showing. Append-only: the DAL exposes insert, list and summary only (FR-008).
 * Posts, targets and accounts are deliberately not foreign keys, so the log outlives them (research P4).
 */
export const activityEvents = pgTable(
  "activity_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    seq: bigint("seq", { mode: "bigint" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    kind: activityEventKind("kind").notNull(),
    outcome: activityOutcome("outcome").notNull(),
    postId: uuid("post_id"),
    postTargetId: uuid("post_target_id"),
    socialAccountId: uuid("social_account_id"),
    providerKey: text("provider_key"),
    providerKeys: text("provider_keys").array().notNull(),
    groupKey: text("group_key"),
    actorUserId: uuid("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    actorApiKeyId: uuid("actor_api_key_id"),
    message: text("message").notNull(),
    details: jsonb("details").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("activity_events_seq_uq").on(t.seq),
    foreignKey({
      name: "activity_events_api_key_fk",
      columns: [t.projectId, t.actorApiKeyId],
      foreignColumns: [apiKeys.projectId, apiKeys.id],
    }),
    check("activity_events_kind_outcome", sql.raw(kindOutcomePairs)),
    check("activity_events_message_len", sql`char_length(${t.message}) BETWEEN 1 AND 500`),
    check("activity_events_details_size", sql`octet_length(${t.details}::text) <= 2000`),
    check("activity_events_ms", sql`${t.occurredAt} = date_trunc('milliseconds', ${t.occurredAt})`),
    check("activity_events_target_pair", sql`(${t.postId} IS NULL) = (${t.postTargetId} IS NULL)`),
    check(
      "activity_events_target_kinds",
      sql`(${t.kind}::text NOT LIKE 'target\_%' OR (${t.postTargetId} IS NOT NULL AND ${t.socialAccountId} IS NOT NULL AND ${t.providerKey} IS NOT NULL)) AND (${t.kind}::text NOT LIKE 'account\_%' OR ${t.postTargetId} IS NULL)`,
    ),
    check("activity_events_needs_reauth_account", sql`${t.kind} <> 'account_needs_reauth' OR ${t.socialAccountId} IS NOT NULL`),
    check(
      "activity_events_provider_keys",
      sql`cardinality(${t.providerKeys}) >= 1 AND (${t.providerKey} IS NULL OR ${t.providerKeys} = ARRAY[${t.providerKey}])`,
    ),
    check("activity_events_group_key_format", sql`${t.groupKey} IS NULL OR ${t.groupKey} ~ '^[a-z0-9-]+$'`),
    index("activity_events_project_time_idx").on(t.projectId, t.occurredAt.desc(), t.seq.desc()),
    index("activity_events_project_outcome_time_idx").on(t.projectId, t.outcome, t.occurredAt.desc(), t.seq.desc()),
    index("activity_events_project_account_time_idx")
      .on(t.projectId, t.socialAccountId, t.occurredAt.desc(), t.seq.desc())
      .where(sql`${t.socialAccountId} IS NOT NULL`),
    index("activity_events_project_target_idx")
      .on(t.projectId, t.postTargetId)
      .where(sql`${t.postTargetId} IS NOT NULL`),
  ],
);

export type ActivityEventRow = typeof activityEvents.$inferSelect;
