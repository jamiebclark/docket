# Quickstart: validating Bluesky video

How to prove entry 7 works. Everything here runs with mocked HTTP only (constitution II); real publishing to Bluesky is **verified with mocks only** until the operator runs the owed live checks in §7. Contracts: [capabilities](./contracts/bluesky-video-capabilities.md), [publishing](./contracts/bluesky-video-publishing.md); data: [data-model.md](./data-model.md).

## 0. Prerequisites

- Node 24, pnpm, dependencies installed (no new package: `@atproto/api` 0.22.0 already ships the video lexicons).
- A Postgres for tests, as for every integration suite: `DATABASE_URL` set (run-scoped test databases since #23).
- No ffmpeg is needed: video rows come from `createVideoAsset` facts and stored bytes; the formatter's ffmpeg suites are entry 6's and run in CI.
- No `docker-compose.yml` or `.env.example` change (FR-025).

## 1. Capabilities, validation, summary and fit (US3)

```sh
pnpm vitest run src/providers/bluesky/capabilities.test.ts src/providers/bluesky/video-validate.test.ts \
  src/providers/requirements.test.ts src/server/services/media-fit.test.ts
pnpm vitest run tests/integration/bluesky/video-fit.test.ts tests/integration/compose/bluesky-video-summary.test.ts
```

Expect:

- Bluesky declares one MP4 (H.264, AAC or silent) video of up to 300,000,000 bytes and 180 s, no other bound, post types text/image/carousel/video, no choice, and the 25-a-day allowance.
- A 5-minute HEVC MOV is "will be adapted" (cut to 3:00, re-encoded); a 40 s H.264/AAC MOV is a rewrap; a 40 s H.264/AAC MP4 fits as is; two videos or a video with an image is refused with Bluesky's wording, through the composer check, the gate and the publish-time re-check, with 0 fake-PDS requests.
- The summary shows the video row, "up to 3 minutes", "300 MB", the two notes, and no "Post as".
- A target whose version is still being built waits "Preparing video for Bluesky"; once ready, the bytes uploaded are the version's.

## 2. Pure step logic

```sh
pnpm vitest run src/providers/bluesky/video-state.test.ts src/providers/bluesky/video-steps.test.ts \
  src/providers/bluesky/pds-host.test.ts src/providers/bluesky/video-service.test.ts \
  src/providers/bluesky/video-errors.test.ts src/providers/bluesky/video-publish.test.ts \
  src/providers/bluesky/steps.test.ts src/providers/bluesky/publish.test.ts src/server/scheduler/record.test.ts
```

Expect: every phase maps to one step; only `create_post` may publish; old Bluesky states parse; the existing `steps.test.ts` and `publish.test.ts` pass untouched; G24's `wait` is shown and uses no attempt, and a `continue` without it still clears `lastError`.

## 3. One video, end to end (US1)

```sh
pnpm vitest run tests/integration/bluesky/video.test.ts
```

Expect, with a 12,000,000-byte 1080 × 1920, 30 s H.264/AAC MP4 and the fake service asking for 5,000,000-byte parts:

1. `getSession`, a token for `did:web:video.bsky.app` / `app.bsky.video.getUploadLimits`, then `getUploadLimits`; the attempt log records the remaining videos and bytes.
2. `startUpload` with `sizeBytes: 12000000`, `mimeType: "video/mp4"`, a name, `durationMs: 30000`, `width: 1080`, `height: 1920`, under a token for `did:web:<PDS host>` / `com.atproto.repo.uploadBlob` expiring 300 s ahead.
3. Parts 1, 2, 3 in three ticks, of 5,000,000, 5,000,000 and 2,000,000 bytes, each with a fresh token; then `finishUpload`.
4. Status reads at ≥ 30 s, then about a minute apart; on the read with the blob, the next tick creates the post with `app.bsky.embed.video` (blob as returned, `aspectRatio` 1080 × 1920, the alt text, no `captions`).
5. The target is `published` with the post's `at://` URI and `https://bsky.app/profile/<handle>/post/<rkey>`.

Also: a one-part video; empty text; a mention resolved first; a timeout at each pre-create step retried with nothing published; a timeout after `createRecord` ambiguous and never retried; text and image posts send exactly today's requests.

## 4. Failures (US2)

```sh
pnpm vitest run tests/integration/bluesky/video-failures.test.ts
```

Expect each start refusal and job failure code to fail with the text of publishing contract §7; an unknown state or unreadable reply to keep polling; no blob at 30 minutes to fail within 16 reads and 35 minutes; 5-minute spacing after 10 minutes; a deduplicated finish to be polled by its `completedJobId`; an already-processed blob to skip polling; expiry to restart twice, then fail; a timed-out part to be resent with the same number; a killed worker to resume at its step (ambiguous only inside `create_post`); a changed post to start again.

## 5. Daily limits (US4)

```sh
pnpm vitest run tests/integration/bluesky/video-limits.test.ts
```

Expect `canUpload: false` to wait an hour with Bluesky's message as the target's status and no upload request; uploads to start once allowed; a refusal 23 hours after the first to fail with that message; a refused check to be logged as skipped and the upload to start; `DailyLimitExceeded` to wait the same way; 25 reservations in 24 hours to defer the next video with "Waiting for Bluesky's daily video upload allowance", 0 Bluesky requests and no attempt used.

## 6. Secrets, limits doc and the final pass

```sh
pnpm vitest run tests/integration/bluesky/video-no-secrets.test.ts \
  tests/integration/limits/enforcement.test.ts tests/integration/docs/limits-inventory.test.ts \
  tests/integration/bluesky
```

Expect no session token, service token or app password anywhere it is recorded or shown; the generated `bluesky: *` video rows and the allowance row to pass; `docs/limits.md` to match the declaration; every existing Bluesky suite to pass unchanged.

Once, at the end of the implement phase (constitution "run checks in proportion"):

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

No `pnpm db:check` (no schema change).

## 7. Owed live checks (operator, together; listed in `docs/accounts.md`)

With a real Bluesky account connected by app password (Bluesky-hosted, verified email):

1. Publish a 30 s H.264/AAC MP4 to Bluesky and open the post.
2. Confirm the host, token audience and method that work for `startUpload`/`uploadPart`/`finishUpload` (`did:web:<PDS host>` / `com.atproto.repo.uploadBlob`), for `getUploadLimits` and for `getJobStatus`; note whether the attempt log shows the limits check `ok` or `skipped`, and whether status reads stayed on `statusAuth: service`.
3. Record the `partSizeBytes` the service returns, and whether one part sends within `SCHEDULER_PROVIDER_TIMEOUT_SECONDS` from the operator's server.
4. Note how long processing took (the reads in the attempt log).
5. Try a 4-minute video with `maxDurationSeconds` raised locally to 600, to see whether 3 minutes can be raised (D2).
6. Confirm the public media URL (`S3_PUBLIC_BASE_URL`, or a CDN in front of it) answers `Range` requests with 206.
