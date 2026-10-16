---

description: "Task list for Instagram Stories as a post type"
---

# Tasks: Instagram Stories as a post type

**Input**: Design documents from `/specs/078-instagram-stories/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md (all present)

**Tests**: Included — the constitution requires mocked-HTTP coverage of every claimed path, and this
feature's own contracts name the exact test files and cases to add or amend.

**Organization**: Tasks are grouped by user story. The two shared-layer extensions (`single_image`
shape, per-post-type image limits) and Instagram's declaration are foundational — every user story
needs them, so they sit in Phase 2, not inside US1.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Exact file paths are given in every description

## Path Conventions

Single project (Next.js app). Source under `src/`, tests under `tests/` and co-located `*.test.ts`,
docs under `docs/`, per plan.md's Project Structure.

---

## Phase 1: Setup

No new project, dependency or scaffolding is introduced (plan.md Technical Context: no new runtime
dependency, no migration, no new directory). This feature has no Setup phase of its own; proceed to
Foundational.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared provider-layer contracts and Instagram's declaration that every user story's
tests and code depend on. **No user-story work can begin until this phase is complete.**

- [X] T001 Add `PostShape = "single_image" | "single_video"`, `PostTypeOption`, `PostTypeChoice`,
  `ImageLimitOverrides`, `ProviderCapabilities["media"].byPostType`, and the three new
  `ValidationIssue["code"]` members (`story_text_dropped`, `story_alt_text_dropped`, `story_will_crop`)
  in `src/providers/types.ts` (C1).
- [X] T002 [P] Extend `resolvePostType` in `src/providers/post-type.ts` so `single_image` consults a
  declared choice exactly as `single_video` already does: the declared `chosen` when it is one of the
  choice's options, else `choice.default`, and `image` when no choice is declared (C2).
- [X] T003 [P] Add `imageLimitsFor(caps, type)` beside `videoLimitsFor` in `src/providers/validation.ts`:
  pure, total, merges `caps.media` (without `byPostType`) with `byPostType[type]` (minus `notes`),
  mapping `null` to "no bound"; an unknown type returns the base limits (C2, data-model.md §4a).
- [X] T004 [US-shared] Add an optional `postType` parameter to `mediaConstraintsOf(caps, postType?)` in
  `src/providers/media.ts`: with no `postType` the result is byte-for-byte identical to today; with one,
  built from `imageLimitsFor(caps, postType)` (C2).
- [X] T005 Add declaration validation to `mediaConstraintsOf` (at registry load, same style as
  `assertVideoCapabilities`): every `media.byPostType` key must be a post type, the merged range must
  satisfy `min <= max`, and `recommendedAspectRatio` when present must be positive, finite, and inside
  the merged range when that range is bounded; throw otherwise (C4).
- [X] T006 Key the image block of `requirementsOf` in `src/providers/requirements.ts` on
  `imageLimitsFor(caps, ctx.postType ?? "image")` instead of `caps.media` directly, and add
  `recommendedAspectRatio: Labelled<number> | null` and `notes: string[]` to the returned image shape
  (data-model.md §6, contracts/compose-and-api.md A3). Leave `shownTypeOf` (the video block's type
  picker) untouched (A3a).
- [X] T007 [P] Stop `constraintsHash` in `src/server/media/hash.ts` from hashing
  `minAspectRatio`/`maxAspectRatio` (K8); existing rows keep their old hash and are rebuilt lazily by
  `prepareVariants`/`resolvePublishMedia` on next use.
- [X] T008 Add `byPostType.story` to `media` and `byPostType.story` to `video` in
  `src/providers/instagram/capabilities.ts`, add the `single_image` `postTypeChoice` (`image`/`story`)
  and extend the `single_video` `postTypeChoice`'s options with `story`, add `"story"` to `postTypes`,
  and define the one shared Story option description string used in both choices (contracts/
  capabilities.md C3, data-model.md §4b).
- [X] T009 [P] Add `storyContainerParams(item, kind)` to `src/providers/instagram/requests.ts`: takes no
  text argument and never reads `item.altText`; returns exactly
  `{ media_type: "STORIES", image_url }` or `{ media_type: "STORIES", video_url }` (contracts/
  publish-requests.md R1).
- [X] T010 [P] Add `"STORIES"` to the `mediaType` enum in `src/providers/instagram/state.ts`
  (`instagramStateSchema`); no schema version bump, no migration (data-model.md §3).
- [X] T011 Extend `planOf` in `src/providers/instagram/steps.ts` so a single asset with resolved post
  type `story` plans a `STORIES` container (image or video kind) through the same
  `create_container -> check_status -> check_quota -> publish` sequence as a Reel (contracts/
  publish-requests.md R5).
- [X] T012 Extend `src/providers/instagram/publish.ts`'s `create_container`/`check_status` branches to
  build the Story's container with `storyContainerParams`, poll a `STORIES` container's
  `status_code`/`status` fields on the image/video cadence already used for other kinds, and recreate
  on `EXPIRED` / fail past `MAX_RECREATIONS` / end `ambiguous` on `PUBLISHED`, matching R2 exactly
  (contracts/publish-requests.md R1-R2).
- [X] T013 In `src/providers/instagram/validate.ts`: skip the feed aspect-ratio check for a `story`
  target (no bound is declared, so nothing to skip in practice, but the `missing_alt_text` and
  `alt_text_too_long` checks must be filtered out for a story target), and append
  `story_text_dropped`, `story_alt_text_dropped`, `story_will_crop` per contracts/validation.md V1,
  with the omissions required by the spec's edge cases (no text, no description, unknown dimensions,
  9:16 asset) (V1, V2).
- [X] T014 In the same file, make every `video_*` message for a `story` target read the merged Story
  limits via `videoLimitsFor(caps, "story")` and quote `postTypeLabel(caps, "story")` = "Story" instead
  of "Reel" (contracts/validation.md V3).
- [X] T015 Pass the resolved post type through to `mediaConstraintsOf` wherever media is adapted for
  publish in `src/server/services/media-variants.ts` (`adaptedMediaFor` / `resolvePublishMedia`), so a
  Story's image planning uses the Story's merged limits (data-model.md §8, plan.md source tree).
- [X] T016 [P] Render the two new image fields (`recommendedAspectRatio`, `notes`) in `detailRows` in
  `src/components/compose/requirements-ui.ts`, immediately after "Aspect ratio" (contracts/
  compose-and-api.md A3).
- [X] T017 [P] Fix the pre-existing React-key defect in
  `src/components/compose/RequirementsSummary.tsx`: key repeated "Note" rows by index so several
  notes cannot collide on one key (plan.md source tree; contracts/compose-and-api.md A3).
- [X] T018 [P] Add `postType` to `PlannerRow` and an optional post-type parameter to `planWith` in
  `tests/helpers/limit-rows.ts`; add the image-override rows so a `null` bound becomes an acceptance
  row (an image outside the base range must not be refused for that type) (contracts/
  capabilities.md C5).

**Checkpoint**: Instagram now declares `story`, resolves it, builds its request, carries its state,
and validates it. All three user stories build on this.

---

## Phase 3: User Story 1 - Publish an image as an Instagram Story (Priority: P1) 🎯 MVP

**Goal**: A content manager composes a post with one image, selects Story for an Instagram target,
sees the notices for dropped text/description and for cropping, schedules it, and it publishes.

**Independent Test**: Compose a post with one image and one Instagram target, select Story, schedule
it, and run the publish sequence against a mocked Instagram. The container is created as a story, the
request carries no caption and no description, and the publish returns a story id.

### Tests for User Story 1

- [X] T019 [P] [US1] Add `single_image` choice and `media.byPostType` declaration-validation cases to
  the existing choice/registry table in `src/providers/registry.test.ts` (contracts/capabilities.md C4,
  contracts/compose-and-api.md A6).
- [X] T020 [P] [US1] Add cases to `src/providers/post-type.test.ts` for `resolvePostType` resolving a
  `single_image` choice (chosen option, fallback to default, no choice declared) (C2).
- [X] T021 [P] [US1] Add cases to `src/providers/media.test.ts` for `mediaConstraintsOf(caps, "story")`
  (no aspect bound, format/size/width unchanged) and for `mediaConstraintsOf(caps)` with no post type
  staying byte-identical to before (C2, SC-009).
- [X] T022 [P] [US1] Add cases to `src/providers/validation.test.ts` for `imageLimitsFor(caps, "story")`
  and `imageLimitsFor(caps, "image")` (data-model.md §4a, C3 invariant 3-4).
- [X] T023 [P] [US1] Add cases to `src/providers/requirements.test.ts`'s `ig(postType)` helper for the
  new image note and recommended-shape rows on a story target, keeping the existing "one Instagram and
  one Facebook post type per shown type" assertion iterating the `single_video` choice only (contracts/
  compose-and-api.md A6).
- [X] T024 [P] [US1] Add cases to `src/providers/instagram/validate.test.ts`: `story_text_dropped` and
  `story_alt_text_dropped` present/absent per the spec's edge cases, `story_will_crop` naming "1:1" for
  a square asset and absent for a 9:16 asset or an asset with no stored dimensions, and no
  `aspect_ratio_out_of_range` for a story image (contracts/validation.md V1, V2).
- [X] T025 [P] [US1] Add cases to `src/providers/instagram/steps.test.ts` and
  `src/providers/instagram/state.test.ts` for a `STORIES` image plan and state transitions (data-model.md §3).
- [X] T026 [P] [US1] Add cases to `src/providers/instagram/publish.test.ts` for an image Story's
  `create_container`/`check_status`/`check_quota`/`publish` sequence, including `storyContainerParams`
  carrying exactly `media_type` and `image_url` with no `caption`/`alt_text` (contracts/
  publish-requests.md R1).
- [X] T027 [US1] Update `tests/integration/compose/post-type-choice.test.ts`: the single-image case now
  expects a choice (Feed post/Story, default "image"), the two-video and video-plus-image "no choice"
  cases keep `postTypeChoice: null`, and the `check()` helper's `postType` union gains `"image"` and
  `"story"` (contracts/compose-and-api.md A6).
- [X] T028 [US1] Create `tests/integration/instagram/stories.test.ts` with the image Story publish
  matrix driven through `runTick()` over a mocked Graph: create (`media_type=STORIES`, `image_url`),
  `FINISHED` poll, quota check, publish recording the returned id as `externalId` (quickstart.md
  Scenario 1 step 5; contracts/publish-requests.md R1-R6).
- [X] T029 [US1] In the same file, add the mixed-post case: one post with text, one image, an
  Instagram story target and a Facebook Page target — both schedule, Facebook publishes with the text,
  the Story without it (quickstart.md Scenario 1 step 6; acceptance scenario 6).
- [X] T030 [P] [US1] Add a case to `tests/integration/api/post-type.test.ts` accepting
  `postTypes: { <igAccountId>: "story" }` on create/update for an Instagram account (contracts/
  compose-and-api.md A4).
- [X] T031 [P] [US1] Add the three new image-override categories (`story min aspect`, `story max
  aspect`, `story recommended aspect`) to `declared()` and the two UNVERIFIED aspect rows in
  `tests/integration/docs/limits-inventory.test.ts` (contracts/capabilities.md C5).
- [X] T032 [US1] Update `tests/integration/limits/enforcement.test.ts`'s planner suite to pass each
  row's post type to `planWith`/`mediaConstraintsOf`, covering the new story image-override rows
  (contracts/capabilities.md C5, contracts/compose-and-api.md A6).

### Implementation for User Story 1

- [X] T033 [US1] Add `docs/limits.md` rows for `story recommended aspect` (0.5625) and the two
  UNVERIFIED `story min/max aspect` rows, each naming its source and enforcement point (contracts/
  capabilities.md C5 rows 1-3; contracts/records.md N3).
- [X] T034 [P] [US1] Add the Story section to `docs/research/meta.md`: container creation
  (`media_type=STORIES`, `image_url`/`video_url`, then `media_publish`), no caption/alt-text/stickers,
  image Story facts (general image handling, 9:16 recommendation only, no hard aspect range),
  publishing-limit counting, and the `media_product_type` read-back field marked `NEEDS RESEARCH` for
  its Story value — each with its source URL and "checked 2026-10-16" (contracts/records.md N1).
- [X] T035 [P] [US1] Document the `single_image` shape and `media.byPostType`/`ImageLimitOverrides` in
  `docs/adding-a-provider.md`, with every new `ProviderCapabilities` member name in an inline code span
  (contracts/records.md N5; enforced by `tests/integration/docs/provider-guide.test.ts`).

**Checkpoint**: User Story 1 is fully functional and independently testable — an image can be
composed, validated with its notices, scheduled, and published as a Story.

---

## Phase 4: User Story 2 - Publish a video as an Instagram Story (Priority: P2)

**Goal**: The same content manager, with a single video, sees Feed video/Reel/Story on offer, the
Story's own tighter limits enforced and reported, and the video publishes as a Story with resumable
polling.

**Independent Test**: Compose a post with one video and one Instagram target, select Story, and run
validation and publish against a mocked Instagram. The choice is offered, the Story's limits are the
ones enforced and reported, and the container is created as a story from the video.

### Tests for User Story 2

- [X] T036 [P] [US2] Add cases to `src/providers/validation.test.ts`/`src/providers/video-plan.test.ts`
  for `videoLimitsFor(caps, "story")` matching FR-020 exactly (MP4/MOV, H264/HEVC, AAC, 100 MB, 3-60 s,
  0.1:1-10:1, 23-60 FPS, 9:16 recommended) (contracts/capabilities.md C3 invariant 2).
- [X] T037 [P] [US2] Add cases to `src/providers/instagram/validate.test.ts` for story video messages:
  a 90 s video adapted to "cut to 1 minute" (never 15 minutes), a 2 s video refused quoting 3 seconds,
  a > 100 MB video refused quoting 100 MB (never 300 MB), and an out-of-range shape padded where
  possible or refused quoting 0.1:1-10:1 (contracts/validation.md V3).
- [X] T038 [P] [US2] Add cases to `src/providers/instagram/steps.test.ts` for a `STORIES` video plan,
  and to `src/providers/instagram/publish.test.ts` for the video Story's
  `storyContainerParams` carrying `video_url` with no caption/alt-text (contracts/publish-requests.md R1).
- [X] T039 [US2] Update `tests/integration/compose/post-type-choice.test.ts`'s single-video default
  case to expect `["video", "reel", "story"]` with `selected: "video"` (contracts/compose-and-api.md A6).
- [X] T040 [US2] Add the generated `instagram: story max duration`, `instagram: story video bytes`,
  `instagram: story video min aspect` rows (via `tests/helpers/limit-rows.ts`'s video overrides) to
  `tests/integration/limits/enforcement.test.ts` (contracts/capabilities.md C5 rows 4-6).
- [X] T041 [US2] Add the "recommended shape: only when asked, or when forced by the range" story case
  to `src/providers/video-plan.test.ts` for `videoLimitsFor(caps, "story")`'s 9:16 recommendation
  (contracts/capabilities.md C5 row 7).
- [X] T042 [US2] In `tests/integration/instagram/stories.test.ts`, add the video Story matrix: container
  created with `media_type=STORIES` and `video_url`, an `IN_PROGRESS` tick that leaves the container id
  in state without recreating it, and a later tick that resumes polling the same container and
  publishes once `FINISHED` (quickstart.md Scenario 2 step 3; user story 2 scenario 6).

### Implementation for User Story 2

- [X] T043 [US2] Add the Story video spec as a first-class entry (no longer parenthetical "not needed
  by Docket") to `docs/research/meta-video.md`, with its source URL, check date, and a note that
  H264/HEVC, AAC, 23-60 FPS and the 9:16 recommendation are the Reel specs the Story inherits in
  Docket's declaration (contracts/records.md N2).

**Checkpoint**: User Stories 1 AND 2 both work independently — image and video Stories can each be
composed, validated against their own limits, and published.

---

## Phase 5: User Story 3 - Know what a Story drops before scheduling it (Priority: P3)

**Goal**: Anyone using the API alone (no UI) can read that `story` is offered with its description,
see the same notices in a target's validation issues, read the Story's own requirements summary, and
get a clear refusal when trying `story` on a non-Instagram account.

**Independent Test**: Read an Instagram account's advertised capabilities and the validation issues
for a Story target through the API, with no UI involved, and check that each dropped element is named.

### Tests for User Story 3

- [ ] T044 [P] [US3] Add a case to `tests/integration/api/post-type.test.ts` reading an Instagram
  account's capabilities and asserting `story` is among the post types with the Story option's label
  and description (contracts/compose-and-api.md A4; user story 3 scenario 1).
- [ ] T045 [P] [US3] Add a case reading a story target's per-target validation issues through the API
  and asserting the same three notices with their severities (contracts/compose-and-api.md A2, A4;
  user story 3 scenario 2).
- [ ] T046 [P] [US3] Add a case reading a story target's requirements summary through the API and
  asserting it reports the Story's own image and video limits, not the feed's or the Reel's (contracts/
  compose-and-api.md A3; user story 3 scenario 3).
- [ ] T047 [US3] Add the refusal case to `tests/integration/api/post-type.test.ts`:
  `postTypes: { <facebookAccountId>: "story" }` returns `400` naming the types Facebook does offer
  (contracts/compose-and-api.md A4; FR-005, FR-006, SC-008; user story 3 scenario 4).

### Implementation for User Story 3

No new production code: `postTypeRefusal`, `offeredPostTypes`, `requirementsOf` and
`validateResolvedContent` are already the single implementations reached by both the composer and the
API (constitution IV) and were completed in Phase 2 / User Story 1. This story is proved by the tests
above alone.

- [ ] T048 [US3] Update `docs/accounts.md`'s Instagram section: a Story can be scheduled for a single
  image or video, and what it does not carry (contracts/records.md N5).
- [ ] T049 [US3] Add the "Instagram Stories (078)" entry to `docs/feature-map.md`: image and video
  Stories, chosen per post in the composer, no caption/link/stickers, no cropping by Docket; verified
  with mocks only; not yet owned — Facebook Page Stories, stickers and links, reading a Story back,
  multi-asset Stories (contracts/records.md N5).

**Checkpoint**: All three user stories are independently functional; the API surfaces everything the
composer does.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: The remaining spec edge cases, the governance records, and the SC-009 "nothing else
changed" proof.

- [ ] T050 [P] Add the remaining edge-case tests to `tests/integration/instagram/stories.test.ts`: the
  publishing allowance exhausted (deferred, not failed, never published twice), the run-time quota full
  (`retryable_error`, `notBefore = +1 h`), container reported `PUBLISHED` (ends `ambiguous`, never
  retried), container expiry (recreated and republished within `MAX_RECREATIONS`, fails past the cap),
  media Instagram cannot process (`fatal_error` with Instagram's detail, no token leaked), and killed
  mid-run (state survives, next tick resumes at the right step, never recreates a finished container)
  (spec Edge Cases; quickstart.md Scenario 4).
- [ ] T051 [P] Add the "media stops being a single asset" edge case: a second image added to a story
  target publishes as a carousel, `TargetCheck.postType` reads `carousel`, and `chosen_post_type` stays
  `story` in the database (FR-024; quickstart.md Scenario 4).
- [ ] T052 [P] Add the "9:16 image accepted for a Story, refused for a feed post" case across
  `src/providers/instagram/validate.test.ts` and the generated limits rows, using the same asset with
  `chosenPostType: "story"` then `"image"` (FR-016, SC-007; quickstart.md Scenario 1 step 4).
- [ ] T053 [P] Add the SC-009 regression proof: a test asserting two `MediaConstraints` differing only
  in aspect bounds share one `constraintsHash` (K8), and that a Story and a feed post resolve to the
  same variant row for the same asset (quickstart.md Scenario 5).
- [ ] T054 [P] Add the `docs/decisions.md` entry `## 078 - Instagram Stories (2026-10-16)` covering D1,
  D2, D3 (citing entry 072's "No hard aspect range" precedent for K12), K1, K5/K6, K8, K11, K16, and the
  constitution amendment (contracts/records.md N4; FR-029).
- [ ] T055 Amend `.specify/memory/constitution.md`'s Engineering Constraints line so stories are out of
  scope except Instagram Stories (078); Facebook Page Stories stay out of scope. Commit as
  `docs(constitution):` with a version bump 1.4.0 -> 1.5.0 and "Last Amended" set to 2026-10-16
  (contracts/records.md N6).
- [ ] T056 Run `pnpm lint && pnpm typecheck && pnpm test` and confirm the full suite is green, including
  `tests/integration/docs/limits-inventory.test.ts` and `tests/integration/docs/provider-guide.test.ts`
  (quickstart.md "Expected outcome").

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 2)**: No dependencies beyond the existing codebase. **Blocks every user
  story** — Instagram's declaration, request builder, state, and validation all live here.
