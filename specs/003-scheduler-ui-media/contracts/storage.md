# Contract: Storage (`src/server/storage/`)

FR-001–FR-005, research F1–F4, D3, D5, D20.

```ts
// src/server/storage/types.ts
export interface StoredObject { key: string; contentType: string; bytes: number }

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

// src/server/storage/index.ts
export function getStorage(): Storage | null;          // null when storage env is unset (media disabled)
export function requireStorage(): Storage;             // throws StorageUnavailableError (name set) when null
export function createS3Storage(config: S3StorageConfig, opts?: { requestHandler?: unknown }): Storage;
export function mediaKeys(projectId: string, assetId: string): {
  original(ext: "jpg" | "png" | "webp"): string;
  thumbnail: string;                                  // …/thumb.webp
  variant(hash: string, ext: "jpg" | "png" | "webp"): string;
};
```

## S3 implementation rules

- **Client options**: `{ region, endpoint?, forcePathStyle, credentials: { accessKeyId, secretAccessKey }, requestChecksumCalculation, responseChecksumValidation }`.
  - `S3_CHECKSUMS=when_required` (the default) sets both checksum options to `"WHEN_REQUIRED"`. `when_supported` sets `"WHEN_SUPPORTED"`.
- **`put`** sends `PutObjectCommand({ Bucket, Key, Body, ContentType, CacheControl: "public, max-age=31536000, immutable" })` and nothing else. In particular: no `ACL`, no `Tagging`, no `ObjectLock*`, no `SSEKMSKeyId`. These are the options R2 lists as unsupported (FR-005).
- **`publicUrl`** encodes each path segment with `encodeURIComponent` and joins them with `/`. A trailing `/` on the base is stripped.
- **Keys** always start with `projects/<projectId>/`. The service layer builds them only through `mediaKeys`.
- **Error mapping**: SDK errors are caught at this boundary and rethrown as `StorageError(operation, httpStatus?)`. The message is "Storage <op> failed (HTTP 503)". It never includes the endpoint credentials, the signed URL or the SDK's raw message, which can echo request details. The original error is kept as `cause` for server logs, which are logged through the same redaction path as 002.
- `getStorage()` is memoised per process from `getEnv().storage`.

## Tests (FR-040)

- **`src/server/storage/s3.test.ts`** uses the F4 in-memory `requestHandler` and asserts:
  - `put` sends PUT with `content-type` and `cache-control`, and no `x-amz-acl` and no `x-amz-checksum-*` under `when_required`;
  - `delete` sends DELETE to the right path in both addressing styles;
  - `publicUrl` encoding;
  - `signedUrl` returns a URL with `X-Amz-Expires=<n>` for 1 and 604800, and rejects 0 and 604801;
  - `get` and `exists` map 404 to `null` / `false`;
  - a thrown SDK error becomes a `StorageError` whose message contains neither the access key nor the secret.
- **`tests/integration/storage-minio.test.ts`** is skipped unless `S3_TEST_ENDPOINT` is set (with `S3_TEST_BUCKET` etc.). Against a real MinIO it puts, fetches the public URL (expecting the right `content-type`), fetches the signed URL, checks `exists`, and deletes. A skipped run is reported as such (constitution II).
