import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ForbiddenError, NotFoundError } from "../dal/errors";
import type { UploadRow } from "../dal/uploads";
import { actorColumns, type ProjectScope } from "../dal/scope";
import { getEnv } from "../env";
import { libraryLimits } from "../media/limits";
import { getStorage, mediaKeys, requireStorage, uploadStagingKey } from "../storage";
import type { Storage } from "../storage";
import { discardPreparedUpload, prepareUpload, commitUpload, toView, type MediaView } from "./media";

const MIB = 1_048_576;
const MIN_PART_BYTES = 8 * MIB;
const MAX_PARTS = 10_000;
const SIGN_BATCH = 20;
const DIRECT_URL_SECONDS = 3600;
const WAITING_FOR_WORKER_MS = 30_000;
const MAX_FILENAME = 255;

/** Part size is fixed per upload; every part but the last has exactly this many bytes (R2 needs equal parts). */
export function partSizeFor(bytes: number): number {
  return Math.max(MIN_PART_BYTES, Math.ceil(Math.ceil(bytes / MAX_PARTS) / MIB) * MIB);
}

/** Expected byte length of part `n` (1-based) of a session. */
export function expectedPartBytes(upload: Pick<UploadRow, "declaredBytes" | "partSize" | "partCount">, n: number): number {
  return n < upload.partCount ? upload.partSize : upload.declaredBytes - (upload.partCount - 1) * upload.partSize;
}

export type UploadRefusalCode =
  | "unsupported_type"
  | "too_large"
  | "size_mismatch"
  | "animated"
  | "too_many_pixels"
  | "unreadable";

export type Refusal<C extends string> = { ok: false; code: C; message: string };
const refuse = <C extends string>(code: C, message: string): Refusal<C> => ({ ok: false, code, message });
const FINISHED = refuse("upload_finished" as const, "This upload has already finished.");
const PARTS_MISSING = "Some parts did not arrive. Retry to send them.";

function need(scope: Pick<ProjectScope, "can">) {
  if (!scope.can({ media: ["edit"] })) throw new ForbiddenError();
}

const createSchema = z.object({
  filename: z.string().max(1000),
  kind: z.enum(["image", "video"]),
  declaredType: z.string().max(100),
  bytes: z.number().int().min(1),
});

export type CreateUploadResult =
  | { ok: true; upload: { id: string; partSize: number; partCount: number; transport: "direct" | "via_app" } }
  | Refusal<"unsupported_type" | "too_large" | "too_many_open" | "storage_unavailable">;

export async function createUpload(scope: ProjectScope, input: unknown): Promise<CreateUploadResult> {
  const parsed = createSchema.parse(input);
  need(scope);
  const storage = getStorage();
  if (!storage) return refuse("storage_unavailable", "Media storage is not set up");
  const env = getEnv();
  const limits = libraryLimits(env)[parsed.kind];
  if (!limits.types.includes(parsed.declaredType)) {
    return refuse("unsupported_type", "This is not a JPEG, PNG or WebP image, or an MP4 or MOV video.");
  }
  if (parsed.bytes > limits.maxBytes) {
    return refuse("too_large", `The file is larger than ${Math.floor(limits.maxBytes / MIB)} MB.`);
  }
  const userId = scope.membership.userId;
  const id = randomUUID();
  const partSize = partSizeFor(parsed.bytes);
  const partCount = Math.ceil(parsed.bytes / partSize);
  const transport = env.media.uploadTransport;
  const filename = parsed.filename.split(/[\\/]/).pop()?.trim().slice(0, MAX_FILENAME) || "upload";
  const stagingKey = uploadStagingKey(scope.project.id, id);
  const capped = await scope.transaction(async (tx) => {
    await tx.members.lockSelf(userId);
    const open = await tx.uploads.countOpenFor(userId);
    if (open >= env.media.maxOpenUploads) return false;
    await tx.uploads.insert({
      id,
      createdByUserId: userId,
      filename,
      kind: parsed.kind,
      declaredType: parsed.declaredType,
      declaredBytes: parsed.bytes,
      partSize,
      partCount,
      transport,
      storageKey: stagingKey,
    });
    return true;
  });
  if (!capped) {
    return refuse("too_many_open", `You have ${env.media.maxOpenUploads} uploads in progress. Wait for some to finish.`);
  }
  try {
    const { uploadId } = await storage.createMultipart(stagingKey, parsed.declaredType);
    await scope.uploads.transition(id, ["open"], "open", { storageUploadId: uploadId });
  } catch {
    await scope.uploads.transition(id, ["open"], "cancelled", { error: "Storage refused the upload." });
    return refuse("storage_unavailable", "Storage refused the upload. Try again.");
  }
  return { ok: true, upload: { id, partSize, partCount, transport } };
}

