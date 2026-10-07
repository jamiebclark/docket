# Research: Video groundwork (018)

Phase 0 for [plan.md](./plan.md). External facts come only from `docs/research/upload-transport.md`, `docs/research/ffmpeg.md` and the platform files the spec cites (constitution I). Code facts were read from `main` at `4d072af` in this phase. Library facts were read from the installed packages' own types and docs in `node_modules`. The spec has no `NEEDS CLARIFICATION` items. This file settles the open implementation questions as plan decisions **P1–P30**. They are recorded in `docs/decisions.md` under `## 018`, beside the spec's D1–D12 and the operator's two choices.

**What could not be run in this phase.** ffmpeg and ffprobe are not installed on the machine that ran this phase, so no ffmpeg command was executed. Every ffmpeg detail that `docs/research/ffmpeg.md` marks UNVERIFIED is therefore assigned to a test that runs real ffmpeg in CI. That test **fails** in CI if the detail is wrong; it is not an assumption (spec assumption 5, constitution II). P23 lists those tests.

## Facts confirmed in the code and installed packages (F)

- **F1 — `runTick` can run inside the web process.** `RUN_WORKER_IN_PROCESS=true` starts `runLoop(runTick)` from `src/instrumentation.ts` through `startInProcessLoop`. `POST /api/internal/tick` also runs `runTick()` in the web process. Only `src/worker.ts` is guaranteed to be the worker. So video processing cannot be a `runTick` section without breaking FR-016 and SC-007.
- **F2 — `media_assets.byte_size` is `integer`.** Its maximum is 2,147,483,647. The largest video the new setting allows is 4,096 MiB = 4,294,967,296 bytes. The column must become `bigint` (P20). `media_variants.byte_size` holds image variants only and stays `integer`.
- **F3 — The CSP blocks direct upload and video playback today.** `buildCsp` sends `connect-src 'self'`, so an XHR `PUT` to the bucket is refused by the browser. There is no `media-src`, so `<video>` falls back to `default-src 'self'`, which blocks both the bucket URL and the `blob:` URL used to read metadata before upload. P6 extends the CSP.
- **F4 — Two validation entry points, one validator.** The composer check and the scheduling gate go through `validateTargetContent`, which uses the planner, then `validateResolvedContent`. The engine's publish-time re-check calls `validateResolvedContent` directly, on items from `resolvePublishMedia` (`src/server/scheduler/publishing.ts`). Both reach `validateAgainstCapabilities`. A check that must hold at all three points (processing or failed media, video limits) therefore belongs in `validateAgainstCapabilities`, and the facts it needs must travel on `MediaItem` (P16).
- **F5 — Every provider's `validate` starts from `validateAgainstCapabilities`** (017 F3). That function judges **every** media item as an image: `mime_not_allowed`, `file_too_large`, `too_many_images` and the alt-text rules. Video items must be routed to the new video checks so they never produce image issues (P16).
- **F6 — `stepFor` sees only `{ text, mediaCount }`.** `StepContent` is built by `contentShape` in `src/server/dal/scheduler.ts`. The mock needs to know whether the post carries a video to choose its video steps (P18).
- **F7 — Storage takes whole buffers.** `Storage` has `put(Buffer)`, `get(): Buffer`, `exists`, `delete`, `publicUrl` and `signedUrl`. There are no multipart, ranged-read or streaming methods. A 4 GB video cannot go through `get`/`put` in memory (P1, P9).
- **F8 — The installed AWS SDK (3.1145.0) has every command the transport needs.** `@aws-sdk/client-s3` has `CreateMultipartUploadCommand`, `UploadPartCommand`, `ListPartsCommand`, `CompleteMultipartUploadCommand` and `AbortMultipartUploadCommand` (`dist-types/commands`). `ListParts` takes `PartNumberMarker` and returns `IsTruncated`, `NextPartNumberMarker` and `Parts[]`, each with `PartNumber`, `ETag` and `Size` (`dist-types/models/models_0.d.ts`). `getSignedUrl(client, command, { expiresIn, unhoistableHeaders, hoistableHeaders })` is in `@aws-sdk/s3-request-presigner` (`dist-types/getSignedUrl.d.ts`, `@smithy/types` `RequestPresigningArguments`). No new package is needed (spec assumption 8).
- **F9 — Next.js 16.3.8 route handlers** (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`, `01-getting-started/15-route-handlers.md`):
  - they support `PUT`;
  - `params` is a `Promise`;
  - a `route.ts` cannot sit at the same segment as a `page.tsx`, but may sit in a deeper segment of a page folder.

  `src/proxy.ts`'s matcher covers `/p/**` and `/api/**`. So a chunk route is buffered up to `proxyClientMaxBodySize` (`UPLOAD_BODY_LIMIT` = `26mb` in `next.config.ts`), and a body over that is **truncated silently** (research §3).
- **F10 — Node 24 child processes** (`@types/node` `child_process.d.ts`): `spawn` takes `timeout`, `killSignal` and `signal: AbortSignal`. `fs.promises.statfs` exists (`fs/promises.d.ts`), so free temp disk can be checked before downloading a video.
- **F11 — There is no browser test environment.** Vitest runs with `environment: "node"`, and no jsdom, happy-dom, Playwright or Testing Library is installed. UI is tested with `renderToStaticMarkup`. So the upload engine must be pure TypeScript with an injected transport, clock and status source, testable in Node (P14). The thin XHR and `<video>` adapters are the only browser-only code.
- **F12 — Two copies of the upload loop.** `UploadDropzone.tsx` (library) and `MediaPicker.tsx` (composer) each call `uploadMediaAction` one file at a time. `prepareUpload`/`commitUpload` are also used by the public API's `uploadMedia`, and `media-from-url.ts` by `importMediaFromUrl`. Those two API paths keep the buffered image path (D10).
- **F13 — Keys.** `mediaKeys(projectId, assetId)` builds `projects/<p>/media/<a>/original.<jpg|png|webp>`, `thumb.webp` and `v/<hash>.<ext>`. Video originals need `mp4`/`mov`, and staging objects need their own prefix (P20).
- **F14 — The generator reads the library in two places.** It lists item sources with `listIdsForSelection` (`src/server/services/jobs/sources/media.ts`) and builds model image input with `ensureVariant` (`src/server/llm/images.ts`). Both must ignore videos (D11, P25).
- **F15 — Thumbnails everywhere come from `MediaView.thumbnailUrl`.** These are the library card, the picker grid and chips, the post page (`posts/[postId]/page.tsx`), `PostViewMedia` (post list) and job items. `toView` falls back to `publicUrl` when there is no thumbnail, which for a video would put a video URL in an `<img>` (P26).
- **F16 — Compose and the offline profile.**
  - `web` and `worker` run the same image, and the worker's `/tmp` is the container's writable layer.
  - MinIO is published on `127.0.0.1:9000`, so a browser on the same machine reaches `http://localhost:9000`.
  - MinIO answers CORS for all origins by default (research §1, MinIO).

  So the offline profile needs one new `.env` line and **no `docker-compose.yml` edit** (P28).
- **F17 — CI.**
  - The `test` job has no ffmpeg.
  - The `docker` job builds without `load`, so it cannot run anything in the image.
  - GitHub-hosted Ubuntu runners get Ubuntu's ffmpeg from apt. That is not Debian bookworm's 5.1.x, and its exact version is UNVERIFIED.

  Fixture tests on the runner therefore do not prove the commands on the image's ffmpeg, so P22 adds a smoke run inside the built image.
- **F18 — The 017 literal-scan test** (`tests/lint/ui-limit-literals.test.ts`) scans a fixed list of UI files. It looks for `image/…` MIME literals, counting-rule names and declared capability numbers of 100 or more. It must grow to cover the new upload files, `video/…` literals and the library limits (FR-036).
- **F19 — Same-origin protection already covers a chunk route.** `checkSameOrigin` refuses a cookie-bearing `PUT` without a matching `Origin`. Browsers send `Origin` on same-origin XHR `PUT`. No change is needed.
- **F20 — Cross-project work goes through `crossProject(reason, fn)`** (`src/server/dal/scope.ts`), as housekeeping does. The scope-check test accepts only that route for unscoped reads, so the worker's claim query and the upload expiry use it (P8, P2).

## Decisions (P)

### P1 — Every upload is a presigned S3 multipart upload driven by small JSON server actions

- **Decision:** images and videos, in the library and the picker, use one flow (D1):
  1. `createUpload` (CreateMultipartUpload; persists the session) →
  2. `signUploadParts` (batches of presigned `UploadPart` URLs) →
  3. the browser `PUT`s each part with XHR →
  4. `completeUpload` (ListParts → CompleteMultipartUpload → processing) or `cancelUpload` (AbortMultipartUpload).

  `listUploadedParts` serves Retry. The calls are server actions in `src/app/p/[projectSlug]/media/upload-actions.ts`, using the existing `runAction` pattern, so membership and role are resolved on every call.

  The part size is fixed per upload: `max(8 MiB, ceil(size / 10,000))`, rounded up to a whole MiB. Every part but the last has exactly that size, which R2 requires. Parts are 1 to 10,000. 8 MiB covers files up to 78 GiB, so the formula's second term never applies under the 4,096 MB ceiling, but it is kept so the rule matches the research. A file under 8 MiB is one part, which is also the last part, so its size is unrestricted.
- **Rationale:** this is the operator's choice and research recommendation 1. Video bytes never touch the app (SC-001). A request to Docket is a few hundred bytes of JSON. The same flow for images means one implementation and one set of tests.
- **Alternatives:**
  - Keep the buffered server action for images. That leaves two paths and no real progress for images; the roadmap asks for progress on every upload.
  - tus (research §2). Three dependencies, and every byte through the app.
  - Route handlers instead of server actions for the JSON calls. This needs no CSRF work either way, but server actions are the project's pattern and are typed end to end.

### P2 — Upload sessions are rows, owned by one member, capped, and expired by housekeeping

- **Decision:** a new project-owned table `media_uploads` (data-model §2).
  - **Contents.** It records the owner (`created_by_user_id`), the file name, kind, declared type and size, part size and count, transport, staging key, the storage `UploadId`, the state and timestamps.
  - **Access.** Sign, list, complete and cancel load the row through the scoped DAL and require that the caller is the owner and still has `media: edit`. Anyone else gets `NotFoundError`. A removed or signed-out member gets `not_found` from `runAction`, which the UI words as "You no longer have access to this project".
  - **Per-member cap.** `createUpload` counts the caller's `open` and `completing` sessions in the project after locking the caller's own membership row: Better Auth's `member` row with `organization_id` = project, through a new `members.lockSelf(userId)` (`FOR NO KEY UPDATE`, in its own statement). This serialises concurrent creates by the same member without an advisory lock (constitution: no session-level features). The count is scoped to the project, which is the scope every DAL call has. At `MEDIA_MAX_OPEN_UPLOADS` (default 10) it refuses with "You have 10 uploads in progress. Wait for some to finish."
  - **Expiry.** `runHousekeeping` gains `expireUploads`. Through `crossProject`, it takes at most 20 sessions per tick that are `open` and older than `MEDIA_UPLOAD_EXPIRY_HOURS` (default 24), or `completing` and older than 1 hour (a crashed completion). For each it calls `abortMultipart` (5 s timeout, idempotent), deletes the staging object, and sets the state to `expired`. Housekeeping runs wherever the scheduler runs, worker or in-process, so expiry needs no ffmpeg and works without a worker container. FR-011's "in the worker" holds for the default deployment. The bucket lifecycle rule is the documented backstop.
- **Rationale:** FR-010 and FR-011. Also, CreateMultipartUpload must happen on the server, and the `UploadId` must survive a Retry.
- **Alternatives:**
  - Keep session state only in the browser. The server could not then enforce ownership, the cap or expiry.
  - A separate cleanup loop. Housekeeping already exists, is bounded and is safe to run concurrently.

### P3 — Presigning uses its own client, the browser-facing endpoint and `WHEN_REQUIRED` checksums

- **Decision:** `createS3Storage` builds a second `S3Client` used only for `signPart`.
  - **Endpoint.** It uses `S3_BROWSER_ENDPOINT` when set, else `S3_ENDPOINT`, else the SDK default. Region, path style and credentials are the same as the main client.
  - **Checksums.** It always uses `requestChecksumCalculation: "WHEN_REQUIRED"`, whatever `S3_CHECKSUMS` says. The browser cannot compute an `x-amz-checksum-*` value (research, "Checksum caveat").
  - **Expiry and batching.** URLs live 3,600 s. The client asks for at most 20 part numbers per call, just before it needs them.
  - **Refused PUTs.** On a `403` from storage, the client asks for that part's URL again once, without the person doing anything, then retries the part. A second `403` is a storage error on the row ("Storage refused the upload"). This handles expired signatures, the edge case of signatures expiring during a slow upload, without telling "expired" apart from "forbidden", which the browser cannot do reliably.

  Presigned URLs and `UploadId`s are never logged. `StorageError` already hides SDK detail.
- **Rationale:** the signature covers the host, so a URL signed for `http://minio:9000` fails from the browser (research §1, MinIO). R2 presigned URLs work only on the S3 API domain, which is `S3_ENDPOINT` (research §1, R2).
- **Alternatives:** rewriting the host of a URL signed for the internal endpoint (this breaks SigV4); one client with a per-call endpoint (the SDK binds the endpoint per client).

### P4 — Completion is built from the bucket's own part list, checked, and idempotent

- **Decision:**
  1. `completeUpload` moves the session `open → completing` in a short transaction (row `FOR UPDATE`).
  2. Outside the transaction, it calls `listParts`, paginated with `PartNumberMarker` at 1,000 parts per page (F8). It requires parts `1..part_count`, each `Size` equal to `part_size` except the last, which must equal `declared_bytes - (part_count - 1) × part_size`.
  3. It then calls CompleteMultipartUpload with those `{PartNumber, ETag}` pairs. The browser never reads `ETag` (research recommendation 2).
  4. A missing part or a wrong size moves the session back to `open`, with the reason "Some parts did not arrive. Retry to send them." A mismatch on the total declared size, or a size above the kind's library limit, refuses the upload: the session becomes `refused`, the upload is aborted and the staging object removed (edge case "declared size differs").
  5. If ListParts answers `NoSuchUpload` while the session is `completing`, a previous attempt already completed it. `headObject(staging)` is checked against `declared_bytes` and the flow continues. So a Retry after a lost response neither fails nor duplicates.
  6. A second `completeUpload` on a `completed` session returns the same asset.
- **Rationale:** FR-015, FR-017 and the "declared size differs" edge case. Reading the part list on the server removes the one CORS header (`ExposeHeaders: ETag`) most likely to be missing.
- **Alternatives:** trusting browser-reported ETags (needs the CORS exposure, and is spoofable); `HeadObject` only (cannot tell which part is missing).

### P5 — The through-the-app fallback is a chunk route that forwards each chunk as the same part

- **Decision:** with `MEDIA_UPLOAD_TRANSPORT=via_app`, `createUpload` still creates the multipart upload on the server. `signUploadParts` returns Docket's own URL per part instead of a bucket URL: `PUT /p/<slug>/media/uploads/<uploadId>/parts/<n>`, a route handler (F9).
  - **Route.** The handler resolves the session and the owner exactly as the actions do. It requires `Content-Length` to equal the expected length of part `n`, reads the body, and requires the received length to equal it too. A short body is answered `400` "The chunk arrived incomplete", which is the silent-truncation guard from research §3. It then calls `storage.uploadPart` on the server.
  - **Size guard.** The chunk is the part, 8 MiB. A module-level assertion and a unit test require `PART_SIZE + 1 MiB ≤ UPLOAD_BODY_LIMIT`, so the app never accepts a configuration whose own limit cannot fit one chunk. The front proxy's limit is documented: allow at least 9 MB per request on Docket's host.
  - **Shared steps.** Progress, Retry (ListParts), Complete and Cancel are the same code as the direct path.
- **Rationale:** D6, research recommendation 4, and FR-015's received-length check. Reusing the multipart session means R2's equal-part rule and the completion checks hold unchanged.
- **Alternatives:** tus (three dependencies); `PutObject` per chunk plus a server-side concatenation (doubles storage traffic).

### P6 — The CSP gains the upload origin in `connect-src` and a `media-src`

- **Decision:** `buildCsp` takes `uploadOrigin: string | null` and `publicMediaOrigin`.
  - `connect-src 'self'` gains `uploadOrigin` when the transport is `direct`.
  - A new `media-src 'self' blob: https:` plus the `http:` public media origin, the same rule `img-src` already has.

  `uploadOrigin` is computed in `src/lib/storage/upload-origin.ts` by a pure function of the storage settings. It uses `S3_BROWSER_ENDPOINT ?? S3_ENDPOINT`, path style or virtual-hosted (`<bucket>.<host>`), and the AWS default host when no endpoint is set. `src/proxy.ts` reads it from `process.env`, as it already does for `S3_PUBLIC_BASE_URL`. A unit test checks the helper against the **SDK's own** presigned `UploadPart` URL origin for every combination: AWS default, R2-style endpoint, MinIO path style, and the browser endpoint set. Presigning is offline, so the test needs no network. The helper's host rules are therefore proved against the SDK rather than remembered.
- **Rationale:** F3. Without it, direct upload and playback fail in every browser.
- **Alternatives:**
  - `connect-src https:`. Too broad, since it would let any script exfiltrate to any host.
  - Importing the SDK into the proxy to presign at request time. Heavy, async, and per request.

### P7 — Images are processed in the web process, synchronously, when their upload completes

- **Decision:** for `kind = image`, `completeUpload`:
  1. reads the staging object (at most `MEDIA_MAX_UPLOAD_MB`, ≤ 25 MB, the same memory bound as today);
  2. runs the existing `processUpload`, which judges by contents, strips metadata and makes the thumbnail, with today's limits;
  3. writes `original.<ext>` and `thumb.webp` with `put`;
  4. inserts the `media_assets` row as `ready` through the existing `commitUpload`;
  5. deletes the staging object and marks the session `completed`.

  A refusal (`unsupported_type`, `animated`, `too_many_pixels`, `unreadable`, `too_large`) returns today's code and message, removes the staging object and marks the session `refused`. The row shows "Processing" while this call runs, and then ready or refused (FR-022).
- **Rationale:** D1 leaves the place open. sharp already runs in the web process, an image needs no worker, and deployments that run the scheduler in-process keep working for images exactly as before. Results and messages are unchanged because the same function runs on the same bytes.
- **Alternatives:** process images in the worker. This adds up to one worker poll of latency to every image, and breaks image upload where no worker container runs.

### P8 — Videos are processed by a worker-only media loop that claims rows with a lease

- **Decision:**
  - **At completion.** For `kind = video`, `completeUpload` inserts the `media_assets` row as `processing_state = processing`, `processing_step = queued`. Its `storage_key` and `public_url` already point at the **final** key (`media/<id>/original.<mp4|mov>`, with the extension from the declared type), and `source_storage_key` is the staging key. The session becomes `completed` with `media_asset_id`.
  - **The loop.** `src/worker.ts` starts `runMediaLoop({ signal })` from `src/server/video/loop.ts` next to `runLoop(runTick)`. It is never started by `instrumentation.ts`, and `runTick` never imports it (F1). Each pass:
    - **Claim:** through `crossProject`, select one row with `processing_state = 'processing' AND kind = 'video' AND (processing_lease_until IS NULL OR processing_lease_until < now())`, oldest first, `FOR UPDATE SKIP LOCKED`. Set `processing_lease_until = now() + 120 s`, a fresh `processing_lease_token`, `processing_attempts + 1` and `processing_step = 'probing'`, then commit. A row whose `processing_attempts` is already 3 is marked `failed` ("Docket could not process this video after 3 attempts") instead of being processed.
    - **Process** outside any transaction (P9). Every 30 s, renew the lease with `UPDATE … WHERE id = $1 AND processing_lease_token = $2`. If no row is updated, the lease was lost, and the run aborts (kills ffmpeg) without writing.
    - **Finish** with one conditional update: `ready` with facts, or `failed` with a reason, `WHERE processing_lease_token = $2 AND deleted_at IS NULL`. If the row was deleted meanwhile, the objects just written are deleted.
    - **Idle poll** every 2 s when nothing is claimable. At most one video is processed at a time per worker process. Several workers are safe through `SKIP LOCKED` and the lease token.
  - **Shutdown.** On SIGTERM, the loop's signal aborts the running ffmpeg (P9). The claim is then released (`processing_lease_until = NULL`, `processing_attempts - 1`, step back to `queued`), so a deploy never uses up attempts. A crash leaves the lease to expire, and that attempt counts (FR-021, US2 AS4).
  - **Bounds.** Each command has a time limit (P9), and the whole item has a 30-minute deadline, so a run is bounded. It cannot be bounded "well under 30 s" like `runTick`, which is why it is not in `runTick` (Complexity Tracking).
- **Rationale:** FR-016 and FR-021, SC-006 and SC-007, the constitution's claim rules, and no `LISTEN` (Neon pooler). Polling a partial index every 2 s is one cheap indexed query.
- **Alternatives:**
  - A `runTick` section. It can run in the web process (F1) and cannot be bounded under 30 s.
  - A queue or Redis. That is new infrastructure (constitution VI).
  - A separate `media_jobs` table. More rows and joins for state that belongs to the asset.

### P9 — The video pipeline: commands, order and limits

- **Decision:** `processVideo(row)` in `src/server/video/process.ts`, inside `fs.mkdtemp(os.tmpdir() + "/docket-video-")`, which is removed in `finally`:
  1. **Disk check.** `statfs(tmpdir)` must show at least `2 × byte_size + 64 MiB` free. If not, the item fails this attempt with the operator log line "not enough temporary disk for <bytes>". The item stays claimable until its attempts run out.
  2. **Download** the staging object to `source` with `storage.getToFile` (a streamed `GetObject` → `pipeline` → file), with the loop's signal and a 30-minute cap.
  3. **Sniff** the first 64 bytes with the shared `sniffMedia` (P12). Anything but `mp4`/`mov` fails: "This is not an MP4 or MOV video."
  4. **Probe** with `ffprobe -v error -of json -show_streams -show_format source` (60 s), parsed by P11. A non-zero exit or unparsable JSON fails: "Docket could not read this video." No video stream fails: "This file has no video." Duration above `MEDIA_MAX_VIDEO_SECONDS`, size above `MEDIA_MAX_VIDEO_MB`, or a displayed side above 4,096 px fails, with the limit and the value ("Videos can be up to 15 minutes; this one is 20 minutes").
  5. **Clean** (D9, P10): `ffmpeg -nostdin -hide_banner -loglevel error -y -i source -map 0:v:0 -map 0:a:0? -c copy -map_metadata -1 -map_chapters -1 -f <mp4|mov> clean.tmp`. The time limit is 10 minutes, or 60 s + 1 s per 20 MB, whichever is shorter. Then probe `clean.tmp` and verify it (P10). On success, rename it to `clean`. The step stays `probing` ("Processing: reading the video") through steps 2 to 5.
  6. **Poster.** Set step `poster`. Run `ffmpeg -nostdin -hide_banner -loglevel error -y -ss <t> -i clean -frames:v 1 -an -f image2 -c:v png poster.tmp.png` (60 s), with `t = min(1, duration / 2)` (FR-019, research §4.1). Rename on success. The thumbnail is made with the same sharp code as image thumbnails (`makeThumbnail`, extracted from `processUpload`), 480 px inside, WebP.
  7. **Store** `clean` at `storage_key` with `storage.putFile` (a streamed server-side multipart upload with 16 MiB parts, so neither memory nor the single-PUT size matters), and the thumbnail at `thumb.webp` with `put`.
  8. **Finish** as `ready` with facts (P11), `mime_type` from the container (`video/mp4` or `video/quicktime`) and `byte_size` of `clean`. Then delete `source_storage_key` and clear it.

  A failure at any step marks the row `failed` with its reason. The worker deletes the staging object and anything it wrote, and the asset's `storage_key` object never exists (FR-017).

  **Spawn rules** (`src/server/video/spawn.ts`, the only file that imports `node:child_process`):
  - argument arrays and no shell;
  - `stdio: ["ignore", "pipe", "pipe"]` plus `-nostdin`;
  - `timeout` and `killSignal: "SIGTERM"`, with `SIGKILL` 5 s later;
  - the loop's `AbortSignal` passed as `signal`;
  - the last 8 KB of stderr kept and the rest discarded, and stdout capped at 4 MB (ffprobe JSON);
  - resolution on `close`, not `exit`, since stdout may still be open after `exit` (research §3.1).

  Any non-zero exit or signal makes the output invalid. Outputs are written to `*.tmp` and renamed only on exit code 0 (FR-016). ffmpeg's own stderr goes to the worker log, truncated, together with the asset id. It is never shown on the item, which says "Docket could not process this video" (edge case "ffmpeg missing or broken"). A missing binary (`ENOENT`) logs "ffmpeg/ffprobe is not installed in this image".
- **Rationale:** FR-016 to FR-020, research §3 and §4.1, D9.
- **Alternatives:**
  - Probing a presigned URL over HTTP instead of downloading. That ties ffmpeg to the network and the bucket, and cleaning needs a local seekable output anyway (research §3.2: MOV/MP4 cannot be written to a pipe).
  - Poster from the source, before cleaning. The poster would then come from bytes Docket does not store.

### P10 — Metadata is removed by remuxing, then verified; nothing unverified is stored

- **Decision:** the clean step copies the first video stream and the first audio stream, if any, without re-encoding. It drops global, stream and chapter metadata, and it writes the same container family as the source (`-f mp4` or `-f mov`). It does not use `+faststart`. That keeps temporary disk at about twice the file (source plus clean), as FR-040 documents. Moving the index is a formatter concern (entry 6), and range requests already let browsers play files whose index is at the end.

  **Verification** of `clean.tmp` before it is used. Any failure marks the item failed with "Docket could not process this video", and the source is never stored instead (D9):
  - **Facts.** Duration within 0.1 s, the same codecs, and the same **displayed** width and height (rotation applied) as the source probe.
  - **Tags.** The format tags of the clean probe are a subset of `{major_brand, minor_version, compatible_brands, encoder}`, and stream tags are a subset of `{handler_name, vendor_id, language, encoder}`. Whatever ffmpeg itself writes for the container is allowed; anything about the person or the device is not.
  - **Rotation.** If the clean probe's rotation differs from the source's, the clean step is run once more with the rotation re-applied. It uses `-display_rotation:v:0 <deg>` as an input option where the binary accepts it, else `-metadata:s:v:0 rotate=<deg>`. Which one Debian's 5.1 accepts is UNVERIFIED, and the in-image smoke run decides it (P22). If the rotation still differs, the item fails.
- **Rationale:** D9 and FR-020. Research §4 marks rotation side-data and option behaviour UNVERIFIED, so the pipeline checks its own output instead of trusting the command.
- **Alternatives:**
  - Re-encoding. Forbidden by FR-043, and slow.
  - Leaving metadata. Forbidden by D9.
  - `-map 0` (all streams). MOV data and timecode tracks can make the MP4 muxer fail, and are not needed for playback.

### P11 — How video facts are read from ffprobe

- **Decision:** the pure parser `parseProbe(json)` in `src/server/video/probe.ts` reads:
  - **Video stream.** The first stream with `codec_type = "video"`, ignoring attached pictures (`disposition.attached_pic = 1`). None means "This file has no video".
  - **Codecs.** `videoCodec` is that stream's `codec_name` (`h264`, `hevc`, …). `audioCodec` is the first `codec_type = "audio"` stream's `codec_name`, or `null` for no audio ("no audio" in the UI).
  - **Duration.** `format.duration`, else the video stream's `duration`, parsed as a float. Missing, not finite or ≤ 0 fails ("Docket could not read this video"). It is stored as milliseconds.
  - **Frame rate** (spec edge case "variable frame rate"). It is the stream's **`avg_frame_rate`** as a fraction, falling back to `r_frame_rate` when `avg_frame_rate` is `0/0`, and stored rounded to 3 decimals. *Why `avg`:* `r_frame_rate` is the stream's base rate, which for a variable-rate phone clip can be far above its real rate, so a cap check on it would refuse clips that play at 30 fps. The average is what a person would call the clip's frame rate, and is the safer side for "up to 60 fps". The field names come from ffprobe's JSON (research §4.8 names `r_frame_rate`). `avg_frame_rate` is UNVERIFIED there and is confirmed by the fixture test (testsrc at 15 fps gives 15).
  - **Rotation.** From the video stream's `side_data_list` entry carrying `rotation`, else `tags.rotate`. When `|rotation| mod 180 = 90`, width and height are swapped. Both field names are UNVERIFIED (research §3.3), and the rotated-fixture test confirms whichever ffmpeg writes.
  - **Pixel aspect.** Sample aspect ratio is ignored. Width and height are coded pixels with rotation applied. Recorded as a known approximation; non-square-pixel phone video is rare.
  - **Container.** It comes from the sniff (P12), not from `format_name`, which names a demuxer family ("mov,mp4,…"). `format_name` must contain `mov` or `mp4`, otherwise the file fails as "not an MP4 or MOV video".
- **Rationale:** FR-018, the spec's edge cases, and US2 AS2.
- **Alternatives:** `r_frame_rate` (refuses real VFR clips); `nb_frames / duration` (absent in some containers).

### P12 — One content sniffer for the browser and the worker

- **Decision:** `src/lib/media/sniff.ts` (client-safe and pure) exports `sniffMedia(bytes: Uint8Array) → { kind: "image" | "video"; mimeType; container? } | null` from the first 64 bytes.
  - **Images.** JPEG `FF D8 FF`; PNG `89 50 4E 47 0D 0A 1A 0A`; WebP `RIFF????WEBP`.
  - **ISO BMFF / QuickTime.** Bytes 4–8 are `ftyp`. A major brand of `qt  ` is `mov` (`video/quicktime`), and any other brand is `mp4` (`video/mp4`). Legacy QuickTime without `ftyp` is `mov` when bytes 4–8 are `moov`, `mdat`, `wide`, `free`, `skip` or `pnot`.

  The browser uses it to refuse a renamed PDF before upload. The worker uses it to set the container. These magic numbers are file-format facts, not platform APIs. Their test runs against **ffmpeg-generated** `-f mp4` and `-f mov` fixtures and sharp-generated images in CI, so they are proved by a run (constitution II). The legacy no-`ftyp` forms are best effort, since ffprobe on the worker re-judges.
- **Rationale:** the "renamed file" edge case and US1's renamed PDF. FR-004 asks for type by contents in the browser where possible. One function means the browser and the server agree.
- **Alternatives:** `File.type` or the extension (a renamed file fools both); mp4box (not installed, `NEEDS DEPENDENCY` and not wanted, per spec assumption 8).

### P13 — Browser checks run before any byte is sent, in a fixed order, against served limits

- **Decision:** for each chosen file, in `src/lib/upload/precheck.ts` (pure) plus the browser adapter `src/components/media/upload/read-video.ts`:
  1. **Sniff** the first 64 bytes (`file.slice(0, 64)`). Unknown, or not in `limits.<kind>.types`, is refused with "This is not a JPEG, PNG or WebP image, or an MP4 or MOV video." The type labels come from the served labels.
  2. **Size** against `limits.<kind>.maxBytes` ("Videos can be up to 1024 MB; this one is 1310 MB").
  3. **Video metadata.** An off-DOM `<video preload="metadata">` on an object URL (research §5), resolving on `loadedmetadata`, `error` or a 10 s timeout, after which the URL is revoked.
     - With finite `duration > 0` and `videoWidth > 0`: check duration against `maxSeconds` and `max(videoWidth, videoHeight)` against `maxSide`. The max-side check is the same whatever the rotation, so the browser's unverified rotation handling cannot cause a false refusal.
     - `videoWidth === 0` after `loadedmetadata` is refused: "This file has no video" (audio-only M4A).
     - `error`, a timeout, or an infinite or NaN duration means "could not read". The file is uploaded and the row says "Checks happen after upload" (FR-005).

  Limits come from `mediaStatus(scope).limits` (data-model §4), which the pages already load. The same values feed the server's checks, so nothing is written twice (FR-004, FR-036). Refusal messages are built by the pure wording helper `src/components/media/upload/upload-ui.ts` from those values. A refused file sends zero bytes and never calls `createUpload` (SC-002).
- **Rationale:** FR-004 and FR-005, SC-002, and the spec's browser edge cases.
- **Alternatives:** reading megapixels in the browser (`createImageBitmap`). Not required by FR-004. The server refuses as today.

### P14 — The client upload engine is pure, with three files in flight and one part in flight per file

- **Decision:** `src/lib/upload/engine.ts` exports `createUploadEngine({ transport, status, limits, sniff, readVideo, clock })`, a framework-free state machine. React subscribes to it through `useSyncExternalStore` in `UploadPanel`.
  - **States per file** (FR-002): `checking`, `refused`, `waiting`, `uploading`, `interrupted`, `cancelled`, `processing`, `ready`, `failed`. Each has `bytesSent`, `total`, `reason` and `step`.
  - **Concurrency** (D12, FR-006). At most 3 files are `uploading`, started in the order chosen. A refused, failed or cancelled file frees its slot at once, and the others are untouched.
  - **Parts.** One part in flight per file, in ascending order. Progress is `confirmedBytes + loaded` of the part in flight. Three files at once already keep a home link busy, and one part per file keeps progress monotonic and Retry exact. *Reverse:* raise it in one constant.
  - **Automatic retry.** A part that fails on the network (XHR `error` or `timeout`, status 0) is retried twice after 1 s and 4 s. After that the file is `interrupted`, with reason "Upload interrupted: the connection was lost". A `4xx` from Docket ("server refusal") or a second `403` or any `5xx` from storage ("storage failure") goes to `interrupted` at once with its reason (FR-007).
  - **Retry** (FR-008). Calls `listUploadedParts`, sets `bytesSent` to the confirmed sum (the bar resumes there and does not start at zero, US1 AS6), and re-sends only the missing parts. A failed part is never treated as stored, so on R2 a failed replacement is re-sent in full (edge case). This makes SC-003 hold by construction: the bytes re-sent are at most the missing bytes.
  - **Cancel** (FR-009). Aborts the XHR, then calls `cancelUpload` (AbortMultipartUpload and staging delete), then sets `cancelled`.
  - **Leaving the page** (FR-012). The panel registers `beforeunload` (`preventDefault`) while any file is `checking`, `waiting` or `uploading`.
  - **Announcements** (FR-003, SC-010). `milestonesCrossed(prevPct, pct)` emits 0, 25, 50, 75 and 100, at most once each per file. The engine also emits error, ready and failed events. The panel words them into one polite `LiveRegion`.

  The transport interface is `sendPart(url, blob, { onProgress, signal }) → { status }`. The browser implementation `xhrTransport` uses `XMLHttpRequest.upload.onprogress` (research §4). Tests inject a fake transport that reports progress, drops connections and refuses.
- **Rationale:** F11 makes the logic testable in Node, which covers the spec's upload tests (progress, mid-upload failure with retry, browser refusal, processing to ready and failed). The spec requires the 3-file cap; the per-file part count is a plan choice.
- **Alternatives:** a React reducer holding the logic (untestable without a DOM); several parts in flight per file (more code for marginal speed at home upload rates).

### P15 — Processing state reaches the row by polling a status action every 2 s

- **Decision:** `mediaProcessingStatusAction(slug, { ids })` (≤ 50 ids) returns, per asset, `{ id, status, step, error, waitingForWorker, item? }`:
  - `item` is the full `MediaView` once ready;
  - `waitingForWorker` is true when the step is `queued` and the row is older than 30 s by the DB clock.

  The panel polls every 2 s while any row is `processing`, and stops when none is. So a server-side change appears within 2 s plus one request, which is under the 5 s of FR-013 and SC-006. The composer runs the same poll for attached items that are not ready, and re-runs its check when one changes, so the blocking "still processing" issue clears by itself (D8, US3 AS5). No reload is involved.
- **Rationale:** there is no `LISTEN` on Neon's pooler, and server-sent events would need a long-lived route through the proxy. A 2 s poll of at most 50 primary-key rows is cheap.
- **Alternatives:** SSE or websockets (long-lived connections through the proxy and reverse proxies); a worker heartbeat (the row's own age is enough to say "waiting for the worker").

### P16 — Video capabilities and validation live in the shared validator

- **Decision:**
  - **Capability shape.** `ProviderCapabilities` gains a **required** `video` block. Required, so every provider says where it stands (FR-024, FR-028). It holds:
    - `maxVideos` (0 = none) and `withImages?` (default false);
    - `containers?` (`"mp4" | "mov"`), `videoCodecs?` and `audioCodecs?` (ffprobe codec names), `silentAllowed?` (default true);
    - `maxBytes?`, `minDurationSeconds?` and `maxDurationSeconds?`;
    - `minWidth?`, `maxWidth?`, `minHeight?` and `maxHeight?`;
    - `minAspectRatio?`, `maxAspectRatio?` and `maxFrameRate?`.

    An undeclared optional field means no limit Docket checks.
  - **What items carry.** `MediaItem` gains `kind?: "image" | "video"` (absent = image, so existing callers and provider tests are unchanged), `status?: "processing" | "ready" | "failed"`, `failureReason?` and `video?: { container, durationSeconds, frameRate, videoCodec, audioCodec }`.
  - **Image rules.** `validateAgainstCapabilities` runs the image rules only on image items, and `too_many_images` counts images only.
  - **Video rules,** on video items, each an `error` on `media.<i>` naming the limit and the value ("This video is 3:42 long; the limit is 1:00"):
    - `video_not_accepted` (`maxVideos = 0`; "This account does not accept video yet." FR-029). It replaces `unsupported_post_type` for that post;
    - `too_many_videos` and `video_with_images`;
    - `video_container_not_allowed`, `video_codec_not_allowed`, `audio_codec_not_allowed` and `audio_required`;
    - `video_too_large`, `video_too_short` and `video_too_long`;
    - `video_too_small` and `video_too_big` (width or height);
    - `video_aspect_out_of_range` and `video_frame_rate_too_high`.
  - **Not-ready items.** Any item whose `status` is `processing` or `failed` adds `media_processing` ("Video 1 is still processing.") or `media_failed` ("Video 1 failed: <reason>. Remove it to continue."). The same goes for images, which in practice are never processing. These are blocking (D8), before any limit check on that item.
  - **Post type.** `inferPostType` returns `"video"` when any item is a video, so a provider without `video` in `postTypes` cannot take one.
  - **Planner.** `planFor`, `adaptedMediaFor`, `prepareVariants` and `resolvePublishMedia` pass video items through as they are. A video never gets an image variant, and is never converted (FR-043). `resolvePublishMedia` still checks that the stored object exists.

  The rows that build `MediaItem` (`itemOf`, `targets.effectiveContent`, the compose check) copy `kind`, `status`, `failureReason` and the video facts from `media_assets`.
- **Rationale:** F4 and F5. One implementation for the composer, the gate and the engine (FR-025). Making the block required stops a future provider silently accepting video by omission.
- **Alternatives:**
  - An optional `video` block, absent = none. Implicit, and FR-028 asks for an explicit declaration.
  - A separate `validateVideo` called by each caller. This breaks constitution IV.

### P17 — The requirements summary gains a `video` part; fit badges cover videos

- **Decision:**
  - **Summary.** `requirementsOf` adds `video`. It carries `maxVideos` and `withImages`, labelled container, codec and audio lists, `silentAllowed` (each list `[]` when undeclared), `maxBytes` (`Labelled` or `null`), and `duration`, `width`, `height` and `aspectRatio` `Range`s. Its labels are:
    - `ratioLabel`, a new helper that renders `9 / 16` → `9:16` and `16 / 9` → `16:9`;
    - `durationLabel`: `60 s` → `1 minute`, `900 s` → `15 minutes`, `75 s` → `1:15`;
    - `fpsLabel`: `60 fps`;
    - codec labels: `h264` → `H.264`, `hevc` → `HEVC`, `aac` → `AAC`, `mp4` → `MP4`, `mov` → `MOV`, from client-safe maps in `src/lib/media/types.ts`.

    The `text`, `image` and `post` parts are computed exactly as before, and the existing `aspectLabel` is untouched (FR-026). `RequirementsSummary.tsx` gains a "Video" line: "Video: not accepted yet" when `maxVideos = 0`, otherwise the list, with "no limit Docket checks" for each `null`.
  - **Badges.** `fitOf(asset, provider)` returns no badge for a video that is not `ready` (the UI says "Badges appear when processing finishes"). For a ready video it builds the `MediaItem` and runs `validateAgainstCapabilities` on a one-item post, keeping the media errors, with "Video 1" reworded to "This video". The result is `fits` or `refused` with those sentences, never `converted` (FR-027).
- **Rationale:** D10 of 017 reserved a `video` sibling. The badge uses the validation check itself, so the two cannot disagree (SC-008).
- **Alternatives:** relabelling the image `aspectLabel` for ratios above 1 (would change the image part, against FR-026).

### P18 — Mock video: declared limits and a real multi-step publish

- **Decision:**
  - **Capabilities.** The mock declares `video: { maxVideos: 1, withImages: false, containers: ["mp4", "mov"], videoCodecs: ["h264"], audioCodecs: ["aac"], silentAllowed: true, maxBytes: 50_000_000, minDurationSeconds: 1, maxDurationSeconds: 60, minAspectRatio: 9 / 16, maxAspectRatio: 16 / 9, maxFrameRate: 60 }` and adds `"video"` to `postTypes` (FR-030).
  - **Step input.** `StepContent` gains `videoCount: number`. `contentShape` counts the post's live media rows with `kind = 'video'` (F6).
  - **Steps.** For a post with a video, `stepFor` and `advance` run `upload_video` (`mayPublish: false`) → continue. Then `check_video` (`mayPublish: false`) answers "still processing" once, as continue with `notBefore` 1 s ahead and `state.videoPolls = 1`, and continues to the publish part the next time. The account's `behaviour` (succeed, multi_step, retryable, fatal, ambiguous, rate_limited, throw) then applies at the publish step exactly as for images (FR-031).
  - **State and logging.** `MockState` becomes `{ done: number; video?: "uploaded" | "polled" }`, and old states without `video` still parse. Each step's attempt summary carries `{ step, mediaKinds }`, so the attempt log shows the steps (US4).
- **Rationale:** US4 and SC-009. The step machine already polls between ticks (spec "current state").
- **Alternatives:** a mock setting to opt into video steps (the default path is what the test must exercise).

### P19 — Library limits and settings

- **Decision:** `src/server/media/limits.ts` exports `libraryLimits(env)`:
  - `image`: `types` = `UPLOAD_MIME_TYPES` (JPEG, PNG, WebP), `maxBytes` = `MEDIA_MAX_UPLOAD_MB` MiB and `maxMegapixels`, as today;
  - `video`: `types` = `VIDEO_UPLOAD_MIME_TYPES` (`video/mp4`, `video/quicktime`, in `src/lib/media/types.ts`), `maxBytes` = `MEDIA_MAX_VIDEO_MB` MiB, `maxSeconds` = `MEDIA_MAX_VIDEO_SECONDS` and `maxSide` = `VIDEO_MAX_SIDE` = 4096.

  It is the single source for the services, the worker and the browser. New settings in `src/server/env.ts`, all documented in `.env.example` (FR-037):

  | Setting | Values | Default |
  |---|---|---|
  | `MEDIA_MAX_VIDEO_MB` | 1–4096 | 1024 |
  | `MEDIA_MAX_VIDEO_SECONDS` | 1–3600 | 900 |
  | `MEDIA_UPLOAD_TRANSPORT` | `direct` \| `via_app` | `direct` |
  | `MEDIA_UPLOAD_EXPIRY_HOURS` | 1–168 | 24 |
  | `MEDIA_MAX_OPEN_UPLOADS` | 1–50 | 10 |
  | `S3_BROWSER_ENDPOINT` | absolute http(s) URL, joins `STORAGE_OPTIONAL` | unset |

  Startup refuses `S3_BROWSER_ENDPOINT` with `http:` when `BETTER_AUTH_URL` is `https:` ("must be https when Docket is served over https"), since mixed content blocks the upload (research recommendation 3). It also refuses `S3_BROWSER_ENDPOINT` together with `MEDIA_UPLOAD_TRANSPORT=via_app` ("not used by the via_app transport"). The expiry cap of 168 h keeps a session inside the 7-day presigned and R2 abort horizon. Labels are MB as `MEDIA_MAX_UPLOAD_MB` already is ("up to 1024 MB").
- **Rationale:** D3, FR-011 and FR-023.
- **Alternatives:** fixed constants for expiry and cap. The spec says "default", so they are settings.

### P20 — Schema: one migration

- **Decision:** migration `0011` (generated by `drizzle-kit`, committed):
  - `media_assets.byte_size` becomes `bigint`, typed as number in TypeScript (F2);
  - `media_assets` gains `kind`, `processing_state`, `processing_step`, `processing_error`, `processing_attempts`, `processing_lease_until`, `processing_lease_token`, `source_storage_key`, `duration_ms`, `frame_rate`, `video_codec`, `audio_codec` and `container`, with checks and a partial index for the claim;
  - a new table `media_uploads`.

  Existing rows get `kind = 'image'` and `processing_state = 'ready'` from column defaults, so nothing about them changes. Keys:
  - **staging:** `projects/<p>/uploads/<uploadId>/source` (`mediaKeys` gains `upload(uploadId)`);
  - **video original:** `media/<asset>/original.mp4|mov` (`Ext` gains `mp4` and `mov`);
  - **poster:** `media/<asset>/thumb.webp`, the same key as image thumbnails.

  Details are in [data-model.md](./data-model.md).
- **Alternatives:** storing processing state on `media_uploads` only. The composer must attach processing items (D8), which needs the `media_assets` row to exist.

### P21 — The web process cannot start ffmpeg: a static import-graph test plus a runtime guard

- **Decision:**
  - **Static test.** `tests/lint/no-ffmpeg-in-web.test.ts` (FR-035, SC-007):
    - walks static and dynamic `import` and `export … from` specifiers, relative and `@/`, starting from every file under `src/app/`, plus `src/proxy.ts`, `src/instrumentation.ts` and `src/server/scheduler/index.ts` (`runTick`, which can run in web per F1);
    - fails if any reached file is under `src/server/video/`;
    - also fails if any file other than `src/server/video/spawn.ts` imports `child_process` or `node:child_process`.
  - **Runtime guard.** `spawn.ts` throws `"ffmpeg may only run in the worker"` unless `markWorkerProcess()` was called. `src/worker.ts` calls it first, and the video tests call it in their setup.
- **Rationale:** a grep alone misses indirect imports, and the import walk proves reachability. The runtime guard catches a dynamic path the walk could miss.
- **Alternatives:** an ESLint `no-restricted-imports` rule (cannot express "reachable from web entries").

### P22 — Packaging and CI

- **Decision:**
  - **Dockerfile.** All stages pin `node:24-bookworm-slim`, so the alias cannot move Debian, or ffmpeg, under the build (research §1.1). The `runner` stage runs `apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*` before `USER nextjs`, and copies `NOTICE` to `/app/NOTICE`. No wrapper library is added (FR-032).
  - **`NOTICE`** at the repository root (FR-033). It says:
    - the Docker image includes FFmpeg (ffmpeg and ffprobe), installed from Debian bookworm's `ffmpeg` package;
    - it is built by Debian with `--enable-gpl` and `--enable-libx264`, so the binaries are licensed under the GNU GPL (research §1.2 and §2);
    - Docket runs them only as separate programs and does not link to them, and Docket's own code stays MIT;
    - the corresponding source is Debian's `ffmpeg` source package for the shipped version (for example `7:5.1.9-0+deb12u1`), at https://sources.debian.org/src/ffmpeg/ and through `apt-get source ffmpeg` on bookworm, with the exact version shown by `dpkg -s ffmpeg` in the image.

    The "separate programs" reading is UNVERIFIED (research §2). The NOTICE states what Docket does, not a legal conclusion.
  - **CI `test` job.**
    - Installs ffmpeg first: `sudo apt-get update && sudo apt-get install -y --no-install-recommends ffmpeg`.
    - `tests/helpers/ffmpeg.ts` makes ffmpeg suites skip with "ffmpeg is not installed; video processing tests skipped" when the binary is missing locally, and **throw** when `process.env.CI` is set (GitHub sets `CI=true`), so CI can never skip them (FR-034).
  - **CI `docker` job.**
    - Builds with `load: true` and `tags: docket:ci`.
    - Runs `ffmpeg -version`, `ffprobe -version` and `ffmpeg -hide_banner -encoders` (checking for `libx264`), all as the image's default user `nextjs`.
    - Runs `docker image ls docket:ci` to log the size.
    - Runs `node scripts/video-smoke.mjs` inside the image. This bundled script (built like `smoke.mjs`) generates landscape, rotated and location-tagged clips with `lavfi`, runs `processVideoFile` (P9 without DB or storage), and asserts facts, cleanliness, rotation and poster. It proves the commands on the image's own Debian 5.1 (F17, research §6).
- **Rationale:** FR-032 to FR-034 and SC-007; spec assumptions 5 and 7.
- **Alternatives:** a static ffmpeg build (research §1.3; rejected by the operator).

### P23 — Fixtures are generated at test time; UNVERIFIED details become assertions

- **Decision:** `tests/helpers/video-fixtures.ts` makes clips in a temporary directory with `lavfi` (research §5):
  - **landscape:** 320×180, 2 s, 15 fps, H.264 + AAC, MP4;
  - **portrait:** 180×320;
  - **silent:** no audio;
  - **mov:** `-f mov`;
  - **rotated:** landscape remuxed with rotation 90, `-display_rotation` with the `rotate` tag as fallback;
  - **located:** `-metadata location=+48.8584+002.2945/`, plus `-movflags use_metadata_tags` if the plain form writes no tag;
  - **audio-only:** M4A;
  - **corrupt:** a valid `ftyp` header followed by random bytes.

  Each generator asserts its own precondition with ffprobe: rotation present, `location` tag present, and so on. So if ffmpeg writes the detail differently, the test fails loudly instead of passing vacuously. The UNVERIFIED items each have an assertion:

  | UNVERIFIED item | Assertion |
  |---|---|
  | `-of json` output shape | parsed by `parseProbe` |
  | rotation field names | the rotated fixture gives displayed 180×320 |
  | `avg_frame_rate` | 15 |
  | duration | within 0.1 s of 2 |
  | metadata removal | no `location` tag, and the string `+48.8584` absent from the stored bytes |
  | rotation kept by the clean step | displayed size unchanged |
  | poster autorotation | the rotated poster is portrait |
  | SIGTERM handling | a long `lavfi` encode is killed by abort, its `.tmp` output is never renamed, and `spawn` reports `killed` |

  The `-progress` keys are not used (processing shows steps, not percent), so that open item is moot.
- **Rationale:** spec assumption 5 and research §5 and §6.

### P24 — The public API reads videos and refuses to upload them

- **Decision:**
  - **Reads.** `MediaSchema` gains `kind`, `processingState` (`processing` / `ready` / `failed`), `processingError` (nullable) and `video` (nullable: `durationSeconds`, `frameRate`, `videoCodec`, `audioCodec`, `container`). The change is additive, so existing clients keep working. `listMedia` and `getMedia` return them (D10). `publicUrl` of a non-ready video names where the file will be, and is documented as usable only when `processingState` is `ready`.
  - **Upload refusal.** `prepareUpload` (API upload) and `prepareFromUrl` (import by URL) sniff the bytes first (P12). A video is refused with `unsupported_media_type` (415) and "Video upload is available in the Docket app; the API accepts images only." (FR-044).
  - **Feature map.** `docs/feature-map.md` records API video upload as not built and unowned.
- **Alternatives:** none. D10 fixed this.

### P25 — The generator never sees videos

- **Decision:** `listIdsForSelection` gains `kind = 'image' AND processing_state = 'ready'` (it serves only the generator's media-library source; F14). `ensureVariant` refuses a non-image asset with "Videos are not sent to the model." This is defence in depth: `llm/images.ts` receives only ids from that source or from posts, whose videos are filtered before it. `docs/feature-map.md` records "generator uses posters" as unowned (D11, FR-045).

### P26 — Views: kind, state, facts and a placeholder for videos without a poster

- **Decision:**
  - **New fields.** `MediaView` gains `kind`, `status`, `processingStep`, `processingError` and `video` (the facts plus server-computed labels `durationLabel`, `frameRateLabel`, `videoCodecLabel` and `audioCodecLabel`, with "no audio" for `null`).
  - **Thumbnail.** For a video that is not ready, `thumbnailUrl` is `/media/video-processing.svg`, a new static file in `public/`, allowed by `img-src 'self'`. Every existing thumbnail consumer (F15) keeps working unchanged and shows the placeholder, then the poster once ready (FR-019, US4 AS3).
  - **Library and picker.**
    - The library lists every live item with its state.
    - A failed item shows its reason and only the Delete action.
    - The card for a ready video shows the poster, a duration badge, and in its detail dialog a `<dl>` of the facts and a `<video controls preload="none">` (US2 AS2).
    - The picker lists `processing` and `ready` items but never `failed` ones (`listMedia` gains `states`).
- **Rationale:** no consumer needs to change to stay correct, and no unready URL is ever put in an `<img>` or `<video>`.

### P27 — Deleting a video

- **Decision:**
  - **Deleting.** `deleteMedia` follows today's delete-impact rules and also deletes `source_storage_key` when set.
  - **Processing items.** A video being processed can be deleted. The worker's finishing update is conditional on `deleted_at IS NULL` and its lease token, so it finds the row gone and deletes what it wrote (P8).
  - **Open uploads.** An open upload session has no asset; Cancel or expiry cleans it.
- **Rationale:** the "deleting a video" edge case.

### P28 — Compose impact and documentation

- **Decision:** **no `docker-compose.yml` edit is required** (F16).
  - **Offline profile.** It needs one new `.env` line, `S3_BROWSER_ENDPOINT=http://localhost:9000`, which `docs/storage.md` and `.env.example` add.
  - **Optional temp-disk edit.** `docs/deployment.md` documents an optional worker volume, `volumes: ["docket-worker-tmp:/tmp"]` under `worker:` plus `docket-worker-tmp:` under `volumes:`, for hosts whose container layer is small. The exact edit is given there and in the release notes, since operators copy the file. It is optional, so the release notes say "no required change".
  - **Docs edits** (FR-037 to FR-041):
    - **`docs/storage.md`:** per backend, CORS, IAM (adding `s3:AbortMultipartUpload` and `s3:ListMultipartUploadParts`, with the research's "confirm the action names" caveat), lifecycle, R2's S3 API domain, https, reverse proxy, the fallback and its 9 MB per-request body;
    - **`docs/deployment.md`:** image size (the number measured in CI), worker CPU and temp disk, and the compose impact;
    - **`docs/limits.md`** and its inventory test;
    - **`docs/adding-a-provider.md`;**
    - **`docs/feature-map.md`;**
    - **`docs/decisions.md`;**
    - **`README.md`:** the media line.
- **Rationale:** FR-040, and the project rule that every compose change is flagged with its exact edit.

### P29 — Shared upload component

- **Decision:** `src/components/media/upload/UploadPanel.tsx` (client) renders the drop area, the "Choose files" button, the help text built from `limits` ("JPEG, PNG or WebP up to 20 MB; MP4 or MOV up to 1024 MB and 15 minutes"), the live region and one `UploadRow` per file.
  - **Library.** `UploadDropzone.tsx` becomes a thin wrapper.
  - **Picker.** `MediaPicker.tsx` uses it with `onUploaded(asset)` to attach each asset as its upload finishes (FR-014).
  - **Removed.** `uploadMediaAction` is removed from both screens. The server action is deleted, and the API keeps its own path (F12).

  The contract is in [contracts/upload-ui.md](./contracts/upload-ui.md). The UI follows the `docket-ui` skill.
- **Rationale:** D1 and FR-001.

### P30 — Out of scope, restated as code boundaries

- **Decision:**
  - No real provider gains video limits. The five real providers declare only `video: { maxVideos: 0 }` (FR-028, FR-042).
  - No ffmpeg command re-encodes or resizes video. The clean step uses `-c copy`, and the poster is one decoded frame (FR-043).
  - Nothing adds `story` or `reel` handling.
  - The ffmpeg modules expose only probe, clean and poster. The formatter (entry 6) adds its own.
