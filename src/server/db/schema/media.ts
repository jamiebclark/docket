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
    thumbnailStorageKey: text("thumbnail_storage_key"),
    thumbnailUrl: text("thumbnail_url"),
    originalFilename: text("original_filename"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
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
    check("media_assets_tags_max", sql`cardinality(${t.tags}) <= 20`),
    index("media_assets_tags_gin").using("gin", t.tags),
    index("media_assets_live_idx")
      .on(t.projectId, t.createdAt.desc())
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

/** One derived, compliant copy of an asset for one provider constraint set, cached by hash. */
export const mediaVariants = pgTable(
  "media_variants",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    mediaAssetId: uuid("media_asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "cascade" }),
    constraintsHash: text("constraints_hash").notNull(),
    storageKey: text("storage_key").notNull(),
    publicUrl: text("public_url").notNull(),
    mimeType: text("mime_type").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    byteSize: integer("byte_size").notNull(),
    steps: text("steps").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check("media_variants_width_pos", sql`${t.width} > 0`),
    check("media_variants_height_pos", sql`${t.height} > 0`),
    check("media_variants_byte_size_pos", sql`${t.byteSize} > 0`),
    unique("media_variants_asset_hash_uq").on(t.mediaAssetId, t.constraintsHash),
    unique("media_variants_storage_key_uq").on(t.projectId, t.storageKey),
    index("media_variants_project_asset_idx").on(t.projectId, t.mediaAssetId),
  ],
);

export type MediaVariantRow = typeof mediaVariants.$inferSelect;

export type MediaAssetRow = typeof mediaAssets.$inferSelect;
