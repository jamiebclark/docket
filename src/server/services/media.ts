import { randomUUID } from "node:crypto";
import { z } from "zod";
import { registerAssetSchema } from "@/lib/validation/scheduling";
import { tagsSchema } from "@/lib/validation/media";
import { ConflictError, ForbiddenError, NotFoundError } from "../dal/errors";
import type { MediaRepo, MediaRow } from "../dal/media";
import { actorColumns, type ProjectScope } from "../dal/scope";
import { getEnv } from "../env";
import { processUpload, type UploadRejection } from "../media/process";
import { getStorage, mediaKeys, requireStorage } from "../storage";
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
export const UPLOAD_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
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
}

function need(scope: Pick<ProjectScope, "can">, permission: "view" | "edit") {
  if (!scope.can({ media: [permission] })) throw new ForbiddenError();
}

export async function mediaStatus(scope: ProjectScope): Promise<MediaStatus> {
  need(scope, "view");
  const { maxUploadBytes, maxPixels } = getEnv().media;
  return { enabled: getStorage() !== null, maxUploadBytes, maxMegapixels: maxPixels / 1_000_000, acceptedTypes: UPLOAD_MIME_TYPES };
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
  return {
    id: row.id,
    thumbnailUrl,
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

/** Processes the image and writes both objects to storage. Touches no table, so a retry is safe. */
export async function prepareUpload(
  scope: ProjectScope,
  file: { name: string; bytes: Buffer },
): Promise<PreparedUpload | ({ ok: false } & UploadRejection)> {
  need(scope, "edit");
  const storage = requireStorage();
  const { maxUploadBytes, maxPixels } = getEnv().media;
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
  page: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(101).optional(),
  offset: z.number().int().min(0).optional(),
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
      limit: f.limit ?? MEDIA_PAGE_SIZE,
      offset: f.offset ?? (page - 1) * MEDIA_PAGE_SIZE,
    }),
    scope.media.listTags(),
  ]);
  return {
    items: await Promise.all(rows.map((r) => toView(r, r.inUse, r.reservedByJobId))),
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
    doomed.push(asset.storageKey, ...(asset.thumbnailStorageKey ? [asset.thumbnailStorageKey] : []), ...variants.map((v) => v.storageKey));
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
