# Bluesky video — verified facts

Checked 2026-10-07. Sources: atproto lexicons (GitHub, `main`), bluesky-social/bsky-docs, bluesky-social/social-app
(the official client, used as the reference implementation), bsky.social help/blog.
Nothing was run against a live account; every flow below is from published lexicons and official source.

## Embed record (`app.bsky.embed.video`)
- Required: `video` (blob). Optional: `captions`, `alt`, `aspectRatio`, `presentation`.
  https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/embed/video.json
- `video` blob: `accept: ["video/mp4"]`, **maxSize 300,000,000 bytes** (lexicon text: "May be up to 300mb, formerly
  limited to 100mb"). Same URL.
  Changed 2026-10-07: the `@atproto/api` changelog records 0.20.39 "Increase video embed size limits from 100MB to 300MB".
  https://github.com/bluesky-social/atproto/blob/main/packages/api/CHANGELOG.md
- `aspectRatio`: `app.bsky.embed.defs#aspectRatio` `{ width, height }`, both integers, **minimum 1**; "may be
  approximate". Optional in the lexicon, but the official tutorial says to compute it (ffprobe or native APIs).
  https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/embed/defs.json
  https://github.com/bluesky-social/bsky-docs/blob/main/docs/tutorials/video.mdx
- `alt`: plain string, no length constraint now (0.20.41 removed `maxGraphemes`/`maxLength` from video `alt`).
  Docket's `maxAltTextLength` for images does not carry over. https://github.com/bluesky-social/atproto/blob/main/packages/api/CHANGELOG.md
- `captions`: array of `{ lang (BCP-47 "language" format), file (blob, accept text/vtt, maxSize 20,000 bytes) }`,
  **maxLength 20**. Captions are uploaded as blobs with `com.atproto.repo.uploadBlob` (UNVERIFIED: the tutorial excerpt
  I could read does not show the caption upload; this follows from the lexicon type `blob`).
  https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/embed/video.json
- `presentation`: hint, known values `default`, `gif`. Same URL.
- `app.bsky.feed.post` `embed` is a union of `images`, `video`, `gallery`, `external`, `record`, `recordWithMedia`
  (so a post has one video **or** images, not both; `gallery` is new on `main`, not researched).
  https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/post.json
  Post text rules (300 graphemes / 3000 bytes) are in `bluesky.md`.
- Embed JSON per the tutorial: `{ $type: "app.bsky.embed.video", video: <blobRef>, aspectRatio: { width, height } }`.
  https://github.com/bluesky-social/bsky-docs/blob/main/docs/tutorials/video.mdx

## Upload flow (the video service, not the PDS)
The video service is `https://video.bsky.app`, DID `did:web:video.bsky.app`.
https://github.com/bluesky-social/social-app/blob/main/src/lib/constants.ts
(`VIDEO_SERVICE`, `VIDEO_SERVICE_DID`). The service processes the file, then **uploads the resulting blob to the user's PDS**
("Upload a video to be processed then stored on the PDS", uploadVideo lexicon).

1. **Service auth token.** Call the user's PDS: `com.atproto.server.getServiceAuth` with params `aud` (required, DID or
   `did#serviceId`, max 2048), `exp` (Unix seconds; **default 60 s from now**; the service may enforce bounds), `lxm` (NSID).
   Error `BadExpiration`.
   https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/getServiceAuth.json
   For the upload the tutorial uses `aud = did:web:<host of the user's PDS>` (the PDS, **not** video.bsky.app),
   `lxm = com.atproto.repo.uploadBlob`, `exp` = now + 30 min (recommended).
   https://github.com/bluesky-social/bsky-docs/blob/main/docs/tutorials/video.mdx
   The official client requests the same `lxm` (`com.atproto.repo.uploadBlob`) for multipart uploads and caches the token
   until 60 s before expiry.
   https://github.com/bluesky-social/social-app/blob/main/src/lib/media/video/multipart/upload.ts
   For `getUploadLimits` the token's `aud`/`lxm` are **UNVERIFIED** (I could not read the tutorial section or client
   code that calls it). The pattern is `aud = did:web:video.bsky.app`, `lxm = app.bsky.video.getUploadLimits`; confirm
   against `@atproto/api` or the social-app source before relying on it.
2. **Upload (single request, legacy-but-documented).** `POST https://video.bsky.app/xrpc/app.bsky.video.uploadVideo`
   with query `did` (user DID) and `name` (file name); headers `Authorization: Bearer <service token>`,
   `Content-Type: video/mp4`, `Content-Length`. Body is the raw MP4. Response: `{ jobStatus }`.
   https://github.com/bluesky-social/bsky-docs/blob/main/docs/tutorials/video.mdx
   https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/video/uploadVideo.json (input `video/mp4`;
   the lexicon declares no query params, the tutorial does).
