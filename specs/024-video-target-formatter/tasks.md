# Tasks: Per-target video formatter

**Input**: Design documents from `/specs/024-video-target-formatter/` (plan.md, spec.md, research.md, data-model.md, contracts/video-planner.md, contracts/video-worker.md, contracts/video-publishing.md, contracts/video-composer.md, quickstart.md)

**Tests**: Requested by the spec (FR-037–FR-042). Pure tests run with no DB or tools; DB integration tests run against run-scoped Postgres; ffmpeg suites use `requireFfmpeg()` (skip locally without ffmpeg, mandatory in CI). No task starts a dev server or browser: every check below is a Vitest run, `tsc --noEmit`, lint or build. Checks that genuinely need a human, a live platform, Docker or CI are marked `🛑 BLOCKED:` and left for the operator.

**Organization**: Grouped by user story. The planner, schema and facts are foundational because every story reads them.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US6 from spec.md
- Contract section names refer to the files in `specs/024-video-target-formatter/contracts/`. Before writing server actions or client components read `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md`, `05-server-and-client-components.md` and `02-guides/server-and-client-boundary.md` (AGENTS.md).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: schema, env and keys. No behaviour change; existing tests stay green.

- [x] T001 Add the new columns and tables to the schema per data-model.md §1–§4: seven media facts columns on `media_assets` (`src/server/db/schema/media.ts`), `post_targets.video_wait_since`, tables `post_video_edits` and `video_versions` (`src/server/db/schema/posts.ts` or the file data-model names); list both new tables in `src/server/db/schema/project-owned.ts`.
- [x] T002 Run `pnpm db:generate` to produce `drizzle/0017_*.sql`, append `UPDATE media_assets SET facts_version = 1 WHERE kind = 'video';` after the generated DDL, then run `pnpm db:check` and confirm it passes.
- [x] T003 [P] Add `VIDEO_ENCODE_CONCURRENCY` (int 1–4, default 1) to `src/server/env.ts` and the exact commented block from quickstart.md §7 to `.env.example` after `MEDIA_MAX_OPEN_UPLOADS`.
- [x] T004 [P] Add `mediaKeys.videoVersion` / `mediaKeys.videoPreview` (`projects/<p>/media/<asset>/vv|vp/<key>.mp4`) to `src/server/storage/index.ts` with a unit test beside the existing key tests.
- [x] T005 [P] Default `facts_version` to 2 and fill the new facts in the `createVideoAsset` factory in `tests/helpers/factories.ts`; add fixture generators (landscape, portrait, square, silent, MOV, high-fps, index-at-end, rotated) and `requireFfmpeg()` in `tests/helpers/video-fixtures.ts`.
- [x] T006 Run `pnpm typecheck && pnpm vitest run` on the media and scheduler suites to confirm Phase 1 changed no behaviour.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: capability and fact types, the pure planner, the edit model, and the worker's pure builders. Everything below depends on these.

**⚠️ CRITICAL**: no user story work starts until this phase is complete.

