import { randomUUID } from "node:crypto";
import { z } from "zod";
import { registerAssetSchema } from "@/lib/validation/scheduling";
import { tagsSchema } from "@/lib/validation/media";
import { ConflictError, ForbiddenError, NotFoundError } from "../dal/errors";
import type { MediaRepo, MediaRow } from "../dal/media";
import { actorColumns, type ProjectScope } from "../dal/scope";
import { durationLabel } from "@/components/media/upload/upload-ui";
import { UPLOAD_MIME_TYPES } from "@/lib/media/types";
import { getEnv } from "../env";
import { libraryLimits, type LibraryLimits } from "../media/limits";
import { processUpload, type UploadRejection } from "../media/process";
import { getStorage, mediaKeys, requireStorage } from "../storage";
import { fitOf, fitPlatforms, type PlatformFit } from "./media-fit";
/** Registration only; storage is entry 3. */
export async function registerAsset(scope: ProjectScope, input: unknown): Promise<MediaRow> {
  const parsed = registerAssetSchema.parse(input);
  if (!scope.can({ media: ["edit"] })) throw new ForbiddenError();
  return scope.transaction(async (tx) => {
    if (!tx.can({ media: ["edit"] })) throw new ForbiddenError();
    return tx.media.insert({
      storageKey: parsed.storageKey,
      publicUrl: parsed.publicUrl,
      mimeType: parsed.mimeType,
      byteSize: parsed.byteSize,
      width: parsed.width ?? null,
      height: parsed.height ?? null,
      ...(parsed.altText !== undefined ? { altText: parsed.altText } : {}),
      ...actorColumns(tx),
    });
  });
}

export async function updateAltText(scope: ProjectScope, assetId: string, altText: string): Promise<void> {
  const id = z.uuid().parse(assetId);
  const alt = z.string().max(2000).parse(altText);
  if (!scope.can({ media: ["edit"] })) throw new ForbiddenError();
  await scope.transaction(async (tx) => {
    if (!tx.can({ media: ["edit"] })) throw new ForbiddenError();
    if (!(await tx.media.get(id))) throw new NotFoundError();
    await tx.media.updateAlt(id, alt);
  });
}

export const MEDIA_PAGE_SIZE = 24;
/** The image types an upload may have; anything a provider does not accept is converted by the media planner. */
export { UPLOAD_MIME_TYPES };
const PREVIEW_SECONDS = 3600;
/** A target in one of these states means the post is, or was meant to be, live: its images stay. */
type PostTargetStatus = Awaited<ReturnType<MediaRepo["postsUsing"]>>[number]["targetStatuses"][number];
const BLOCKING: readonly PostTargetStatus[] = ["scheduled", "publishing", "failed", "ambiguous"];
const REMOVABLE: readonly PostTargetStatus[] = ["draft", "cancelled"];

export interface MediaView {
  id: string;
  thumbnailUrl: string;
  publicUrl: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  byteSize: number;
  altText: string;
  missingAlt: boolean;
  tags: string[];
  inUse: boolean;
  /** The job holding this image in a queued, running or failed item, if any. */
  reservedByJobId: string | null;
  originalFilename: string | null;
  createdAt: Date;
  kind: "image" | "video";
  status: "processing" | "ready" | "failed";
  processingStep: "queued" | "probing" | "poster" | null;
  processingError: string | null;
  /** Set once a video is ready. `labels` are person-facing, so no component formats a fact itself. */
  video: null | {
    durationSeconds: number;
    frameRate: number | null;
    videoCodec: string;
    audioCodec: string | null;
    container: "mp4" | "mov";
    labels: { duration: string; frameRate: string | null; videoCodec: string; audioCodec: string; container: string };
  };
  /** Set by `listMedia` when asked for a `fit`: one entry per platform of the result's `platforms`. */
  fit?: PlatformFit[];
}
export interface PostRef {
  postId: string;
  excerpt: string;
  status: PostTargetStatus | "mixed";
}
export interface MediaStatus {
  enabled: boolean;
  maxUploadBytes: number;
  maxMegapixels: number;
  acceptedTypes: readonly string[];
  limits: LibraryLimits;
  transport: "direct" | "via_app";
}

function need(scope: Pick<ProjectScope, "can">, permission: "view" | "edit") {
  if (!scope.can({ media: [permission] })) throw new ForbiddenError();
}

