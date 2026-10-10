import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { posts } from "./posts";
import { projects } from "./projects";

/** The ledger entry of "one source record has become a post" (FR-006). Never updated, never deleted. */
export const externalItemClaims = pgTable(
  "external_item_claims",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    externalId: text("external_id").notNull(),
    postId: uuid("post_id").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.sourceKey, t.externalId] }),
    foreignKey({
      name: "external_item_claims_post_fk",
      columns: [t.projectId, t.postId],
      foreignColumns: [posts.projectId, posts.id],
    }).onDelete("cascade"),
    index("external_item_claims_post_idx").on(t.projectId, t.postId),
    check(
      "external_item_claims_source_key_shape",
      sql`char_length(${t.sourceKey}) BETWEEN 1 AND 64 AND ${t.sourceKey} ~ '^[a-z0-9][a-z0-9._:-]*$'`,
    ),
    check("external_item_claims_external_id_len", sql`char_length(${t.externalId}) BETWEEN 1 AND 200`),
    check("external_item_claims_external_id_trimmed", sql`btrim(${t.externalId}) = ${t.externalId}`),
  ],
);

export type ExternalItemClaimRow = typeof externalItemClaims.$inferSelect;