- [x] T007 Extend `VideoCapabilities` (six new fields) and `VideoFacts` (bitrates, sample rate, channels, index position) in `src/providers/types.ts`; add the matching checks to `assertVideoCapabilities` in `src/providers/media.ts` (refuse a `recommendedAspectRatio` outside its range) and merge the new fields in `videoLimitsFor` in `src/providers/validation.ts`. Add registry tests in `src/providers/registry.test.ts` (data-model §5, contracts/video-planner.md "Registry checks").
- [x] T008 [P] Create `src/lib/video/edit.ts` (`VideoEdit`, defaults, `videoEditSchema`, `assertEditFits`) with `src/lib/video/edit.test.ts` covering FR-001/FR-003 (end before start, outside the video, under one second, tenth-of-second precision).
- [x] T009 Create `src/providers/video-plan.ts` (`planVideo`, `previewRecipe`, `VideoRecipe`/`VideoPlan`/`VideoStep` types per data-model §6) following contracts/video-planner.md "planVideo" and P1–P8 (even-integer geometry in Node, canvas ceiling `max(long side, 1920)`, never enlarge, refuse below minimum, cut at maximum with a note, as-is/rewrap/re-encode order, `checking` for unknown facts).
- [x] T010 Write `src/providers/video-plan.test.ts`: every worked example in contracts/video-planner.md (as-is Instagram, Facebook Reel pad 1080×1920 with frame 1080×606 at 0,656, crop x = 80 / 0 / 1312, 21:9→16:9 on mock, has/needs refusals, identical limits → one key), unknown facts → `checking`, a trim equal to the whole video, per-limit as-is/adapt/refuse cases (FR-038).
- [x] T011 [P] Add `videoRecipeKey` (hash of the numeric recipe, P2) to `src/server/media/hash.ts` with tests in `src/server/media/hash.test.ts`.
- [x] T012 [P] Create `src/providers/video-labels.ts` (step words, note wording) with `src/providers/video-labels.test.ts`.
- [x] T013 [P] Create `src/server/video/ffmpeg-args.ts`: pure builders for crop with focal point, blurred pad (`split…boxblur…overlay`), colour pad (`pad=…:color=0x…`), trim (`-ss`/`-t`), fps, scale, x264 High yuv420p `veryfast`, AAC, faststart, rewrap; export `USED_OPTIONS`; never emit `-fs` (contracts/video-worker.md "Pure argument builders", P3, P6–P8).
- [x] T014 Write `src/server/video/ffmpeg-args.test.ts`: crop with focal point at centre, near each edge and at each edge (x = 80, 0, 1312 for 1920×1080 → 9:16 variants), blurred pad, colour pad, trim start only / start and end / cut at a target's maximum, fps, assertion that `-fs` never appears (FR-037).
- [x] T015 [P] Create `src/server/video/boxes.ts` (`indexAtFront` MP4 box walker) with `src/server/video/boxes.test.ts` using hand-built byte fixtures.
- [x] T016 [P] Extend `src/server/video/probe.ts` to parse video bitrate, audio bitrate, sample rate, channels (P9) with cases added to `src/server/video/probe.test.ts`.
- [x] T017 Carry the new facts through `src/server/media/item.ts`, `src/server/dal/media.ts` (`NewMedia`), `src/server/dal/media-processing.ts` (`finishReady`) and `src/server/video/process.ts`; add `+faststart` to the remux in `src/server/video/clean.ts` (D18, P23). Existing media tests stay green.
- [x] T018 [P] Create `tests/integration/video/ffmpeg-options.test.ts` (behind `requireFfmpeg()`): assert every entry of `USED_OPTIONS` appears in the installed ffmpeg's own `-h` output (P6).
- [x] T019 [P] Create `tests/integration/media/clean-faststart.test.ts` (behind `requireFfmpeg()`): a new upload is stored with its index at the front, with no re-encode.
- [x] T020 Add the rescan: `claimRescan`/`finishRescan` in `src/server/dal/media-processing.ts`, `src/server/video/rescan.ts`, hooked into `src/server/video/loop.ts` when idle (P9); stored bytes must not change. Test in `tests/integration/media/rescan.test.ts` (behind `requireFfmpeg()`).

**Checkpoint**: run `pnpm typecheck && pnpm vitest run src/providers src/lib/video src/server/video src/server/media`. Planner and builders proven without tools.

---

## Phase 3: User Story 1 - A video that breaks limits is adapted and published (Priority: P1) 🎯 MVP

**Goal**: one master video reaches every target; fitting targets get the original, others a worker-built H.264/AAC MP4.

**Independent Test**: mock provider with Reel-like limits; a fixture clip too long and wide for one target and fine for another; run the worker loop and ticks; one target publishes the original byte for byte, the other a version whose ffprobe output meets its limits (`tests/integration/media/video-publish-adapted.test.ts`).

### Declarations and gate

- [x] T021 [US1] Declare the D7 values (each with its source in a comment) in `src/providers/instagram/capabilities.ts`, `src/providers/facebook/capabilities.ts` (Reel), `src/providers/threads/capabilities.ts` and the full small limit set in `src/providers/mock/index.ts`; values come only from `docs/research/meta-video.md` (P24).
- [x] T022 [US1] Wire `planVideo` into `adaptedMediaFor`/`validateTargetContent` in `src/server/services/media-variants.ts` and the three validators (`src/providers/{instagram,facebook,threads}/validate.ts`) so refusals say what the video has and what the target needs, and remove the "Docket does not crop, trim or convert video yet." suffix everywhere (FR-032). Update the hand-written expected messages in provider validate/fit tests and list each changed expectation in the commit message.
- [x] T023 [US1] Update generated enforcement rows: `tests/helpers/limit-rows.ts` (adapt vs refuse rows), `tests/integration/limits/enforcement.test.ts` and `tests/integration/docs/limits-inventory.test.ts`; add every new declared limit with its source to `docs/limits.md` (P25, FR-013).
- [x] T024 [P] [US1] Add `tests/lint/no-video-yet-suffix.test.ts` failing if the removed suffix string appears under `src/` or `docs/`.

