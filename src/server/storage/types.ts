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
}

export type { S3StorageConfig } from "../env";