async function owned(scope: ProjectScope, uploadId: string): Promise<UploadRow> {
  need(scope);
  const row = await scope.uploads.getOwned(z.uuid().parse(uploadId), scope.membership.userId);
  if (!row) throw new NotFoundError();
  return row;
}

const signSchema = z.object({
  uploadId: z.uuid(),
  partNumbers: z.array(z.number().int().min(1).max(MAX_PARTS)).min(1).max(SIGN_BATCH),
});

export async function signUploadParts(scope: ProjectScope, input: unknown) {
  const { uploadId, partNumbers } = signSchema.parse(input);
  const row = await owned(scope, uploadId);
  if (row.state !== "open" || !row.storageUploadId) return FINISHED;
  const unique = new Set(partNumbers);
  if (unique.size !== partNumbers.length || partNumbers.some((n) => n > row.partCount)) {
    return refuse("bad_parts" as const, "Those parts are not part of this upload.");
  }
  const storage = requireStorage();
  const expiresAt =
    row.transport === "via_app"
      ? new Date(row.createdAt.getTime() + getEnv().media.uploadExpiryHours * 3_600_000)
      : new Date(Date.now() + DIRECT_URL_SECONDS * 1000);
  const parts = await Promise.all(
    partNumbers.map(async (partNumber) => ({
      partNumber,
      url:
        row.transport === "via_app"
          ? `/p/${scope.project.slug}/media/uploads/${row.id}/parts/${partNumber}`
          : await storage.signPart(row.storageKey, row.storageUploadId!, partNumber, DIRECT_URL_SECONDS),
      expiresAt: expiresAt.toISOString(),
    })),
  );
  return { ok: true as const, parts };
}

/** Parts the bucket holds whose size is right for their number; a wrong-size part counts as missing. */
function goodParts(row: UploadRow, listed: { partNumber: number; etag: string; bytes: number }[]) {
  return listed.filter(
    (p) => p.partNumber >= 1 && p.partNumber <= row.partCount && p.bytes === expectedPartBytes(row, p.partNumber),
  );
}

export async function listUploadedParts(scope: ProjectScope, input: unknown) {
  const { uploadId } = z.object({ uploadId: z.uuid() }).parse(input);
  const row = await owned(scope, uploadId);
  if ((row.state !== "open" && row.state !== "completing") || !row.storageUploadId) return FINISHED;
  const listed = (await requireStorage().listParts(row.storageKey, row.storageUploadId)) ?? [];
  const parts = goodParts(row, listed).map(({ partNumber, bytes }) => ({ partNumber, bytes }));
  return { ok: true as const, parts, confirmedBytes: parts.reduce((n, p) => n + p.bytes, 0) };
}

/** Ends a session as refused and removes what it left in storage. */
async function refuseSession(scope: ProjectScope, row: UploadRow, rejection: Refusal<UploadRefusalCode>) {
  await scope.uploads.transition(row.id, ["open", "completing"], "refused", { error: rejection.message });
  await cleanUp(requireStorage(), row);
  return rejection;
}

async function cleanUp(storage: Storage, row: UploadRow) {
  if (row.storageUploadId) await storage.abortMultipart(row.storageKey, row.storageUploadId).catch(() => undefined);
  await storage.delete(row.storageKey).catch(() => console.error(`media: could not delete staging object ${row.storageKey}`));
}

async function assetOf(scope: ProjectScope, id: string | null): Promise<MediaView | null> {
  const asset = id ? await scope.media.get(id) : null;
  return asset ? toView(asset) : null;
}

