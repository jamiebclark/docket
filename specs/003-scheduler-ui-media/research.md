# Research: Scheduler Screens and Media (003)

Phase 0 output for [plan.md](./plan.md). Facts come from `docs/research/`, from the
installed packages' own docs and types, or from probes **run during planning**
(constitution I and II). Each item says which. **F** = a verified fact,
**U** = unverified (with a fallback), **D** = a design decision.

## Verified facts

### F1 — S3 client: checksum headers and the R2-safe settings (run)

A probe ran `@aws-sdk/client-s3` 3.1145.0 against an in-memory `requestHandler`
(no network). It recorded the outgoing `HttpRequest` for `PutObjectCommand` and
`DeleteObjectCommand`:

| Client config | PUT headers sent (filtered) | Presigned GET query |
|---|---|---|
| default | `content-type`, `cache-control`, `x-amz-sdk-checksum-algorithm`, `x-amz-checksum-crc32` | includes `x-amz-checksum-mode=ENABLED` |
| `requestChecksumCalculation: "WHEN_REQUIRED"`, `responseChecksumValidation: "WHEN_REQUIRED"` | `content-type`, `cache-control` only | no checksum mode |

- This confirms `docs/research/llm-and-storage.md` §3: current SDKs add CRC32 checksums by default, and the two `WHEN_REQUIRED` settings remove them. R2 needs them removed.
- The default for Docket is therefore `WHEN_REQUIRED` (env `S3_CHECKSUMS=when_required`).
- No `x-amz-acl` header is sent unless `ACL` is passed. Docket never passes `ACL` (R2 rejects it, research §3).

### F2 — S3 client: path style and endpoints (run)

- `forcePathStyle: false` with `endpoint: https://acct.r2.cloudflarestorage.com` sends to host `bkt.acct.r2.cloudflarestorage.com`, path `/p/abc.jpg`.
- `forcePathStyle: true` sends to host `acct.r2.cloudflarestorage.com`, path `/bkt/p/abc.jpg`.
- Both are configurable (`S3_FORCE_PATH_STYLE`). Whether R2 or MinIO *requires* one of them is still research **UNVERIFIED** (see U1).

### F3 — Presigned URLs (run)

- `getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), { expiresIn })` works offline. It is purely local signing.
- `expiresIn: 604800` (7 days) is accepted. `604801` throws `Signature version 4 presigned URLs must have an expiration date less than one week in the future`.
- Docket validates `1 ≤ seconds ≤ 604800` itself before calling the SDK, so the error message is Docket's and the bound matches R2's documented range (research §3).

### F4 — The S3 client can be tested without a network (run)

- `new S3Client({ requestHandler: { handle(request) { … }, updateHttpClientConfig() {}, httpHandlerConfigs() { return {}; } } })` receives each signed `HttpRequest` and can return `{ response: { statusCode, headers, body } }`.
- This is the "mocked S3 client" for FR-040. It asserts methods, hosts, paths and headers (content type, no ACL, no checksum headers) with **no new dependency** (`aws-sdk-client-mock` is not installed and is not needed).

### F5 — sharp 0.35.5: orientation, metadata stripping, limits (run)

The probe used sharp 0.35.5 with libvips 8.18.7.

- **Orientation and metadata.** The input was a 400×200 JPEG with EXIF `Orientation=6` and `Make=ProbeCam`. For it, `metadata()` returns `width 400, height 200, orientation 6` and `autoOrient: { width: 200, height: 400 }`.
  - `sharp(buf, { autoOrient: true }).jpeg().toBuffer()` gives a 200×400 image with no `orientation`, no `exif`, and the bytes no longer contain `ProbeCam`.
  - The types confirm: "The default behaviour, when withMetadata is not used, is to strip all metadata and convert to the device-independent sRGB colour space."
