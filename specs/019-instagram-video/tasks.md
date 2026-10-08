---

description: "Task list for Instagram video (Reels, Feed video, mixed carousels)"
---

# Tasks: Instagram video

**Input**: Design documents from `/specs/019-instagram-video/`

**Prerequisites**: plan.md, spec.md, research.md (P1–P27), data-model.md, contracts/ (post-type-choice, video-capabilities, instagram-publishing, creation-allowance), quickstart.md

**Tests**: Required. The spec (FR-032–FR-034, SC-008) demands step-machine, mocked-Graph, enforcement and composer tests. Every test uses mocked Graph replies (`tests/helpers/fake-graph.ts`, clock pinned by `atTime`); nothing sleeps and nothing calls Instagram. Video rows come from `createVideoAsset` facts, so no ffmpeg is needed.

**Organization**: Grouped by user story. Generic contract types, the resolver, the schema and the server-side choice storage are Foundational, because every story needs them.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US5 from spec.md

## Ground rules for every task

- **Next.js is not the one you know.** Before editing the composer or any server-component prop, read `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md` and `07-mutating-data.md` (AGENTS.md).
- **UI work** follows the `docket-ui` skill: labelled fieldset, keyboard operation, visible focus, polite live region. No limit literals in UI code (SC-007).
- **Existing Instagram suites stay byte-for-byte unchanged** (SC-008): `tests/integration/instagram/{publish-e2e,carousel,container-status,outcomes,quota,limits}.test.ts`. Never edit them to make a change pass; fix the code.
- **Every new contract member is optional**, so Facebook, Threads, Bluesky, X and the mock compile and behave unchanged.
- **Verify with targeted `pnpm vitest run <files>` per task.** The full gate runs once, in the final phase. Check by running tests, `pnpm typecheck` and `pnpm lint`. Never start `pnpm dev` or probe a server.
- **Commit** with conventional commits and explicit paths.

---

## Phase 1: Setup

**Purpose**: Orient and pin the baseline before changing anything.

- [X] T001 Run `pnpm vitest run tests/integration/instagram/ tests/integration/meta/` and `pnpm typecheck` on the untouched branch; record that they pass as the baseline for SC-008. Read `specs/019-instagram-video/research.md` code facts F1–F17 and the four files in `specs/019-instagram-video/contracts/`.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: Generic contract types, the post-type resolver, per-type limits, the schema and the server-side choice. Nothing here changes behaviour for a provider that declares nothing.

**⚠️ CRITICAL**: No user story starts until this phase is complete and every existing test is still green.