### Versions and the worker loop

- [x] T025 [US1] Create `src/server/dal/video-versions.ts` (scoped repo) and `src/server/dal/video-version-processing.ts` (cross-project worker repo, inside `crossProject(…)` with fixed reasons); register `videoVersions` in `src/server/dal/scope.ts`.
- [x] T026 [US1] Create `src/server/video/encode.ts` (encode/rewrap runner via `runTool`, bitrate/resolution retry loop for byte limits per P8, per-attempt timeout that grows with kept length) and `src/server/video/readback.ts` (check output against the plan and the target's limits, D13).
- [x] T027 [US1] Create `src/server/video/versions-loop.ts` (`runVideoVersionLoop`: `VIDEO_ENCODE_CONCURRENCY` lanes, `FOR UPDATE SKIP LOCKED` claim with lease token and heartbeat, due-soonest first, ≤3 attempts, never store partial or stale output) per P12, and wire it in `src/worker.ts`.
- [x] T028 [US1] Create `tests/integration/video/formatter.test.ts` (behind `requireFfmpeg()`): fixture clips (landscape, portrait, square, silent, MOV, 60 fps, index-at-end, rotated) → probed dimensions, duration (±0.1 s), container, codecs, frame rate and size match plan and target; MOV and index-at-end are rewraps with unchanged streams (FR-039, SC-003).
- [x] T029 [US1] Create `tests/integration/video/versions-loop.test.ts` (behind `requireFfmpeg()`): two lanes build one version once; a killed build is taken over and rebuilt with no partial object stored; a deleted asset stores nothing; a readback mismatch fails after 3 attempts and is never `ready`.

### Sync and publishing the version

- [x] T030 [US1] Create `src/server/services/video-versions.ts` (`syncVideoVersions(scope, postId, { requeueFailed })`, wanted keys, shared versions across identical limits) per contracts/video-publishing.md and P14; call it from the post services (`src/server/services/posts/{index,compose,retry,retry-all,cancel}.ts`) and from schedule/queue/publish-now/edit paths.
- [x] T031 [US1] Make `resolvePublishMedia` in `src/server/services/media-variants.ts` publish a ready version's public URL, requeue a version whose object vanished, and never build in the tick; as-is targets publish the stored original untouched (FR-026).
- [x] T032 [P] [US1] Create `tests/integration/compose/video-sync.test.ts` (no ffmpeg): versions queued on schedule/queue/publish-now/edit/retry, drafts get none, two same-limit targets share one row, a stale edit's result is not used.
- [x] T033 [P] [US1] Create `tests/integration/media/video-as-is.test.ts` (no ffmpeg): a fitting video reaches the provider with the same URL and bytes, no `video_versions` row, no tool call (FR-040, SC-002).
- [x] T034 [P] [US1] Create `tests/integration/media/video-publish-adapted.test.ts` (behind `requireFfmpeg()`): the MVP independent test above.
- [x] T035 [P] [US1] Create `tests/integration/media/video-version-vanished.test.ts` (no ffmpeg): a version whose object is missing is requeued, not published.

**Checkpoint**: US1 works end to end with the default edit (whole video, blurred pad, centre). Run `pnpm vitest run tests/integration/video tests/integration/media tests/integration/compose`.

---

## Phase 4: User Story 5 - Publishing waits for the video and fails clearly (Priority: P2)

**Goal**: the tick never sends an unadapted file, never hangs, and never calls a provider or spends an attempt while a version builds.

**Independent Test**: with the DB clock, make a target due while its version is queued; ticks make no provider call and write no attempt; after the version is ready the next tick publishes it; failure and two-hour timeout produce the exact messages (`tests/integration/scheduler/video-wait.test.ts`, no ffmpeg).

- [x] T036 [US5] Add `ClaimContext.videoGate` to `src/server/dal/scheduler.ts` and the `decide()` branch in `src/server/scheduler/publishing.ts` per contracts/video-publishing.md "claim-time gate" and P13: wait while queued/building, set/clear `post_targets.video_wait_since` (`src/server/dal/targets.ts`), fail with "The video could not be adapted for <platform>: <reason>" on a failed version or after 2 hours ("took too long", or "needs the worker process" when no `video` heartbeat). First step only, inside the claim transaction, no tool or storage call, at most four indexed reads and one insert per claimed video target (SC-004).
- [x] T037 [US5] Expose `preparingVideo` ("Preparing video for <platform>") in `src/server/services/posts/view.ts`; clear `video_wait_since` on retry, cancel and reschedule; make Retry requeue the version (`src/server/services/posts/{retry,retry-all,cancel}.ts`).
- [x] T038 [P] [US5] Create `tests/integration/scheduler/video-wait.test.ts`: waiting makes no provider call and no attempt row; publishes on the tick after ready; fails on a failed version; fails at 2 h with "took too long" or the worker-not-running reason; Retry requeues; as-is targets are unaffected.
- [x] T039 [P] [US5] Create `tests/integration/scheduler/video-stale.test.ts`: a result for a changed edit/media/target or deleted video is never used (FR-023).

**Checkpoint**: run `pnpm vitest run tests/integration/scheduler`; the existing scheduler suites still pass (FR-042).

---

## Phase 5: User Story 2 - Choose crop or pad and set the focal point (Priority: P1)

**Goal**: the member picks crop (with a focal point on the poster frame) or pad (blurred copy or solid colour) per video.

**Independent Test**: unit tests build crop and pad instructions for a 1920×1080 source to 9:16 at left, centre and right focal points and for blurred and colour pads (T014) and the UI helpers map pointer and arrow-key input to a focal point (`src/components/compose/video-edit-ui.test.ts`).

- [x] T040 [US2] Add edit persistence: `listVideoEdits`/`setVideoEdits` in `src/server/dal/posts.ts` (setMedia prunes edits for removed media), `videoEdits` in `postInputSchema` (`src/lib/validation/scheduling.ts`), server enforcement of `post: ["edit"]` and `assertEditFits` in the post services (P10, P21, FR-004), and sync on edit change.
- [x] T041 [P] [US2] Create `src/components/compose/video-edit-ui.ts` (pure helpers: focal-point from pointer and from arrow keys, spoken position text like "20% across, 50% down", trim parse/format to a tenth of a second, validation messages) with `src/components/compose/video-edit-ui.test.ts`.
- [x] T042 [P] [US2] Create `src/components/compose/FocalPointPicker.tsx` (keyboard-operable, announced position, visible focus) following contracts/video-composer.md "Components" and the `docket-ui` skill.
- [x] T043 [US2] Create `src/components/compose/VideoEditDialog.tsx` and `VideoEditButton.tsx`: fit method (crop / blurred pad / colour pad), colour, focal point, recommended-shape checkbox; keeps the previous edit on an invalid entry.
- [x] T044 [US2] Add `videoEdits` state and payload to `src/app/p/[projectSlug]/compose/Composer.tsx` and `actions.ts`; add `videos[]` to `checkComposition` per contracts/video-composer.md "Check response".
- [x] T045 [P] [US2] Create `tests/integration/compose/video-edits.test.ts` (no ffmpeg): edits saved and read back, defaults applied, invalid edits refused, role enforced, pruned when media is removed, edit change queues a new version and drops the old one.
- [x] T046 [US2] Run `pnpm typecheck && pnpm lint` to confirm the server/client boundary of the new components.

---

## Phase 6: User Story 3 - Trim to a start and end (Priority: P1)

**Goal**: trim fields to a tenth of a second, cut at each target's maximum with a note.

**Independent Test**: trim builders produce the computed start and duration for each target maximum (T014); the formatter suite probes trimmed output duration within ±0.1 s (T028).

- [x] T047 [US3] Add the trim fields (start, end, to a tenth of a second, with refusals per FR-003) to `VideoEditDialog.tsx` using the helpers in `video-edit-ui.ts`; show the per-target cut note from the plan.
- [x] T048 [P] [US3] Add trim cases to `tests/integration/video/formatter.test.ts`: start only, start and end, cut at a target's maximum, trim equal to the whole video (is as-is, no version), trim that leaves under one second (refused).
- [x] T049 [P] [US3] Add trim cases to `src/providers/video-plan.test.ts` and `tests/integration/compose/video-edits.test.ts` if not already covered by T010/T045 (end before start, outside the video).

---

## Phase 7: User Story 4 - Preview each target before publishing (Priority: P2)

**Goal**: a ≤640 px preview per target, built by the worker, shown before publishing; drafts get previews only.

**Independent Test**: request previews for a draft with three targets (as is, adapted, refused); run the worker; the adapted preview is ≤640 px on its long side with the planned duration and sound; shared like versions; replaced when the edit changes (`tests/integration/compose/video-previews.test.ts`).

- [x] T050 [US4] Create `src/server/services/video-previews.ts` (request/status, `previewRecipe`, shared with identical recipes, replaced on edit change, never waited on by scheduling or publishing) and the two server actions in `src/app/p/[projectSlug]/compose/actions.ts` (P16, FR-029).
- [x] T051 [US4] Create `src/components/compose/VideoTargetPreview.tsx`: requests a preview, polls until ready, shows the original for "fits as is", "rewrapped", the preview video, or the refusal, with live announcements.
- [x] T052 [P] [US4] Create `tests/integration/compose/video-previews.test.ts` (no ffmpeg, version rows set directly): request, share, replace, status, refused target; and add a preview case (long side ≤640, planned duration, audio kept) to `tests/integration/video/versions-loop.test.ts` behind `requireFfmpeg()`.

---

## Phase 8: User Story 6 - See what Docket will do, up front (Priority: P3)

**Goal**: badges and the requirements summary state adapt/refuse/checking from the planner.

**Independent Test**: for fixture facts against each provider's limits, the badge and its words match; no message ends with the removed suffix (T024).

- [x] T053 [US6] Add `adapted`/`checking` states to `src/server/services/media-fit.ts` and `src/components/media/fit-ui.ts` / `FitBadges.tsx` ("fits", "will be adapted" with step words, "will be refused" with reason, "checking"); extend `src/server/services/media-fit.test.ts` and `tests/integration/media/fit.test.ts`.
- [x] T054 [P] [US6] Add `video.adapts` / `video.cannot` to `src/providers/requirements.ts` (+ `requirements.test.ts`) and render in `src/components/compose/RequirementsSummary.tsx` / `requirements-ui.ts`; no limit literals in UI code.

---

## Phase 9: Housekeeping and Delete (FR-033)

- [x] T055 Add `collectVideoVersions` to `src/server/scheduler/housekeeping.ts` (unreferenced, stale or failed versions and previews; objects deleted, no ffmpeg) and make `deleteMedia` in `src/server/services/media.ts` remove versions and previews.
- [x] T056 [P] Create `tests/integration/video/collect.test.ts` (no ffmpeg): collection rules and delete-with-video.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [X] T057 [P] Add `--formatter` mode to `scripts/video-smoke.ts` (build a 30 s 1080×1920 preview, print `preview 30s 1080x1920 → <ms> ms`, fail on readback failure) and the docker step with `--cpus=2` in `.github/workflows/ci.yml` (quickstart §5).
- [X] T058 [P] Update `docs/deployment.md` (CPU, memory, temp disk; the worker requirement; the exact `.env.example` and optional compose edits from quickstart §7, FR-036), `docs/adding-a-provider.md` (declaring video limits gets the formatter), `docs/feature-map.md` (formatter moves to Built, with the unowned list from FR-044–FR-046), `docs/meta-setup.md` (owed live checks, quickstart §8).
- [X] T059 Add an "024 — Implementation outcome" entry to `docs/decisions.md`: what shipped, the two judgement calls (P3 canvas ceiling, P25 enforcement rows), every changed existing-test expectation, and which suites ran locally vs only in CI.
- [X] T060 Run `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build` once and fix failures; report ffmpeg suites as run only if they actually executed (constitution II).
- [ ] T061 🛑 BLOCKED: needs Docker and CI — run `docker run --rm --cpus=2 --user 1001 --entrypoint node docket:ci scripts/video-smoke.js --formatter`, record the SC-007 time (≤60 s) in `docs/decisions.md`, and confirm on CI that the ffmpeg suites ran rather than skipped (SC-009).
- [ ] T062 🛑 BLOCKED: needs live Instagram, Facebook and Threads accounts and a running worker — perform the owed live checks in quickstart §8 (adapted IG Reel and Feed, adapted FB Reel, Threads fps reduction, off-centre crop, trimmed version, one rewrap) and the manual mock-provider walkthrough in quickstart §4 in a real browser.

---

## Dependencies & Execution Order

- **Phase 1 → Phase 2 → stories.** Phase 2 (planner, builders, facts) blocks everything.
- **US1 (Phase 3)** needs Phase 2 and delivers the MVP (default edit only).
- **US5 (Phase 4)** needs US1's versions (T025, T030, T031).
- **US2 (Phase 5)** needs Phase 2 and T030 (sync on edit change); independent of US5.
- **US3 (Phase 6)** needs US2's dialog (T043).
- **US4 (Phase 7)** needs US1's loop (T027) and US2's edits (T040).
- **US6 (Phase 8)** needs T022 and Phase 2.
- **Phase 9** needs US1's repos (T025). **Phase 10** is last; T060 after everything else.

### Parallel opportunities

- Phase 1: T003, T004, T005.
- Phase 2: T008, T011, T012, T013, T015, T016 together; then T018, T019.
- US1: T032–T035 after T031; T024 any time after T022.
- US2: T041 and T042 together; US5 tests T038/T039 together.
- US6, Phase 9 and docs (T057, T058) can run alongside US4 once their dependencies are met.

## Implementation Strategy

1. **MVP**: Phase 1, Phase 2, Phase 3 (US1) with US5's gate (Phase 4) — an adapted video is built and safely published with the default edit.
2. Add US2 (edit dialog, crop/pad), then US3 (trim), US4 (previews), US6 (badges/summary).
3. Housekeeping, docs and the single final check pass last.
4. Report ffmpeg-dependent suites as passing only from a run that executed them; otherwise say CI is owed.

## Notes

- Never run ffmpeg in the web process or the tick (`tests/lint/no-ffmpeg-in-web.test.ts`).
- Never use `-fs`; never store partial or stale output; no provider or storage call inside a held transaction.
- Commit with conventional commits and explicit paths.

---

## Phase 11: Review remediation

- [X] T063 Keep every cut strictly inside the target's maximum duration: in `planVideo` plan `keptMs` at least one output frame (or 100 ms) under `maxDurationSeconds` when cutting at the maximum or when a selection ends within that margin of it, carry the maximum in the recipe (e.g. `video.maxDurationMs`) and make `checkOutput` fail when the probed duration exceeds it; add a `requireFfmpeg()` formatter case with a 29.97 fps fixture cut at a maximum whose ready version passes `provider.validate` (G15) — review F1 (BLOCKER), src/providers/video-plan.ts:115, src/server/video/readback.ts:53, src/server/scheduler/publishing.ts:428
- [X] T064 Fix the `--formatter` smoke so it can pass and measures SC-007: generate a 30 s 1080×1920 fixture with audio, build its recipe via `planVideo` (mock limits) then `previewRecipe` (≤ 640 px), time `buildFile` with `preview: true`, read it back and print the figure; optionally add pad, crop and trim full builds per research P22 — review F2 (MAJOR), scripts/video-smoke.ts:41, scripts/video-smoke.ts:53, src/server/video/readback.ts:50
- [X] T065 Render "Preparing video for <provider name>" wherever target status is shown when `preparingVideo` is true (the post page beside `StatusBadge`, and any row that shows `inProgress`), with a test for the wording — review F3 (MAJOR), src/app/p/[projectSlug]/posts/[postId]/page.tsx:114, src/server/services/posts/view.ts:70
- [X] T066 Call `syncVideoVersions(scope, postId, { requeueFailed: true })` after `approvePost` (and so `bulkApprove`) and `applyApprovalPolicy` queue targets, and add an approve-into-queue case to `tests/integration/compose/video-sync.test.ts` — review F4 (MAJOR), src/server/services/review.ts:214, src/server/services/generation/policy.ts:106
