export interface StoredObject {
  key: string;
  contentType: string;
  bytes: number;
}

export interface Storage {
  /** Stores bytes under `key`. Always sends ContentType and CacheControl; never ACL. */
  put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
  /** `${S3_PUBLIC_BASE_URL}/${encodeKey(key)}`. Pure, no network. */
  publicUrl(key: string): string;
  /** Presigned GET. Throws RangeError unless 1 ≤ seconds ≤ 604800. */
  signedUrl(key: string, expiresInSeconds: number): Promise<string>;
  /** Bytes of the object, or null when it does not exist (404 / NoSuchKey). */
  get(key: string): Promise<Buffer | null>;
  /** HeadObject; false on 404 / NotFound. */
  exists(key: string): Promise<boolean>;
  /** CreateMultipartUpload with ContentType and CacheControl, no ACL. */
  createMultipart(key: string, contentType: string): Promise<{ uploadId: string }>;
  /** Presigned UploadPart for the browser (own client, browser endpoint, no checksum parameters). 1 ≤ seconds ≤ 604800. */
  signPart(key: string, uploadId: string, partNumber: number, expiresInSeconds: number): Promise<string>;
  /** Server-side UploadPart (fallback route only). */
  uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer): Promise<void>;
  /** All parts, following NextPartNumberMarker; null when the upload no longer exists (NoSuchUpload / 404). */
  listParts(key: string, uploadId: string): Promise<{ partNumber: number; etag: string; bytes: number }[] | null>;
  completeMultipart(key: string, uploadId: string, parts: readonly { partNumber: number; etag: string }[]): Promise<void>;
  /** Idempotent: a missing upload succeeds. */
  abortMultipart(key: string, uploadId: string): Promise<void>;
  /** HeadObject → size, or null on 404. */
  head(key: string): Promise<{ bytes: number } | null>;
  /** Streams the object to `path` (worker). Throws StorageError; null when missing. */
  getToFile(key: string, path: string, signal: AbortSignal): Promise<{ bytes: number } | null>;
  /** Streams `path` to `key` with a server-side multipart upload (16 MiB parts), aborting it on failure (worker). */
  putFile(key: string, path: string, contentType: string, signal: AbortSignal): Promise<{ bytes: number }>;
}

export type { S3StorageConfig } from "../env";