export type CompleteUploadResult =
  | { ok: true; asset: MediaView }
  | Refusal<"parts_missing" | "upload_finished" | UploadRefusalCode>;

export async function completeUpload(scope: ProjectScope, input: unknown): Promise<CompleteUploadResult> {
  const { uploadId } = z.object({ uploadId: z.uuid() }).parse(input);
  need(scope);
  const userId = scope.membership.userId;
  const storage = requireStorage();
  // Claim: open → completing under the row lock (a `completing` session is a retry after a lost response).
  const claimed = await scope.transaction(async (tx) => {
    const row = await tx.uploads.lockOwned(uploadId, userId);
    if (!row) throw new NotFoundError();
    if (row.state === "completed") return { done: await assetOf(tx, row.mediaAssetId) };
    if (row.state === "open") await tx.uploads.transition(row.id, ["open"], "completing");
    else if (row.state !== "completing") return { done: null };
    return { row };
  });
  if (!claimed.row) return claimed.done ? { ok: true, asset: claimed.done } : FINISHED;
  const row = claimed.row;
  if (!row.storageUploadId) return FINISHED;

  const backToOpen = async (message: string) => {
    await scope.uploads.transition(row.id, ["completing"], "open", { error: message });
    return refuse("parts_missing" as const, PARTS_MISSING);
  };

  try {
    const listed = await storage.listParts(row.storageKey, row.storageUploadId);
    if (listed === null) {
      // A previous attempt already completed the multipart upload; check what it produced.
      const head = await storage.head(row.storageKey);
      if (!head) return await refuseSession(scope, row, refuse("size_mismatch", SIZE_MISMATCH));
      if (head.bytes !== row.declaredBytes) return await refuseSession(scope, row, refuse("size_mismatch", SIZE_MISMATCH));
    } else {
      if (listed.some((p) => p.partNumber > row.partCount)) {
        return await refuseSession(scope, row, refuse("size_mismatch", SIZE_MISMATCH));
      }
      const good = goodParts(row, listed);
      if (good.length !== row.partCount) return await backToOpen(PARTS_MISSING);
      await storage.completeMultipart(
        row.storageKey,
        row.storageUploadId,
        good.map(({ partNumber, etag }) => ({ partNumber, etag })),
      );
      const head = await storage.head(row.storageKey);
      if (!head || head.bytes !== row.declaredBytes) {
        return await refuseSession(scope, row, refuse("size_mismatch", SIZE_MISMATCH));
      }
    }
  } catch (err) {
    await scope.uploads.transition(row.id, ["completing"], "open", { error: "Storage refused the upload." });
    throw err;
  }

  return row.kind === "image" ? finishImage(scope, storage, row) : finishVideo(scope, storage, row);
}

const SIZE_MISMATCH = "The file that arrived is not the size that was sent. Upload it again.";

/** Images are processed in the web process, as before (P7). */
async function finishImage(scope: ProjectScope, storage: Storage, row: UploadRow): Promise<CompleteUploadResult> {
  const body = await storage.get(row.storageKey);
  if (!body) return refuseSession(scope, row, refuse("unreadable", "That file could not be read as an image."));
  const prepared = await prepareUpload(scope, { name: row.filename, bytes: body });
  if (!("id" in prepared)) return refuseSession(scope, row, refuse(prepared.code, prepared.message));
  try {
    const result = await scope.transaction(async (tx) => {
      const locked = await tx.uploads.lockOwned(row.id, row.createdByUserId);
      if (locked?.state === "completed") return { lost: await assetOf(tx, locked.mediaAssetId) };
      if (locked?.state !== "completing") return { lost: null };
      const asset = await commitUpload(tx, prepared);
      await tx.uploads.transition(row.id, ["completing"], "completed", { mediaAssetId: asset.id });
      return { asset };
    });
    if (!result.asset) {
      await discardPreparedUpload(prepared);
      return result.lost ? { ok: true, asset: result.lost } : FINISHED;
    }
    await storage.delete(row.storageKey).catch(() => console.error(`media: could not delete staging object ${row.storageKey}`));
    return { ok: true, asset: result.asset };
  } catch (err) {
    await discardPreparedUpload(prepared);
    await scope.uploads.transition(row.id, ["completing"], "open", { error: "Something went wrong. Try again." });
    throw err;
  }
}