export async function mediaStatus(scope: ProjectScope): Promise<MediaStatus> {
  need(scope, "view");
  const env = getEnv();
  const limits = libraryLimits(env);
  return {
    enabled: getStorage() !== null,
    maxUploadBytes: limits.image.maxBytes,
    maxMegapixels: limits.image.maxMegapixels,
    acceptedTypes: [...limits.image.types, ...limits.video.types],
    limits,
    transport: env.media.uploadTransport,
  };
}

export async function toView(
  row: MediaRow,
  inUse = row.firstUsedAt !== null,
  reservedByJobId: string | null = null,
): Promise<MediaView> {
  const storage = getStorage();
  const signed = storage && getEnv().storage?.previewUrls === "signed";
  const sign = async (key: string, fallback: string) => (signed ? storage.signedUrl(key, PREVIEW_SECONDS) : fallback);
  const publicUrl = await sign(row.storageKey, row.publicUrl);
  const thumbnailUrl =
    row.thumbnailStorageKey && row.thumbnailUrl ? await sign(row.thumbnailStorageKey, row.thumbnailUrl) : publicUrl;
  const ready = row.kind === "video" && row.processingState === "ready";
  return {
    id: row.id,
    thumbnailUrl: row.kind === "video" && !ready ? VIDEO_PLACEHOLDER : thumbnailUrl,
    publicUrl,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    byteSize: row.byteSize,
    altText: row.altText,
    missingAlt: row.altText.trim() === "",
    tags: row.tags,
    inUse,
    reservedByJobId,
    originalFilename: row.originalFilename,
    createdAt: row.createdAt,
    kind: row.kind as MediaView["kind"],
    status: row.processingState as MediaView["status"],
    processingStep: row.processingStep as MediaView["processingStep"],
    processingError: row.processingError,
    video: ready ? videoFacts(row) : null,
  };
}

/** Shown in place of a poster until a video is ready, and for a video that failed (P26). */
export const VIDEO_PLACEHOLDER = "/media/video-processing.svg";

const VIDEO_CODEC_LABEL: Record<string, string> = { h264: "H.264", hevc: "HEVC", vp9: "VP9", av1: "AV1", mpeg4: "MPEG-4" };
const AUDIO_CODEC_LABEL: Record<string, string> = { aac: "AAC", mp3: "MP3", opus: "Opus", ac3: "AC-3", vorbis: "Vorbis" };

function videoFacts(row: MediaRow): NonNullable<MediaView["video"]> {
  const container = row.container === "mov" ? "mov" : "mp4";
  const seconds = (row.durationMs ?? 0) / 1000;
  const codec = row.videoCodec ?? "";
  return {
    durationSeconds: seconds,
    frameRate: row.frameRate,
    videoCodec: codec,
    audioCodec: row.audioCodec,
    container,
    labels: {
      duration: durationLabel(Math.round(seconds)),
      frameRate: row.frameRate === null ? null : `${Number(row.frameRate.toFixed(2))} fps`,
      videoCodec: VIDEO_CODEC_LABEL[codec] ?? codec.toUpperCase(),
      audioCodec: row.audioCodec ? (AUDIO_CODEC_LABEL[row.audioCodec] ?? row.audioCodec.toUpperCase()) : "No audio",
      container: container === "mov" ? "MOV" : "MP4",
    },
  };
}

export type UploadResult = { ok: true; asset: MediaView } | ({ ok: false } & UploadRejection);

export interface PreparedUpload {
  id: string;
  originalKey: string;
  thumbKey: string;
  original: { ext: string; body: Buffer; mimeType: string; bytes: number; width: number; height: number };
  filename: string | null;
}

export const VIDEO_UPLOAD_REFUSAL = "Video upload is available in the Docket app.";

