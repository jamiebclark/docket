# Implementation Plan: Video groundwork

**Branch**: `018-video-groundwork` | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/018-video-groundwork/spec.md`

## Summary

Entry 2 of the video roadmap. It builds what every later video entry needs: video in the media library, metadata and posters made in the worker, video capability fields and validation, and an upload experience that works for files of hundreds of megabytes. It also gives every upload, images included, progress, early refusals and recovery. Decisions P1–P30 are in [research.md](./research.md).

**Upload transport (US1, US5; operator choice).**

- **Flow.** Every upload is a presigned S3 multipart upload straight from the browser to the bucket, driven by five small JSON server actions: create, sign parts, list parts, complete and cancel (P1).
- **Parts.** Fixed parts of at least 8 MiB, sent one at a time per file with XHR for progress, three files at a time (P14).
- **Completion.** The server completes from the bucket's own `ListParts`, checking every part's size and the declared total. Completion is idempotent (P4).
- **Sessions.** A new project-owned `media_uploads` table records each session, its owner, a per-member cap of 10 open sessions, and expiry in housekeeping (P2).
- **Endpoints and fallback.** Presigning uses a second S3 client on the new optional `S3_BROWSER_ENDPOINT`, always with `WHEN_REQUIRED` checksums (P3). `MEDIA_UPLOAD_TRANSPORT=via_app` switches to a chunk route through the app, with the same session, the same part size and length checks against silent truncation (P5).
- **CSP.** It gains the upload origin in `connect-src` and a new `media-src`, without which neither direct upload nor playback works (P6, F3).

**Browser experience (US1).**

- **One component.** A shared `UploadPanel` serves both the media library and the composer's picker, with a pure client engine tested in Node (P14, P29, F11).
- **Before upload.** The browser checks the type (one shared magic-byte sniffer, P12), the size and, for video, duration and largest side, against limits served from the server (P13, P19).
- **Rows.** Each row has an accessible progress bar and milestone announcements. Errors appear on their row with Retry (resuming from confirmed parts) and Cancel.
- **After upload.** A 2 s status poll shows processing until ready or failed (P15).

**Processing (US2).**

- **Images** are processed in the web process when their upload completes, by today's `processUpload`, so their results and messages are unchanged (P7).
- **Videos** become `media_assets` rows in `processing` and are handled by a new **worker-only** media loop. `runTick` can run inside the web process (F1), so the loop is not part of it. Rows are claimed with `FOR UPDATE SKIP LOCKED`, a renewed lease and bounded attempts (P8).
- **Pipeline.** Download to a temporary directory, sniff, ffprobe, check against the library limits, remux with metadata removed and the result verified (D9, P10), poster frame, then stream back to the bucket (P9, P11).
- **The web process cannot start ffmpeg.** This is enforced by an import-graph test and a runtime guard (P21).
- **Schema.** `media_assets.byte_size` becomes `bigint`, because 4,096 MB does not fit in `integer` (F2, P20).

**Capabilities and validation (US3, US4).**

- **Capabilities.** `ProviderCapabilities` gains a required `video` block. The five real providers declare `{ maxVideos: 0 }`, and the mock declares the spec's limits (P16, P18).
- **One validator.** `validateAgainstCapabilities` now separates images from videos and checks each video limit. It refuses processing or failed media, so the composer check, the scheduling gate and the engine's publish-time re-check all refuse the same way (F4, F5).
- **Summary and badges.** The requirements summary gains a `video` part, and fit badges cover videos, never as "converted" (P17).
- **Mock publishing.** The mock publishes a video through `upload_video` → `check_video` (reports still processing once) → `publish` (P18).

**Packaging (US5).**

- **Image.** Pinned to `node:24-bookworm-slim`, with Debian's ffmpeg installed and a `NOTICE` file for GPL ffmpeg.
- **CI.** ffmpeg is installed for the fixture tests, and they cannot skip in CI. The `docker` job runs ffmpeg and a video smoke script inside the built image (P22, P23).
- **Compose.** No `docker-compose.yml` edit is required. The offline profile needs one `.env` line (P28).

**Not built here (spec FR-042 to FR-045):** no real provider publishes video; no transcoding, cropping or trimming; API video upload, posters for the generator and cross-reload resume stay unowned follow-ups (P24, P25, P30).

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS.

**Primary Dependencies**: all already installed. No new npm dependency (spec assumption 8).

- **Next.js 16.3.8.**
  - Changes: new server actions, one new route handler (`PUT`, in a deeper segment than the media page; F9), the client upload component, and the proxy's CSP inputs.
  - Read before editing (AGENTS.md): `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`, `01-app/01-getting-started/15-route-handlers.md`, `01-app/01-getting-started/05-server-and-client-components.md`, and `01-app/03-api-reference/05-config/01-next-config-js/proxyClientMaxBodySize.md`.
- **React 19.2.8.** `useSyncExternalStore` binds the engine.
- **zod 4.6.5.** Every action input and env var.
- **`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` 3.1145.0.** The multipart commands and `getSignedUrl` (F8).
- **sharp.** Image processing as today, plus the poster thumbnail in the worker.
- **Drizzle 0.45.3 / drizzle-kit 0.31.11.** One migration.
- **System binary:** Debian bookworm's `ffmpeg` package (ffmpeg and ffprobe 5.1.x) in the runner image, run only through `child_process.spawn` with argument arrays. **No wrapper library** (operator choice; fluent-ffmpeg is deprecated, research §3.4).

**Storage**: PostgreSQL. Migration `0011`:

- `media_assets.byte_size` → `bigint`;
- `media_assets` gains kind, processing state, step, error, attempts, lease, source key and video facts;
- a new `media_uploads` table.

Objects go to the S3-compatible bucket:

- staging: `projects/<p>/uploads/<u>/source`;
- video originals: `media/<a>/original.mp4|mov`;
- posters: `thumb.webp`.

See [data-model.md](./data-model.md).

**Testing**: Vitest (`environment: node`) against real Postgres, with run-scoped databases. There is no browser environment (F11), so:

- **Pure engine tests:** the upload engine, precheck, milestones, sniff and the probe parser, each with fakes.
- **Integration:** upload sessions with `MemoryStorage`; compose check, limits and docs inventory; API; generator.
- **ffmpeg suites:** processing, spawn, loop and the US4 end-to-end test, with fixtures generated at test time with `lavfi`. They skip locally without ffmpeg and cannot skip in CI.
- **Lint-style tests:** no ffmpeg in the web process, and no UI limit literals.
- **Markup:** UI is checked with `renderToStaticMarkup`.
- **In-image smoke:** `scripts/video-smoke.mjs` in the CI `docker` job.
- **No live calls.** See [quickstart.md](./quickstart.md).

**Target Platform**: self-hosted Linux containers (`web` and `worker` from one image, amd64 and arm64) on Docker Compose, Unraid, or a container host with Neon. Browsers: current Chrome, Firefox and Safari. XHR upload progress is available everywhere (research §4). Reading video metadata is best effort, with a server fallback.

**Project Type**: web application (Next.js App Router monolith with a separate worker process).

**Performance Goals**:

- **Docket's request sizes (SC-001).** No request to Docket above 1 MB on the direct path; requests are JSON of a few hundred bytes.
- **Browser refusals (SC-002).** Under 1 s from choosing a file. The sniff reads 64 bytes, and the `<video>` metadata read has a 10 s cap that only delays *uploading*, never a refusal of type or size.
- **Status updates (SC-006).** A state change reaches the row within 5 s. The worker idles at 2 s per poll, the UI polls every 2 s, and each status call is one primary-key query over at most 50 ids.
- **Processing time.** A video costs about two file-sized disk writes plus a stream copy, with no re-encode.

**Constraints**:

- No ffmpeg in the web process (FR-016, SC-007).
- No `LISTEN` and no session-level Postgres features (Neon pooler).
- No provider or storage call inside a held transaction.
- Each worker run is bounded by per-command time limits and a 30-minute item deadline.
- The worker needs temporary disk of about twice the largest video (FR-040).
- Proxy-buffered request bodies are capped at 26 MB, and an oversized body is truncated silently (research §3), so the chunk route checks lengths.
- Presigned URLs live at most 7 days (research §1). Docket signs for 1 h, and expiry is at most 168 h.
- No literal limits or MIME types in UI code (FR-036).
- Text and image parts of the summary are unchanged (FR-026).

**Scale/Scope**: 6 providers (5 real platforms declaring `maxVideos: 0`, plus mock).

- **New source files:** about 25:
  - `src/server/video/*` (7);
  - `src/server/services/uploads.ts`, `src/server/dal/uploads*.ts`, `src/server/dal/media-processing.ts` and `src/server/media/limits.ts`;
  - `src/lib/upload/*` (5), `src/lib/media/sniff.ts` and `src/lib/storage/upload-origin.ts`;
  - `src/components/media/upload/*` (4);
  - the upload actions and the chunk route;
  - `scripts/video-smoke.ts`, `NOTICE` and `public/media/video-processing.svg`.
- **Edited source files:** about 30:
  - provider types, the validator, requirements, mock and five capability files;
  - media service, views, variants, fit, DAL media, targets and scheduler content shape;
  - env, storage, CSP and proxy, worker, housekeeping;
  - the API schema and operations, the generator source and images;
  - `MediaCard`, `MediaPicker`, `UploadDropzone`, `RequirementsSummary` and `Composer`;
  - the Dockerfile, CI and `package.json`.
- **Docs:** 9 files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How this plan meets it |
|---|---|---|
| I. Verified facts over memory | PASS | Transport facts come from `docs/research/upload-transport.md`, and ffmpeg and licensing facts from `docs/research/ffmpeg.md`. Library facts were read from the installed SDK, Next and `@types/node` in this phase (F8–F10). Two kinds of remaining fact are not taken from memory: research's UNVERIFIED items (rotation field names, `avg_frame_rate`, metadata removal, SIGTERM behaviour, option support on 5.1) and file-format magic numbers. Each is an **assertion in a test that runs real ffmpeg** in CI and inside the image (P23, P22), so a wrong guess fails the build. The upload origin's host rules are checked against the SDK's own presigned URLs (P6). The unverified AWS IAM action names stay labelled UNVERIFIED in `docs/storage.md`, as research requires. |
| II. Nothing is "working" unless it ran | PASS | Every behaviour has an automated test (quickstart §1–§5). ffmpeg behaviour is proved by real runs in CI and in the image. A real bucket, a browser and a reverse proxy cannot run in the pipeline, so they are listed as owed live checks (quickstart §7) and reported as "verified with mocks only" until then. Provider tests make no live calls. |
| III. Project isolation in one place | PASS | `media_uploads` carries `project_id` and is read through a scoped repo on `ProjectScope`. Ownership by member is checked in the service on every call, and the role check (`media: edit` / `view`) is server-side. The worker's claim and the upload expiry are the only cross-project reads; they go through `crossProject(reason, …)` as housekeeping does (F20), and the scope-check test covers them. No route, action or job imports the raw client. |
| IV. One service layer | PASS | The library and the picker share one component, engine and set of actions. The API keeps its own image path by design (D10). One validator serves the composer, the gate and the engine (F4). One sniffer serves the browser and the worker (P12), and one `libraryLimits` serves the services, the worker and the browser (P19). Badges reuse the validator (P17). |
| V. Providers are plug-ins | PASS | Video limits are declared in each provider's own `capabilities.ts`. The new `video` block is required so that no provider accepts video by omission (P16). The mock's video steps live in its folder. The scheduler, composer and schema learn about **video** once, generically, and adding a video-capable provider later needs no change outside its folder. |
| VI. Boring, few dependencies | JUSTIFIED | No new npm package. **New runtime dependency: the ffmpeg system package** in the image. It was chosen by the operator, is justified below, and is recorded in `docs/decisions.md` `## 018`. No new infrastructure: no queue, no Redis, and polling instead of `LISTEN`. |
| VII. Secrets never leak | PASS | Storage credentials stay on the server. Presigned URLs are short-lived, per part, never logged and never put in errors. Storage errors keep `StorageError`'s scrubbing. The `UploadId` is never logged. ffmpeg stderr goes to the worker log truncated, never to the item or the browser. The new env vars are Zod-validated and documented. |
| Engineering constraints | JUSTIFIED | Neon-safe: polling, no `LISTEN`, no advisory locks. The per-member cap locks the member's row instead. All times are UTC from the DB clock. The UI follows `docket-ui`. Video was out of scope "until a spec says otherwise", and this spec says otherwise. **Deviation:** video processing is a worker loop outside `runTick` (see below). |
| Workflow | PASS | Conventional commits with explicit paths. `docs/decisions.md` `## 018` is written in this phase. Checks run in proportion: targeted tests per task, then one full pass with `db:check` and `build` at the end of implement. |

**Post-design re-check (after Phase 1)**: PASS, with the two justified deviations below.

- The design adds one table and one migration, one route handler and one worker loop, and its boundaries are testable. The worker-only rule is enforced by test (P21), not by convention.
- One coupling needs naming. The browser and the worker share `src/lib/media/sniff.ts`. That module is pure and client-safe, and this sharing is what constitution IV asks for.
- `MediaItem` grows optional fields instead of a breaking change, so existing provider code and tests compile unchanged.

## Project Structure

### Documentation (this feature)

```text
specs/018-video-groundwork/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0: facts F1–F20, decisions P1–P30
├── data-model.md        # Phase 1: media_assets changes, media_uploads, types, codes
├── quickstart.md        # Phase 1: validation runs and owed live checks
├── contracts/
│   ├── uploads.md            # server actions, chunk route, Storage additions
│   ├── upload-ui.md          # UploadPanel, engine, row states, a11y, tests
│   ├── video-processing.md   # worker loop, commands, facts, failures, tests
│   ├── video-capabilities.md # capabilities, validator, summary, badges, mock, API, limits.md
│   └── operations.md         # env, CSP, Dockerfile, NOTICE, CI, literal scan, docs
├── checklists/
└── tasks.md             # Phase 2 (/speckit-tasks), not created here
```

### Source Code (repository root)

```text
NOTICE                                          # NEW: GPL ffmpeg in the image, Debian source
Dockerfile                                      # bookworm-slim pin; apt ffmpeg; COPY NOTICE
.github/workflows/ci.yml                        # test: apt ffmpeg; docker: load, ffmpeg checks, video smoke
package.json                                    # build:video-smoke
public/media/video-processing.svg               # NEW: placeholder thumbnail
scripts/video-smoke.ts                          # NEW: in-image pipeline check
drizzle/0011_*.sql                              # NEW: migration (generated)
src/
├── worker.ts                                   # markWorkerProcess(); runMediaLoop beside runLoop
├── proxy.ts                                    # uploadOrigin into the CSP
├── lib/
│   ├── media/types.ts                          # VIDEO_UPLOAD_MIME_TYPES, codec/container label maps
│   ├── media/sniff.ts                          # NEW (+ test)
│   ├── storage/upload-origin.ts                # NEW (+ test against the SDK)
│   ├── http/security-headers.ts                # connect-src upload origin, media-src (+ test)
│   ├── api/schemas.ts                          # MediaSchema video fields
│   └── upload/{engine,precheck,milestones,xhr-transport}.ts   # NEW (+ tests)
├── providers/
│   ├── types.ts                                # VideoCapabilities, VideoFacts, MediaItem fields, StepContent.videoCount
│   ├── validation.ts                           # image/video split, video codes, processing/failed (+ test)
│   ├── requirements.ts                         # video part, ratio/duration/fps labels (+ test)
│   ├── media.ts                                # assertVideoCapabilities
│   ├── mock/{index,settings}.ts                # video caps, video steps (+ test)
│   └── {instagram,facebook,threads,bluesky,x}/capabilities.ts  # video: { maxVideos: 0 }
├── server/
│   ├── env.ts                                  # six settings, cross-field issues (+ test)
│   ├── db/schema/media.ts                      # columns, bigint, media_uploads
│   ├── dal/{media,targets,scheduler,members,scope}.ts           # filters, facts, videoCount, lockSelf, uploads repo
│   ├── dal/{uploads,uploads-housekeeping,media-processing}.ts   # NEW
│   ├── storage/{types,s3,index}.ts             # multipart, head, file streaming, presign client; mediaKeys mp4/mov/upload (+ test)
│   ├── media/{limits.ts,process.ts}            # NEW libraryLimits; export makeThumbnail
│   ├── video/{guard,spawn,probe,clean,poster,process,loop}.ts  # NEW, worker-only
│   ├── scheduler/housekeeping.ts               # expireUploads
│   ├── services/uploads.ts                     # NEW: create/sign/list/complete/cancel/status/uploadPartViaApp
│   ├── services/{media,media-variants,media-fit,media-from-url}.ts   # views, video pass-through, badges, API refusal
│   ├── services/views/media.ts                 # API view fields
│   ├── services/jobs/sources/media.ts, llm/images.ts            # images only
│   └── api/operations/media.ts                 # video refusal, descriptions
├── components/
│   ├── media/upload/{UploadPanel,UploadRow}.tsx, upload-ui.ts, read-video.ts   # NEW (+ tests)
│   ├── media/{MediaCard,MediaPicker,FitBadges}.tsx              # video display, shared upload, badge text
│   └── compose/RequirementsSummary.tsx, requirements-ui.ts       # video line
└── app/p/[projectSlug]/
    ├── media/{page,UploadDropzone,MediaEditDialog}.tsx, actions.ts   # limits prop, wrapper, video details; uploadMediaAction removed
    ├── media/upload-actions.ts                 # NEW: the six actions
    ├── media/uploads/[uploadId]/parts/[partNumber]/route.ts      # NEW: via_app chunk PUT
    └── compose/Composer.tsx                    # status poll for attached non-ready media

tests/
├── helpers/{storage,ffmpeg,video-fixtures,limit-rows,factories}.ts   # multipart MemoryStorage; skip/fail; lavfi; video rows; createVideoAsset
├── integration/media/{uploads,video-publish}.test.ts             # NEW
├── integration/video/{process,spawn,loop}.test.ts                # NEW (ffmpeg)
├── integration/api/media-video.test.ts                           # NEW
├── integration/{compose/check,docs/limits-inventory,limits/enforcement,generation/*}.test.ts   # extended
└── lint/{no-ffmpeg-in-web,ui-limit-literals}.test.ts             # NEW / extended

docs/{storage,deployment,limits,adding-a-provider,feature-map,decisions}.md, .env.example, README.md
```

**Structure Decision**: the existing single Next.js app, with new code next to its peers:

- `src/providers` holds pure capability and validation code.
- `src/server/services` holds the one upload service.
- `src/server/dal` holds the scoped repos, with cross-project repos used only through `crossProject`.
- `src/server/video` is new and worker-only, its boundary enforced by test.
- Client-safe pure logic sits in `src/lib/upload` and `src/lib/media`, so the engine can be tested in Node.
- UI lives in `src/components/media/upload`, shared by the library and the picker.

## Implementation order (for /speckit-tasks)

1. **Foundation.**
   - Schema and migration (P20), with `byte_size` as `bigint`, then `db:check`.
   - Env settings and `libraryLimits` (P19).
   - `sniffMedia` (P12).
   - Storage multipart, head and file streaming methods, the presign client and `MemoryStorage` (contracts/uploads.md).
   - `upload-origin` and the CSP (P6).
   - Existing tests must stay green: the image path is unchanged so far.
2. **US1 server side.**
   - The uploads DAL and service: create with the cap, sign, list, complete for images (P7), cancel, status.
   - The actions, the chunk route (P5) and upload expiry in housekeeping, with `tests/integration/media/uploads.test.ts`.
3. **US1 client side.**
   - The engine, precheck, milestones and XHR transport, with their tests.
   - The `upload-ui` wording, `UploadPanel` and `UploadRow`.
   - The library wrapper and the picker, then remove `uploadMediaAction`.
   - Extend `ui-limit-literals`.
4. **US2 processing.**
   - Guard and spawn, the probe parser, clean, poster and `processVideoFile` (P9–P11).
   - The ffmpeg helper and fixtures, then the processing and spawn tests.
   - The media-processing DAL and loop with the loop tests.
   - Wire the worker, then video completion in `completeUpload`.
   - The `no-ffmpeg-in-web` test.
5. **US3 capabilities.**
   - Types, the `assertVideoCapabilities` registry check, the validator split and video codes (P16).
   - The five `maxVideos: 0` declarations and the mock caps.
   - `MediaItem` facts from rows (`itemOf`, `effectiveContent`, compose).
   - The summary video part (P17), then `fitOf` for videos.
   - `RequirementsSummary`, `FitBadges`, `MediaCard`, the detail dialog and the placeholder (P26).
   - The composer status poll.
   - `limit-rows`, the inventory, `docs/limits.md` and the enforcement rows.
6. **US4 mock end to end.**
   - `StepContent.videoCount` and the mock video steps (P18).
   - `tests/integration/media/video-publish.test.ts`.
7. **API and generator.** `MediaSchema` fields and the video refusal on upload and import (P24); generator filters (P25); their tests.
8. **US5 packaging and docs.**
   - Dockerfile, `NOTICE`, `video-smoke` and the CI jobs (P22).
   - `.env.example`, `docs/storage.md`, `docs/deployment.md` (including the optional compose edit and the measured image size), `docs/adding-a-provider.md`, `docs/feature-map.md` and README.
9. **Final pass.** `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build` once, then push so CI runs the ffmpeg suites and the in-image smoke run.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| New runtime dependency: Debian's `ffmpeg` package (ffmpeg and ffprobe) in the runner image (constitution VI) | Probing video, removing location metadata without re-encoding, and making poster frames all need a demuxer and decoder for MP4/MOV with H.264 and HEVC. No installed package does this: sharp is images only. The operator chose Debian's apt build, run as a separate process with no wrapper. | A static ffmpeg build (research §1.3) needs per-arch downloads and checksums, and gets no distro security updates. An LGPL build has no CPU H.264 (research §2). A wrapper library (fluent-ffmpeg) is deprecated (research §3.4). Doing without ffmpeg is impossible for FR-016 to FR-020. |
| Background work outside `runTick()` (constitution, Engineering Constraints: "Scheduler work lives in runTick(): bounded (well under 30 s)") | `runTick` also runs inside the web process (`RUN_WORKER_IN_PROCESS`, `POST /api/internal/tick`; F1), where FR-016 and SC-007 forbid ffmpeg. One video's processing takes minutes, not seconds. The media loop keeps every other scheduler rule: `FOR UPDATE SKIP LOCKED` claims, a lease with a token, bounded attempts, no provider or storage call in a held transaction, safe to kill and to run concurrently, and per-command time limits with a 30-minute item deadline. | A `runTick` section would run ffmpeg in web for in-process deployments and blow the tick budget. A queue or Redis is new infrastructure. Spawning ffmpeg per tick in small slices is impossible: a remux or probe cannot be paused and resumed. |
