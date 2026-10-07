# Quickstart: validating video groundwork (018)

How to prove the feature works. Shapes and rules are in [data-model.md](./data-model.md) and [contracts/](./contracts/). This guide only says what to run and what to expect.

## Prerequisites

- Node 24, pnpm, and a Postgres reachable at `DATABASE_URL`, as for every test run. Test databases are run-scoped.
- **ffmpeg and ffprobe on `PATH`** for the processing suites (`brew install ffmpeg`, or `apt-get install ffmpeg`).
  - Without them, those suites skip locally with "ffmpeg is not installed; video processing tests skipped".
  - In CI they never skip: `CI=true` makes a missing binary a failure (FR-034).
- No network and no real bucket. Storage is `MemoryStorage`, and S3 command shapes are tested with the SDK and a stub request handler.

## 1. Pure and unit checks (no DB, no ffmpeg)

```sh
pnpm vitest run src/lib/media/sniff.test.ts src/lib/upload src/components/media/upload \
  src/providers/validation.test.ts src/providers/requirements.test.ts src/providers/registry.test.ts \
  src/providers/mock/mock.test.ts src/server/video/probe.test.ts src/lib/storage/upload-origin.test.ts \
  src/lib/http/security-headers.test.ts src/server/env.test.ts src/server/storage/s3.test.ts
```

Expected results:

- **Upload engine:**
  - six files → never more than three `uploading` at once; one fails mid-upload and the other five reach `ready` (SC-004);
  - a drop at part 3 → `interrupted` → Retry re-sends only parts 3 and later, and the bar resumes from the confirmed bytes (SC-003);
  - a file over the served limits → `refused`, with zero action calls (SC-002);
  - milestones are announced at most five times per file (SC-010);
  - the fake status drives `processing` → `ready` and → `failed`.
- **Validator:** every video code at its boundary; a processing or failed item blocks; image issues are unchanged.
- **Summary:** the mock's video part lists every declared limit; the five real providers say "not accepted yet"; text and image parts are identical to 017 (FR-026).
- **Upload origin:** equals the SDK's presigned `UploadPart` origin in every configuration (P6).
- **Env:** defaults and ranges for the six new settings; the https and via_app cross-field issues.
- **S3 storage:** multipart commands are sent with the expected inputs; `listParts` follows `NextPartNumberMarker`; the presign client uses the browser endpoint and no checksum parameters.

## 2. Server flows with the database (no ffmpeg)

```sh
pnpm vitest run tests/integration/media tests/integration/compose tests/integration/limits \
  tests/integration/docs tests/integration/api/media-video.test.ts tests/integration/generation
```

Expected results:

- **Upload sessions** (`tests/integration/media/uploads.test.ts`, new):
  - create → sign → parts `PUT` into `MemoryStorage` → complete. An image becomes `ready` with today's results (metadata stripped, thumbnail). A video becomes `processing` / `queued`.
  - Complete again returns the same asset.
  - A size mismatch gives `refused`, and the staging object is gone.
  - A missing part gives `parts_missing`, and the session is back to `open`.
  - Another member, or a removed member, gets `not_found`.
  - The 11th open upload gives `too_many_open`.
  - Cancel aborts and deletes.
  - Housekeeping expires an old session and aborts it.
  - The `via_app` route refuses a short body and a wrong `Content-Length`, and forwards a good chunk as the same part.
  - SC-001: on the `direct` path, no request reaching Docket carries file bytes.
- **Compose check:** a processing video gives the blocking `media_processing`, which clears when the row turns ready. The 3:42 video gives blocking issues for mock (too long) and Instagram (not accepted yet).
- **Limits:** generated `<key>: videos` rows for every provider, and `mock: <video category>` rows, each refused at the gate before any provider call. `docs/limits.md` matches the declarations (SC-008).
- **API:** list and get return `kind`, `processingState` and `video`. Uploading or importing a video gives `415` with "Video upload is available in the Docket app" (FR-044).
- **Generator:** a ready video in the library is never selected or sent to the model (FR-045).