/** ISO base media (MP4/MOV) and WebM/Matroska signatures. */
function looksLikeVideo(b: Buffer): boolean {
  if (b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp") return true;
  return b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
}

/** Processes the image and writes both objects to storage. Touches no table, so a retry is safe. */
export async function prepareUpload(
  scope: ProjectScope,
  file: { name: string; bytes: Buffer },
): Promise<PreparedUpload | ({ ok: false } & UploadRejection)> {
  need(scope, "edit");
  const storage = requireStorage();
  const { maxUploadBytes, maxPixels } = getEnv().media;
  if (looksLikeVideo(file.bytes)) {
    return { ok: false, code: "unsupported_type", message: VIDEO_UPLOAD_REFUSAL };
  }
  const out = await processUpload(file.bytes, { maxBytes: maxUploadBytes, maxPixels });
  if (!out.ok) return out;
  const id = randomUUID();
  const keys = mediaKeys(scope.project.id, id);
  const originalKey = keys.original(out.original.ext);
  const thumbKey = keys.thumbnail;
  await storage.put(originalKey, out.original.body, out.original.mimeType);
  try {
    await storage.put(thumbKey, out.thumbnail.body, "image/webp");
  } catch (err) {
    await storage.delete(originalKey).catch(() => undefined);
    throw err;
  }
  const filename = file.name.split(/[\\/]/).pop()?.trim().slice(0, 255) || null;
  return { id, originalKey, thumbKey, original: out.original, filename };
}

/** Removes the objects of an upload whose row was never written. */
export async function discardPreparedUpload(prepared: PreparedUpload): Promise<void> {
  const storage = getStorage();
  if (!storage) return;
  await Promise.all(
    [prepared.originalKey, prepared.thumbKey].map((key) =>
      storage.delete(key).catch(() => console.error(`media: orphaned object after failed insert: ${key}`)),
    ),
  );
}

/** Writes the row for a prepared upload. Runs inside the caller's transaction. */
export async function commitUpload(
  tx: ProjectScope,
  prepared: PreparedUpload,
  meta: { altText?: string; tags?: string[] } = {},
): Promise<MediaView> {
  need(tx, "edit");
  const storage = requireStorage();
  const row = await tx.media.insert({
    id: prepared.id,
    storageKey: prepared.originalKey,
    publicUrl: storage.publicUrl(prepared.originalKey),
    thumbnailStorageKey: prepared.thumbKey,
    thumbnailUrl: storage.publicUrl(prepared.thumbKey),
    mimeType: prepared.original.mimeType,
    byteSize: prepared.original.bytes,
    width: prepared.original.width,
    height: prepared.original.height,
    originalFilename: prepared.filename,
    ...(meta.altText !== undefined ? { altText: meta.altText } : {}),
    ...(meta.tags !== undefined ? { tags: meta.tags } : {}),
    ...actorColumns(tx),
  });
  return toView(row);
}

/** Rejections are returned, not thrown, so a batch can report per file. */
export async function uploadMedia(
  scope: ProjectScope,
  input: { file: { name: string; bytes: Buffer } },
): Promise<UploadResult> {
  const prepared = await prepareUpload(scope, input.file);
  if (!("id" in prepared)) return prepared;
  try {
    return { ok: true, asset: await scope.transaction((tx) => commitUpload(tx, prepared)) };
  } catch (err) {
    await discardPreparedUpload(prepared);
    throw err;
  }
}

const listSchema = z.object({
  tag: z.string().optional(),
  unused: z.boolean().optional(),
  missingAlt: z.boolean().optional(),
  q: z.string().max(100).optional(),
  /** The composer's picker passes `["processing", "ready"]`; the library stays unfiltered. */
  states: z.array(z.enum(["processing", "ready", "failed"])).min(1).optional(),
  page: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(101).optional(),
  offset: z.number().int().min(0).optional(),
  fit: z.union([z.object({ accountIds: z.array(z.uuid()).max(50) }), z.object({ active: z.literal(true) })]).optional(),
});

export async function listMedia(scope: ProjectScope, filter: unknown = {}) {
  need(scope, "view");
  const f = listSchema.parse(filter);
  const page = f.page ?? 1;
  const [{ rows, total }, tags] = await Promise.all([
    scope.media.list({
      ...(f.tag ? { tag: f.tag } : {}),
      ...(f.unused ? { unused: true } : {}),
      ...(f.missingAlt ? { missingAlt: true } : {}),
      ...(f.q ? { q: f.q } : {}),
      ...(f.states ? { states: f.states } : {}),
      limit: f.limit ?? MEDIA_PAGE_SIZE,
      offset: f.offset ?? (page - 1) * MEDIA_PAGE_SIZE,
    }),
    scope.media.listTags(),
  ]);
  const providers = f.fit ? await fitPlatforms(scope, f.fit) : [];
  return {
    items: await Promise.all(
      rows.map(async (r) => {
        const view = await toView(r, r.inUse, r.reservedByJobId);
        // A video that is not ready has no facts to judge, so it gets no badges (the card says why).
        return f.fit ? { ...view, fit: r.processingState === "ready" ? providers.map((p) => fitOf(r, p)) : [] } : view;
      }),
    ),
    platforms: providers.map((p) => ({ key: p.key, name: p.displayName })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / MEDIA_PAGE_SIZE)),
    tags,
  };
}

const excerptOf = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text);