- **User Story 1 (Phase 3)**: Depends on Phase 2. No dependency on US2 or US3.
- **User Story 2 (Phase 4)**: Depends on Phase 2 only — the video Story path (T036-T043) reuses the
  same shared types and the same `storyContainerParams`/`planOf`/`validate.ts` edits as US1, but adds
  no new dependency on US1's tasks. Independently testable once Phase 2 is done.
- **User Story 3 (Phase 5)**: Depends on Phase 2 only. Reads capabilities, issues and requirements
  that Phase 2 (and, for the full image/video matrix, Phases 3-4) already produce; its own tasks add
  tests and docs, no new production code.
- **Polish (Phase 6)**: Depends on Phases 2-5 being complete; several of its tasks exercise both the
  image and the video path together.

### Within Each User Story

- Tests are written first (T019-T032 for US1, T036-T042 for US2, T044-T047 for US3) and must fail
  before the corresponding implementation lands — but because this feature's implementation is
  concentrated in Phase 2 (the shared declaration, request builder, state and validator), most of
  Phase 3/4's "Implementation" work is documentation (T033-T035, T043), and the provider-layer code
  itself is proved by Phase 2's own test tasks running green.
- Docs tasks (T033-T035, T043, T048-T049, T054-T055) can follow their story's test tasks in any order.

