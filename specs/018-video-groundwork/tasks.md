---

description: "Task list for 018 video groundwork"
---

# Tasks: Video groundwork

**Input**: Design documents in `specs/018-video-groundwork/` (plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md)

**Prerequisites**: plan.md, spec.md. Read `node_modules/next/dist/docs/` guides named in plan.md before editing routes, actions or the proxy (AGENTS.md).

**Tests**: Included. The spec and quickstart require them. All checks are Vitest, `renderToStaticMarkup`, `tsc`, lint or build. Nothing needs a browser or the network. ffmpeg suites skip locally without ffmpeg and cannot skip in CI.

**Format**: `[ID] [P?] [Story] Description`. [P] = different files, no dependency on unfinished tasks.

## Phase 1: Setup

- [x] T001 Read the Next docs named in plan.md (route handlers, server and client components, `proxyClientMaxBodySize`) under `node_modules/next/dist/docs/`, and note anything that differs from the contracts in `specs/018-video-groundwork/research.md` under a new "Implement notes" heading
- [x] T002 [P] Add `tests/helpers/ffmpeg.ts` (`requireFfmpeg()`: `describe.skip` locally, throws "ffmpeg is required in CI" when `CI` is set) and `tests/helpers/video-fixtures.ts` (lavfi-generated landscape, portrait, silent, MOV, rotated, located, corrupt, audio-only, long and oversize clips)
- [x] T003 [P] Extend `tests/helpers/storage.ts` so `MemoryStorage` supports multipart (create, uploadPart, listParts, complete, abort), head and file streaming per `contracts/uploads.md`

---

## Phase 2: Foundational (blocks all stories)

- [x] T004 Edit `src/server/db/schema/media.ts`: `byte_size` to `bigint`; add kind, processing state, step, error, attempts, lease, source key and video-fact columns; add the `media_uploads` table per `data-model.md`; generate `drizzle/0011_*.sql` with `pnpm db:generate` and verify with `pnpm db:check`
- [x] T005 [P] Add the six settings and the two cross-field `storageIssues` to `src/server/env.ts` with tests in `src/server/env.test.ts`; document them in `.env.example`
- [x] T006 [P] Create `src/server/media/limits.ts` (`libraryLimits(env)`, served to the browser) per `data-model.md` §4
- [x] T007 [P] Create `src/lib/media/sniff.ts` (`sniffMedia(bytes)`) with `src/lib/media/sniff.test.ts` (JPEG/PNG/WebP from sharp; MP4/MOV from ffmpeg fixtures; PDF, M4A brand and random bytes refused); add `VIDEO_UPLOAD_MIME_TYPES` and label maps to `src/lib/media/types.ts`
- [x] T008 Extend `src/server/storage/{types,s3,index}.ts` with multipart create/list/complete/abort, head, file streaming, the presign client and `mediaKeys` for `uploads/<u>/source`, `original.mp4|mov` and `thumb.webp`; add tests in `src/server/storage/s3.test.ts` using the SDK with a stub request handler (`listParts` follows `NextPartNumberMarker`; presigned URLs use the browser endpoint and no checksum parameters)
- [x] T009 [P] Create `src/lib/storage/upload-origin.ts` with `src/lib/storage/upload-origin.test.ts` asserting the origin equals the SDK's presigned `UploadPart` origin for AWS default, R2, MinIO path-style and a browser endpoint
- [x] T010 Add `uploadOrigin` to `CspInput` in `src/lib/http/security-headers.ts` (`connect-src`, new `media-src`) and compute it in `src/proxy.ts`; extend `src/lib/http/security-headers.test.ts`
- [x] T011 [P] Add the upload DAL (`src/server/dal/uploads.ts`, `uploads-housekeeping.ts`) with the `uploads` repo on `ProjectScope` in `src/server/dal/scope.ts`, `lockSelf` in `src/server/dal/members.ts`, and the new media filters in `src/server/dal/media.ts`; keep `tests/integration` scope-check tests green
- [x] T012 Run `pnpm typecheck` and `pnpm vitest run tests/integration/media src/server` to confirm the unchanged image path is still green

**Checkpoint**: foundation ready.

---

## Phase 3: User Story 1 - Upload with progress, early refusals and recovery (P1) 🎯 MVP

**Goal**: every upload is a multipart upload with progress, early refusals, Retry and Cancel, in the library and the picker.

**Independent Test**: `pnpm vitest run src/lib/upload src/components/media/upload tests/integration/media/uploads.test.ts`

### Tests first

