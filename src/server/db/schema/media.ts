import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { apiKeys } from "./api";
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
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    altText: text("alt_text").default("").notNull(),
    thumbnailStorageKey: text("thumbnail_storage_key"),
    thumbnailUrl: text("thumbnail_url"),
    originalFilename: text("original_filename"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    firstUsedAt: timestamp("first_used_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdByApiKeyId: uuid("created_by_api_key_id"),
    kind: text("kind").notNull().default("image"),
    processingState: text("processing_state").notNull().default("ready"),
    processingStep: text("processing_step"),
    processingError: text("processing_error"),
    processingAttempts: integer("processing_attempts").notNull().default(0),
    processingLeaseUntil: timestamp("processing_lease_until", { withTimezone: true }),
    processingLeaseToken: uuid("processing_lease_token"),
    sourceStorageKey: text("source_storage_key"),
    durationMs: integer("duration_ms"),
    frameRate: doublePrecision("frame_rate"),
    videoCodec: text("video_codec"),
    audioCodec: text("audio_codec"),
    container: text("container"),
    videoBitrate: bigint("video_bitrate", { mode: "number" }),
    audioBitrate: bigint("audio_bitrate", { mode: "number" }),
    audioSampleRate: integer("audio_sample_rate"),
    audioChannels: smallint("audio_channels"),
    indexAtFront: boolean("index_at_front"),
    factsVersion: smallint("facts_version").notNull().default(2),
    factsAttempts: smallint("facts_attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    foreignKey({
      name: "media_assets_api_key_fk",
      columns: [t.projectId, t.createdByApiKeyId],
      foreignColumns: [apiKeys.projectId, apiKeys.id],
    }),
    check("media_assets_width_pos", sql`${t.width} > 0`),
    check("media_assets_height_pos", sql`${t.height} > 0`),
    check("media_assets_byte_size_pos", sql`${t.byteSize} > 0`),
    unique("media_assets_storage_key_uq").on(t.projectId, t.storageKey),
    index("media_assets_first_used_idx").on(t.projectId, t.firstUsedAt),
    check("media_assets_tags_max", sql`cardinality(${t.tags}) <= 20`),
    index("media_assets_tags_gin").using("gin", t.tags),
    check("media_assets_kind_valid", sql`${t.kind} IN ('image','video')`),
    check("media_assets_state_valid", sql`${t.processingState} IN ('processing','ready','failed')`),
    check("media_assets_step_valid", sql`${t.processingStep} IN ('queued','probing','poster')`),
    check("media_assets_container_valid", sql`${t.container} IN ('mp4','mov')`),
    check(
      "media_assets_video_ready_facts",
      sql`${t.kind} <> 'video' OR ${t.processingState} <> 'ready' OR (${t.durationMs} IS NOT NULL AND ${t.videoCodec} IS NOT NULL AND ${t.container} IS NOT NULL AND ${t.width} IS NOT NULL AND ${t.height} IS NOT NULL)`,
    ),
    check("media_assets_facts_version_valid", sql`${t.factsVersion} IN (1, 2)`),
    check("media_assets_video_bitrate_pos", sql`${t.videoBitrate} IS NULL OR ${t.videoBitrate} > 0`),
    check("media_assets_audio_bitrate_pos", sql`${t.audioBitrate} IS NULL OR ${t.audioBitrate} > 0`),
    check("media_assets_audio_sample_rate_pos", sql`${t.audioSampleRate} IS NULL OR ${t.audioSampleRate} > 0`),
    check("media_assets_audio_channels_pos", sql`${t.audioChannels} IS NULL OR ${t.audioChannels} > 0`),
    check("media_assets_step_matches_state", sql`(${t.processingState} = 'processing') = (${t.processingStep} IS NOT NULL)`),
    check("media_assets_error_matches_state", sql`(${t.processingState} = 'failed') = (${t.processingError} IS NOT NULL)`),
    index("media_assets_processing_idx")
      .on(t.createdAt)
      .where(sql`${t.processingState} = 'processing' AND ${t.deletedAt} IS NULL`),
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

/** One incomplete or finished upload session: a multipart upload into staging. */
export const mediaUploads = pgTable(
  "media_uploads",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    kind: text("kind").notNull(),
    declaredType: text("declared_type").notNull(),
    declaredBytes: bigint("declared_bytes", { mode: "number" }).notNull(),
    partSize: integer("part_size").notNull(),
    partCount: integer("part_count").notNull(),
    transport: text("transport").notNull(),
    storageKey: text("storage_key").notNull(),
    storageUploadId: text("storage_upload_id"),
    state: text("state").notNull().default("open"),
    mediaAssetId: uuid("media_asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    check("media_uploads_kind_valid", sql`${t.kind} IN ('image','video')`),
    check("media_uploads_transport_valid", sql`${t.transport} IN ('direct','via_app')`),
    check(
      "media_uploads_state_valid",
      sql`${t.state} IN ('open','completing','completed','refused','cancelled','expired')`,
    ),
    check("media_uploads_declared_bytes_pos", sql`${t.declaredBytes} > 0`),
    check("media_uploads_part_size_min", sql`${t.partSize} >= 5242880`),
    check("media_uploads_part_count_range", sql`${t.partCount} BETWEEN 1 AND 10000`),
    unique("media_uploads_storage_key_uq").on(t.projectId, t.storageKey),
    index("media_uploads_member_open_idx")
      .on(t.projectId, t.createdByUserId)
      .where(sql`${t.state} IN ('open','completing')`),
    index("media_uploads_expiry_idx")
      .on(t.createdAt)
      .where(sql`${t.state} IN ('open','completing')`),
  ],
);

export type MediaUploadRow = typeof mediaUploads.$inferSelect;

/** One adapted video file or preview, shared by every target whose plan gives the same key. */
export const videoVersions = pgTable(
  "video_versions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    mediaAssetId: uuid("media_asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    recipe: jsonb("recipe").notNull(),
    steps: text("steps").array().notNull(),
    state: text("state").notNull().default("queued"),
    attempts: smallint("attempts").notNull().default(0),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    error: text("error"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    storageKey: text("storage_key"),
    publicUrl: text("public_url"),
    container: text("container"),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    frameRate: doublePrecision("frame_rate"),
    videoCodec: text("video_codec"),
    audioCodec: text("audio_codec"),
    videoBitrate: bigint("video_bitrate", { mode: "number" }),
    byteSize: bigint("byte_size", { mode: "number" }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    unique("video_versions_asset_kind_key_uq").on(t.mediaAssetId, t.kind, t.key),
    unique("video_versions_storage_key_uq").on(t.projectId, t.storageKey),
    check("video_versions_kind_valid", sql`${t.kind} IN ('full','preview')`),
    check("video_versions_state_valid", sql`${t.state} IN ('queued','building','ready','failed')`),
    check("video_versions_container_valid", sql`${t.container} IN ('mp4','mov')`),
    check("video_versions_lease_pair", sql`(${t.leaseUntil} IS NULL) = (${t.leaseToken} IS NULL)`),
    check("video_versions_error_matches_state", sql`(${t.state} = 'failed') = (${t.error} IS NOT NULL)`),
    check(
      "video_versions_ready_facts",
      sql`${t.state} <> 'ready' OR (${t.storageKey} IS NOT NULL AND ${t.publicUrl} IS NOT NULL AND ${t.container} IS NOT NULL AND ${t.width} IS NOT NULL AND ${t.height} IS NOT NULL AND ${t.durationMs} IS NOT NULL AND ${t.frameRate} IS NOT NULL AND ${t.videoCodec} IS NOT NULL AND ${t.videoBitrate} IS NOT NULL AND ${t.byteSize} IS NOT NULL)`,
    ),
    index("video_versions_claim_idx")
      .on(t.dueAt, t.createdAt)
      .where(sql`${t.state} IN ('queued','building')`),
    index("video_versions_project_asset_idx").on(t.projectId, t.mediaAssetId),
    index("video_versions_collect_idx")
      .on(t.checkedAt)
      .where(sql`${t.state} <> 'building'`),
  ],
);

export type VideoVersionRow = typeof videoVersions.$inferSelect;
