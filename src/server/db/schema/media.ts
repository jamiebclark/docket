import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { projects } from "./projects";

/** A file registered in a project. Upload and storage arrive in a later entry. */
export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    publicUrl: text("public_url").notNull(),
    mimeType: text("mime_type").notNull(),
    width: integer("width"),
    height: integer("height"),
    byteSize: integer("byte_size").notNull(),
    altText: text("alt_text").default("").notNull(),
    firstUsedAt: timestamp("first_used_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    check("media_assets_width_pos", sql`${t.width} > 0`),
    check("media_assets_height_pos", sql`${t.height} > 0`),
    check("media_assets_byte_size_pos", sql`${t.byteSize} > 0`),
    unique("media_assets_storage_key_uq").on(t.projectId, t.storageKey),
    index("media_assets_first_used_idx").on(t.projectId, t.firstUsedAt),
  ],
);

export type MediaAssetRow = typeof mediaAssets.$inferSelect;