- [x] T013 [P] [US1] Write `tests/integration/media/uploads.test.ts` per quickstart §2: create/sign/parts/complete for an image and a video; idempotent complete; `refused` on size mismatch; `parts_missing`; `not_found` for another or removed member; `too_many_open`; cancel; housekeeping expiry; chunk route short body and wrong `Content-Length`; SC-001 no file bytes reach Docket on `direct`
- [x] T014 [P] [US1] Write `src/lib/upload/engine.test.ts`, `precheck.test.ts`, `milestones.test.ts` and `src/components/media/upload/upload-ui.test.ts`, `UploadPanel.test.ts` per `contracts/upload-ui.md` (cap of 3 with six files and one failing, resume from part 3, refusals with zero action calls, at most five announcements)

### Implementation

- [x] T015 [US1] Create `src/server/services/uploads.ts` (create with per-member cap, sign, list, complete, cancel, status, `uploadPartViaApp`); images complete through today's `processUpload` (P7)
- [x] T016 [US1] Create `src/app/p/[projectSlug]/media/upload-actions.ts` (the six JSON actions with zod inputs and role checks) and the chunk route `src/app/p/[projectSlug]/media/uploads/[uploadId]/parts/[partNumber]/route.ts` (P5)
- [x] T017 [US1] Add `expireUploads` to `src/server/scheduler/housekeeping.ts`
- [x] T018 [P] [US1] Create `src/lib/upload/{milestones,precheck,engine,xhr-transport}.ts`
- [x] T019 [P] [US1] Create `src/components/media/upload/{upload-ui.ts,read-video.ts,UploadRow.tsx,UploadPanel.tsx}` following `docket-ui` (progressbar attributes, single live region, `beforeunload`, 2 s status poll)
- [x] T020 [US1] Replace the internals of `src/app/p/[projectSlug]/media/UploadDropzone.tsx` and `src/components/media/MediaPicker.tsx` with `UploadPanel`; pass limits from `src/app/p/[projectSlug]/media/page.tsx`; remove `uploadMediaAction` from `src/app/p/[projectSlug]/media/actions.ts`
- [x] T021 [US1] Extend `tests/lint/ui-limit-literals.test.ts` per `contracts/operations.md` (new files, `(image|video)/` pattern, library limits)
- [x] T022 [US1] Run `pnpm vitest run src/lib/upload src/components/media tests/integration/media tests/lint` and fix failures

**Checkpoint**: US1 works for images and for videos up to the `processing` state.

---

## Phase 4: User Story 2 - Videos are probed and get a poster in the background (P1)

**Goal**: the worker probes, cleans and posters each video; failures end as `failed` with a reason.

**Independent Test**: `pnpm vitest run tests/integration/video src/server/video tests/lint/no-ffmpeg-in-web.test.ts`

- [X] T023 [P] [US2] Write `src/server/video/probe.test.ts` (pure `parseProbe` on recorded JSON samples) and `tests/integration/video/{process,spawn,loop}.test.ts` per `contracts/video-processing.md`
- [X] T024 [P] [US2] Create `src/server/video/guard.ts` and `spawn.ts` (the only importer of `node:child_process`)
- [X] T025 [P] [US2] Create `src/server/video/probe.ts`, `clean.ts` and `poster.ts`; export `makeThumbnail` from `src/server/media/process.ts`
- [X] T026 [US2] Create `src/server/video/process.ts` (`processVideoFile`)
- [X] T027 [US2] Create `src/server/dal/media-processing.ts` (cross-project claim with `FOR UPDATE SKIP LOCKED`, lease, attempts, through `crossProject`) and `src/server/video/loop.ts` (`runMediaLoop`, `processNext`)
- [X] T028 [US2] Wire `markWorkerProcess()` and `runMediaLoop` into `src/worker.ts`; make video completion in `src/server/services/uploads.ts` create the `processing` row
- [X] T029 [P] [US2] Write `tests/lint/no-ffmpeg-in-web.test.ts` (import-graph walk and the `child_process` allow-list)
- [X] T030 [US2] Extend `src/server/services/media.ts`, `views/media.ts` and `src/components/media/MediaCard.tsx` / `MediaEditDialog.tsx` to show poster, facts and playback; add `public/media/video-processing.svg`
- [X] T031 [US2] Run `pnpm vitest run tests/integration/video tests/lint` and fix failures. ffmpeg must be present locally; if absent, state that in the final report rather than skipping silently — NOTE: ffmpeg/ffprobe are absent in this environment, so the real-ffmpeg suites (process.test.ts, the ffmpeg half of loop.test.ts) SKIPPED unrun; all else ran green (full suite 3348 passed). Run them with ffmpeg installed.

**Checkpoint**: US1 + US2 deliver the P1 scope.

---

## Phase 5: User Story 3 - See which accounts take a video (P2)

**Goal**: capabilities, validation, summary and badges cover video.

**Independent Test**: `pnpm vitest run src/providers src/server/services/media-fit.test.ts tests/integration/compose tests/integration/limits tests/integration/docs`