async function refsFor(tx: Pick<ProjectScope, "media" | "posts">, id: string): Promise<(PostRef & { all: PostTargetStatus[] })[]> {
  const used = await tx.media.postsUsing(id);
  const out: (PostRef & { all: PostTargetStatus[] })[] = [];
  for (const u of used) {
    const post = await tx.posts.get(u.postId);
    if (!post) continue;
    const distinct = [...new Set(u.targetStatuses)];
    out.push({
      postId: u.postId,
      excerpt: excerptOf(post.baseText),
      status: distinct.length === 1 ? distinct[0]! : "mixed",
      all: u.targetStatuses,
    });
  }
  return out;
}

export async function getMedia(scope: ProjectScope, assetId: string) {
  const id = z.uuid().parse(assetId);
  need(scope, "view");
  const row = await scope.media.get(id);
  if (!row) throw new NotFoundError();
  const usedBy = (await refsFor(scope, id)).map(({ postId, excerpt, status }) => ({ postId, excerpt, status }));
  const reservedByJobId = await scope.media.reservedJobFor(id);
  return { ...(await toView(row, row.firstUsedAt !== null || usedBy.length > 0, reservedByJobId)), usedBy };
}

const updateSchema = z.object({ altText: z.string().max(2000).optional(), tags: tagsSchema.optional() });

export async function updateMedia(scope: ProjectScope, assetId: string, patch: unknown): Promise<MediaView> {
  const id = z.uuid().parse(assetId);
  const parsed = updateSchema.parse(patch);
  need(scope, "edit");
  const row = await scope.transaction(async (tx) => {
    need(tx, "edit");
    const updated = await tx.media.update(id, {
      ...(parsed.altText !== undefined ? { altText: parsed.altText } : {}),
      ...(parsed.tags !== undefined ? { tags: parsed.tags } : {}),
    });
    if (!updated) throw new NotFoundError();
    return updated;
  });
  return toView(row);
}

const toRef = ({ postId, excerpt, status }: PostRef): PostRef => ({ postId, excerpt, status });

export async function deleteMediaImpact(scope: ProjectScope, assetId: string) {
  const id = z.uuid().parse(assetId);
  need(scope, "view");
  if (!(await scope.media.get(id))) throw new NotFoundError();
  const refs = await refsFor(scope, id);
  return {
    blocked: refs.filter((r) => r.all.some((s) => BLOCKING.includes(s))).map(toRef),
    affected: refs.filter((r) => !r.all.some((s) => BLOCKING.includes(s))).map(toRef),
  };
}

/** Lock order (research D10): posts by id → their targets → the asset. */
export async function deleteMedia(scope: ProjectScope, assetId: string): Promise<{ affected: PostRef[] }> {
  const id = z.uuid().parse(assetId);
  need(scope, "edit");
  const doomed: string[] = [];
  const result = await scope.transaction(async (tx) => {
    need(tx, "edit");
    const first = await tx.media.postsUsing(id);
    const postIds = first.map((u) => u.postId).sort();
    for (const postId of postIds) {
      await tx.posts.lockForUpdate(postId);
      await tx.targets.lockForPost(postId);
    }
    const asset = await tx.media.lockForUpdate(id);
    if (!asset) throw new NotFoundError();
    if (asset.deletedAt) return { affected: [] as PostRef[] };
    const refs = await refsFor(tx, id);
    if (refs.some((r) => !postIds.includes(r.postId))) {
      throw new ConflictError("This image was just added to a post. Try again.");
    }
    const blocked = refs.filter((r) => r.all.some((s) => BLOCKING.includes(s)));
    if (blocked.length > 0) {
      throw new ConflictError(
        `This image is used by ${blocked.length} ${blocked.length === 1 ? "post that is" : "posts that are"} scheduled, publishing or needing attention.`,
      );
    }
    const drafts = refs.filter((r) => r.all.every((s) => REMOVABLE.includes(s))).map((r) => r.postId);
    await tx.media.detachFromPosts(id, drafts);
    await tx.media.softDelete(id, new Date());
    const variants = await tx.media.deleteVariants(id);
    const videoKeys = await tx.videoVersions.deleteForAsset(id);
    doomed.push(asset.storageKey, ...(asset.sourceStorageKey ? [asset.sourceStorageKey] : []), ...(asset.thumbnailStorageKey ? [asset.thumbnailStorageKey] : []), ...variants.map((v) => v.storageKey), ...videoKeys);
    return { affected: refs.map(toRef) };
  });
  const storage = getStorage();
  if (storage) {
    await Promise.all(
      doomed.map((key) => storage.delete(key).catch(() => console.error(`media: could not delete object ${key}`))),
    );
  }
  return result;
}