- **Pixel limit.** `limitInputPixels: N` makes **both** `metadata()` and the pipeline throw `Input image exceeds pixel limit`. The decompression-bomb check therefore happens before any pixels are decoded.
- **Content-based type detection.** A non-image buffer throws `Input buffer contains unsupported image format`. `metadata().format` is the decoder's name (`jpeg`, `png`, `webp`, `gif`, `heif`, …), so the type is judged from the bytes, not the file name.
- **Animation.** An animated WebP or GIF has `metadata().pages === 2` (≥ 2). A still WebP has `pages === undefined`. Rule: `pages > 1` means animated, and the file is rejected.
- **PNG with alpha to JPEG.** `flatten({ background: "#ffffff" }).resize({ width: 1440, height: 1440, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85, mozjpeg: true })` turns a 3000×1000 RGBA PNG into a 1440×480 JPEG.
- **Other APIs in the installed types:** `failOn` (default `'warning'`), `withoutEnlargement`, `toColorspace`, `keepIccProfile`, `withMetadata` and `metadata().hasAlpha`.

### F6 — Next.js 16.3.8: request-size limits on uploads (installed docs)

- **Server Action body limit.** `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/serverActions.md`: the default limit is **1 MB**, set by `experimental.serverActions.bodySizeLimit` (bytes or a string such as `'3mb'`). The limit counts multipart overhead, so allow about 10–20 KB of room.
- **Proxy body buffering.** `…/proxyClientMaxBodySize.md`: when `proxy.ts` matches a request, Next buffers its body up to **10 MB** by default. Past that, the body is **silently truncated** and the request continues.
  - Docket's `src/proxy.ts` matcher covers every non-static path, so a 20 MB upload would arrive truncated.
- Both keys exist in the installed `NextConfig` types (`config-shared.d.ts` lines 932 and 1137). Both are build-time config (`next.config.ts`), not runtime env.

### F7 — Next.js 16: Server Actions are dispatched one at a time per client (installed docs)

- `…/02-guides/server-actions.md` "Sequential dispatch on the client": "do not rely on `Promise.all` to parallelize Server Actions … use a Route Handler for non-mutation requests".
- Live composer validation therefore cannot use a Server Action. A slow upload would queue every keystroke check behind it.
- `refresh()` and `updateTag()` exist in `next/cache` (installed `revalidate.d.ts`). `revalidatePath` is still supported.

### F8 — sharp is present in the standalone output (inspected)

- `.next/standalone/node_modules/sharp` exists at the top level of the existing build (Next traces it), with its `@img/sharp-*` platform packages in `.pnpm`.
- So a worker bundle built with `--external:sharp` can resolve it from `.next/standalone/node_modules`. This was inspected on the darwin build only. The Linux image is covered by U3.

### F9 — MinIO distribution status (web search during planning; third-party sources)

- MinIO Inc. stopped publishing community Docker images in October 2025. The upstream repository was archived in February 2026.
- The last official tag is `minio/minio:RELEASE.2025-09-07T16-13-09Z`. It is frozen and gets no security fixes (e.g. CVE-2025-62506).
- Community builds such as `pgsty/minio` continue.
- Sources:
  - <https://www.chainguard.dev/de-DE/unchained/secure-and-free-minio-chainguard-containers>
  - <https://forum.rockstor.com/t/minio-no-longer-updates-the-docker-image/10785>
  - <https://www.youngju.dev/blog/2026-07-17-minio-archived-garage-seaweedfs-ceph-rgw.en>
  - <https://coolify.io/docs/services/minio-community-edition>
- Root credentials are `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` (password ≥ 8 characters). The server command is `server /data --console-address ":9001"`. Sources: <https://docs.dokploy.com/docs/templates/minio>, <https://www.datacamp.com/tutorial/minio-docker>.
- **These are third-party sources, not MinIO's own docs, and nothing was pulled or run.** This **disagrees with the input**, which assumes "a MinIO service" is an ordinary choice (recorded per constitution I). See D4 for how the plan responds.

## Unverified (with fallbacks)

