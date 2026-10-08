---

description: "Task list for Bluesky video (roadmap entry 7)"
---

# Tasks: Bluesky video

**Input**: Design documents from `/specs/025-bluesky-video/`

**Prerequisites**: plan.md, spec.md, research.md (F1–F18, P1–P22), data-model.md, contracts/bluesky-video-capabilities.md, contracts/bluesky-video-publishing.md, quickstart.md

**Tests**: Required. The spec (FR-026, FR-027) demands mocked-HTTP step-machine tests; real Bluesky publishing is "verified with mocks only". Every verification task below is an executable Vitest run. No task needs a browser, dev server, `curl` or ffmpeg (video rows come from `createVideoAsset` facts).

**Organization**: Grouped by user story. US1, US2, US3 are P1; US4 is P2. The declaration itself (`capabilities.ts`) is foundational because US1's publish path cannot be reached without the `video` post type.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelisable (different files, no dependency on incomplete tasks)
- **[Story]**: US1–US4
- Paths are repo-relative from the worktree root. Read `contracts/*.md` section named in each task for exact shapes, messages and request bodies.

## Path Conventions

Single Next.js app. Source in `src/providers/bluesky/`, generic hook in `src/providers/types.ts` and `src/server/scheduler/record.ts`, tests beside source plus `tests/integration/bluesky/`, helper in `tests/helpers/`.

---

## Phase 1: Setup

**Purpose**: Confirm the baseline before touching anything.