/** Videos get a `processing/queued` row; the worker does the rest (entry 018 US2). */
async function finishVideo(scope: ProjectScope, storage: Storage, row: UploadRow): Promise<CompleteUploadResult> {
  const assetId = randomUUID();
  const container = row.declaredType === "video/quicktime" ? "mov" : "mp4";
  const finalKey = mediaKeys(scope.project.id, assetId).video(container);
  const result = await scope.transaction(async (tx) => {
    const locked = await tx.uploads.lockOwned(row.id, row.createdByUserId);
    if (locked?.state === "completed") return { asset: await assetOf(tx, locked.mediaAssetId) };
    if (locked?.state !== "completing") return { asset: null };
    const inserted = await tx.media.insert({
      id: assetId,
      kind: "video",
      processingState: "processing",
      processingStep: "queued",
      storageKey: finalKey,
      publicUrl: storage.publicUrl(finalKey),
      sourceStorageKey: row.storageKey,
      mimeType: row.declaredType,
      byteSize: row.declaredBytes,
      originalFilename: row.filename,
      ...actorColumns(tx),
    });
    await tx.uploads.transition(row.id, ["completing"], "completed", { mediaAssetId: inserted.id });
    return { asset: await toView(inserted) };
  });
  return result.asset ? { ok: true, asset: result.asset } : FINISHED;
}

export async function cancelUpload(scope: ProjectScope, input: unknown): Promise<{ ok: true } | typeof FINISHED> {
  const { uploadId } = z.object({ uploadId: z.uuid() }).parse(input);
  const row = await owned(scope, uploadId);
  if (row.state === "cancelled" || row.state === "expired") return { ok: true };
  if (row.state !== "open" && row.state !== "completing") return FINISHED;
  if (await scope.uploads.transition(row.id, ["open", "completing"], "cancelled")) {
    await cleanUp(requireStorage(), row);
  }
  return { ok: true };
}

export async function processingStatus(scope: ProjectScope, input: unknown) {
  const { ids } = z.object({ ids: z.array(z.uuid()).max(50) }).parse(input);
  if (!scope.can({ media: ["view"] })) throw new ForbiddenError();
  const rows = await scope.media.processingStatus(ids);
  const now = Date.now();
  const items = await Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      status: r.state,
      step: r.step,
      error: r.error,
      waitingForWorker: r.step === "queued" && now - r.createdAt.getTime() > WAITING_FOR_WORKER_MS,
      item: r.state === "ready" ? await assetOf(scope, r.id) : null,
    })),
  );
  return { ok: true as const, items };
}

export type ViaAppResult =
  | { ok: true }
  | { ok: false; status: 400 | 409 | 502; error: string; message?: string };

/** The chunk route's body: the part is forwarded as the same multipart part (P5). */
export async function uploadPartViaApp(
  scope: ProjectScope,
  input: { uploadId: string; partNumber: number; contentLength: number | null; readBody: () => Promise<ArrayBuffer> },
): Promise<ViaAppResult> {
  const row = await owned(scope, input.uploadId);
  if (row.state !== "open" || row.transport !== "via_app" || !row.storageUploadId) {
    return { ok: false, status: 409, error: "upload_finished" };
  }
  const n = input.partNumber;
  if (!Number.isInteger(n) || n < 1 || n > row.partCount) return { ok: false, status: 400, error: "bad_part" };
  const expected = expectedPartBytes(row, n);
  if (input.contentLength !== expected) {
    return { ok: false, status: 400, error: "length_mismatch", message: "The chunk is not the expected size." };
  }
  const body = Buffer.from(await input.readBody());
  if (body.length !== expected) {
    return { ok: false, status: 400, error: "chunk_incomplete", message: "The chunk arrived incomplete." };
  }
  try {
    await requireStorage().uploadPart(row.storageKey, row.storageUploadId, n, body);
  } catch {
    return { ok: false, status: 502, error: "storage_failed", message: "Storage refused the upload." };
  }
  return { ok: true };
}