### Parallel Opportunities

- Within Phase 2: T001 first (shared types everyone imports), then T002-T003 [P], T007 [P], T009-T010
  [P], T016-T018 [P] can run in parallel; T004-T006, T008, T011-T015 touch shared files in sequence as
  noted.
- Within Phase 3: T019-T026, T030-T031 are marked [P] (different test files); T027-T029, T032-T035
  touch files other tasks in the same phase also touch and should run after their prerequisites.
- Within Phase 4: T036-T038 [P]; T039-T042 follow.
- Within Phase 5: T044-T046 [P]; T047-T049 follow.
- Within Phase 6: T050-T054 are marked [P] (different test/doc files); T055-T056 run last.

---

## Parallel Example: Phase 2 (Foundational)

```bash
# After T001 (shared types) lands:
Task: "Extend resolvePostType for single_image in src/providers/post-type.ts"
Task: "Add imageLimitsFor in src/providers/validation.ts"
Task: "Stop constraintsHash hashing aspect bounds in src/server/media/hash.ts"
Task: "Add storyContainerParams in src/providers/instagram/requests.ts"
Task: "Add STORIES to mediaType enum in src/providers/instagram/state.ts"
```

## Parallel Example: User Story 1 tests

```bash
Task: "Add single_image/byPostType cases to src/providers/registry.test.ts"
Task: "Add resolvePostType single_image cases to src/providers/post-type.test.ts"
Task: "Add mediaConstraintsOf(caps, \"story\") cases to src/providers/media.test.ts"
Task: "Add imageLimitsFor cases to src/providers/validation.test.ts"
Task: "Add story notice cases to src/providers/instagram/validate.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 2: Foundational (shared types, `imageLimitsFor`, `mediaConstraintsOf`, Instagram's
   declaration, `storyContainerParams`, `STORIES` state, `planOf`, `publish.ts` branches,
   `validate.ts` notices).
2. Complete Phase 3: User Story 1 (image Story, end to end, with its tests and docs).
3. **STOP and VALIDATE**: `pnpm vitest run src/providers/instagram tests/integration/instagram/stories.test.ts`
   green; an image Story composes, validates with its notices, schedules and publishes against the
   mock.
4. Demo: schedule an existing 1:1 image from this project as an Instagram Story.

### Incremental Delivery

1. Foundational → image Story (US1, MVP) → video Story (US2) → API-only verification (US3) → Polish
   (remaining edge cases, SC-009 proof, decisions log, constitution amendment).
2. Each story adds value without breaking the previous one — the shared validator, request builder and
   state machine are extended, never duplicated (constitution IV).

### Parallel Team Strategy

Once Phase 2 is done, US1, US2 and US3 can proceed in parallel: US1 and US2 touch the same files
(`validate.ts`, `steps.ts`, `publish.ts`, `stories.test.ts`) for different kinds (image vs. video) and
should be sequenced or coordinated by file; US3 touches only tests and docs and has no file overlap
with either.
