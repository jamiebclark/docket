import { sql } from "drizzle-orm";
import {
  boolean,
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

export const webhookEventType = pgEnum("webhook_event_type", [
  "post.published",
  "post.failed",
  "job.finished",
  "account.needs_reauth",
  "ping",
]);
export const webhookDeliveryStatus = pgEnum("webhook_delivery_status", [
  "pending",
  "delivering",
  "succeeded",
  "failed",
]);
export const webhookAttemptError = pgEnum("webhook_attempt_error", [
  "timeout",
  "connect",
  "dns",
  "tls",
  "redirect",
  "http_status",
  "endpoint_disabled",
  "internal",
  "address_not_allowed",
]);

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    description: text("description").default("").notNull(),
    events: webhookEventType("events").array().notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    disabledReason: text("disabled_reason"),
    secretEncrypted: text("secret_encrypted").notNull(),
    previousSecretEncrypted: text("previous_secret_encrypted"),
    previousSecretExpiresAt: timestamp("previous_secret_expires_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    unique("webhook_endpoints_project_id_uq").on(t.projectId, t.id),
    check("webhook_endpoints_url_len", sql`char_length(${t.url}) <= 2000`),
    check("webhook_endpoints_description_len", sql`char_length(${t.description}) <= 200`),
    check("webhook_endpoints_events_card", sql`cardinality(${t.events}) >= 1`),
    check("webhook_endpoints_disabled_reason", sql`${t.disabledReason} IS NULL OR ${t.disabledReason} IN ('gone','failing','manual')`),
    check("webhook_endpoints_disabled_has_reason", sql`${t.enabled} OR ${t.disabledReason} IS NOT NULL`),
    check(
      "webhook_endpoints_previous_pair",
      sql`(${t.previousSecretEncrypted} IS NULL) = (${t.previousSecretExpiresAt} IS NULL)`,
    ),
    index("webhook_endpoints_enabled_idx").on(t.projectId).where(sql`${t.enabled}`),
  ],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    type: webhookEventType("type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    body: jsonb("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("webhook_events_project_id_uq").on(t.projectId, t.id),
    index("webhook_events_project_created_idx").on(t.projectId, t.createdAt.desc()),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    endpointId: uuid("endpoint_id").notNull(),
    status: webhookDeliveryStatus("status").default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    leaseOwner: uuid("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastStatusCode: smallint("last_status_code"),
    lastErrorKind: webhookAttemptError("last_error_kind"),
    resendOf: uuid("resend_of"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    unique("webhook_deliveries_project_id_uq").on(t.projectId, t.id),
    foreignKey({
      name: "webhook_deliveries_event_fk",
      columns: [t.projectId, t.eventId],
      foreignColumns: [webhookEvents.projectId, webhookEvents.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "webhook_deliveries_endpoint_fk",
      columns: [t.projectId, t.endpointId],
      foreignColumns: [webhookEndpoints.projectId, webhookEndpoints.id],
    }).onDelete("cascade"),
    check("webhook_deliveries_attempt_range", sql`${t.attemptCount} BETWEEN 0 AND 8`),
    check("webhook_deliveries_lease_pair", sql`(${t.leaseOwner} IS NULL) = (${t.leaseUntil} IS NULL)`),
    check("webhook_deliveries_delivering_leased", sql`(${t.status} = 'delivering') = (${t.leaseOwner} IS NOT NULL)`),
    index("webhook_deliveries_claim_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index("webhook_deliveries_recovery_idx")
      .on(t.leaseUntil)
      .where(sql`${t.status} = 'delivering'`),
    index("webhook_deliveries_endpoint_idx").on(t.projectId, t.endpointId, t.createdAt.desc()),
  ],
);

/** Append-only: the DAL exposes insert and list only. */
export const webhookDeliveryAttempts = pgTable(
  "webhook_delivery_attempts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    deliveryId: uuid("delivery_id").notNull(),
    attempt: smallint("attempt").notNull(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
    statusCode: smallint("status_code"),
    errorKind: webhookAttemptError("error_kind"),
    durationMs: integer("duration_ms").notNull(),
    responseExcerpt: text("response_excerpt"),
  },
  (t) => [
    foreignKey({
      name: "webhook_delivery_attempts_delivery_fk",
      columns: [t.projectId, t.deliveryId],
      foreignColumns: [webhookDeliveries.projectId, webhookDeliveries.id],
    }).onDelete("cascade"),
    check("webhook_delivery_attempts_attempt_range", sql`${t.attempt} BETWEEN 1 AND 8`),
    check("webhook_delivery_attempts_outcome", sql`${t.statusCode} IS NOT NULL OR ${t.errorKind} IS NOT NULL`),
    index("webhook_delivery_attempts_delivery_idx").on(t.projectId, t.deliveryId, t.attempt),
  ],
);

export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;
export type WebhookEventRow = typeof webhookEvents.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
export type WebhookAttemptRow = typeof webhookDeliveryAttempts.$inferSelect;
export type WebhookEventType = WebhookEventRow["type"];
