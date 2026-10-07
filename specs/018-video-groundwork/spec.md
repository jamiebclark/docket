# Feature Specification: Video groundwork

**Feature Branch**: `018-video-groundwork`

**Created**: 2026-10-07

**Status**: Draft

**Input**: User description: "Roadmap entry 2 of 8 ('Video groundwork') from .specify/roadmaps/video.md. Research for this entry: docs/research/upload-transport.md and docs/research/ffmpeg.md; follow their recommendations unless the plan records why not. Operator decisions already made: upload transport is presigned S3 multipart straight from the browser to the bucket, with XHR per part for progress and the server calling ListParts for ETags; a chunked route through the app only as the documented fallback when the bucket cannot be reached from browsers; the browser-facing endpoint is a new optional env var (documented in .env.example and docs/storage.md, with the IAM, CORS and lifecycle notes the research lists). ffmpeg: Debian's apt ffmpeg in the runner image (a GPL build that includes libx264), run only as a separate process via child_process.spawn, no fluent-ffmpeg; a NOTICE entry stating that the image includes GPL ffmpeg and where its source is (Debian's source package); ffmpeg installed in CI for the fixture tests. Record both choices in docs/decisions.md. Deliver: MP4/MOV in the media library with resumable or chunked upload and larger limits; ffprobe metadata (duration, dimensions, codecs, frame rate); poster frames for thumbnails; ffmpeg/ffprobe in the worker image, processing in the worker, not the web process; video capability fields and validation, shown through the requirements summary from entry 1; the mock provider accepts video end to end; document the docker-compose impact. Upload experience for every upload (images too), in both the media library dropzone and the composer's media picker: a per-file progress bar (bytes sent / total, percent, role=progressbar and a polite live region announcing milestones); checks in the browser before any bytes are sent (type, size and, for video, duration and dimensions) using the same limits the server enforces, never duplicated constants; errors as they happen (network drop, server refusal, storage failure) on that file's row with Retry (resuming where it stopped) and Cancel; a processing state per file (probing, making the poster frame) that updates until ready or failed without a page reload; parallel uploads with a small concurrency cap where one failure never hides or stops the others. Testing: the mock provider accepts video end to end; upload tests cover progress reporting, a mid-upload failure with retry, the in-browser refusal using the server's limits, and the processing state reaching ready and failed. Must NOT take on: no real provider publishes video (entries 3 Instagram, 4 Facebook Page, 5 Threads, 7 Bluesky, 8 TikTok); no transcoding, cropping or trimming per target (entry 6); an out-of-range video is reported by validation, not fixed."

## Context and sources

- **Roadmap**: `.specify/roadmaps/video.md`, entry 2 of 8. Goal: platform requirements up front (entry 1, done), then video on every provider, a per-target video formatter and a TikTok provider. This entry builds what every later video entry needs: video in the media library, video metadata and poster frames made in the worker, video capability fields and validation, and an upload experience that works for files of hundreds of megabytes.
- **Current state** (from the roadmap and the code on `main`):
  - The media library accepts JPEG, PNG and WebP only. Each file goes through a server action, one file at a time, as a single request whose body is capped at 26 MB. The server holds the whole file in memory, judges it by its contents, strips its metadata, makes a thumbnail and stores both. The person sees "uploading…" with no progress, and learns of a refusal only after the whole file has arrived. `UploadDropzone.tsx` (media library) and `MediaPicker.tsx` (composer) each have their own copy of this loop.
  - Image limits per file come from configuration (`MEDIA_MAX_UPLOAD_MB`, at most 25, and `MEDIA_MAX_MEGAPIXELS`) and are served to the UI by the media status the pages already read.
  - Entry 1 added a per-account requirements summary to the composer's per-account check, grouped into text, image and post parts, so that a video part could be added beside the image part (017 decision D10). It also added per-platform fit badges (fits / will be converted / will be refused) in the media library and the picker.
  - `PostType` already includes `video`, `story` and `reel`, unused. The publish step machine already supports multi-step publishing with polling between ticks.
  - The `web` and `worker` services run the same published image. The image has no ffmpeg. There is no `NOTICE` file.