- **U1 — R2 / MinIO addressing style.** It is unknown whether either requires path style (research §3, UNVERIFIED).
  - *Fallback*: `S3_FORCE_PATH_STYLE` is configurable. The documented examples use `false` for R2 and S3 and `true` for MinIO. The storage test runs against MinIO when `S3_TEST_ENDPOINT` is set and otherwise against the F4 handler.
  - Report "verified against MinIO" only if that run happened.
- **U2 — MinIO image behaviour** (F9 is third-party): whether the pinned tag still pulls, and whether `PutBucketPolicy` with an anonymous `s3:GetObject` statement makes objects publicly readable.
  - *Fallback*: the image is overridable (`MINIO_IMAGE`). The bucket is prepared with the AWS SDK (`CreateBucketCommand`, `PutBucketPolicyCommand`; both exist in the installed client) rather than MinIO's `mc`, so no unresearched CLI is involved.
  - The quickstart step is reported "not verified" if Docker is unavailable.
- **U3 — sharp in the Linux image and the worker bundle.** F8 was checked on darwin.
  - *Fallback*: the implement phase runs `node .next/standalone/worker.mjs` once after `pnpm build` and the Docker build in CI. If `sharp` does not resolve in the worker, the Dockerfile copies `node_modules/sharp` and `@img` explicitly. Never bundle a native module.
- **U4 — Variant bytes are deterministic.** Two concurrent generations of the same variant write the same key. The plan does not depend on byte equality: the database row wins (`ON CONFLICT DO NOTHING … RETURNING` existing), and the object at that key is a valid variant either way.

## Decisions

### D1 — Uploads: one file per Server Action call, with raised limits

- **Decision**: the media library and the composer upload by calling a Server Action once per file, in sequence, from a client component.
  - `next.config.ts` sets `experimental.serverActions.bodySizeLimit` and `experimental.proxyClientMaxBodySize` to the same constant, `UPLOAD_BODY_LIMIT = "26mb"`.
  - `MEDIA_MAX_UPLOAD_MB` is capped at 25 by env validation.
  - A unit test asserts `next.config.ts`'s limits ≥ the env maximum plus 1 MB of multipart room (F6).
- **Rationale**: per-file results ("each file is reported individually"), CSRF/origin protection for free (Server Actions), the typed `ActionResult` shape FR-037 asks for, and no browser-to-bucket signed PUT (the spec rejects it; research §3 notes the R2 checksum issue with signed PUTs).
- **Alternatives**:
  - A route handler with `formData()`: needs its own origin check and a session check, and duplicates the `ActionResult` plumbing.
  - Excluding the path from the proxy matcher: still hits the 1 MB action limit.
  - Presigned PUT from the browser: rejected by the spec.

### D2 — Live composer checks: a read-only route handler

- **Decision**: `POST /p/[projectSlug]/compose/check` (JSON in, JSON out) calls the service `checkComposition(scope, input)`.
  - The client debounces 200 ms and aborts the previous request with an `AbortController`.
  - The response carries, per target account: `count`, `limit`, `countingRule`, `issues` (errors, warnings, info notes), `postType` and the effective text.
  - The composer renders exactly these numbers; it contains no counting code.
- **Rationale**: F7 rules out Server Actions for keystroke traffic.
  - It is the same function the submit path uses (`validateTargetContent`, D7), so SC-002 ("match the server") holds by construction.
  - Adaptation notes need asset metadata and variant planning, which live on the server.
- **Alternatives**:
  - Running provider `validate` in the browser: it would bundle every provider (future ones pull `@atproto/api`), `countUtf8Bytes` uses `Buffer`, and it could not see media rows.
  - A Server Action: serialised behind uploads (F7).

### D3 — Storage: an interface plus one S3 implementation