3. **Upload (multipart, newer).** Lexicons added in `@atproto/api` 0.20.40 and used by the official client:
   - `app.bsky.video.startUpload` (JSON in: `sizeBytes` exact, `mimeType`, optional `name`, advisory `durationMs`,
     `width`, `height`; out: `jobId`, `partSizeBytes`, `partCount`, `expiresAt`). Errors: `UnsupportedContentType`,
     `VideoTooLarge`, `VideoTooLong`, `BadAspectRatio`, `DailyLimitExceeded`, `TooManyOpenUploads`, `UploadForbidden`,
     `ServiceOverloaded`.
   - `app.bsky.video.uploadPart` (params `jobId`, `partNumber` >= 1; body `application/octet-stream`; `Content-Length`
     must match the expected part size exactly; parts are idempotent).
   - `app.bsky.video.getUploadStatus` (state: `created`, `finishing`, `completed`, `failed`, `aborted`, `expired`).
   - `app.bsky.video.finishUpload` (idempotent; returns `completedJobId` and `jobStatus`; **on deduplication
     `completedJobId` may differ from the `jobId`, poll that one**). `app.bsky.video.abortUpload` also exists.
   https://github.com/bluesky-social/atproto/tree/main/lexicons/app/bsky/video (files `startUpload.json`,
   `uploadPart.json`, `finishUpload.json`, `getUploadStatus.json`, `abortUpload.json`)
   Host/auth for the multipart calls: **UNVERIFIED** (not read; assume the same video service and service-auth token).
   Whether single-request `uploadVideo` is deprecated: **UNVERIFIED** (the tutorial still documents it; lexicon has no
   deprecation note).
4. **Poll the job.** `app.bsky.video.getJobStatus?jobId=...` (query, on the video service). Poll until the response's
   `jobStatus.blob` is present (tutorial wording), or `state` is `JOB_STATE_FAILED`.
   https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/video/getJobStatus.json
5. **Create the post** with `com.atproto.repo.createRecord` (`app.bsky.feed.post`), `embed` as above, using the blob
   from `jobStatus.blob` exactly as returned.

### Job status (`app.bsky.video.defs#jobStatus`)
Fields: `jobId`, `did`, `state`, `progress` (0-100, within the current state), `blob`, `error`, `failureCode`, `message`.
https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/video/defs.json
- `state` known values, in order: `JOB_STATE_CREATED`, `JOB_STATE_ENCODING`, `JOB_STATE_ENCODED`, `JOB_STATE_SCANNING`,
  `JOB_STATE_SCANNED`, `JOB_STATE_UPLOADING`, `JOB_STATE_UPLOADED`, `JOB_STATE_COMPLETED`, `JOB_STATE_FAILED`.
  "All values not listed as a known value indicate that the job is in process" -> treat unknown states as still running,
  never as an error.
- `failureCode` known values: `validation_failure`, `encoding_failure`, `pds_upload_failure`,
  `pds_upload_unsupported_blob_size`, `generic_failure`.
- Terminal: `JOB_STATE_COMPLETED` (with `blob`) and `JOB_STATE_FAILED`. Poll interval and total timeout are not
  specified by the docs: **UNVERIFIED**; choose conservatively (several seconds, minutes of total budget).
- `already_exists`: if the upload returns an error saying the video was already processed, the response still carries the
  `BlobRef` from the earlier job, "which you should use". Tutorial URL above. (Exact error shape: **UNVERIFIED**.)

### Upload limits (`app.bsky.video.getUploadLimits`)
Query on the video service, authenticated. Output: `canUpload` (bool, required), `remainingDailyVideos`,
`remainingDailyBytes`, `message`, `error`. If `canUpload` is false the official client shows `message` or "You have
temporarily reached the limit for video uploads. Please try again later."
https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/video/getUploadLimits.json
https://github.com/bluesky-social/social-app/blob/main/src/lib/media/video/upload.shared.ts