- **Research** (phases cannot fetch the web; these files are the only source of external facts):
  - `docs/research/upload-transport.md`: presigned multipart upload from the browser straight to the bucket, driven by small JSON calls to Docket (create, sign parts, list parts, complete, abort); a fixed part size of at least 5 MiB for the whole upload (R2 requires every part but the last to be the same size), at most 10,000 parts; per-part progress through XHR (fetch has no upload progress); the server reads the part list (ListParts, paginated at 1,000) to complete the upload, so the browser never needs to read the `ETag` header; per-backend CORS, IAM and incomplete-upload cleanup (AWS lifecycle rule, R2's default 7-day abort, MinIO's `stale_uploads_expiry`); R2 presigned URLs work only on the S3 API domain; a browser-facing endpoint is needed when the server's endpoint is container-internal (the offline MinIO profile); an `https` page cannot upload to an `http` endpoint; the server-proxied chunk fallback must keep each chunk under the app's 26 MB proxy buffer, which truncates silently. Browser metadata: an off-page video element reads duration and dimensions; it fails on codecs the browser cannot decode (for example HEVC in some browsers), and browser metadata is advisory only.
  - `docs/research/ffmpeg.md`: Debian's apt `ffmpeg` (5.1.x on bookworm, the base of `node:24-slim`) is a GPL build that includes libx264; ffprobe JSON output (`-show_streams -show_format`); a poster frame command (`-ss` before the input, one frame, seek to `min(1 s, duration / 2)`); spawn rules (argument arrays, no shell, `-nostdin`, timeouts, bounded stderr, kill children on worker shutdown, write to a temporary name and rename on success); fluent-ffmpeg is deprecated on npm; fixture clips are best generated at test time with ffmpeg's `lavfi` test sources rather than committed. Several command details are marked UNVERIFIED and must be confirmed by a real run in CI (its section 6).
  - Platform video limits (for later entries, read here only to size Docket's own library limits): Instagram Reels 300 MB and 3 to 900 s, Threads video 1 GB and up to 300 s (`docs/research/meta-video.md`); Bluesky 300,000,000 bytes, duration ceiling 10 minutes in the official client (`docs/research/bluesky-video.md`); TikTok up to 4 GB, 360 to 4,096 px, up to 10 minutes via the API (`docs/research/tiktok.md`).
- **Operator decisions** (fixed before this entry; restated so the plan follows them): the transport is presigned multipart from the browser to the bucket, with XHR per part and the server calling ListParts; a chunked route through the app is the documented fallback only for buckets the browser cannot reach; the browser-facing bucket endpoint is a new optional setting. ffmpeg is Debian's apt package in the runner image, run only as a separate process, never through a wrapper library; the image ships a NOTICE entry for GPL ffmpeg and its Debian source package; CI installs ffmpeg for the fixture tests. Both choices go into `docs/decisions.md`.

## Decisions made while specifying

These are judgement calls. Planning records each one in `docs/decisions.md`.

- **D1 — One upload path for every file.** *What:* images and videos, in the media library and in the composer's picker, all use the same upload flow: checks in the browser, bytes sent to storage with progress, then a processing state until the item is ready or failed. The two screens share one upload component instead of two copies. *Why:* the roadmap asks for the new experience on every upload, and one path means one set of tests. *Consequence:* images keep exactly today's checks and results (judged by contents, metadata stripped, thumbnail made, same size and megapixel limits); only how the bytes travel and how progress is shown changes. Where image processing runs is a planning choice; video processing always runs in the worker (FR-016).
- **D2 — Library limits are separate from platform limits.** *What:* the media library has its own limits per kind (what Docket will store), and each provider has its own video limits (what that platform will take). A video that is within the library limits but outside a platform's limits is stored, and the fit badges and validation say it will be refused for that platform (FR-024, FR-027). *Why:* this matches how images work today, and lets one video be used for several platforms with different limits once entries 3 to 8 land.
- **D3 — The library's video limits.** *What:* new settings for the largest video file (default 1,024 MB, allowed 1 to 4,096 MB) and the longest video (default 900 seconds, allowed 1 to 3,600 seconds), plus a fixed ceiling of 4,096 px on either side. Accepted containers are MP4 and MOV, judged by contents. The image limits stay as they are. *Why:* the roadmap leaves "larger limits" unquantified. 1 GB covers the largest per-file limit of Instagram, Threads and Bluesky in the research; 4 GB (TikTok's maximum) is reachable by setting. 900 s is Instagram Reels' maximum and above Threads (300 s) and TikTok's API maximum (10 minutes); 4,096 px is TikTok's documented maximum and above every other platform's. *Reverse:* change the defaults; no code depends on the values.
- **D4 — Real providers declare that they do not accept video yet.** *What:* Instagram, Facebook, Threads, Bluesky and X declare zero videos per post. Their summaries say "Video: not accepted yet", their fit badges for a video say "will be refused", and a post with a video cannot be scheduled to them. Their researched video limits are declared by their own entries (3, 4, 5, 7), and X video is not on this roadmap. *Why:* declaring limits that no publish code honours would promise something Docket cannot do; and "no real provider publishes video yet" is a requirement of this entry.
- **D5 — A post carries images or one video, not both, unless a provider declares otherwise.** *What:* the video capability says how many videos a post may carry and whether a video may be mixed with images. The mock declares one video and no mixing. *Why:* mixed carousels belong to Instagram (entry 3) and Threads (entry 5); the field lets them turn it on without changing the shared validator.
- **D6 — Upload transport selection.** *What:* direct-to-bucket upload is the default. A new optional setting gives the bucket endpoint the browser should use (needed when the server's endpoint is internal, as in the offline MinIO profile). A second setting lets the operator choose the through-the-app chunked fallback for a bucket the browser cannot reach at all. With neither set, direct upload uses the server's own endpoint, which is correct for AWS S3 and R2. *Why:* the operator chose direct upload with a documented fallback; detecting an unreachable bucket automatically is unreliable, because a CORS refusal looks exactly like a network drop to the browser. *Reverse:* remove the fallback setting; direct upload is unaffected.
- **D7 — Resume lasts as long as the page.** *What:* Retry resumes an interrupted upload from the last part the bucket confirmed, as long as the page that started it is still open. If the page is closed or reloaded, the incomplete upload is abandoned and cleaned up, and the person starts it again. While any upload is in progress, leaving the page asks for confirmation. *Why:* resuming after a reload would mean storing upload state in the browser and asking the person to pick the same file again; it adds a lot for a rare case. *Reverse:* a later entry can add cross-reload resume; the server keeps enough state (FR-010).
- **D8 — An item that is still processing can be attached, but not published.** *What:* in the composer, a just-uploaded video can be attached while it is still processing. The post cannot be queued, scheduled or published until every attached item is ready; while it waits, the composer shows a blocking "still processing" issue that clears by itself. A failed item shows its reason and blocks the same way until removed. *Why:* the person can keep writing instead of waiting; the scheduling gate and the engine's publish-time re-check stay the single place that refuses (one implementation).
- **D9 — Location and descriptive metadata are removed from videos.** *What:* processing removes location and other descriptive metadata (camera, creation tool, comments) from the stored video by copying the streams into a clean container, without re-encoding, keeping what playback needs (for example orientation). *Why:* images already have all metadata stripped, the bucket is public, and from entry 3 on the original is what platforms receive until the formatter (entry 6) exists. A phone video's location must never become public. *Cost:* the worker needs temporary disk for about twice the file size while it works (documented with the compose impact, FR-040). *Reverse:* if the plan finds the copy unreliable for some files, it records why and what it does instead; storing a video with location data is not an acceptable fallback.
- **D10 — The public API reads videos but does not upload them in this entry.** *What:* listing and getting media through the API returns videos with their kind, metadata, poster and processing state. The API's upload and import-by-URL operations stay image-only and refuse a video with their existing "not an accepted type" answer, with a message saying video upload is available in the app. *Why:* direct-to-bucket upload is a browser flow; an API version needs its own design (session endpoints, idempotency). No entry on the roadmap owns it, so it is recorded in `docs/feature-map.md` as not built.
- **D11 — The generator does not use videos.** *What:* videos are excluded from the generator's media-library item source and are never sent to the model as image input. *Why:* the model's input is images. Sending the poster frame instead is a possible later improvement, owned by no entry on this roadmap; it is recorded in `docs/feature-map.md`.
- **D12 — Concurrency.** At most three files upload at once per page; further files wait in a queued state, in the order chosen. *Why:* the roadmap asks for a small cap; three keeps a home connection busy without starving any one file.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Upload with progress, early refusals and recovery (Priority: P1)

A team member drops six files on the media library: four photos, a 400 MB phone video and a 30 MB PDF someone renamed to `.mp4`. Each file gets its own row at once. The fake video is refused before any bytes are sent ("This is not an MP4 or MOV video"), because the browser could not read it as a video. A second video, 20 minutes long, is refused too ("Videos can be up to 15 minutes; this one is 20 minutes"). The others start, three at a time, each with a progress bar showing bytes sent, total and percent. Halfway through the big video the person's Wi-Fi drops; that row says "Upload interrupted: the connection was lost" with Retry and Cancel, while the photos that already finished stay finished. They press Retry, and the video continues from where it stopped instead of starting over. The same happens in the composer's media picker.

**Why this priority**: this is the experience every upload gets, images included, and large videos are unusable without it. It is the roadmap's main user-facing promise for this entry.

**Independent Test**: with the mock provider and the offline storage, upload a mix of images and videos (fixtures made at test time), including one that the browser refuses, one that fails mid-upload and is retried, and one that is cancelled; check each row's states, progress values, announcements and final result.

**Acceptance Scenarios**:

1. **Given** the media library, **When** the person chooses several files, **Then** each file gets its own row immediately, at most three upload at the same time, and the rest show "Waiting".
2. **Given** a file is uploading, **When** bytes are sent, **Then** its row shows a progress bar with bytes sent, total size and percent, exposed as a progress bar to assistive technology, and a polite announcement is made at start, at 25 %, 50 %, 75 % and on completion, not on every percent.
3. **Given** a file whose type, size or (for video) duration or dimensions break the library limits, **When** it is chosen, **Then** its row says why at once and no bytes are sent; the limits the browser uses are the ones the server enforces, read from the server.
4. **Given** a video the browser cannot read (for example a codec it cannot decode), **When** it is chosen, **Then** it is uploaded anyway and its row says its checks happen after upload; the server's checks decide.
5. **Given** an upload in progress, **When** the connection drops, the server refuses it or storage reports a failure, **Then** that row shows the error as soon as it happens with Retry and Cancel, and every other row carries on unaffected.
6. **Given** an interrupted upload, **When** the person presses Retry on the same open page, **Then** the upload resumes from the parts storage already confirmed, and the progress bar starts from the bytes already sent rather than zero.
7. **Given** an upload in progress or interrupted, **When** the person presses Cancel, **Then** the upload stops, anything partly stored is removed, the row says "Cancelled", and the other uploads continue.
8. **Given** uploads in progress, **When** the person tries to leave the page, **Then** the browser asks them to confirm.
9. **Given** the composer's media picker, **When** the person uploads files there, **Then** they get the same rows, progress, checks, errors, Retry and Cancel as in the media library, and each item is attached to the post when its upload finishes.

---

### User Story 2 - Videos are probed and get a poster frame in the background (Priority: P1)

After the 400 MB video finishes uploading, its row says "Processing: reading the video", then "Processing: making the poster frame", then "Ready", without the person reloading the page. The video now appears in the media library with a poster thumbnail, its duration (3:42), size (1080 × 1920), video and audio codecs (H.264, AAC) and frame rate (30 fps). A corrupt file that only looked like a video ends in "Failed: Docket could not read this video" and does not appear as a usable item.

**Why this priority**: without metadata and a poster, no later entry can validate or show a video. It is what "groundwork" means.

**Independent Test**: upload fixture videos (landscape, portrait, silent, and a corrupt one) with the worker running; check that each reaches ready with the right duration, dimensions, codecs, frame rate and a poster, that the corrupt one reaches failed with its reason, and that the web process never ran ffmpeg or ffprobe.

**Acceptance Scenarios**:

1. **Given** a video upload has finished, **When** the worker processes it, **Then** its row moves through "Processing: reading the video" and "Processing: making the poster frame" to "Ready", updating on its own within a few seconds of each change.
2. **Given** a ready video, **When** the person looks at it in the library, **Then** they see a poster thumbnail, duration, width and height as displayed (rotation applied), video codec, audio codec (or "no audio"), frame rate, file size, and can play it.
3. **Given** a file the worker cannot read as a video, or one whose real duration, size or dimensions exceed the library limits (the browser's reading was wrong or skipped), **When** it is processed, **Then** it ends as "Failed" with a reason, its stored bytes are removed, and it is never offered as attachable media.
4. **Given** the worker is stopped in the middle of processing, **When** it starts again, **Then** the item is picked up again and finishes; it is never left "Processing" for ever. After a bounded number of failed attempts it is marked failed with a reason.
5. **Given** a video whose file carries a location, **When** it is ready, **Then** the stored video no longer contains the location or other descriptive metadata, and it still plays the right way up.
6. **Given** an image upload, **When** it finishes, **Then** it shows a short processing state and becomes ready with today's checks and results (metadata stripped, thumbnail made, same refusals and messages).

---

### User Story 3 - See which accounts take a video before using it (Priority: P2)

In the composer the person selects a mock account and an Instagram account. The requirements summary for the mock now has a video part: one video per post, MP4 or MOV, H.264, up to 50 MB, 1 to 60 seconds, aspect 9:16 to 16:9, up to 60 fps, not mixed with images. Instagram's summary says "Video: not accepted yet". In the picker, the 3:42 video shows "Mock: will be refused: longer than 60 seconds" and "Instagram: will be refused: video not accepted yet". A 20-second clip shows "Mock: fits". Attaching the long video shows a blocking issue for both accounts, and scheduling is refused with the same reasons.

**Why this priority**: it is how the requirements-up-front promise of entry 1 extends to video. It depends on stories 1 and 2 for videos to exist.

**Independent Test**: with ready fixture videos, select each provider's account in the composer and compare the video part of the summary, the fit badges and the validation issues with the provider's declared video capabilities.

**Acceptance Scenarios**:

1. **Given** an empty composer, **When** a mock account is selected, **Then** its summary shows a video part with every video limit the mock declares, and "no limit Docket checks" for any it does not declare.
2. **Given** an empty composer, **When** an Instagram, Facebook, Threads, Bluesky or X account is selected, **Then** its summary says video is not accepted yet; its text and image parts are unchanged from entry 1.
3. **Given** a ready video, **When** the picker or the library shows it, **Then** each platform's badge says "fits" or "will be refused" with the reason from the same check validation uses; "will be converted" is never shown for a video in this entry.
4. **Given** a post with a video outside a selected account's video limits (duration, size, dimensions, aspect, frame rate, codec, container, count, or mixed with images where not allowed), **When** the composer checks it, **Then** a blocking issue names the limit and the video's value, and queueing, scheduling and publishing to that account are refused with the same issue.
5. **Given** a post with a video still processing or failed, **When** the composer checks it, **Then** a blocking issue says so, and it clears by itself when the video becomes ready.

---

### User Story 4 - The mock provider publishes a video end to end (Priority: P2)

With `MOCK_PROVIDER_ENABLED=true` and the offline storage, the person uploads a 20-second clip, attaches it to a post for the mock account, schedules it, and watches it publish. The publish goes through more than one step (the mock reports the video as still processing once before it is published), so the multi-step path the real providers will use is exercised. The post's target is marked published, with the attempt log showing each step.

**Why this priority**: the roadmap requires it, and it proves the whole chain (upload, processing, capabilities, validation, scheduling, step machine) before any real provider depends on it.

**Independent Test**: an end-to-end test that uploads a fixture video through the same services the UI uses, waits for ready, creates and schedules a post for a mock account, runs ticks, and checks the target ends published with the expected steps; a second run with a video outside the mock's limits checks it is refused before publishing.

**Acceptance Scenarios**:

1. **Given** a ready video within the mock's limits, **When** a post with it is scheduled to a mock account and ticks run, **Then** the target goes through at least two steps, including one that reports the video as still processing, and ends published.
2. **Given** a ready video outside the mock's limits, **When** the post is scheduled, **Then** scheduling is refused with the validation issue; if the post is already queued when it starts breaking the limits (for example its account was changed), the engine's publish-time re-check fails the target on its first step, as for images.
3. **Given** a post with a video, **When** it is viewed in the post list, calendar or composer, **Then** the video's poster is shown where an image thumbnail would be.

---

### User Story 5 - Operators can deploy it (Priority: P3)

An operator running Docket with Docker Compose on a home server pulls the new image. The release notes and `docs/deployment.md` say the image is larger because it now includes ffmpeg, that the worker now needs CPU and temporary disk while it processes a video, and exactly what to change, if anything, in their copied `docker-compose.yml` and `.env`. `docs/storage.md` tells them how to set CORS, IAM permissions and incomplete-upload cleanup for their bucket (AWS S3, R2 or MinIO), when they need the new browser-facing endpoint setting, and when to switch to the through-the-app fallback and what their reverse proxy must allow for it. The repository's `NOTICE` says the image includes GPL ffmpeg from Debian and where its source is.

**Why this priority**: without it, direct uploads fail on a bucket with no CORS rule, and the image's licence obligations are unmet. It is documentation and packaging, needed before release but not before the features can be built.

**Independent Test**: build the image and check `ffmpeg -version` and `ffprobe -version` run in it as the app user; follow `docs/storage.md` for the offline MinIO profile and upload a video from a browser; check `NOTICE`, `.env.example`, `docs/storage.md`, `docs/deployment.md` and `docs/decisions.md` for the required content.

**Acceptance Scenarios**:

1. **Given** the built image, **When** ffmpeg and ffprobe are run in it as the unprivileged app user, **Then** both run and report their versions; the worker uses them and the web process does not.
2. **Given** the offline Compose profile with the documented `.env` lines, **When** a person uploads a video in a browser on the same machine, **Then** it uploads directly to MinIO with progress and is processed to ready.
3. **Given** a bucket the browser cannot reach and the fallback setting chosen, **When** a person uploads a video, **Then** it uploads in chunks through Docket, each request below the app's request-body limit, with the same progress, Retry and Cancel.
4. **Given** the repository, **When** someone reads `NOTICE`, **Then** it states that the Docker image includes ffmpeg under the GPL, built by Debian with libx264, and where to get the corresponding source (Debian's `ffmpeg` source package for the shipped version).

---

### Edge Cases

- **Browser cannot read the video** (codec it cannot decode, odd MOV): uploaded anyway with "checks happen after upload"; the worker decides (scenario 1.4).
- **Browser reading is wrong or tampered with**: the server's checks are authoritative; a file the browser let through but that breaks a limit is refused after upload and its bytes removed (scenario 2.3). A browser-side refusal never replaces a server check.
- **Declared size differs from what arrived**: an upload whose stored size differs from what the browser declared, or exceeds the library limit, is refused and removed when it is completed.
- **A renamed file**: type is judged by contents, never by name or declared type, in the browser where possible and always on the server.
- **Duration unknown or infinite in the browser** (some streams report it before metadata loads): treated as "could not read"; uploaded and checked on the server.
- **Rotated phone video**: dimensions and aspect are the displayed ones, with rotation applied, in the library, the summary checks and the badges.
- **Silent video**: accepted; audio codec shows "no audio". Whether a platform requires audio is the platform's own capability in its later entry.
- **Very short video** (shorter than the poster frame's usual seek time): the poster comes from a point within the video (half its duration).
- **Variable frame rate**: the frame rate shown and checked is the stream's declared rate as the probe reports it; how variable rates are judged is recorded in the plan.
- **Audio-only MP4/M4A or a file with no video stream**: refused ("This file has no video").
- **Storage refuses mid-upload** (expired signature, bucket full, permissions): the row shows a storage error with Retry; Retry asks Docket for fresh signatures.
- **Signatures expire while a slow upload is running**: parts not yet sent get fresh signatures without the person doing anything.
- **Session ended mid-upload** (signed out or removed from the project): further parts and completion are refused; the row says the person no longer has access; the incomplete upload is cleaned up.
- **Project deleted or switched mid-upload**: uploads belong to the project they started in; switching projects in another tab does not move them.
- **Abandoned uploads** (tab closed, browser crash): never become media items; Docket's own clean-up removes them after a set time, and the bucket's lifecycle rule is the backstop documented per backend.
- **Many open uploads by one person**: a person may have a bounded number of incomplete uploads open at once (default 10); further ones are refused with a clear message until some finish.
- **Duplicate upload of the same file**: allowed, as today; each becomes its own item.
- **Deleting a video**: removes the video, its poster and any partial objects; posts using it follow today's delete-impact rules for media.
- **Media storage not set up**: the upload area says uploads are unavailable, as today, for images and video.
- **Worker not running**: uploads complete and stay "Processing"; the row says processing is waiting for the worker if nothing has happened for a while, and nothing is lost when it starts.
- **ffmpeg missing or broken in the worker**: processing fails with a clear operator-facing reason in the worker's log and a "Docket could not process this video" message on the item; images are unaffected.
- **Retry on R2 after a failed part re-upload**: the part is re-sent in full (research: a failed replacement on R2 loses the earlier part).
- **Reverse proxy on the fallback path caps request bodies**: the chunk size is documented, and the fallback refuses to start if the app's own limit cannot fit one chunk.

## Requirements *(mandatory)*

### Functional Requirements

**Upload experience (images and video, media library and composer picker)**

- **FR-001**: The media library's upload area and the composer's media picker MUST use one shared upload flow with the same states, checks, messages, progress and controls (D1).
- **FR-002**: Each chosen file MUST get its own row at once, showing its name and one of these states: checking, refused (with reason), waiting, uploading (with progress), interrupted (with reason, Retry and Cancel), cancelled, processing (with its current step), ready, failed (with reason).
- **FR-003**: While uploading, a row MUST show bytes sent, total bytes and percent, exposed to assistive technology as a progress bar with its current, minimum and maximum values and an accessible name naming the file. A polite live region MUST announce, per file, the start, each 25 % milestone, completion, any error, and the final ready or failed state; it MUST NOT announce every percent.
- **FR-004**: Before any bytes are sent, the browser MUST check each file's type and size and, for a video, its duration and dimensions as read from the file's own metadata, against the library limits the server enforces. Those limits MUST be read from the server (configuration and capabilities), never written as constants in client code. A file that breaks a limit MUST be refused at once with a reason naming the limit and the file's value, and none of its bytes sent.
- **FR-005**: When the browser cannot read a video's metadata, the file MUST still be uploaded, and its row MUST say that its checks happen after upload. Browser checks MUST be treated as advisory; the server MUST re-check every limit (FR-017).
- **FR-006**: At most three files MUST upload at the same time per page; others MUST wait in the order chosen (D12). One file's refusal, failure or cancellation MUST NOT stop, hide or reset any other file's row.
- **FR-007**: A network failure, a refusal by Docket or a storage failure during an upload MUST be shown on that file's row as soon as it is detected, with Retry and Cancel.
- **FR-008**: Retry MUST resume the upload from the parts storage has already confirmed, without re-sending them, for as long as the page that started it is open (D7). Parts whose signature has expired MUST be re-signed automatically.
- **FR-009**: Cancel MUST stop the upload, ask storage to discard what was stored for it, mark the row cancelled and leave other uploads running.
- **FR-010**: Docket MUST keep, per incomplete upload, which project and member it belongs to, the file's declared name, type and size, the chosen part size, where in storage it is going, when it started and its state. Only the member who started it MAY sign parts for, complete or cancel it, and only while they still have upload rights in that project.
- **FR-011**: Incomplete uploads older than a set time (default 24 hours) MUST be discarded by Docket's own clean-up in the worker, including what is stored for them. A member MUST NOT have more than a set number of incomplete uploads at once (default 10).
- **FR-012**: While any upload on the page is checking, waiting or uploading, leaving the page MUST ask for confirmation.
- **FR-013**: After an upload finishes, its row MUST show the item's processing state and update by itself, without a page reload, until the item is ready or failed. A state change MUST appear on the row within 5 seconds of happening on the server.
- **FR-014**: In the composer's media picker, each uploaded item MUST be attached to the post when its upload finishes, whether or not processing has finished (D8).

**Transport**

- **FR-015**: By default, file bytes MUST travel from the browser straight to the bucket in parts of a fixed size per upload (at least 5 MiB except the last, at most 10,000 parts), each sent with per-part progress; Docket MUST only handle small requests to start the upload, sign parts, list confirmed parts, complete and cancel. Docket MUST build the completion from the bucket's own list of confirmed parts, so the browser never needs to read part identifiers from storage responses. An optional setting MUST name the bucket endpoint the browser uses when it differs from the server's. A second setting MUST let the operator choose the through-the-app chunked fallback for a bucket the browser cannot reach, with the same progress, Retry and Cancel, each request kept below the app's request-body limit, and every chunk's received length checked against its declared length (D6).

**Processing**

- **FR-016**: Video processing (probing and poster frames, and the metadata clean-up of D9) MUST run in the worker, never in the web process, by running ffprobe and ffmpeg as separate processes with argument lists (no shell), a time limit, no terminal input and a bounded amount of captured output. A stopped worker MUST stop its running ffmpeg processes. Output MUST be written under a temporary name and only used after a successful exit.
- **FR-017**: When an upload completes, Docket MUST check on the server that what was stored matches the declared size and is within the library limit for its kind. For video, processing MUST then confirm by its contents that it is an MP4 or MOV container with a video stream, and that its duration and dimensions are within the library limits. A file that fails any check MUST end as failed with a reason, have its stored bytes removed, and never be offered as attachable media.
- **FR-018**: For each ready video, Docket MUST record its duration, displayed width and height (rotation applied), video codec, audio codec or the absence of audio, frame rate, container and file size.
- **FR-019**: For each ready video, Docket MUST store a poster frame taken from within the video (at one second, or half the duration if shorter), sized like image thumbnails, and use it wherever the item is shown as a thumbnail: media library, picker, composer, post list and calendar.
- **FR-020**: Processing MUST remove location and other descriptive metadata from the stored video without re-encoding it, keeping what correct playback needs (D9).
- **FR-021**: Processing MUST be safe to stop at any point: an item whose processing was interrupted MUST be picked up again, and after a bounded number of attempts MUST be marked failed with a reason. Processing work MUST follow the scheduler's rules: bounded runs, safe to run concurrently with other workers, claims that cannot be taken twice.
- **FR-022**: Images MUST keep today's processing results, refusals and messages; they gain the processing state of FR-013, however brief (D1).

**Library limits**

- **FR-023**: The media library MUST accept MP4 and MOV videos in addition to today's image types, judged by contents. New settings MUST set the largest video file (default 1,024 MB, allowed 1 to 4,096 MB) and the longest video (default 900 s, allowed 1 to 3,600 s); a fixed ceiling of 4,096 px applies to either side (D3). The image settings MUST stay as they are. The upload area's help text MUST state the accepted types and limits from the same values.

**Video capabilities and validation**

- **FR-024**: A provider MUST be able to declare video capabilities in its own folder: videos per post (0 = none), whether a video may be combined with images, accepted containers, accepted video codecs, accepted audio codecs or "no audio allowed", largest file, shortest and longest duration, smallest and largest width and height, narrowest and widest aspect ratio, and highest frame rate. An undeclared field means no limit Docket checks.
- **FR-025**: The shared validator MUST check a post's videos against the target's video capabilities, as one implementation used by the composer check, the scheduling gate and the engine's publish-time re-check. Each broken limit MUST be a blocking issue naming the limit and the video's value. A video that is processing or failed MUST be a blocking issue (D8). An out-of-range video MUST be reported, never converted, cropped, trimmed or re-encoded (entry 6 owns that).
- **FR-026**: The requirements summary from entry 1 MUST gain a video part beside the image part, derived from the provider's video capabilities on the server, with display labels computed there; the text, image and post parts MUST NOT change. A provider that accepts no video MUST be shown as "Video: not accepted yet".
- **FR-027**: The per-platform fit badges in the media library and the picker MUST cover videos, using the same check as validation: "fits" or "will be refused" with the reason. "Will be converted" MUST NOT be shown for videos in this entry.
- **FR-028**: Instagram, Facebook, Threads, Bluesky and X MUST declare zero videos per post in this entry (D4); their text and image capabilities MUST NOT change.
- **FR-029**: A post's type MUST be inferred as `video` when it carries a video. Queueing, scheduling or publishing a post with a video to an account whose provider declares zero videos MUST be refused with a blocking issue saying that platform does not accept video yet.

**Mock provider**

- **FR-030**: The mock provider MUST declare video capabilities: one video per post, not mixed with images, MP4 and MOV containers, H.264 video, AAC audio or no audio, up to 50,000,000 bytes, 1 to 60 seconds, aspect 9:16 to 16:9, up to 60 fps; and `video` among its post types.
- **FR-031**: The mock provider MUST publish a post with a video through at least two steps, one of which reports the video as still being processed by the platform before the next tick completes it, so the multi-step polling path is exercised. Its existing behaviours (settings that simulate failures, ambiguity and so on) MUST apply to video posts too.

**Packaging, CI and documentation**

- **FR-032**: The runner image MUST include Debian's packaged ffmpeg and ffprobe, runnable by the unprivileged app user, installed without recommended extras. No ffmpeg wrapper library MAY be added.
- **FR-033**: The repository MUST have a `NOTICE` file stating that the Docker image includes ffmpeg, licensed under the GPL as built by Debian with libx264, that Docket runs it only as a separate program, and where to get its corresponding source (Debian's `ffmpeg` source package for the shipped version).
- **FR-034**: CI MUST install ffmpeg and run the processing tests against clips generated at test time. Locally, when ffmpeg is not installed, those tests MUST skip with a message saying so; in CI they MUST NOT skip.
- **FR-035**: A test MUST fail if code that runs in the web process starts ffmpeg or ffprobe.
- **FR-036**: A test MUST fail if upload UI code contains a literal upload limit or accepted type, in the manner of entry 1's limit-literal test.
- **FR-037**: `.env.example` MUST document every new setting (browser-facing bucket endpoint, fallback choice, video size and duration limits, incomplete-upload expiry and per-member cap if configurable) with defaults and when to set them.
- **FR-038**: `docs/storage.md` MUST document, per backend (AWS S3, R2, MinIO): the CORS rule (origin, methods, allowed headers; exposing `ETag` optional because Docket lists parts itself), the extra permissions multipart upload needs (with the research's caveat that the exact AWS action names must be confirmed), incomplete-upload clean-up (AWS lifecycle rule, R2's default, MinIO's server setting), that R2 uploads must use the S3 API domain, that the browser-facing endpoint must be `https` when Docket is, what a reverse proxy in front of the bucket must allow, and when and how to use the fallback, including the per-request body size the app's proxy must allow.
- **FR-039**: `docs/limits.md` and its inventory test MUST cover the new video capability categories for every provider that declares them (the mock in this entry), each with its source, enforcement point and test, so the document cannot drift. Where the generated enforcement tests are per category, they MUST include the video categories.
- **FR-040**: `docs/deployment.md` MUST describe the docker-compose impact: the larger image, the worker's CPU use and temporary disk need (about twice the largest video while it is cleaned), whether any `docker-compose.yml` edit is needed and, if so, the exact edit; and any new `.env` line the offline profile needs. If `docker-compose.yml` changes, the change MUST be listed with its exact edit in the release notes for operators who copy the file.
- **FR-041**: `docs/adding-a-provider.md` MUST document the video capability fields; `docs/feature-map.md` MUST move the groundwork items to "Already built" and record the unowned follow-ups (API video upload, the generator using posters, cross-reload resume); `docs/decisions.md` MUST record the operator's transport and ffmpeg choices and D1 to D12.

**Scope boundaries**

- **FR-042**: This entry MUST NOT publish video to any real provider, add any real provider's video capabilities, or add new providers.
- **FR-043**: This entry MUST NOT transcode, re-encode, crop, pad, trim or resize videos for any target, nor produce per-target video variants or previews.
- **FR-044**: The public API's media upload and import-by-URL operations MUST keep refusing video with their existing "not an accepted type" response and a message saying video upload is available in the app; its list and get operations MUST return videos with their kind, metadata, poster and processing state (D10).
- **FR-045**: The generator MUST NOT include videos in its media-library item source or send them to the model (D11).

### Key Entities

- **Media item** (existing, extended): a file in a project's library. Gains a kind (image or video), a processing state (processing with its current step, ready, failed with a reason) and, for video, duration, frame rate, video codec, audio codec or none, container and a poster frame (stored like a thumbnail). Width and height are the displayed dimensions.
- **Upload session** (new): one incomplete upload. Belongs to one project and one member; records the declared name, type and size, the part size, the storage destination, the storage's upload identifier, when it started and its state (open, completed, cancelled, expired). Becomes a media item on completion; discarded on cancel or expiry.
- **Video capabilities** (new, per provider): videos per post, mixing with images, accepted containers and codecs, size, duration, dimension, aspect and frame-rate bounds. Read by the validator, the requirements summary and the fit badges.
- **Requirements summary** (existing, extended): gains a video part beside the image part.
- **Library limits** (existing, extended): per kind, what Docket will store: accepted types, largest file, and for video the longest duration and largest side. Served to the browser for its pre-upload checks.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A 1 GB video uploads through the media library with visible progress and no request to Docket larger than 1 MB on the default path; a test confirms no file bytes pass through the app on that path.
- **SC-002**: A file that breaks a library limit the browser can read is refused with its reason in under 1 second after it is chosen, with zero bytes sent.
- **SC-003**: After a mid-upload failure, Retry re-sends only the parts not yet confirmed; in the test, the bytes re-sent are at most one part's size more than the bytes that were missing.
- **SC-004**: With six files chosen and one failing mid-upload, the other five reach ready; no more than three are ever uploading at once.
- **SC-005**: A ready video's recorded duration, dimensions, codecs and frame rate match the fixture's known values (duration within 0.1 s) for landscape, portrait and silent fixtures, and a corrupt fixture ends failed.
- **SC-006**: A row's processing state changes appear without a reload within 5 seconds of the server-side change.
- **SC-007**: Zero ffmpeg or ffprobe runs happen in the web process (enforced by test).
- **SC-008**: For every provider, the video part of the requirements summary and the video fit badges are derived from that provider's declared video capabilities, with no limit literal in UI code (enforced by test), and `docs/limits.md` matches the declarations (enforced by test).
- **SC-009**: A video post to a mock account publishes end to end in the test suite through at least two publish steps.
- **SC-010**: Every upload state is reachable by keyboard and announced by screen readers: progress bars expose their values, progress milestones are announced at most five times per file (start, 25 %, 50 %, 75 %, done), and Retry and Cancel are labelled with the file name.
- **SC-011**: An operator following `docs/storage.md` for the offline profile can upload a video from a browser on the first attempt; the `NOTICE` file and the decision log contain the ffmpeg licensing statement and the transport decision.

## Assumptions

- The bucket stays public-read (docs/storage.md). Uploads go to keys that are unguessable and are not shown or used anywhere until processing finishes; a refused or cancelled upload's bytes are removed.
- Upload rights are today's: any member role that can upload images can upload videos. No new permission is added.
- The image limits (`MEDIA_MAX_UPLOAD_MB`, `MEDIA_MAX_MEGAPIXELS`) and the 26 MB request-body limit stay, because the public API's image upload still sends the file to the app.
- Fixture videos are generated at test time with ffmpeg's own test sources, not committed (research recommendation); a rotated fixture and a fixture with location metadata are generated the same way, or the plan records how they are made.
- The research's UNVERIFIED command details (progress output keys, rotation side-data names, SIGTERM behaviour, `-print_format`) are confirmed by tests running real ffmpeg in CI, not assumed.
- The offline MinIO profile can reach direct uploads from a browser on the same machine with one extra `.env` line for the browser-facing endpoint (`http://localhost:9000`); MinIO answers CORS itself. If the plan finds a `docker-compose.yml` edit is needed, it is flagged with its exact edit (FR-040).
- The Node base image is Debian bookworm, giving ffmpeg 5.1.x; the plan may pin the base image tag so the ffmpeg version does not change unnoticed.
- No new runtime npm dependency is needed: the AWS SDK packages for multipart and presigning are already installed. The browser-side MP4 parser the research mentions as a fallback (`mp4box`) is not installed; this entry relies on the browser's own video element and the server's checks (FR-005). If the plan wants the parser, it is `NEEDS DEPENDENCY: mp4box`.

## Out of scope (and who owns it)

- Publishing video to Instagram (Reels, feed video, mixed carousels): **entry 3**. Facebook Page Reels and video: **entry 4**. Threads video and video carousel items: **entry 5**. Bluesky video: **entry 7**. TikTok provider: **entry 8**. Each declares its own researched video capabilities.
- Transcoding, re-encoding, cropping, padding, trimming, resizing, frame-rate or bitrate fitting, focal points and per-target previews: **entry 6** (per-target video formatter). Here an out-of-range video is reported by validation, not fixed.
- Stories and the `story`/`reel` post types: owned by the platform entries that need them (3 and 4).
- X video: not on this roadmap.
- Uploading video through the public API, the generator using videos or their posters, and resuming an upload after the page is reloaded: not owned by any entry on this roadmap; recorded in `docs/feature-map.md`.
- Choosing a different poster frame or cover per platform: **entry 6** and the platform entries (the feature map's "later" list).