- [x] T002 Add the optional contract members from `data-model.md` §2 to `src/providers/types.ts`: `PostTypeChoice`, `VideoLimitOverrides`, `minFrameRate` and `video.byPostType`, `CreationAllowance`, `StepInfo.allowance`, `StepContent.kinds`/`postType`, `PostContent.postType`, and the new issue codes.
- [x] T003 [P] Create `src/providers/post-type.ts` (`shapeOf`, `choiceFor`, `resolvePostType`, `offeredPostTypes`, `postTypeLabel`) per `contracts/post-type-choice.md` §2, with `src/providers/post-type.test.ts` covering the §2 table, an unoffered value falling back to the default, a stored `reel` on a two-item post resolving to `carousel`, and the mock's 2-video and video+image posts keeping their 018 refusal codes.
- [x] T004 [P] Add `videoLimitsFor` (merging `video.byPostType` over the base block) and the `minFrameRate` check (skipped when the frame rate is unknown) to `src/providers/validation.ts`, switch `inferPostType` to the resolver, and extend `src/providers/validation.test.ts` (inclusive bounds, unknown frame rate not refused, override merge).
- [x] T005 [P] Change `ratioLabel` to the `1:n` form in `src/providers/video-labels.ts` and extend its test (summary text "1:100 – 10:1").
- [x] T006 [P] Add the registry checks to `src/providers/media.ts` and `src/providers/registry.ts`: a bad default, an option outside `postTypes`, a duplicate shape, a bad `byPostType` key or `minFrameRate`, and a malformed `creationAllowance` all throw. Extend `src/providers/registry.test.ts`.
- [x] T007 Add `post_targets.chosen_post_type` (nullable text with a CHECK) to `src/server/db/schema/posts.ts` and the project-owned `allowance_uses` table with its `(social_account_id, created_at)` index per `data-model.md` §1 (in `src/server/db/schema/scheduler.ts`, exported from the schema index). Run `pnpm db:generate` to produce `drizzle/0012_*.sql`, then `pnpm db:check`.
- [x] T008 Add the tables to the project-owned lists in `tests/helpers/scope-check.ts` and run `pnpm vitest run tests/integration/scope-check.test.ts tests/integration/migrations`. (The list lives in `src/server/db/project-owned.ts`.)
- [x] T009 Add `postType` to `postTargetInputSchema` in `src/lib/validation/scheduling.ts` and `TargetSchema.postType` in `src/lib/api/schemas.ts`.
- [x] T010 Store and read the choice in `src/server/dal/targets.ts` (`chosenPostType` in records and patches; `effectiveContent` also returns each item's kind) and expose `kinds` plus `chosenPostType` from `contentShape` in `src/server/dal/scheduler.ts`.
- [x] T011 Implement `assertPostTypeOffered` (400 naming the allowed values; `post: edit` role unchanged) and thread `postType` through `createDraft`/`updatePost`/`updatePostVariants` in `src/server/services/posts/{index,compose,content}.ts`. `postType` absent keeps the stored value, `null` clears it.
- [x] T012 Make `validateTargetContent` pass the resolved `postType`, and add the resolved `postType` and `postTypeChoice` to `TargetCheck` in `src/server/services/posts/validate.ts` (`checkComposition`).
- [x] T013 Resolve the post type in `src/server/scheduler/publishing.ts` (for `stepFor`, the publish-time re-check and `PublishContext.postType`), passing `kinds` and `postType` into `StepContent`.
- [x] T014 [P] Return each target's effective `postType` in `src/server/services/views/post.ts`, and accept the `postTypes` record (keys must be in `accountIds`) in `createPost` in `src/server/api/operations/posts.ts`; the OpenAPI document must list `postTypes` and `Target.postType`.
- [x] T015 [P] Write `tests/integration/posts/post-type-update.test.ts` (absent keeps, `null` clears, `updatePostVariants` keeps) and `tests/integration/api/post-type.test.ts` (default `video`, `reel`, `story` → 400 naming `video, reel`, a Facebook account → 400, an unknown key → 400, OpenAPI lists the fields). These need the Instagram declaration from T017; write them now and run them after T017. (Written; they fail until T017 declares the Instagram choice, so they are run in Phase 3.)
- [x] T016 Run `pnpm vitest run src/providers tests/integration/scheduler tests/integration/instagram tests/integration/meta && pnpm typecheck && pnpm db:check`; every pre-existing test must pass with no edit. (Passed; the one edit to a pre-existing test is the exact-shape assertion in `tests/integration/scheduler/step-content.test.ts`, which now sees `kinds` and `postType`, and a `postTypeChoice: null` fixture field in `Composer.test.ts`.)

**Checkpoint**: Foundation ready. No provider declares anything yet, so behaviour is unchanged.

---

## Phase 3: User Story 3 - Out-of-range video is refused with a clear message (Priority: P1)

**Goal**: Instagram declares its video limits per post type, and every broken limit is refused with a message naming the type, the limit and the value.

**Independent Test**: For each declared limit, validate a post that breaks exactly that limit through the composer check, the scheduling gate and the publish-time re-check; each is blocked, and no Graph request is made.

- [x] T017 [US3] Declare Instagram's capabilities in `src/providers/instagram/capabilities.ts` per `contracts/video-capabilities.md` §1: `postTypeChoices` (`video` default, `reel`, with labels and one-line descriptions), the Reel limits in the base video block (D5), `minFrameRate: 23`, and the `carousel` override (10 videos; images aspect 0.8–1.91, D7).
- [x] T018 [US3] Update `src/providers/instagram/validate.ts` per `contracts/video-capabilities.md` §3: the image loop covers images only, the crop check covers video items, `too_many_items` at 11, every video refusal names the post type and says Docket does not adjust video yet (P12), and the alt-text notice skips video (FR-026). Extend `src/providers/instagram/validate.test.ts`.
- [x] T019 [P] [US3] Update `src/providers/requirements.ts` to take the `postType` input and return `video.postType`, `minFrameRate` and notes plus a carousel part (P13), and extend `src/providers/requirements.test.ts`.
- [x] T020 [P] [US3] Update `src/components/compose/requirements-ui.ts` to show the chosen type's label, placement (feed and Reels, or Reels only), limits ("23 fps – 60 fps", "1:100 – 10:1") and the carousel line, and extend `src/components/compose/requirements-ui.test.ts`. No limit literals.
- [x] T021 [US3] Check `src/server/services/media-fit.ts` against `contracts/video-capabilities.md` §5: Instagram video badges use the default type's limits ("fits" or "will be refused", never "will be converted"). Add a test case where the badge test lives (FR-028).
- [x] T022 [US3] Add per-type rows to `tests/helpers/limit-rows.ts` (`contracts/video-capabilities.md` §7), including the frame-rate floor and the carousel override, and extend `tests/integration/limits/enforcement.test.ts` so each row is refused through `validateResolvedContent`, `addToQueue` and the publish-time re-check with zero Graph requests (SC-002).
- [x] T023 [US3] Add the Instagram video rows to `docs/limits.md` (each with its research source, enforcement point and test) and update `tests/integration/docs/limits-inventory.test.ts` per `contracts/video-capabilities.md` §6. The `creation allowance` row lands in T046.
- [x] T024 [US3] Run `pnpm vitest run src/providers src/components tests/integration/limits tests/integration/docs tests/integration/api/post-type.test.ts tests/integration/posts/post-type-update.test.ts` (this also completes T015). Result: 897 pass; the 3 failures in `tests/integration/docs/provider-guide.test.ts` (`creationAllowance`, `postTypeChoices`, `minFrameRate`/`byPostType` undocumented) are owed to T048.

**Checkpoint**: A bad Instagram video is refused everywhere with a clear message.

---

## Phase 4: User Story 2 - Choose Reel or Feed video and see that type's requirements (Priority: P1)

**Goal**: The composer shows a per-target "Post as" choice for a single-video Instagram post; the choice is saved and the summary follows it.

**Independent Test**: With one video and an Instagram account, the choice defaults to Feed video, switching to Reel updates the summary, the choice survives save and reopen, and it is hidden for a carousel but kept.

- [x] T025 [US2] Write `tests/integration/compose/post-type-choice.test.ts` per `contracts/post-type-choice.md` §7: `checkComposition` gives `video` as the default, `reel` gives `selected: "reel"` and the Reel summary; images, two videos and video+image give no choice and the carousel summary; a mock account has no choice; an unoffered value is refused; save → reopen keeps `reel`; carousel and back keeps it (FR-008).
- [x] T026 [US2] Add the "Post as" fieldset to `src/app/p/[projectSlug]/compose/Composer.tsx` per `contracts/post-type-choice.md` §5: a legend, radios named per account, `aria-describedby` one-line descriptions, state saved with the target, and a polite live line announcing the changed type (P6). Pass `postType` from `src/app/p/[projectSlug]/compose/[postId]/page.tsx` and label items "Video 1" in the preview list.
- [x] T027 [US2] Extend `src/app/p/[projectSlug]/compose/Composer.test.ts` with `renderToStaticMarkup` assertions: fieldset, legend "Post as", radios, `aria-describedby`, the live line, no fieldset without `postTypeChoice`, "Video 1" in the preview.
- [x] T028 [US2] Run `pnpm vitest run tests/integration/compose "src/app/p/[projectSlug]/compose/Composer.test.ts" tests/lint/ui-limit-literals.test.ts && pnpm typecheck && pnpm lint`.
- [x] T029 [US2] Write a Playwright-free keyboard and label check as markup assertions in `Composer.test.ts`: every radio has a label, the group has a legend, and the live region has `aria-live="polite"`. Visual inspection on a real device is not part of this entry.

**Checkpoint**: The choice works end to end in the composer, the check and the API.

---

## Phase 5: User Story 1 - Publish one video to Instagram (Priority: P1) 🎯 MVP

**Goal**: One video publishes as a Feed video or a Reel through the step machine, polling until finished.

**Independent Test**: `reels.test.ts` publishes both types with mocked Graph replies through `runTick`, covering polling, `ERROR`, ceilings and timeouts.

- [x] T030 [P] [US1] Create `src/providers/instagram/requests.ts` with `VIDEO_ITEM_MEDIA_TYPE` (omitted, D8/P14, one named value) and the pure param builders per `contracts/instagram-publishing.md` §2: the Reel container (`media_type=REELS`, `video_url`, caption, `share_to_feed`; no alt text, cover, collaborators, location, user tags, audio name, trial or AI label), the video carousel item, and the status-read fields. `VIDEO` must never be produced.
- [x] T031 [P] [US1] Extend `src/providers/instagram/state.ts`: optional `REELS`, `shareToFeed`, `kinds` and `itemProgress` fields under `v: 1` (P19), `videoCheckDelayMs` (60 s up to 5:00, then 300 s), and `recreated()` keeping the plan. Create `src/providers/instagram/state.test.ts` with the boundaries 4:59 → 60 s and 5:00 → 300 s, old and new shapes accepted, and a garbage state handled totally.
- [x] T032 [US1] Update `src/providers/instagram/steps.ts`: `planOf`, `validState(plan)` (a changed kind, count, `shareToFeed` or post type restarts from the first create step), single-video step sequence, `allowance` on each create step. Extend `src/providers/instagram/steps.test.ts` for one image, Feed video, Reel and old v1 image states staying valid.
- [x] T033 [US1] Update `src/providers/instagram/publish.ts` for REELS: create, the video-pace status read with `status_code,status`, the `ERROR` message with the redacted detail, the 60-minute ceiling (≤ 16 checks) and the `EXPIRED` rebuild at most twice; image reads stay exactly `{ fields: "status_code" }` (P16, P17, P20). Update `src/providers/instagram/index.ts` so `stepFor` passes `kinds` and `postType`. Extend `src/providers/instagram/publish.test.ts` with the exact params, no `media_type=VIDEO`, `share_to_feed=false` for a Reel and the image read unchanged.
- [x] T034 [US1] Add `instagramVideoSetup(storage, text, kinds, { postType? })` to `tests/helpers/instagram-publish.ts`, attaching ready `createVideoAsset` rows and images in order on the existing `metaSetup` account.
- [x] T035 [US1] Write `tests/integration/instagram/reels.test.ts` per `contracts/instagram-publishing.md` §6: Feed video and Reel create → three `IN_PROGRESS` reads about 60 s apart → `FINISHED` → quota → one publish, with `externalId` and `externalUrl` stored; the 5-minute pace after 5 minutes; failure at 60 minutes with "…within 60 minutes; nothing was published" and ≤ 16 reads; `ERROR` with a detail and none of it a token; `EXPIRED` rebuild twice; a timeout on create or check is retried and on publish is ambiguous; restart at every step resumes; switching to Reel before publish restarts at `create_container`; a published-already status is ambiguous.
- [x] T036 [US1] Extend `tests/integration/meta/no-secrets.test.ts` with a video `ERROR` whose detail echoes the token: no token in `lastError`, the attempts or the logs.
- [x] T037 [US1] Run `pnpm vitest run tests/integration/instagram tests/integration/meta src/providers/instagram` and confirm `git diff --stat main -- tests/integration/instagram/publish-e2e.test.ts tests/integration/instagram/carousel.test.ts tests/integration/instagram/container-status.test.ts tests/integration/instagram/outcomes.test.ts tests/integration/instagram/quota.test.ts tests/integration/instagram/limits.test.ts` is empty (FR-005).

**Checkpoint**: MVP. A single video publishes once as a Reel or Feed video.

---

## Phase 6: User Story 4 - Publish a carousel that mixes images and videos (Priority: P2)

**Goal**: A 2–10 item carousel with any mix of images and videos publishes; every video item is polled to `FINISHED` first.

**Independent Test**: `video-carousel.test.ts` publishes image, video, image and an all-video carousel with mocked replies.

- [X] T038 [US4] Extend `src/providers/instagram/steps.ts` and `publish.ts` for carousels: `create_item_<k>` per item in order (a video item through the requests builder, never a Reel), `check_item_<k>` for each video item before `create_carousel`, the carousel read at the video pace when it contains a video, an item `ERROR` failing with the item's position and kind before the carousel is created, `EXPIRED` rebuilding from item 1 at most twice, and the 23 h guard measured from the oldest container. Extend the `steps.test.ts` and `publish.test.ts` cases for image+video+image and an all-video carousel, including `children` in post order.
- [X] T039 [US4] Write `tests/integration/instagram/video-carousel.test.ts` per `contracts/instagram-publishing.md` §6: three item creates in order, the video item polled to `FINISHED` before `create_carousel`, one publish; an all-video carousel polls every item first; an item `ERROR` names item 2; `EXPIRED` rebuild twice at most; the 23 h guard; 11 items refused before any request; a Reel is never a carousel item.
- [X] T040 [US4] Run `pnpm vitest run tests/integration/instagram src/providers/instagram` and confirm the six unchanged suites in T037 still have an empty `git diff`.

**Checkpoint**: Mixed carousels publish.

---

## Phase 7: User Story 5 - Slow, failed and limited processing end cleanly (Priority: P2)

**Goal**: The 400-per-24h container allowance is enforced exactly, including under concurrency, with a visible wait.

**Independent Test**: Seed `allowance_uses` rows and drive targets through `runTick`; no account ever exceeds 400 in a window.

- [x] T041 [US5] Declare `creationAllowance` (400 per rolling 24 h) in `src/providers/instagram/index.ts`, and make `stepFor` report `StepInfo.allowance` units: the whole need on a build's first create step, 1 on a retry (P22).
- [x] T042 [US5] Add `allowanceUsed` and `reserveAllowance` to `src/server/dal/scheduler.ts` (project-scoped; one indexed range query on `social_account_id, created_at`), and the claim-context methods per `contracts/creation-allowance.md` §3.
- [x] T043 [US5] In `src/server/scheduler/publishing.ts` `decide`, check and reserve inside the claim transaction where the account row is locked: a target that does not fit creates nothing, records a deferral attempt with the message, and sets `nextAttemptAt` to the oldest counted row's expiry + 1 s (P23, P24). Providers without a declaration run no query.
- [x] T044 [US5] Add `pruneAllowanceUses` (rows older than 7 days) to `src/server/scheduler/housekeeping.ts` using `crossProject` with its own reason, and call it from the housekeeping pass.
- [x] T045 [US5] Write `tests/integration/scheduler/allowance.test.ts` with a test provider declaring `creationAllowance`: units vs retry units by attempt count (including after recovery), no declaration → no query, the deferral attempt row, and the 7-day prune.
- [x] T046 [US5] Write `tests/integration/instagram/container-allowance.test.ts` per `contracts/creation-allowance.md` §6 (399 used lets a single video create and defers a second target with no Graph request; 390 used defers a 10-item carousel needing 11 until the clock passes the window; two due targets with room for one create exactly one; two concurrent `runTick` calls stay ≤ 400; an `EXPIRED` rebuild reserves the whole need again; a retried create reserves 1; image targets count). Add the `instagram: creation allowance` row to `tests/helpers/limit-rows.ts`, `docs/limits.md` and the inventory test (P26).
- [x] T047 [US5] Add a case for rate-limit refusals on create staying a retryable wait (FR-021) to `tests/integration/instagram/container-allowance.test.ts`, then run `pnpm vitest run tests/integration/scheduler tests/integration/instagram tests/integration/limits tests/integration/docs tests/integration/scope-check.test.ts`.

**Checkpoint**: All five stories work; the cap holds under concurrency.

---

## Phase 8: Polish, documentation and final gate

**Purpose**: Docs, decisions, the one full pass and the owed live checks.

- [X] T048 [P] Document G19–G22, every new contract member and the Instagram worked example (Reels, Feed video, mixed carousels, video polling, container allowance) in `docs/adding-a-provider.md`; extend `tests/integration/docs/provider-guide.test.ts` so it checks the new members are mentioned.
- [X] T049 [P] Update `docs/feature-map.md` (Instagram video delivered; resumable upload, covers and optional Reel fields, API video upload and a post update API recorded as unowned) and `docs/meta-setup.md` (no new permission; the owed live checks from `quickstart.md` §7).
- [X] T050 [P] Write the implementation outcome in `docs/decisions.md` under `## 019`: the two judgement calls (status detail read for video containers only, P16; a real `creation allowance` category, P26), the accepted approximations from `contracts/creation-allowance.md` §5, and a note that `docker-compose.yml` and `.env.example` do not change (FR-031).
- [X] T051 Run the final gate once, synchronously: `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build`. Fix any failure in the code, never in the six unchanged Instagram suites.
- [ ] T052 🛑 BLOCKED: needs a real Instagram Business account and the operator — run the four live checks in `specs/019-instagram-video/quickstart.md` §7 (Reel only in the Reels tab; Feed video in the feed grid; image+video+image carousel accepting `media_type` omitted for a video item; a 200–300 MB Reel fetched by `video_url`) in one sitting and report all results together. Until then Instagram video is "verified with mocks only".

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (1)** → **Foundational (2)** → every story.
- **US3 (3)** needs Foundational. It declares the Instagram capabilities, which US1, US2 and US4 read.
- **US2 (4)** needs Foundational and T017 (the Instagram choice declaration).
- **US1 (5)** needs Foundational and T017.
- **US4 (6)** needs US1 (it extends the same step machine).
- **US5 (7)** needs US1 (`stepFor` and the create steps); it is independent of US4 and US2.
- **Polish (8)** needs all stories. T052 can only run after deploy and does not block the others.

### Within a story

Pure types and builders → steps and publish → helpers → integration tests → targeted run.

### Parallel opportunities

- Phase 2: T003, T004, T005 and T006 touch different files (T002 first). T014 and T015 are parallel to each other.
- Phase 3: T019 and T020 are parallel after T017.
- Phase 5: T030 and T031 are parallel.
- Phase 8: T048, T049 and T050 are parallel.
- With two workers after Foundational and T017: one takes US2 (Phase 4), one takes US1 (Phase 5), and US5 follows US1 while US4 runs beside it, though both edit `publish.ts` or `steps.ts`, so serialise those two.

## Implementation Strategy

### MVP first

1. Phase 1 and Phase 2.
2. Phase 3 (T017–T018 are enough to unblock the rest; finish the rest of the phase afterwards).
3. Phase 5: one video publishes as Feed video or Reel. Stop and validate with `reels.test.ts`.

### Incremental delivery

1. Add US2 (the choice in the composer) and the rest of US3.
2. Add US4 (mixed carousels).
3. Add US5 (the allowance).
4. Polish, then the single final gate (T051).

## Notes

- Each task's verification is an automated run; no task needs a browser, a dev server or the network.
- The only human-owned work is T052, which is marked blocked with its reason.
- Out of scope (FR-035–FR-038): Stories; cropping, trimming or encoding (entry 6); Facebook (4), Threads (5), Bluesky (7), X and TikTok (8); resumable upload, covers, API video upload.

---

## Phase 9: Review remediation

- [x] T053 Finish the FR-029/FR-030 doc moves: add `note: video processing ceiling` (60 min; 5 min is guidance, not a hard stop, D9; Instagram step machine; test reference) and `note: share to feed` rows to the Instagram table in `docs/limits.md` per `contracts/video-capabilities.md` §6; in `docs/feature-map.md` take the Instagram Reels and feed video / mixed carousel rows out of the "Video (other platforms not built)" table (or mark them built in 019) and correct the 018 sentence "No provider publishes video yet"; keep `tests/integration/docs/limits-inventory.test.ts` green — review F1 (MAJOR), docs/limits.md:63, docs/feature-map.md:46
- [x] T054 Add the missing FR-032 tests: a carousel container holding a video that returns `ERROR` with a detail (message "Instagram could not process the carousel: …", attempt `statusDetail`, no publish), and kill-mid-flight recovery (expired lease with `inFlightStep` set, as in `tests/integration/threads/outcomes.test.ts:178`) on a Reel `create_container` and a carousel `check_item_<k>`, showing the step retried, the allowance charged `retryUnits` (1) and exactly one publish — review F2 (MAJOR), src/providers/instagram/publish.ts:248, tests/integration/instagram/reels.test.ts:49