- [x] T001 Run `pnpm vitest run src/providers/bluesky tests/integration/bluesky src/server/scheduler/record.test.ts` and record that the existing Bluesky and record suites are green (baseline; no file changes). Confirm `DATABASE_URL` is set for integration suites.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: G24, the declaration, state, step derivation, clients and the shared test helper. No user story can run before this is done.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T002 Add optional `wait?: string` to the `continue` member of `StepResult` in `src/providers/types.ts` and make `applyStepResult` in `src/server/scheduler/record.ts` write it to `lastError` for a `continue` that carries it, using no attempt (publishing contract §8; plan G24). A `continue` without `wait` must still write `lastError: null`.
- [x] T003 Add two cases to `src/server/scheduler/record.test.ts`: a `continue` with `wait` shows the message and uses no attempt; a `continue` without it still clears `lastError`. Run `pnpm vitest run src/server/scheduler/record.test.ts`.
- [x] T004 [P] Create `src/providers/bluesky/capabilities.ts` per data-model §1 and capabilities contract §1: `BLUESKY_VIDEO` (one video, no images with it, MP4, H.264, AAC or silent, 300,000,000 bytes, 180 s), the two summary notes (about 25 a day; verified email for Bluesky-hosted accounts), the creation allowance (25 per 86,400 s, "Bluesky's daily video upload allowance"), post types `text,image,carousel,video` with no choice, and `blueskyCapabilities`.
- [x] T005 Edit `src/providers/bluesky/index.ts` to use `capabilities.ts` and declare `creationAllowance` (depends on T004).
- [x] T006 [P] Create `src/providers/bluesky/video-state.ts` per data-model §2 and §4: `videoUploadSchema`, phases (`limits`, `start`, `parts`, `finish`, `job`, `ready`), pace constants (first read 30 s, 1 min until 10 min, then 5 min; fail at 30 min or 16 reads), `fitState` (drops state whose media no longer match), `partRange(k)`, `nextReadAt`.
- [x] T007 Edit `src/providers/bluesky/settings.ts`: `blueskyStateSchema` gains `video: videoUploadSchema.optional()`, `v` stays `1` (depends on T006).
- [x] T008 Edit `src/providers/bluesky/steps.ts`: `stepForContent` reads `kinds` and the upload phase and emits `resolve_mentions` (if any) → `check_upload_limits` → `start_upload` → `upload_part_1..N` → `finish_upload` → `check_job` → `create_post` per data-model §3; reserve the allowance at `check_upload_limits` (plan P2). Text and image steps stay byte for byte (depends on T006, T007).
- [x] T009 [P] Create `src/providers/bluesky/pds-host.ts` exporting `pdsHostOf(didDoc): string | null` (reads `#atproto_pds`; contract §3, P4) and `src/providers/bluesky/pds-host.test.ts` covering present, absent, malformed.
- [x] T010 [P] Create `src/providers/bluesky/video-errors.ts` with the plain explanations of publishing contract §7 and `sanitiseMessage(text, secrets)` (P17), and `src/providers/bluesky/video-errors.test.ts` covering every D8 code and secret scrubbing.
- [x] T011 [P] Create `src/providers/bluesky/media-range.ts` exporting `readRange(url, first, last, signal)` and `storedSize(url, signal)` using HTTP `Range` (P6; no whole-file read).
- [x] T012 Create `src/providers/bluesky/video-service.ts` per contract §2 and §4: `VIDEO_SERVICE_URL`, `VIDEO_SERVICE_DID`, `serviceToken` (method-scoped, `exp` +300 s), `getUploadLimits`, `startUpload`, `uploadPart`, `finishUpload`, `getJobStatus`, and `VideoServiceError extends XRPCError` keeping the body (P5, P15). Add `src/providers/bluesky/video-service.test.ts` covering token audience/method/expiry, the token reaching only `https://video.bsky.app`, error subclassing and body retention (depends on T010).
- [x] T013 [P] Create `tests/helpers/bluesky-video.ts` with `blueskyVideoSetup`, `routeVideoService` (extends the fake PDS in `tests/helpers/fake-pds.ts` with the video service's paths; configurable replies per method; echoes the token it received) and `rangeFetch` (byte-range media stub answering 206).
- [x] T014 [P] Create `src/providers/bluesky/video-state.test.ts` (schema, `fitState`, `partRange` incl. last short part and one-part video, `nextReadAt` pace boundaries) and `src/providers/bluesky/video-steps.test.ts` (every phase maps to one step; only `create_post` may publish; old Bluesky states parse; mentions step present only with mentions). Run them plus untouched `src/providers/bluesky/steps.test.ts`: `pnpm vitest run src/providers/bluesky/video-state.test.ts src/providers/bluesky/video-steps.test.ts src/providers/bluesky/steps.test.ts src/providers/bluesky/pds-host.test.ts src/providers/bluesky/video-service.test.ts src/providers/bluesky/video-errors.test.ts` (depends on T006–T012).

**Checkpoint**: Foundation ready; story phases can begin.

---

## Phase 3: User Story 1 - Publish one video to Bluesky (Priority: P1) 🎯 MVP

**Goal**: A target whose content is one video is uploaded in parts through Bluesky's video service, polled, and posted with an `app.bsky.embed.video`.

**Independent Test**: `pnpm vitest run tests/integration/bluesky/video.test.ts src/providers/bluesky/video-publish.test.ts` — a 12,000,000-byte 1080×1920 30 s MP4 with 5,000,000-byte parts publishes with the exact requests of quickstart §3.

### Implementation for User Story 1

- [x] T015 [US1] Create `src/providers/bluesky/video-publish.ts` with the handlers for `check_upload_limits`, `start_upload`, `upload_part_<k>`, `finish_upload`, `check_job` per publishing contract §4.1–§4.5 (success paths and retryable outcomes first; US2/US4 outcomes completed in their phases). Each step makes at most four short calls and sends at most one part; PDS host read once per upload via `getSession` DID doc with configured-server fallback (P4); token never stored (depends on T008–T012).
- [x] T016 [US1] Edit `src/providers/bluesky/publish.ts`: dispatch the video step names to `video-publish.ts`; add the `app.bsky.embed.video` embed to `createPost` per §4.6 (blob exactly as returned, `aspectRatio`, alt text, no `captions`); `create_post` stays the only publishing step and an unknown create outcome stays ambiguous (depends on T015).
- [x] T017 [US1] Create `src/providers/bluesky/video-publish.test.ts` unit-testing each handler's success outcome and retryable outcomes (timeout, 429 with `Retry-After`, 5xx, dropped connection) with mocked clients, plus `media-range` behaviour (206, size mismatch vs declared) (depends on T015).
- [x] T018 [US1] Create `tests/integration/bluesky/video.test.ts` through `runTick` with the helper of T013, covering quickstart §3: the full request sequence and token audiences, three parts of 5,000,000/5,000,000/2,000,000 bytes in three ticks, status reads at ≥30 s then ~1 min, post created with the blob, `published` with `at://` URI and `https://bsky.app/profile/<handle>/post/<rkey>`; plus one-part video, empty text, mention resolved first, timeout at each pre-create step retried with nothing published, timeout after `createRecord` ambiguous and never retried, a target waiting while its Bluesky version is still being built ("Preparing video for Bluesky") then uploading that version's bytes (FR-017), and text/image posts sending exactly today's requests (depends on T016).
- [x] T019 [US1] Run `pnpm vitest run src/providers/bluesky/video-publish.test.ts tests/integration/bluesky` and confirm every pre-existing Bluesky suite passes untouched.

**Checkpoint**: One video publishes end to end (MVP).

---

## Phase 4: User Story 2 - A failed or slow Bluesky video ends cleanly (Priority: P1)

**Goal**: Every refusal, expiry, slow job or restart ends with a plain message or a clean resume, never a duplicate or a stuck post.

**Independent Test**: `pnpm vitest run tests/integration/bluesky/video-failures.test.ts`.

### Implementation for User Story 2

- [x] T020 [US2] Complete the failure outcomes in `src/providers/bluesky/video-publish.ts` per contract §4.2–§4.5 and §6–§7: fatal start refusals (`UnsupportedContentType`, `VideoTooLarge`, `VideoTooLong`, `BadAspectRatio`, `UploadForbidden`, 401/403, other 4xx) with exact message text; part errors (`UploadAlreadyCompleted` skip, restart codes, same-`k` resend after timeout using P21's text, fatal part codes); finish outcomes (failed job state, early blob, `completedJobId` deduplication, already-processed blob in a non-2xx body per P15); job polling (failed state beats a blob, unknown state keeps polling, 30 min / 16 read ceiling, `statusAuth` service→none fallback per P13); restart from the limits check at most twice then fail (P14); a changed post starts again (P18); token-refusal outcomes of §2.
- [x] T021 [US2] Extend `src/providers/bluesky/video-publish.test.ts` with unit cases for each outcome row of contract §4.2–§4.5 and the restart counter (depends on T020).
- [x] T022 [US2] Create `tests/integration/bluesky/video-failures.test.ts` covering quickstart §4: each start refusal and job failure code ends with the §7 text; unknown state or unreadable reply keeps polling; no blob at 30 min fails within 16 reads and 35 min; 5-minute spacing after 10 minutes; deduplicated finish polled by `completedJobId`; already-processed blob skips polling; expiry restarts twice then fails; timed-out part resent with the same number; killed worker resumes at its step (ambiguous only inside `create_post`); changed post starts again; status-auth fallback (depends on T020).
- [x] T023 [US2] Run `pnpm vitest run src/providers/bluesky/video-publish.test.ts tests/integration/bluesky/video-failures.test.ts tests/integration/bluesky/video.test.ts`.

**Checkpoint**: US1 and US2 both pass.

---

## Phase 5: User Story 3 - Bluesky's video limits shape the video before it is sent (Priority: P1)

**Goal**: The declaration drives validation, the requirements summary, fit badges and entry 6's formatter, with no Bluesky formatter code.

**Independent Test**: quickstart §1 commands.

### Implementation for User Story 3

- [x] T024 [P] [US3] Edit `src/providers/bluesky/validate.ts`: reword `too_many_videos` and `video_with_images` in Bluesky's words (P19; capabilities contract §2); everything else unchanged.
- [x] T025 [P] [US3] Create `src/providers/bluesky/capabilities.test.ts` (declaration values, post types, no choice, allowance) and `src/providers/bluesky/video-validate.test.ts` (two videos and video-with-images refused with Bluesky's wording, 0 fake-PDS requests, through composer check, scheduling gate and publish-time re-check) (depends on T024).
- [x] T026 [US3] Edit `src/providers/requirements.test.ts` per P20: drop Bluesky from the generic "empty video notes unchanged" loop and add a Bluesky video summary case (video row, "up to 3 minutes", "300 MB", the two notes, no "Post as"). Summary keys must avoid the words the redactor drops (F6).
- [x] T027 [P] [US3] Create `tests/integration/bluesky/video-fit.test.ts`: a 5-minute HEVC MOV is "will be adapted" (cut to 3:00, re-encoded), a 40 s H.264/AAC MOV is a rewrap, a 40 s H.264/AAC MP4 fits as is, two videos or video+image refused; uses `createVideoAsset` facts, no ffmpeg.
- [x] T028 [P] [US3] Create `tests/integration/compose/bluesky-video-summary.test.ts` for the server-side summary and fit badges (FR-018, FR-019).
- [x] T029 [US3] Add the Bluesky video rows to `docs/limits.md` per data-model §7 (videos, video with images, containers, codecs, audio codecs, video bytes, max duration, creation allowance), then run `pnpm vitest run tests/integration/limits/enforcement.test.ts tests/integration/docs/limits-inventory.test.ts` and fix the doc until the generated tests pass (depends on T004).
- [x] T030 [US3] Run `pnpm vitest run src/providers/bluesky/capabilities.test.ts src/providers/bluesky/video-validate.test.ts src/providers/requirements.test.ts src/server/services/media-fit.test.ts tests/integration/bluesky/video-fit.test.ts tests/integration/compose/bluesky-video-summary.test.ts`.

**Checkpoint**: US3 passes independently of publishing details.

---

## Phase 6: User Story 4 - Bluesky's daily video limit makes posts wait, not fail at once (Priority: P2)

**Goal**: Refused upload checks and the allowance defer posts with Bluesky's message instead of failing.

**Independent Test**: `pnpm vitest run tests/integration/bluesky/video-limits.test.ts`.

### Implementation for User Story 4

- [x] T031 [US4] Complete the limit logic in `src/providers/bluesky/video-publish.ts` per contract §4.1 and §4.2: `canUpload: false` and `DailyLimitExceeded` wait one hour via G24 `wait` with Bluesky's message, `limitWaitSince` kept, fatal at 23 hours after the first refusal (P9); refused or unreadable check is skipped with `limitsCheck: "skipped"` (P10); allowance reservation at the limits check with one extra unit on a retried start (P2), deferring with "Waiting for Bluesky's daily video upload allowance", 0 Bluesky requests and no attempt used.
- [x] T032 [US4] Create `tests/integration/bluesky/video-limits.test.ts` covering quickstart §5: `canUpload: false` waits an hour showing Bluesky's message with no upload request; upload starts once allowed; refusal 23 h after the first fails with that message; refused check logged as skipped and upload starts; `DailyLimitExceeded` waits the same way; 25 reservations in 24 hours defer the next video (depends on T031).
- [x] T033 [US4] Run `pnpm vitest run tests/integration/bluesky/video-limits.test.ts tests/integration/bluesky`.

**Checkpoint**: All four stories pass.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [x] T034 [P] Create `tests/integration/bluesky/video-no-secrets.test.ts`: drive every video step with a fake service that echoes the token and assert no session token, service token or app password appears in state, `lastError`, attempts, summaries, activity, logs or snapshots (FR-007, constitution VII).
- [x] T035 [P] Edit `docs/adding-a-provider.md`: §13 video steps (per-step service tokens for a second host, upload in parts within bounded steps, limits check and fallback, job polling, error explanations) and G24 in the generic hooks index and §7.
- [x] T036 [P] Edit `docs/feature-map.md`: move Bluesky video to "Already built"; record unowned items (WebVTT captions, GIF hint, gallery embed, quote posts with video, more than one video or video with images, another video service, API video upload, generator video).
- [x] T037 [P] Edit `docs/accounts.md` (Bluesky): no new connection step, verified email for Bluesky-hosted accounts, about 25 a day, and the owed live checks of quickstart §7; state that real publishing is verified with mocks only (FR-027).
- [x] T038 [P] Edit `docs/decisions.md`: record the implementation outcome under `## 025`, and state that `docker-compose.yml` and `.env.example` are unchanged (FR-025).
- [x] T039 Run the full pass once: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` (no `db:check`; no schema change). Fix any failure; report exact output if anything remains red.
- [ ] T040 🛑 BLOCKED: needs a real Bluesky account (app password, verified email) and the operator's server — run the owed live checks of quickstart §7 (publish a 30 s MP4; confirm host/token audience for upload, limits and status calls; record `partSizeBytes` and part timing; processing time; 4-minute video with raised max duration; `Range` 206 on the public media URL) and record results in `docs/accounts.md`.

---

## Dependencies & Execution Order

- **Setup (T001)** → **Foundational (T002–T014)** → stories.
- Within Foundational: T002→T003; T004→T005; T006→T007→T008; T010→T012; T014 after T006–T012. T004, T006, T009, T010, T011, T013 are parallel.
- **US1 (T015–T019)** needs Foundational. **US2 (T020–T023)** extends `video-publish.ts` so follows US1. **US4 (T031–T033)** also edits `video-publish.ts`: after US2 (same file, no parallel). **US3 (T024–T030)** touches different files and can run in parallel with US1/US2 once Foundational is done.
- **Polish (T034–T040)** after all stories; T039 last before T040.

### Parallel Example

```text
After Foundational:
  Stream A: T015 → T016 → T017 → T018 → T019 → T020 → … → T031 → …
  Stream B (US3): T024, T025, T027, T028 in parallel, then T026, T029, T030
Polish: T034, T035, T036, T037, T038 in parallel
```

## Implementation Strategy

### MVP First

1. T001, then Foundational (G24 first, with its tests).
2. US1 → validate with `video.test.ts` → MVP.
3. US2 (failure handling), US3 (limits/summary/fit; can proceed alongside), US4 (daily limit).
4. Polish: secrets suite, docs, one final `lint/typecheck/test/build`.

### Notes

- Do not edit any existing Bluesky test file except `requirements.test.ts` and `record.test.ts` (plan P20, G24).
- No new runtime dependency, no migration, no UI component change.
- Real Bluesky behaviour is UNVERIFIED in places (parts host/auth, limits/status audience, already-processed shape); each has a conservative fallback in one named constant or function — keep it that way.

---

## Phase 8: Review remediation

- [x] T041 Sanitise every code taken from a Bluesky reply (`error`, `failureCode`, the refused-token code) the way messages are sanitised, e.g. accept only `^[A-Za-z0-9_.-]{1,64}$` and otherwise `sanitiseMessage(code, secrets)`, before it reaches `lastError` or a summary's `response.error`. Then make `tests/integration/bluesky/video-no-secrets.test.ts` echo the received bearer token in `message`, `error` and `failureCode` of the limits, start, part, finish and job replies, and assert it is absent from activity events and the rendered target view too (publishing contract §9) — review F1 (MAJOR), src/providers/bluesky/video-publish.ts:267, src/providers/bluesky/video-errors.ts:41, tests/integration/bluesky/video-no-secrets.test.ts:50
- [x] T042 Add the five Bluesky `note:` rows of data-model §7 to `docs/limits.md`: 10 GB daily bytes not modelled, the upload limits check (hourly, fails 23 h after the first refusal), the 30-minute / 16-read processing ceiling, the verified-email rule, and the unverified 10-minute client ceiling. Each must cite an existing test title. Then run `pnpm vitest run tests/integration/docs/limits-inventory.test.ts` — review F2 (MAJOR), docs/limits.md:159
- [x] T043 Record `limitsCheck` (`ok` | `refused` | `skipped`) in the `check_upload_limits` response summary on every path, and `progress` (when numeric) in the `check_job` and `finish_upload` response summaries. Assert "skipped" in `tests/integration/bluesky/video-limits.test.ts` "a refused check is skipped", and `progress` in a `check_job` test — review F3 (MAJOR), src/providers/bluesky/video-publish.ts:201, src/providers/bluesky/video-publish.ts:384
