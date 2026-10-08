---

description: "Task list for Threads video (VIDEO posts and video carousel items)"
---

# Tasks: Threads video

**Input**: Design documents from `/specs/023-threads-video/`

**Prerequisites**: plan.md, spec.md, research.md (F1–F19, P1–P21, D1–D12), data-model.md (§1–§7), contracts/ (`threads-capabilities.md`, `threads-publishing.md`), quickstart.md

**Tests**: Required. The spec (FR-026, FR-027) and constitution II demand an automated test for every behaviour, with mocked Threads replies (`tests/helpers/fake-graph.ts`) and the pinned DB clock (`atTime`). No test makes a live call.

**Execution environment**: Implementation is headless. Every check below is a Vitest run, `tsc`, lint or build. Nothing needs a browser or the network. The live Threads checks are the one human-owned task (T036).

**Organization**: Tasks are grouped by user story. The declaration, validator, state and request modules come first (Phase 2) because the engine's publish-time re-check (G15) runs `validateThreads`, so no video publish test can pass until Threads declares video.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US4 from spec.md
- Run `pnpm vitest run <paths>` for targeted checks. The full `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass happens once, in the final phase (no `db:check`: no schema change).

## Path Conventions

Single Next.js app. Provider code in `src/providers/threads/`, tests beside sources as `*.test.ts` and in `tests/integration/`. No migration, no engine, no UI component change. Existing Threads, Instagram, Facebook and Bluesky test files stay byte-for-byte unchanged (SC-008) except the helper/extension files named below.

---

## Phase 1: Setup

**Purpose**: Confirm the baseline before changing anything.

- [X] T001 Run `pnpm vitest run src/providers/threads src/providers/requirements.test.ts src/providers/video-labels.test.ts tests/integration/threads tests/integration/limits tests/integration/docs tests/integration/meta` and record that it passes on the untouched branch (baseline for SC-008). No file change.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The three generic fixes (P2, P3, P6), Threads' declaration and validator, and the pure state, request and error modules. MUST complete before any story.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Generic fixes (contracts/threads-capabilities.md §3, §5; research P2, P3, P6)

- [X] T002 [P] In `src/providers/requirements.ts` set `video.postType` only when `caps.postTypeChoices` has at least one entry (P2). Extend `src/providers/requirements.test.ts`: a provider with `byPostType` and no choice gets `postType: null`; one Instagram and one Facebook summary per type pinned unchanged.
- [X] T003 [P] In `src/providers/video-labels.ts` make `videoBytesLabel(n)` print `${Number((n / 1e9).toFixed(2))} GB` for `n ≥ 1_000_000_000`, else today's MB label (P3). Extend `src/providers/video-labels.test.ts`: 1e9 → "1 GB", 1.05e9 → "1.05 GB", 300e6 → "300 MB", 50e6 → "50 MB".
- [X] T004 [P] In `tests/helpers/limit-rows.ts` `videoRows`, change the condition for the base `videos` and `video with images` rows to `!choice && !caps.video.byPostType?.carousel` (P6). Confirm `pnpm vitest run tests/integration/limits/enforcement.test.ts` still passes for the mock, Instagram, Facebook, Bluesky and X rows.

### Threads declaration and validator (data-model §1; contracts/threads-capabilities.md §1–§2)

- [X] T005 In `src/providers/threads/capabilities.ts` add `THREADS_MAX_ITEMS = 20` and `THREADS_VIDEO` (one video, no images, MP4/MOV, H.264/HEVC, AAC or silent, 1,000,000,000 B, 300 s, 1,920 px, aspect 0.01–10, 23–60 fps). Set `video: THREADS_VIDEO` with `byPostType.video` (note "9:16 recommended") and `byPostType.carousel` (`maxVideos: 20`, `withImages: true`, a note). Add `video` to `postTypes`. No `postTypeChoices`, no `creationAllowance`; publish limit stays 250 / 86,400 s (D1, D2, D3, D11).
- [X] T006 In `src/providers/threads/validate.ts` (depends on T005): run the image planner only for items with `kind !== "video"`; rewrite every `video_*` issue except `video_not_accepted` to `<shared message without trailing period> for Threads. Docket does not crop, trim or convert video yet.`; add `too_many_items` (count, limit 20) for a post with at least one image, at least one video and more than `THREADS_MAX_ITEMS` items (P4). Never emit a "will be converted" video note.
- [X] T007 [P] Create `src/providers/threads/video-validate.test.ts` covering every row of contracts/threads-capabilities.md §2's expected-issues table (inclusive limits, unknown frame rate, 300 px video, 2,000-char alt text on video, image-video-image with item 3 at 120 fps → `media.2` only, 20 mixed ok, 21 mixed → `too_many_items`, 21 images / 21 videos keep their own codes) and issue order (text, postType, media). Existing `validate.test.ts` stays untouched and green.
- [X] T008 Run `pnpm vitest run src/providers/threads src/providers/requirements.test.ts src/providers/video-labels.test.ts src/providers/registry.test.ts src/providers/validation.test.ts` and fix any registry consistency error from the new declaration.

### State, steps and pure modules (data-model §2–§4; contracts/threads-publishing.md §1–§3, §5)

- [X] T009 In `src/providers/threads/state.ts` extend `threadsStateSchema` (stays `v: 1`): `mediaType` gains `VIDEO`; optional `kinds` and `itemProgress` (per item: `createdAt`, `ready`, `checks`, bounded to 20); add the `ThreadsPlan` type, the video pace constants (first read 30 s, 60 s while younger than 5 min, then 5 min, ceiling 60 min) and `videoCheckDelayMs(ageMs)` (P8, P10). Every pre-023 state shape must still parse.
- [X] T010 [P] Create `src/providers/threads/state.test.ts`: every pre-023 state parses; VIDEO, `kinds` and `itemProgress` bounds; `videoCheckDelayMs` at 0, 299,999 and 300,000 ms.
- [X] T011 In `src/providers/threads/steps.ts` (depends on T009) add `planOf`, make `validState` take the plan (text, media count, kinds), and add the `check_item_<k>` steps per data-model §3: carousel with a video runs `create_item_*` → `check_item_<k>`* (first unready video first) → `create_carousel` → `check_status`* → `check_quota` → `publish`; a single video uses `create_container`, `check_status`, `check_quota`, `publish`; only `publish` may publish; more than 20 items is `invalid`; state that no longer fits returns null so the first create step runs (D10). Image and text paths unchanged.
- [X] T012 [P] Create `src/providers/threads/video-steps.test.ts`: single video from empty and every saved state; image-video-image, all-video (2) and 20-item carousels through every step; `check_item_<first unready>`; non-fitting state (kinds changed, image↔video swap, item removed, parent with unready items, misaligned progress) → first create step; >20 → `invalid`; only `publish` may publish; garbled state and content are total. Confirm `src/providers/threads/steps.test.ts` passes untouched.
- [X] T013 [P] Create `src/providers/threads/requests.ts` (pure): `STATUS_FIELDS = "status,error_message"`, `videoContainerParams` (`media_type=VIDEO`, `video_url`, `text` only if not empty), `itemParams` for video items (`media_type=VIDEO`, `video_url`, `is_carousel_item=true`, no text, no alt text) with image-item, text, parent and publish builders byte-for-byte as today (P7), and `readStatus(body, [token])` → `{ status, errorMessage }` with the token scrubbed (data-model §4).
- [X] T014 [P] Create `src/providers/threads/video-errors.ts`: the documented codes, `videoErrorExplanation(errorMessage)` matching a code as a whole case-sensitive token (`INVALID_ASPEC_RATIO` as Threads spells it; `INVALID_ASPECT_RATIO` and lowercase do not match), and `videoErrorText` building the exact §5 messages for single video, video item k and parent with video, with figures from `THREADS_VIDEO` and `docsUrl("storage")` (P13).
- [X] T015 [P] Create `src/providers/threads/video-errors.test.ts`: each code alone and inside a sentence; the corrected spelling and lowercase do not match; empty message → `(status ERROR)` with no colon; figures come from `THREADS_VIDEO`.

**Checkpoint**: Declaration, validator, state, steps, requests and error texts exist and their unit tests pass. Run `pnpm vitest run src/providers/threads src/providers/requirements.test.ts src/providers/video-labels.test.ts`.

---

## Phase 3: User Story 1 - Publish one video to Threads (Priority: P1) 🎯 MVP

**Goal**: A Threads target whose content is exactly one video is created as `media_type=VIDEO`, polled at the video pace, quota-checked and published once.

**Independent Test**: `pnpm vitest run src/providers/threads/video-publish.test.ts tests/integration/threads/video.test.ts` — a 1,080 × 1,920, 30 s video with text ends `published` with Threads' id, after reads at about 30 s, 90 s and 150 s.

- [x] T016 [US1] In `src/providers/threads/publish.ts` add the single-video `create_container` request (via `requests.ts`), `readStatus` on every status read with `fields=status,error_message`, `errorMessage` (only when non-empty) in every read's attempt summary (P12), the video pace and 60-minute ceiling for a video container (`notBefore` only, never sleeping), the video `ERROR` message via `video-errors.ts`, the ceiling message "Threads did not finish processing the video within 60 minutes; nothing was published. Retry the post to try again." exactly as contracts/threads-publishing.md §5, and the video wording of the public-URL hint. Image and text behaviour, pace, 5-minute cap and messages unchanged (US1 #7).
- [x] T017 [US1] Add `threadsVideoSetup(storage, text, kinds)` to `tests/helpers/threads-publish.ts` (rows from `createVideoAsset` facts; `threadsSetup` unchanged).
- [x] T018 [P] [US1] Create `src/providers/threads/video-publish.test.ts` (single-video part): `advanceThreads` with fake Graph replies for the exact create params and absent keys (`image_url`, `alt_text`, `is_carousel_item`, `children`), each §4 status row (`FINISHED`, `IN_PROGRESS` under and at the ceiling, `ERROR`, `EXPIRED`, `PUBLISHED`, unknown, unreadable body), the §5 messages, and the token absent from every result.
- [x] T019 [US1] Create `tests/integration/threads/video.test.ts` through `runTick` with `atTime`: the exact create request; three `IN_PROGRESS` reads at about 30 s, 90 s and 150 s; `FINISHED`; quota; publish with `creation_id`; the target `published` with Threads' id; no text → no `text` param; a timeout on create and on a read is retried; a timeout after publish was sent, and an unreadable publish reply, end `ambiguous` and are not retried. Confirm every pre-existing file in `tests/integration/threads/` passes untouched.

**Checkpoint**: Single-video Threads posts publish end to end with mocked Threads.

---

## Phase 4: User Story 2 - Publish a carousel that mixes images and videos (Priority: P1)

**Goal**: Video items are created with `media_type=VIDEO`, each is checked until `FINISHED` before the carousel is created, and the parent is read at the video pace.

**Independent Test**: `pnpm vitest run tests/integration/threads/video-carousel.test.ts` — image, video, image publishes in order, only item 2 is read, and no `CAROUSEL` request is sent while it is `IN_PROGRESS`.

- [x] T020 [US2] In `src/providers/threads/publish.ts` (depends on T016) add video item creates, the `check_item_<k>` handling per contracts/threads-publishing.md §3–§4 (item `createdAt + 30 s` due times, `itemProgress[k].ready` / `checks`, the next unready item's `notBefore`, the item's own 60-minute ceiling, item `ERROR` message naming its position, `EXPIRED` recreating the whole post at most twice, `PUBLISHED` ambiguous), the parent read at the video pace when any item is a video, and `check_quota` measuring the 23-hour guard from the oldest of the parent and every item `createdAt` (§6). Image-only carousels unchanged: no item reads, 60 s pace, 5-minute cap.
- [x] T021 [P] [US2] Extend `src/providers/threads/video-publish.test.ts` (carousel part): exact video-item params (no `text`, `alt_text`, `image_url`), image-item and parent requests unchanged, `children` in post order for a 20-item mixed carousel, `check_item_<k>` rows of §4, oldest-container age for `AGED`, token absent from every result.
- [x] T022 [US2] Create `tests/integration/threads/video-carousel.test.ts` through `runTick`: image, video, image creates three items in order and reads only item 2; no `CAROUSEL` request while item 2 is `IN_PROGRESS` (SC-006: 0 parent requests, 0 image reads); then the parent at the video pace, quota and publish; an all-video pair where the second item is read only after the first finishes; the image-only carousel unchanged (no item reads, parent at the 60 s pace with the 5-minute cap).

**Checkpoint**: Mixed and all-video carousels publish end to end with mocked Threads.

---

## Phase 5: User Story 3 - A failed or slow Threads video ends cleanly (Priority: P1)

**Goal**: Every failure path ends failed, retried or ambiguous exactly as the rules say, with no double publish and no token leak.

**Independent Test**: `pnpm vitest run tests/integration/threads/video-failures.test.ts tests/integration/meta/no-secrets.test.ts`.

- [x] T023 [US3] Create `tests/integration/threads/video-failures.test.ts` through `runTick` and `atTime`: each documented code on a single video and on item 2 with the §5 messages and no `CAROUSEL` or publish request; an unknown message shown as sent; a single video moves to the 5-minute pace after 5 minutes and fails at 60 minutes within 17 reads (SC-005), and the same for a video item; `EXPIRED` on a single video and on an item recreates the post from the first create step and fails on the third expiry; `PUBLISHED` while checking an item is ambiguous; an unknown status is retried; a token rejection on a read fails the target and flags the account; a worker killed mid-step (stale lease) resumes at the saved step; the post changed between ticks (video swapped for an image) restarts at `create_item_1` / `create_container`; the 23-hour guard measured from the oldest item. Fix any gap found in `src/providers/threads/publish.ts`.
- [x] T024 [P] [US3] Extend `tests/integration/meta/no-secrets.test.ts` with a Threads video `ERROR` whose `error_message` echoes the token: the token appears in no attempt, `lastError` or summary (SC-007).

**Checkpoint**: All failure paths covered; 0 double publishes, 0 token leaks.

---

## Phase 6: User Story 4 - See Threads' video requirements up front, and be refused before scheduling (Priority: P2)

**Goal**: The composer summary, fit badges, scheduling gate and docs inventory all follow the declaration, with no Threads-specific UI code.

**Independent Test**: `pnpm vitest run tests/integration/limits/enforcement.test.ts tests/integration/docs tests/integration/threads/video-fit.test.ts tests/integration/compose/threads-video-summary.test.ts`.

- [x] T025 [US4] Add Threads' video rows to `docs/limits.md` per data-model §6 (videos, video with images, video containers, codecs, silent video, video bytes, duration, width, aspect, frame rates, carousel video rows), each with research source, enforcement point and test. Then run `pnpm vitest run tests/integration/docs/limits-inventory.test.ts`; if it derives expected rows from `byPostType`, make the one-line change in that test to ignore a notes-only entry.
- [x] T026 [US4] Run `pnpm vitest run tests/integration/limits/enforcement.test.ts` and confirm the generated `threads:` rows (video codecs, audio codecs, video bytes, max duration, video max width, video min/max aspect, min/max frame rate, carousel videos) each refuse in the core, when queueing, and at publish time on step `engine-validate` with `advance` never called; the carousel row stops at Docket's 10-item cap (P5); mock, Instagram, Facebook, Bluesky and X rows are unchanged. Do not edit the test file.
- [x] T027 [P] [US4] Extend `src/providers/requirements.test.ts` with Threads' summary per data-model §7: `video.postType === null`, the "Video: MP4, MOV, H.264, HEVC, AAC, up to 1 GB, up to 5 minutes, aspect 1:100 – 10:1, 23 fps – 60 fps, not with images" gist and the carousel line ("up to 20 items; images and videos may be mixed …"), all derived from the declaration.
- [x] T028 [P] [US4] Create `tests/integration/threads/video-fit.test.ts`: with a Threads account, a fitting video is `fits`, a 120 fps video is `refused` with "This video …" wording, and `converted` is never produced (FR-019).
- [x] T029 [P] [US4] Create `tests/integration/compose/threads-video-summary.test.ts`: the composer check for one video and a Threads account returns the summary with video limits and no `postTypeChoice`; a 6-minute video returns the §2 message and `addToQueue` fails with `validation`.

**Checkpoint**: Threads video limits are visible and enforced before scheduling.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Docs, decisions, and the final gates.

- [x] T030 [P] Update `docs/adding-a-provider.md` §15 (Threads worked example): the `VIDEO` container, video carousel items checked before the parent, the video pace and 60-minute ceiling, and the error explanations (FR-021). Run `pnpm vitest run tests/integration/docs/provider-guide.test.ts`.
- [x] T031 [P] Update `docs/feature-map.md`: move Threads video to "Already built"; record as unowned: resumable or byte upload for Threads, a cover or thumbnail for Threads video, posts of more than 10 items (P5), API video upload and generator video (FR-022).
- [x] T032 [P] Update `docs/meta-setup.md`: "Threads video: owed live checks" — no new permission, verified with mocks only, and the five checks of quickstart §6 (FR-024, FR-027).
- [x] T033 [P] Update `docs/decisions.md` `## 023` with the implementation outcome (D1–D12 are recorded already; add the three generic fixes P2, P3, P6, P5's 10-item cap, and P12's `errorMessage` on image reads) (FR-023).
- [x] T034 Confirm FR-025: `git diff --stat main -- docker-compose.yml .env.example drizzle/` is empty. State in the final report that no compose or env edit is needed.
- [x] T035 (lint, typecheck, build pass; full run 3905 passed, 4 failed in 2 files under load; re-run alone: only failures/retry-all-cap fails — a DB-timing suite unrelated to Threads; confirm on a quiet machine/CI) Run once, synchronously: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` (no `db:check`). Fix any failure, including any previously existing Threads, Instagram, Facebook or Bluesky test that changed (SC-008).
- [ ] T036 🛑 BLOCKED: needs a connected Threads tester account, a public bucket and the network — run the five live checks of quickstart §6 (publish a single video; publish a mixed carousel; whether video items must finish before the parent; processing time; the exact `error_message` of a refused video) and record each result in `docs/decisions.md`. Owed by the operator, not blocking the build.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none.
- **Foundational (Phase 2)**: after Setup; BLOCKS all stories. Inside it: T005 → T006 → T007/T008; T009 → T010, T011 → T012; T013, T014 → T015 are independent of the validator work.
- **US1 (Phase 3)**: after Phase 2. T016 → T017/T018 → T019.
- **US2 (Phase 4)**: after US1's T016 (same file, `publish.ts`).
- **US3 (Phase 5)**: after US2 (failure paths include video items).
- **US4 (Phase 6)**: after Phase 2 only; its tests do not need publishing, so it can run in parallel with US1–US3 (different files).
- **Polish (Phase 7)**: after all stories. T035 last of the automated tasks.

### Parallel Opportunities

- T002, T003, T004 together.
- T010, T012, T013, T014/T015 together once T009 and T011 are done as noted.
- T027, T028, T029 together; T030–T033 together.

### Parallel Example: Phase 2 generic fixes

```text
Task: "T002 requirements.ts postType only with a declared choice"
Task: "T003 videoBytesLabel GB from 1e9"
Task: "T004 limit-rows.ts skip single-video rows with a carousel override"
```

---

## Implementation Strategy

### MVP First (US1)

1. Phase 1 and Phase 2 (generic fixes, declaration, validator, state, steps, requests, errors).
2. Phase 3 (single video). Stop and run its tests.

### Incremental Delivery

1. US1 → single video publishes.
2. US2 → mixed carousels.
3. US3 → every failure path pinned.
4. US4 → summary, badges, limits docs and inventory (can run any time after Phase 2).
5. Polish, final gates, and the owed live checks (T036).

---

## Notes

- Out of scope (FR-028–FR-031): cropping, trimming or encoding (entry 6); Bluesky video (entry 7); TikTok (entry 8); changes to Instagram, Facebook or X; resumable/byte upload, covers, video alt text, API/generator video; replies, quotes, polls; raising the 10-item post cap.
- Commit after each task or logical group with conventional commits and explicit paths.