- **Decision**: `src/server/storage/` exports `interface Storage { put; delete; publicUrl; signedUrl; get; exists }` and `createS3Storage(config)`. `getStorage()` returns the singleton, or `null` when storage is not configured.
  - `get` and `exists` go beyond FR-001's four operations: the publish-time fallback (FR-016, US4-AS7) must detect a missing variant and re-read the original to regenerate it. This is recorded in decisions.
  - Keys:
    - `projects/<projectId>/media/<assetId>/original.<ext>`
    - `…/thumb.webp`
    - `…/v/<constraintsHash>.<ext>`
  - Every put sets `ContentType` and `CacheControl: public, max-age=31536000, immutable`. Keys are never reused for different bytes, except the variant race in U4, which writes equivalent bytes.
- **Rationale**: one place for R2 rules (no ACL, checksums `WHEN_REQUIRED`, content type always set), testable with F4, and project-prefixed keys so a storage key can never collide across projects.
- **Alternatives**: a local-filesystem implementation (rejected: Meta needs public URLs, and the brief says "use a real bucket"); `@aws-sdk/lib-storage` multipart (not installed; files are ≤ 25 MB and a single `PutObject` is fine).

### D4 — Offline MinIO: opt-in, pinned, overridable, prepared by Docket's own script

- **Decision**: `docker-compose.yml` gains two services under `profiles: ["offline"]`.
  - `minio`:
    - image `${MINIO_IMAGE:-minio/minio:RELEASE.2025-09-07T16-13-09Z}`;
    - ports bound to `127.0.0.1:9000` and `127.0.0.1:9001` only;
    - development-only root credentials with defaults;
    - a named volume.
  - `storage-init`: the Docket image running `node scripts/storage-init.mjs`, bundled by esbuild like `prestart.mjs` (decision 20). The script:
    1. creates the bucket if missing (`CreateBucketCommand`, treating `BucketAlreadyOwnedByYou` as success);
    2. applies an anonymous-read bucket policy (`PutBucketPolicyCommand`);
    3. exits 0.
  - `web` and `worker` are unchanged by default. With the profile, the operator sets the `S3_*` values the docs give (endpoint `http://minio:9000`, public base `http://localhost:9000/docket-media`).
  - The docs state:
    - the image is frozen and unmaintained upstream (F9), and how to swap in a community build via `MINIO_IMAGE`;
    - MinIO is for offline development with the mock provider only;
    - Instagram and Threads can never fetch from `localhost`.
- **Rationale**: the spec requires MinIO under an optional profile. F9 makes the default image a known-stale artifact, so it is pinned by exact tag (reproducible), bound to loopback (never exposed), overridable, and clearly labelled. Using the AWS SDK for setup avoids depending on `mc`, which is also unmaintained and unresearched.
- **Alternatives**:
  - `minio/mc` init container: unresearched CLI, frozen image.
  - Another S3-compatible server (Garage, SeaweedFS): unresearched, and it contradicts the spec.
  - Dropping offline storage: contradicts the spec. Media features are simply disabled without storage, which already covers offline text-only work.

### D5 — Storage env: all-or-nothing group, validated at start-up