- [x] T032 [P] [US3] Write/extend `src/providers/validation.test.ts`, `requirements.test.ts`, `registry.test.ts`, `src/server/services/media-fit.test.ts` and `tests/integration/compose/check.test.ts` per `contracts/video-capabilities.md`
- [x] T033 [US3] Edit `src/providers/types.ts` (`VideoCapabilities`, `VideoFacts`, `MediaItem` fields) and add `assertVideoCapabilities` in `src/providers/media.ts`
- [x] T034 [P] [US3] Add `video: { maxVideos: 0 }` to the five `src/providers/{instagram,facebook,threads,bluesky,x}/capabilities.ts` and the mock's limits in `src/providers/mock/settings.ts`
- [x] T035 [US3] Split `validateAgainstCapabilities` in `src/providers/validation.ts` into image and video, add the video codes and processing/failed refusal
- [x] T036 [US3] Add the `video` part to `src/providers/requirements.ts`; render it in `src/components/compose/RequirementsSummary.tsx` and `requirements-ui.ts`
- [x] T037 [US3] Populate video `MediaItem`s from rows (`src/server/dal/targets.ts`, `scheduler.ts`, compose check) and extend `fitOf` in `src/server/services/media-fit.ts`, `media-variants.ts` and `FitBadges.tsx` (never "converted")
- [x] T038 [US3] Add the status poll for attached non-ready media in `src/app/p/[projectSlug]/compose/Composer.tsx`
- [x] T039 [US3] Extend `tests/helpers/limit-rows.ts`, `tests/helpers/factories.ts` (`createVideoAsset`), `tests/integration/docs/limits-inventory.test.ts`, `tests/integration/limits/enforcement.test.ts`, and update `docs/limits.md`
- [x] T040 [US3] Run the US3 test selection above and `pnpm typecheck`

---

## Phase 6: User Story 4 - Mock provider publishes a video (P2)

**Goal**: the mock takes `upload_video` → `check_video` → `publish`.

- [x] T041 [US4] Add `StepContent.videoCount` in `src/providers/types.ts` and the scheduler content shape; implement the mock video steps in `src/providers/mock/index.ts` with tests in `src/providers/mock/mock.test.ts`
- [x] T042 [US4] Write `tests/integration/media/video-publish.test.ts` (ffmpeg): upload through services, `processNext`, schedule, ticks, attempt log, published; out-of-limits video refused at scheduling and failed at publish-time re-check
- [x] T043 [US4] Show the video poster in the post list, calendar and composer thumbnails (where images show thumbnails)
- [ ] T044 [US4] 🛑 BLOCKED: ffmpeg is not installed in this environment, so video-publish.test.ts skips (mock tests pass). Run `pnpm vitest run src/providers/mock tests/integration/media/video-publish.test.ts`

---

## Phase 7: API and generator (spec FR-044, FR-045)

- [x] T045 [P] Add video fields to `MediaSchema` in `src/lib/api/schemas.ts` and `views/media.ts`; make upload and import refuse video with 415 "Video upload is available in the Docket app" in `src/server/api/operations/media.ts` and `src/server/services/media-from-url.ts`; test in `tests/integration/api/media-video.test.ts`
- [x] T046 [P] Filter videos out of `src/server/services/jobs/sources/media.ts` and `src/server/services/llm/images.ts`; extend `tests/integration/generation/*`

---

## Phase 8: User Story 5 - Operators can deploy it (P3)

- [X] T047 [P] [US5] Edit `Dockerfile` (`node:24-bookworm-slim`, apt `ffmpeg`, `COPY NOTICE`), create `NOTICE` per research P22, add `scripts/video-smoke.ts` and `build:video-smoke` in `package.json`
- [X] T048 [P] [US5] Edit `.github/workflows/ci.yml` (apt ffmpeg in `test`; `load: true`, `tags: docket:ci` and the in-image ffmpeg and smoke steps in `docker`)
- [X] T049 [P] [US5] Update `docs/storage.md`, `docs/deployment.md`, `docs/adding-a-provider.md`, `docs/feature-map.md`, `README.md` and the offline block of `.env.example` per `contracts/operations.md`; `tests/integration/docs/provider-guide.test.ts` must pass
- [X] T050 [US5] Run `pnpm build` and confirm `scripts/video-smoke.mjs` is produced in `.next/standalone/scripts/`

---

## Phase 9: Polish

- [x] T051 Run `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build` once and fix everything; the last `feat(media)` commit body must carry the operator note from `contracts/operations.md`
- [x] T052 Append the implementation outcome and any deviations to `docs/decisions.md` under `## 018`

---

## Owed live checks (quickstart §7; cannot run in the pipeline)