## Limits
| Limit | Value | Source |
|---|---|---|
| File size | **300,000,000 bytes** (decimal MB, "ISO megabytes") | embed lexicon; client `VIDEO_MAX_SIZE_MB = 300` (https://github.com/bluesky-social/social-app/blob/main/src/lib/constants.ts) |
| Duration | **UNVERIFIED, see below** | |
| Container | `video/mp4` for the blob. The upload endpoints accept more (client list: mp4, mpeg, webm, quicktime, gif) and the service transcodes | embed lexicon; social-app constants |
| Daily uploads | **25 videos or 10 GB per day per account** | https://bsky.social/about/blog/09-11-2024-video (help text, not a lexicon). Live values come from `getUploadLimits` |
| Email | Bluesky-hosted accounts must have a **verified email** before uploading video; "You must verify your email before you can upload a video" | https://bsky.social/about/blog/09-11-2024-video and the tutorial |
| Captions | up to 20, WebVTT, 20,000 bytes each | embed lexicon |

**Duration conflict (UNVERIFIED).** The official client constant is `VIDEO_MAX_DURATION_MS = 10 * 60 * 1000` (**10 minutes**)
(https://github.com/bluesky-social/social-app/blob/main/src/lib/constants.ts). The bsky.social launch page still says
"up to 60 seconds" (stale, launch-era). User posts mention 3 minutes, which I did not accept as proof. No lexicon states a
duration cap; `startUpload` has a `VideoTooLong` error, so the server enforces one. Treat **3 minutes as a conservative
product limit and 10 minutes as the client ceiling**, and let `VideoTooLong`/`JOB_STATE_FAILED` be authoritative.
The codec, resolution and frame-rate requirements of the service are **not published** in the lexicons I read: UNVERIFIED.
Send H.264/AAC MP4 (the safe common denominator).

The bsky.social page above is Bluesky's own site but is a product/help page, not an API reference; the daily numbers
could change without a lexicon change.

## Auth: can an app password do this?
**Yes, by the PDS source (not tested live).** `getServiceAuth` on the PDS rejects an app-password (non-privileged) session
only when `lxm` is in `PRIVILEGED_METHODS` (chat.bsky.* methods and `com.atproto.server.createAccount`) or in
`PROTECTED_METHODS` (account/email/identity/app-password management: `com.atproto.server.getSession`,
`updateEmail`, `createAppPassword`, etc.). `com.atproto.repo.uploadBlob` and `app.bsky.video.*` are in neither list, so a
plain app password can mint the video service token.
https://github.com/bluesky-social/atproto/blob/main/packages/pds/src/api/com/atproto/server/getServiceAuth.ts
https://github.com/bluesky-social/atproto/blob/main/packages/pds/src/pipethrough.ts
- `exp` bounds enforced by the PDS: not more than **1 hour** ahead; a token with **no `lxm`** is capped at **1 minute**;
  not in the past. Always send `lxm`. (getServiceAuth.ts above.)
- Takendown accounts are blocked. The verified-email rule applies to the account behind the password; a live test with a
  real app-password session is still owed (**UNVERIFIED end to end**).

## `@atproto/api` support
- Docket pins `"@atproto/api": "^0.22.0"` in `package.json`; `pnpm-lock.yaml` and `node_modules` resolve **0.22.0**.
  npm latest is **0.23.2** (checked 2026-10-07, https://registry.npmjs.org/@atproto/api/latest).
- 0.22.0 already includes the video lexicons: `AppBskyVideoGetUploadLimits`/`startUpload` appear in
  `node_modules/@atproto/api/dist/client/index.d.ts` (6 matches). Changelog: video embed support 0.13.5; 300 MB limit 0.20.39;
  multipart lexicons 0.20.40; video `alt` limits removed 0.20.41.
  https://github.com/bluesky-social/atproto/blob/main/packages/api/CHANGELOG.md
- The generated client exposes `agent.app.bsky.video.getUploadLimits()`, `getJobStatus()` etc., but the package does **not**
  do the service-auth dance or talk to video.bsky.app for you. Docket must call `agent.com.atproto.server.getServiceAuth`
  then use `fetch` against `https://video.bsky.app/xrpc/...` (or an `Agent` pointed at the video service with the service
  token as the bearer). The tutorial does this by hand.
- Docket's `src/providers/bluesky/client.ts` builds a plain `Agent` with a static Bearer header (no `CredentialSession`),
  which suits this: the access JWT is passed to the PDS for `getServiceAuth`, the service token is used only for the video host.
- `BlobRef` serialisation: existing image steps persist `BlobRef#toJSON()`; the same works for the video blob.

## Rate limits
Not documented for the video service beyond the daily caps. PDS write budgets (`bluesky.md`) still apply to
`createRecord`. The `uploadBlob` PDS call is performed by the video service, not by Docket.

## Publish-step design notes (facts, not code)
- Steps that do not publish: service-auth, upload, poll. Only `createRecord` may publish, as for images.
- The job survives between ticks, so store `jobId` (non-secret) in step state, never the service token.
- The service token's default life is 60 s; request 30 min only if one tick uploads a large file, else request per step.
- Upload timeout is **not** ambiguous (nothing public yet): retry. After `JOB_STATE_COMPLETED` the blob is on the PDS
  but is unreferenced until `createRecord`, so a retry of the job is safe.