- **Decision**: the group is `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_PUBLIC_BASE_URL`, plus optional `S3_ENDPOINT`, `S3_REGION` (default `auto`), `S3_FORCE_PATH_STYLE` (default `false`), `S3_CHECKSUMS` (`when_required` default | `when_supported`) and `S3_PREVIEW_URLS` (`public` default | `signed`).
  - None of the four required values set means `storage: null`, and media is disabled.
  - Any one set means all four are required. Each missing one is reported by name.
  - `S3_PUBLIC_BASE_URL` must be absolute http(s) with no query. `https://` is required when `NODE_ENV=production`, except for `localhost` / `127.0.0.1`, so offline MinIO works in a production build.
  - The secret value never appears in messages (001's env pattern).
- Upload limits: `MEDIA_MAX_UPLOAD_MB` (1–25, default 20) and `MEDIA_MAX_MEGAPIXELS` (1–100, default 50).
- **Rationale**: FR-003 (none → disabled; partial → fail, naming the setting). It is explicit credentials rather than the AWS default chain, so the configuration is visible and documented.

### D6 — Media constraints are part of provider capabilities

- **Decision**: extend `ProviderCapabilities.media` with optional fields:
  - `outputMimeType` (what to convert to when a type is not accepted; default the first `allowedMimeTypes`);
  - `minWidth`, `maxWidth`, `minHeight`, `maxHeight`;
  - `minAspectRatio`, `maxAspectRatio` (width ÷ height);
  - `maxAltTextLength`.
- `allowedMimeTypes` and `maxBytesPerFile` keep their meaning. A pure `mediaConstraintsOf(capabilities)` in `src/providers/media.ts` normalises them into `MediaConstraints`.
- **Rationale**: FR-012 says declaring constraints is a change inside the provider's folder. Capabilities are already where a provider declares media rules, and the composer already receives capabilities. A second declaration would drift.
- **Alternatives**: a separate `mediaConstraints` property (duplicates `allowedMimeTypes` / `maxBytesPerFile`).

### D7 — One validation path: plan media, then the provider validates what will be sent

- **Decision**: a pure `planImage(asset, constraints)` in `src/providers/media.ts` returns one of:
  - `{ kind: "original" }` — the asset already complies;
  - `{ kind: "derive", steps, output, notes }` — `steps ⊆ convert | downscale | compress`; `output` is the predicted mime and dimensions, with `bytes ≤ maxBytes`; `notes` are `severity: "info"` issues;
  - `{ kind: "refuse", issues }` — aspect ratio out of range, below the minimum size, or a downscale that would cross a minimum.
- A server function `validateTargetContent(tx, account, content)` does three things:
  1. builds the *adapted* `PostContent`;
  2. calls `provider.validate(adapted, capabilities)`;
  3. merges in the plan's notes and refusals.
- The composer check (D2), `previewQueue`, the queue/schedule/publish gates and `updatePost`'s re-validation all call it. `ValidationIssue.severity` gains `"info"`.
- `validateAgainstCapabilities` also learns `maxAltTextLength` (an error naming the limit).
- **Rationale**: FR-015 (judge the image as it will be sent) with one implementation (constitution IV). Fixable mismatches stop being errors.
- **Alternatives**: changing every provider's `validate` to know about adaptation (it would leak engine policy into providers).

### D8 — Variants: generated before acceptance, cached by constraint hash, checked at publish

- **Decision**:
  - `constraintsHash = sha256(canonicalJSON({ v: VARIANT_PIPELINE_VERSION, ...constraints }))` (hex, first 32 characters).
  - The table is `media_variants`, unique `(media_asset_id, constraints_hash)`.
  - **Before** the queue, schedule or publish-now transaction (and before `updatePost` when it re-validates scheduled targets), the service calls `prepareVariants(scope, postId)`:
    - outside any transaction, for each distinct `(asset, provider constraints)` pair whose plan is `derive` and which has no row yet, it reads the original, generates, puts, and inserts the row (`ON CONFLICT DO NOTHING`);
    - a failure is recorded per pair.
  - Inside the transaction, the gate requires every `derive` pair to have a row; otherwise the target fails with `code: "validation"` and issue `variant_failed` (message from the generator).
  - At publish (`scheduler/publishing.ts` `execute`, outside any transaction, inside the time budget), `resolvePublishMedia(repos, targetId, provider)`:
    1. resolves each image to its variant (or original);
    2. checks `storage.exists(key)`;
    3. regenerates a missing variant from the original;
    4. if regeneration fails or the original is gone, records `fatal_error` with "Image N could not be prepared for <platform>." **No provider call happens.**
- **Generation algorithm** (`src/server/media/variants.ts`):
  1. Start from the cleaned original (upright, sRGB, no metadata).
  2. Resize `fit: "inside"` to `maxWidth` / `maxHeight` with `withoutEnlargement`.
  3. Encode to the output type. JPEG flattens alpha on white. Quality runs 90 → 50 in steps of 8.
  4. While the result is over `maxBytes` at quality 50, downscale by 0.85 and retry, keeping ≥ `minWidth` / `minHeight`.
  5. At most 12 encodes, then fail with "Could not fit image within N bytes without going below W×H."
  - It never crops or upscales (FR-013).
- **Rationale**: FR-016 says failures are seen by the editor, not at publish. Generating outside the transaction keeps locks short (constitution: no slow I/O in held transactions, by analogy with provider calls). The hash includes a pipeline version, so changing the algorithm or the constraints invalidates old variants (FR-014, edge case "Constraint changes").
- **Alternatives**:
  - Generating at upload: the platforms are unknown then (spec assumption).
  - Generating inside the transaction: holds post locks for seconds.

### D9 — Cleaned originals and thumbnails at upload

- **Decision**: the upload pipeline runs in this order.
  1. Check the byte size against `MEDIA_MAX_UPLOAD_MB` *before* sharp.
  2. `sharp(buf, { limitInputPixels: MEDIA_MAX_MEGAPIXELS × 1e6, failOn: "warning" }).metadata()`:
     - reject an unknown format (`unreadable`);
     - reject `format ∉ {jpeg, png, webp}` (`unsupported_type`);
     - reject `pages > 1` (`animated`);
     - reject the pixel limit (`too_many_pixels`).
  3. Re-encode with `autoOrient: true` in the same format: JPEG q90 mozjpeg, PNG compression 9, WebP q90. Metadata is stripped and the colour space becomes sRGB by default (F5).
  4. Make a 480 px `thumb.webp` (`fit: "inside"`).
  5. Put both objects.
  6. Insert the row with the upright dimensions and byte size *of the stored file*. The mime type comes from the decoder, not the client.
  - If the insert fails, delete both objects. If that delete also fails, log the orphan keys (no secrets).
- **Rationale**: FR-006 and FR-007; "no record without a file"; the claimed type is never trusted. Thumbnails keep the library and composer fast (SC-006 spirit) without serving 20 MB originals.

### D10 — Deleting media: soft delete, post-first lock order

- **Decision**: `media_assets.deleted_at` (soft delete, like posts and accounts in 002).
  - `deleteMedia` locks in the order the rest of the system uses: posts (by id) → asset.
    1. Read the post ids using the asset (no lock).
    2. Lock those posts in id order, then lock their targets.
    3. Lock the asset `FOR UPDATE`.
    4. Re-read `post_media` under the lock. If a new post appeared, throw `ConflictError("This image was just added to a post. Try again.")`.
  - It is refused when any target of those posts is `scheduled | publishing | failed | ambiguous`.
  - Otherwise, in the transaction:
    - remove `post_media` rows of posts whose targets are all `draft`/`cancelled` (drafts), then renumber their positions;
    - set `deleted_at`;
    - delete the `media_variants` rows.
  - After commit, delete the objects: original, thumbnail and variants.
  - Published posts keep their `post_media` row, which points at the soft-deleted asset, so their detail shows "Image deleted" (FR-010).
  - Attach paths (`createDraft`, `updatePost`) lock the post first (already true) and then read the assets with `FOR SHARE` and `deleted_at IS NULL`. A concurrent delete and attach serialise, and exactly one wins (edge case).
- **Rationale**: the FK from `post_media` is `ON DELETE RESTRICT`, and published history must stay readable. Taking the post locks first matches 002's order and avoids deadlocks.

### D11 — Tags as a `text[]` column

- **Decision**: `media_assets.tags text[] NOT NULL DEFAULT '{}'`.
  - Normalised by Zod: trimmed, lower-cased, deduplicated, 1–40 characters, `[\p{L}\p{N}][\p{L}\p{N} _-]*`, at most 20.
  - Indexed with GIN `(tags)`. Filtered with `tags @> ARRAY[$tag]`.
  - The project's tag list is `SELECT DISTINCT unnest(tags)` scoped by project.
- **Rationale**: one column instead of a table plus registry entry and join. It is case-insensitive by normalisation (FR-009).
- **Alternatives**: a `media_tags` join table (more joins and scope rules for no gain at this scale).

### D12 — "Move into this occurrence" uses the same guarantee as the queue

- **Decision**: `moveTargetToOccurrence(scope, targetId, { slotId, scheduledAt })`.
  1. Lock the post, then the target (`withLockedTarget` order).
  2. Require `status = scheduled`, `scheduleKind ∈ {slot, explicit}` and no live lease.
  3. Require the slot to belong to the target's account (otherwise `ConflictError("That slot belongs to another account.")`) and not be paused.
  4. Require `scheduledAt` to be an actual occurrence of that slot: recompute with `occurrencesBetween` over `[scheduledAt − 1 min, scheduledAt]`, with the instant in the future and within `QUEUE_HORIZON_DAYS`.
  5. `releaseOccurrence`, then `tryHoldOccurrence`. A `false` result throws `ConflictError("That slot was just taken.")`, and the transaction rolls back, so the target keeps what it had.
  6. Reset the attempt fields as `addToQueue` does, and re-derive the status.
- **Rationale**: FR-026, SC-005. The partial unique index decides races exactly as in 002 D3.

### D13 — Pull-forward preview = the real function, rolled back

- **Decision**: `previewPullQueueForward(scope, accountId)` runs the same body as `pullQueueForward` inside a transaction that is rolled back by throwing a private sentinel caught outside, and returns `moved`.
  - Confirming calls `pullQueueForward` with `expected` (the previewed moves). The result marks entries that differ.
- **Rationale**: FR-028 asks for a confirmation listing the moves. One implementation (constitution IV). No speculative copy of the algorithm.

### D14 — Explicit local time → instant, with DST notes

- **Decision**: `resolveLocalDateTime(timeZone, "YYYY-MM-DDTHH:mm")` (pure, in `services/queue/occurrences.ts`) uses `disambiguation: "compatible"`, the same rule as slots (002 decisions). It also reports:
  - `kind: "gap"` when the wall time does not exist;
  - `kind: "overlap"` when it occurs twice (`"earlier"` and `"later"` differ);
  - `kind: "exact"` otherwise.
- The service `previewExplicitTime(scope, postId, { local })` returns the resolved instant, the zone, the kind, a past check, and per-target near-queued warnings.
- `scheduleAt` itself still takes an ISO instant (`atSchema`, unchanged). The composer sends the instant the preview returned.
- **Rationale**: US2-AS1 shows the resolved instant for gap and overlap times. The rule is the queue's (spec edge case). The API keeps its instant-based contract.

### D15 — Composer flow over existing services

- **Decision**:
  - The composer keeps unsaved state in the client.
  - **Save draft** calls `createDraft` or `updatePost`.
  - Each scheduling action first saves, then:
    - **Add to queue**: `previewQueue` → confirmation dialog → `addToQueue({ targetIds, expected })`, which shows the assigned times with `changedFromPreview` highlighted;
    - **Schedule**: `previewExplicitTime` → dialog → `scheduleAt`;
    - **Publish now**: dialog naming the accounts → `publishNow`.
  - The composer route is `/p/[projectSlug]/compose`, with `/p/[projectSlug]/compose/[postId]` for an existing post.
  - Post type is derived from media (002 `inferPostType`).
- **Rationale**: it reuses 002's services and their per-target results (FR-021–FR-023). Nothing is reserved before confirmation (US1-AS4).

### D16 — Post list query

- **Decision**: a new DAL method `posts.list({ status?, needsDecision?, limit, offset })` returns non-deleted posts ordered by "relevant time" (the next scheduled target time ascending for live posts, else `updated_at` descending). It is computed in SQL with a lateral aggregate over `post_targets` (join rule `project_id` equality).
  - It also returns a total count.
  - `needsDecision` = `EXISTS` a target with status `ambiguous`.
  - The page size is fixed at 25. The page comes from `?page=`.
- Service: `listPosts(scope, input)` adds account names and per-target statuses.
- **Rationale**: FR-029. Offset pagination is fine at self-hosted scale (hundreds of posts).

### D17 — Calendar

- **Decision**: `getCalendar(scope, { view: "month" | "week", date: "YYYY-MM-DD", accountId? })` is computed on the server with Temporal in the project zone.
  - **Range**:
    - month = 6 rows of weeks starting Monday, covering the month;
    - week = Monday–Sunday containing `date`;
    - each range runs from the local midnight at its start to the local midnight after its end.
  - **Data**:
    - targets in range (non-cancelled), from a new DAL `targets.listInRange(from, to, accountId?)` joined to posts for the excerpt;
    - `listEmptySlots` for the same range (already future-only, active-only and horizon-bounded; ≤ 42 days < its 92-day cap);
    - cells grouped by local date;
    - the week view groups each day's items by local hour, using that day's actual hours (23 or 25 on DST days).
  - The page is a server component. Only the interactive `CalendarBoard` (drag and drop, action menus, live region) is a client component; it receives serialisable cells.
  - **Drag and drop** uses native HTML5 DnD (`draggable`, `dragover`, `drop`). Every drop target is also reachable through the "Move to slot…" menu, a dialog listing that account's empty slots (US5-AS9).
- **Rationale**: FR-024–FR-028 and docket-ui (Temporal stays on the server; client components stay leaf-level). There is no DnD library (spec assumption, constitution VI).

### D18 — Needs-reauth banner and the accounts screen

- **Decision**: the project layout calls `listAccounts` (all members have `account:view`) and renders `<ReauthBanner>` (`role="alert"`) when any account has `needs_reauth`.
  - The banner names the accounts.
  - Owners and admins (`scope.can({ account: ["manage"] })`) get a link to `/p/[slug]/accounts#account-<id>`. Editors are told to ask an owner or admin.
- New services:
  - `reconnectMock(scope, accountId)`: `account:manage`, mock accounts only. It calls `saveConnectedAccount` with the same external id, which reactivates the account and clears `last_error`.
  - `accountRemovalImpact(scope, accountId)`: the count of distinct non-deleted posts with open targets on the account, for the confirmation text (US7-AS9).
- **Rationale**: FR-034 and FR-036, through the one upsert 002 built.

### D19 — Testing server actions

- **Decision**: action tests call the exported action functions directly in Vitest with:
  - `vi.mock("@/server/auth/session")` returning a fake session per role;
  - `vi.mock("next/cache")` (no-op `revalidatePath` / `refresh`);
  - `vi.mock("next/navigation")` (`redirect` / `notFound` throw tagged errors).
- They use 001's `createProjectWithMembers`. One table-driven file lists every action with its required permission and asserts `ok` / `forbidden` / `not_found` for owner, admin, editor and non-member (SC-009).
- **Rationale**: FR-040 asks for authorization of the server actions themselves, not only the services.

### D20 — Thumbnails and previews: public URL by default, signed on request

- **Decision**: library and composer `<img>` elements use the thumbnail's public URL. With `S3_PREVIEW_URLS=signed` (a private bucket, or R2 without a public domain during setup), the page asks `storage.signedUrl(key, 3600)` for each visible thumbnail.
  - Provider publishing always uses the **public** URL. Meta needs it, and a signed R2 URL only works on the S3 API domain (research §3).
- **Rationale**: it uses FR-001's signed-URL operation where the spec suggests it, without making private buckets look publishable.

### D21 — No new runtime dependencies

- Everything above uses packages already in `package.json`: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `sharp`, `@js-temporal/polyfill`, `zod`, `next`, `react`.
- The new build step (`build:storage-init`) uses the existing esbuild dev dependency, as decision 20 did.
- The only new infrastructure is the opt-in MinIO service (D4), justified in plan.md "Complexity Tracking".