- [ ] T053 🛑 BLOCKED: needs a real browser and the offline MinIO profile — upload a ~200 MB video, drop Wi-Fi mid-way, Retry, watch it reach Ready, play it and publish to the mock account (US5 AS2, SC-011)
- [ ] T054 🛑 BLOCKED: needs a real R2 or AWS S3 bucket — direct upload of a 1 GB file with the documented CORS and IAM; confirm the IAM action names and presigned `UploadPart` on R2
- [ ] T055 🛑 BLOCKED: needs the operator's reverse proxy — `MEDIA_UPLOAD_TRANSPORT=via_app` upload, Retry and Cancel with a 9 MB body limit (US5 AS3)
- [ ] T056 🛑 BLOCKED: needs the operator's Unraid host — pull the new image and run `docker exec <worker> ffmpeg -version`; confirm the worker has twice the largest video in temporary disk

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 → stories. US1 needs Phase 2. US2 needs US1's service (T015) for completion (T028). US3 needs US2's rows for real videos but its unit tests use `createVideoAsset`, so T032–T036 may start after Phase 2. US4 needs US2 and US3. Phase 7 needs T033 and T030. US5 can start after Phase 2 (T047–T049 are independent files).
- Within a story: tests, then DAL/services, then actions and UI.
- T051 comes last; T053–T056 are owed by the operator and stay open.

## Parallel Examples

- Phase 2: T005, T006, T007, T009, T011 together.
- US1: T013, T014 together; then T018 and T019 together.
- US2: T024 and T025 together.
- US5: T047, T048 and T049 together.

## Implementation Strategy

**MVP**: Phases 1–4 (US1 + US2, both P1). Then US3 and US4 (P2), the API/generator guards, then US5 (P3) and the final pass.

---

## Phase 10: Review remediation

- [x] T057 Build the upload engine once per mounted panel and slug, independent of the `limits` object's identity: keep `limits` in a ref, or key the memo on a stable value. Stop the batch-settled `router.refresh()` and the action's `refresh()` from wiping rows. Add a test that re-renders `UploadPanel` with an equal but new `limits` object and asserts the rows survive. Review F1 (BLOCKER): src/components/media/upload/UploadPanel.tsx:131, src/components/media/upload/UploadPanel.tsx:165, src/app/p/[projectSlug]/media/page.tsx:77, src/app/p/[projectSlug]/media/upload-actions.ts:32
- [ ] T058 🛑 BLOCKED: workflow edited and ready, but pushing is withheld from this phase, so a human must push and confirm the ffmpeg suites ran (not skipped) and the image checks passed in CI, then correct docs/decisions.md:749 and docs/deployment.md:102 if they differ. Edit `.github/workflows/ci.yml`:
  - `test` job: apt-install ffmpeg before `pnpm test`.
  - `docker` job: `load: true` and `tags: docket:ci`; then run `ffmpeg -version`, `ffprobe -version`, the libx264 encoder check and `node scripts/video-smoke.mjs`, all as uid 1001, and log the image size.

  Push, and confirm the ffmpeg suites ran and passed in CI rather than skipped. Correct `docs/decisions.md:749` and `docs/deployment.md:102` to match what actually ran. If `.github/workflows/` cannot be written from this phase, leave this task unticked and report it for a human. Review F2 (BLOCKER): .github/workflows/ci.yml:50, .github/workflows/ci.yml:96, tests/helpers/ffmpeg.ts:15
- [x] T059 Call `markWorkerProcess()` at the start of `main()` in `scripts/video-smoke.ts`, so the in-image smoke can run the pipeline, and add a test that guards it. Review F3 (MAJOR): scripts/video-smoke.ts:22, src/server/video/spawn.ts:34
- [x] T060 Delete `sourceStorageKey` when a video is deleted (`deleteMedia`) and in the media loop's `!ready` branch. Assert that the source is gone in `tests/integration/video/loop.test.ts:163` and in a new test that deletes a queued video. Review F4 (MAJOR): src/server/services/media.ts:410, src/server/video/loop.ts:94
- [x] T061 Make Retry reach `completeUpload` when the parts were all confirmed or completion was already attempted, or treat `upload_finished` from `listUploadedParts` as a cue to complete. Add an engine test where completion succeeds on the server but the response is lost, then Retry reaches ready. Review F5 (MAJOR): src/lib/upload/engine.ts:292, src/server/services/uploads.ts:157
- [x] T062 Hide failed items from the composer's picker by passing a `states: ["processing", "ready"]` filter through `listSchema` and `listMedia` to `scope.media.list`; the library stays unfiltered. Add an integration test. Review F6 (MAJOR): src/components/media/MediaPicker.tsx:208, src/server/services/media.ts:293, src/server/dal/media.ts:59
