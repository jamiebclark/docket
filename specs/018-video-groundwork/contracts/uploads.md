# Contract: upload sessions (server actions, chunk route, storage)

Decisions P1–P5, P7, P8, P13 and P15 in [../research.md](../research.md). Shapes are in [../data-model.md](../data-model.md).

All actions live in `src/app/p/[projectSlug]/media/upload-actions.ts` (`"use server"`). They call `runAction(slug, fn)`, so a missing session or a non-member gets `{ ok: false, code: "not_found" }`, and they delegate to `src/server/services/uploads.ts`. Every service function requires `media: edit` (today's upload right, spec assumption 2). Every action except `createUpload` also requires that the session's `created_by_user_id` is the caller; otherwise it throws `NotFoundError`, so a session never reveals that it exists. Inputs are parsed with Zod. Expected refusals are returned as data, `{ ok: true, data: { ok: false, code, message } }`, like `uploadMedia` today, and are never thrown.

## `createUpload(slug, input)`

```ts
input: { filename: string /* ≤ 1000, trimmed to base name ≤ 255 */;
         kind: "image" | "video"; declaredType: string; bytes: number /* int ≥ 1 */ }
→ { ok: true; upload: { id: string; partSize: number; partCount: number; transport: "direct" | "via_app" } }
| { ok: false; code: "unsupported_type" | "too_large" | "too_many_open" | "storage_unavailable"; message: string }
```

1. Storage must be set up, or the action returns `storage_unavailable` ("Media storage is not set up").
2. `declaredType` must be in `libraryLimits().<kind>.types`, or it returns `unsupported_type`.
3. `bytes` must be ≤ `libraryLimits().<kind>.maxBytes`, or it returns `too_large`.
4. In one transaction: `members.lockSelf(user)`, then `uploads.countOpenFor(user)` must be below `MEDIA_MAX_OPEN_UPLOADS`, or it returns `too_many_open`. The row is then inserted as `open` with `storage_upload_id = NULL`, and the transaction commits. Because the count and the insert happen under the same lock, the cap is exact.
5. Outside any transaction: `storage.createMultipart(stagingKey, declaredType)`, then `transition(id, ["open"], "open", { storageUploadId })`. If `createMultipart` throws, the row becomes `cancelled` with `error` set, and the action returns `storage_unavailable` ("Storage refused the upload. Try again.").

A session whose `storage_upload_id` is still `NULL` cannot be signed, listed or completed (`upload_finished`). Housekeeping expires it like any other open session.

## `signUploadParts(slug, { uploadId, partNumbers })`

```ts
partNumbers: number[]  // 1..partCount, unique, at most 20
→ { ok: true; parts: { partNumber: number; url: string; expiresAt: string /* ISO */ }[] }
| { ok: false; code: "upload_finished"; message: "This upload has already finished." }
```

The session must be `open`.

- **`direct`:** `storage.signPart(key, uploadId, n, 3600)` through the presign client (P3).
- **`via_app`:** each URL is `/p/<slug>/media/uploads/<uploadId>/parts/<n>`, and `expiresAt` is the session's expiry.

Presigned URLs are never logged.

## `listUploadedParts(slug, { uploadId })`

```ts
→ { ok: true; parts: { partNumber: number; bytes: number }[]; confirmedBytes: number }
| { ok: false; code: "upload_finished"; message: string }
```

The session must be `open` or `completing`. The parts come from `storage.listParts`, paginated (F8). Only parts whose size is right for their number are returned. A part of the wrong size counts as missing and is re-sent, since `UploadPart` with the same number replaces it. ETags are not returned to the browser.

## `completeUpload(slug, { uploadId })`

```ts
→ { ok: true; asset: MediaView }      // image: status "ready"; video: status "processing", step "queued"
| { ok: false; code: "parts_missing"; message: "Some parts did not arrive. Retry to send them." }   // session back to open
| { ok: false; code: "size_mismatch" | "too_large" | "unsupported_type" | "animated" | "too_many_pixels" | "unreadable"; message: string } // session refused
| { ok: false; code: "upload_finished"; message: string }
```

The full algorithm is P4 (completion) and P7 (images). It is idempotent:

- A completed session returns its asset.
- A `NoSuchUpload` from ListParts while the session is `completing` is resolved with `headObject` and continues.

For an image, `revalidatePath`/`refresh()` is called once the row is written, as `uploadMediaAction` does today. For a video, the client polls status instead.

## `cancelUpload(slug, { uploadId })`

```ts
→ { ok: true }   // also when already cancelled or expired (idempotent)
| { ok: false; code: "upload_finished"; message: string }  // completed or refused: nothing to cancel
```

The session moves from `open` or `completing` to `cancelled` under its row lock. Then `abortMultipart`, which treats `NoSuchUpload` as success, and `delete(stagingKey)`, which also succeeds when the key is missing.

## `mediaProcessingStatusAction(slug, { ids })`

```ts
ids: string[] (uuid, ≤ 50)
→ { ok: true; items: { id: string; status: "processing" | "ready" | "failed"; step: "queued" | "probing" | "poster" | null;
                         error: string | null; waitingForWorker: boolean; item: MediaView | null }[] }
```

Requires `media: view`. Ids that are unknown, foreign or deleted are left out of `items`; the client treats a missing id as "removed". `waitingForWorker` is `step = 'queued' AND now() − created_at > 30 s` (DB clock).

## Chunk route (fallback, `MEDIA_UPLOAD_TRANSPORT=via_app`)

`src/app/p/[projectSlug]/media/uploads/[uploadId]/parts/[partNumber]/route.ts`, `export async function PUT(request, { params })`, `runtime = "nodejs"`.

1. Resolve the session with `getSession()` and `forProject(session, slug)`. A missing session, a non-member, or not the owner gets `404 { error: "not_found" }`.
2. The upload must be `open`, the transport `via_app`, and `partNumber` in `1..partCount`. Otherwise `409 { error: "upload_finished" }` or `400 { error: "bad_part" }`.
3. `Content-Length` must equal the part's expected length. Otherwise `400 { error: "length_mismatch", message: "The chunk is not the expected size." }`.
4. `await request.arrayBuffer()`. The received length must equal `Content-Length`. Otherwise `400 { error: "chunk_incomplete", message: "The chunk arrived incomplete." }`. This is the silent-truncation guard (research §3).
5. `storage.uploadPart(key, uploadId, n, body)`. A storage error gets `502 { error: "storage_failed", message: "Storage refused the upload." }`, with no SDK detail.
6. On success, `204`. The body is never logged.

The same-origin check in `src/proxy.ts` already applies (F19). `PART_SIZE + 1 MiB ≤ bytes(UPLOAD_BODY_LIMIT)` is asserted at module load and by a unit test (P5).

## Storage interface additions (`src/server/storage/types.ts`)

```ts
interface Storage {
  /* existing methods unchanged */
  /** CreateMultipartUpload with ContentType and CacheControl, no ACL. */
  createMultipart(key: string, contentType: string): Promise<{ uploadId: string }>;
  /** Presigned UploadPart for the browser (P3); 1 ≤ seconds ≤ 604800. */
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
```

`createS3Storage` implements these with the commands in F8. It wraps every SDK error in `StorageError(op, status)`, as today. `tests/helpers/storage.ts` `MemoryStorage` implements them in memory, so tests can inject a failure per part (`failPartFor`) and `signPart` returns `memory://<key>?part=<n>` for the fake transport.
