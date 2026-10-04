import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  foreignKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { posts } from "./posts";
import { projects } from "./projects";

export const generationMode = pgEnum("generation_mode", ["single", "series_plan", "series_post", "regenerate"]);
export const llmFailureKind = pgEnum("llm_failure_kind", [
  "invalid_output",
  "refused",
  "incomplete",
  "timeout",
  "rate_limited",
  "unavailable",
  "auth",
  "bad_request",
]);

export const voiceProfiles = pgTable(
  "voice_profiles",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references((): AnyPgColumn => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    currentVersion: integer("current_version").default(1).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    unique("voice_profiles_project_id_uq").on(t.projectId, t.id),
    uniqueIndex("voice_profiles_project_name_uq")
      .on(t.projectId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} IS NULL`),
    check("voice_profiles_current_version_pos", sql`${t.currentVersion} >= 1`),
  ],
);

/** Immutable: the repository has no update or delete. */
export const voiceProfileVersions = pgTable(
  "voice_profile_versions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id").notNull(),
    version: integer("version").notNull(),
    content: jsonb("content").notNull(),
    authorUserId: uuid("author_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: "voice_profile_versions_profile_fk",
      columns: [t.projectId, t.profileId],
      foreignColumns: [voiceProfiles.projectId, voiceProfiles.id],
    }).onDelete("cascade"),
    unique("voice_profile_versions_profile_version_uq").on(t.profileId, t.version),
    unique("voice_profile_versions_project_id_uq").on(t.projectId, t.id),
    check("voice_profile_versions_version_pos", sql`${t.version} >= 1`),
  ],
);

export const generationSeries = pgTable(
  "generation_series",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    brief: text("brief").notNull(),
    plan: jsonb("plan").notNull(),
    request: jsonb("request").notNull(),
    plannedCount: smallint("planned_count").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("generation_series_project_id_uq").on(t.projectId, t.id),
    check("generation_series_planned_count_range", sql`${t.plannedCount} BETWEEN 2 AND 10`),
  ],
);

export const generationFailures = pgTable(
  "generation_failures",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    mode: generationMode("mode").notNull(),
    seriesId: uuid("series_id"),
    seriesPosition: smallint("series_position"),
    postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }),
    inputs: jsonb("inputs").notNull(),
    kind: llmFailureKind("kind").notNull(),
    message: text("message").notNull(),
    attempts: jsonb("attempts").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    requestedByUserId: uuid("requested_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: "generation_failures_series_fk",
      columns: [t.projectId, t.seriesId],
      foreignColumns: [generationSeries.projectId, generationSeries.id],
    }).onDelete("cascade"),
    index("generation_failures_project_created_idx").on(t.projectId, t.createdAt.desc()),
    check("generation_failures_series_pair", sql`(${t.seriesId} IS NULL) = (${t.seriesPosition} IS NULL)`),
  ],
);

export type VoiceProfileRow = typeof voiceProfiles.$inferSelect;
export type VoiceProfileVersionRow = typeof voiceProfileVersions.$inferSelect;
export type GenerationSeriesRow = typeof generationSeries.$inferSelect;
export type GenerationFailureRow = typeof generationFailures.$inferSelect;