## 3. Processing with real ffmpeg

```sh
pnpm vitest run tests/integration/video tests/integration/media/video-publish.test.ts
```

Expected results (all fixtures are generated at test time with `lavfi`):

- Landscape, portrait, silent and MOV clips reach `ready` with duration within 0.1 s, displayed size, H.264/AAC (or no audio), 15 fps, and a poster at `thumb.webp` (SC-005).
- The rotated clip's displayed size is 180×320, and its poster is portrait.
- The located clip's stored bytes do not contain the coordinate string, and its probe has no `location` tag (US2 AS5).
- The corrupt clip gives "Docket could not read this video". The audio-only file gives "This file has no video". Over-limit clips are refused with the limit named. Each failure leaves no stored bytes.
- Loop: concurrent workers claim different rows; an expired lease is re-claimed; a shutdown releases the claim with the attempt refunded; the 4th claim fails the item (US2 AS4).
- Spawn: a timeout or abort kills ffmpeg, and its `.tmp` output is never used.
- **US4 end to end:** a 2 s clip goes through upload, `ready`, scheduling to a mock account and ticks. The attempt log shows `upload_video` → `check_video` (processing) → `publish` → published (SC-009). An out-of-limits clip is refused at scheduling.

## 4. Lint-style guarantees

```sh
pnpm vitest run tests/lint
```

Expected results:

- `no-ffmpeg-in-web`: nothing under `src/server/video/` is reachable from `src/app/**`, `src/proxy.ts`, `src/instrumentation.ts` or `runTick`, and only `spawn.ts` imports `child_process` (SC-007).
- `ui-limit-literals`: no `image/…` or `video/…` literal and no declared or library limit in upload, composer, picker or library UI code (FR-036).

## 5. Image and CI checks

These run in CI, in the `docker` job:

- `ffmpeg -version`, `ffprobe -version`, `id -u` = 1001, and `libx264` in `-encoders` inside `docket:ci` (FR-032).
- `node scripts/video-smoke.mjs` inside the image passes on Debian's ffmpeg 5.1.x (P22).
- The image size is printed. Copy it into `docs/deployment.md`.

To reproduce locally: `docker build -t docket:ci .`, then the same `docker run` lines from contracts/operations.md.

## 6. Final pass (once, at the end of implement)

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build
```

`db:check` runs because the schema changed. `build` runs because routes, the proxy, config and the client/server boundary changed.

## 7. Live checks owed by the operator

None of these can run in the pipeline. Report each as "verified with mocks only" until done.

1. **Offline profile in a real browser.** Add `S3_BROWSER_ENDPOINT=http://localhost:9000` to `.env`, then run `docker compose --profile offline up -d` and `MOCK_PROVIDER_ENABLED=true`. Upload a phone video of about 200 MB in the media library. Expected:
   - per-file progress;
   - Wi-Fi off mid-way gives "Upload interrupted: the connection was lost", and Retry continues from where it stopped;
   - "Processing: reading the video" → "Processing: making the poster frame" → "Ready" without a reload;
   - poster, facts and playback in the detail dialog;
   - publish to the mock account succeeds (US5 AS2, SC-011).
2. **MinIO and `ETag`.** Docket never reads `ETag` (P4), so step 1 passing confirms the CORS defaults are enough.
3. **R2 or AWS S3 bucket** with the documented CORS and IAM. A direct upload of a 1 GB file completes. Confirm the IAM action names against AWS's page (research UNVERIFIED), and confirm presigned `UploadPart` works on R2 (research UNVERIFIED).
4. **`MEDIA_UPLOAD_TRANSPORT=via_app`** behind the operator's reverse proxy, with its body limit set to at least 9 MB. Upload, Retry and Cancel work, and no request is above the limit (US5 AS3).
5. **Unraid.** Pull the new image, then check that `docker exec <worker> ffmpeg -version` runs, and that the worker container's disk holds twice the largest video.
