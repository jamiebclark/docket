---

description: "Task list for standing content series that keep producing posts on a cadence"
---

# Tasks: Standing content series that keep producing posts on a cadence

**Input**: Design documents from `/specs/071-evergreen-series/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/services.md, contracts/worker.md, contracts/ui.md, quickstart.md

**Tests**: Requested by the spec's own test list and included below, following quickstart.md's mapping to success criteria.

**Organization**: Tasks are grouped by user story. The Foundational phase (pure modules, schema, shared refactors, DAL) is the blocking prerequisite the plan calls out — no user story work can begin until it is complete. US1, US2 and US3 are all P1 and are built together in one slice (plan § "Phase 2 — Tasks", step 7), because a series that fires but can bypass policy or double-generate is worse than no series at all.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1–US6, mapping to spec.md's priorities (US1/US2/US3 = P1, US4/US5 = P2, US6 = P3)
- File paths are exact; contract/data-model section references are inline for traceability

---

## Phase 1: Setup

- [X] T001 [P] Add `STANDING_SERIES_TICK_MAX_SERIES` and `STANDING_SERIES_TICK_MAX_POSTS` documentation blocks (description, optional marker, default) to `.env.example`, in the existing generator group (contracts/worker.md §7)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The pure cadence and avoid-titles modules, validation schemas, schema and migration, the shared refactors the producer needs (budget module, generalised blocked-project resolution, widened media reservation, `avoidTitles` on the plan prompt, the fourth `GeneratedPostLink` variant), authorization, configuration and the DAL. Nothing in later phases copies what belongs here.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete. Per plan.md's own guidance, SC-011's existing suites (`tests/integration/generation`, `tests/integration/jobs`, `prompt.golden.test.ts`) must stay green at the **end** of this phase — the cheapest moment to discover a refactor broke something.

### Pure modules (no database)

- [X] T002 [P] Create `src/lib/series/cadence.ts`: `CadencePeriod`, `CADENCE_PERIODS`, `CADENCE_COUNT_MIN`/`MAX`, `periodStartDate`, `periodStartInstant`, `nextBoundaryAfter`, `boundariesBetween`, each using `Temporal` with `disambiguation: "compatible"` following `src/lib/email/schedule.ts`'s shape (contracts/services.md §1)
- [X] T003 [P] Unit tests for `cadence.ts` in `src/lib/series/cadence.test.ts`: day/week(Monday)/month boundaries, a 31st→30th month rollover, a spring-forward gap resolving to one instant after it, an autumn overlap taking the earlier offset, `boundariesBetween` across a DST change counting whole periods, and a changed time zone recomputing the next boundary without relabelling a stored date (quickstart.md "SC-001", plan § structure)
- [X] T004 [P] Create `src/lib/series/avoid.ts`: `AVOID_RUNS = 3`, `AVOID_TITLES_MAX = 20`, `avoidTitles(plans)` returning newest-first, case-insensitively de-duplicated, capped titles (contracts/services.md §2)
- [X] T005 [P] Unit tests for `avoidTitles` in `src/lib/series/avoid.test.ts`: ordering, de-duplication, the cap, and an empty input producing an empty array
- [X] T006 [P] Create `src/lib/validation/standing-series.ts`: `STANDING_SERIES_NAME_MAX = 100`, `createStandingSeriesSchema`, `updateStandingSeriesSchema` (= create), `standingSeriesRunConfigSchema` (data-model.md §6, `v: 1`), importing `SERIES_COUNT_MAX`/`TARGET_ACCOUNTS_MAX`/`BRIEF_MAX`/`INSTRUCTIONS_MAX`/`IMAGE_PROMPT_MAX`/`tagSchema` rather than re-typing any bound (contracts/services.md §3)
- [X] T007 [P] Unit tests for the schemas in `src/lib/validation/standing-series.test.ts`: name trim/length/uniqueness is not checked here (service-level), cadence bounds, the three `media` branches of the discriminated union, and the run-config schema round-tripping data-model.md §6's shape

### Schema and migration

- [X] T008 [P] Create `src/server/db/schema/standing-series.ts`: the seven new enums (`standing_series_period`, `standing_series_media_source`, `standing_series_position_status`, `standing_series_outcome`, `standing_series_skip_reason`, `standing_series_block_reason`, `standing_series_pause_reason`) and the three tables `standing_series`, `standing_series_runs`, `standing_series_positions` with every column, CHECK, unique index and composite FK in data-model.md §§1–3
- [X] T009 [P] Re-export the new schema module from `src/server/db/schema/index.ts`
- [X] T010 [P] Add `standing_series_position_id` (nullable), its composite FK `ON DELETE SET NULL` and the partial unique index `posts_standing_series_position_uq` to `posts` in `src/server/db/schema/posts.ts` (data-model.md §5)
- [X] T011 [P] Add `standing_series_run_id`/`standing_series_position` (nullable), the composite FK `ON DELETE CASCADE`, the two CHECKs (`standing_mode_pair`, `standing_position_needs_run`) and the index to `generation_failures`, and add `standing_series_plan`/`standing_series_post` to the `generation_mode` pgEnum, in `src/server/db/schema/generation.ts` (data-model.md §5)
- [X] T012 [P] Add `standing_series_create`/`_update`/`_pause`/`_resume`/`_delete` to the `membership_action` pgEnum in `src/server/db/schema/audit.ts` (data-model.md §5, FR-008)
- [X] T013 Generate the Drizzle migration for T008–T012 with `pnpm db:generate`, commit the SQL file under `drizzle/`, and confirm `pnpm db:check` is green — each `ALTER TYPE … ADD VALUE` outside the transaction that first uses it, as the existing migrations already do (depends on T008, T009, T010, T011, T012) (FR-001)
- [X] T014 [P] Add `standing_series`, `standing_series_runs`, `standing_series_positions` (each keyed on `project_id`) to `src/server/db/project-owned.ts` (depends on T008) (FR-065)

### Shared refactors (before anything consumes them — plan § "Phase 2 — Tasks" step 3)

- [X] T015 [P] Move `withinBudget`, `Overran` and the redacted log line out of `src/server/services/jobs/runner.ts` into new `src/server/scheduler/budget.ts`, and update `jobs/runner.ts` to import them, with its existing tests passing unchanged (**S36**) (contracts/worker.md §1, services.md §7.4)
- [X] T016 Generalise `resolveBlockedProjectIds` in `src/server/dal/job-claims.ts` to accept a candidate project-id list, move it (or a thin re-export) to `src/server/dal/credential-owners.ts`, and add `standingSeriesExcludingProjects` beside the existing `jobsExcludingProjects`; `claimDueJobItems` keeps calling it with job candidates, unchanged in behaviour (**S37**) (contracts/worker.md §3)
- [X] T017 Widen the private `reservations` expression in `src/server/dal/media.ts` to count `standing_series_positions` rows with `status IN ('queued','running')` and a `media_asset_id`, confirm `listIdsForSelection({ unusedOnly })`, `reservedAmong` and `list` all read it, and add `claimPoolImage({ tag })`: `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1` over live `image` assets, `first_used_at IS NULL`, unreserved, tag-matching when given, oldest first (**S15**, **S16**) (depends on T008) (contracts/services.md §4)
- [X] T018 [P] Add `avoidTitles: readonly string[]` to `buildSeriesPlanPrompt` in `src/server/services/generation/prompt.ts`, appending one `TITLES TO AVOID: …` line only when non-empty, so the empty case is byte-identical to today's committed golden snapshot (**S31**) (contracts/services.md §8)
- [X] T019 [P] Add `avoidTitles` (default `[]`) and an explicit `purpose` parameter to `planSeries` in `src/server/services/generation/series.ts`, forwarding both to `buildSeriesPlanPrompt` / the usage recorder (depends on T004, T018) (contracts/services.md §8)
- [X] T020 [P] Update `prompt.golden.test.ts` to cover `buildSeriesPlanPrompt` both with and without prior-run titles, asserting the existing empty-case snapshot is unchanged (depends on T018) (FR-018, quickstart.md "SC-003")
- [X] T021 [P] Add `{ standingSeriesPositionId: string }` as a fourth `GeneratedPostLink` variant in `src/server/services/generation/save.ts` (depends on T010) (contracts/services.md §8)
- [X] T022 [P] Add `"standing_series_post"` to `generationRecordSchema.mode` in `src/lib/validation/generation.ts` (contracts/services.md §8)
- [X] T023 [P] Add `generate.standing_series_plan` and `generate.standing_series_post` to `UsagePurpose` in `src/server/llm/usage.ts`, and their labels to `USAGE_PURPOSE_LABELS` in `src/lib/generation/usage-purpose.ts` (data-model.md §5, **S13**)
- [X] T024 Widen the closed call-site list from eight to ten in `src/server/llm/no-missing-usage-purpose.test.ts` (depends on T023) — the two standing-series call sites (plan + post) are added in Phase 4/5, so this stays red until then; note that in the task like T020 in the image-generation entry did
- [X] T025 [P] Add `findByStandingSeriesPosition(positionId, { includeDeleted? })` to `src/server/dal/posts.ts`, mirroring `findByJobItemId` (depends on T010) (contracts/services.md §4)
- [X] T026 [P] Add `listForRun(runId)` and the two new insert fields to `src/server/dal/generation-failures.ts` (depends on T011) (contracts/services.md §4)

### Authorization, env and config

- [X] T027 [P] Add `standing_series: ["manage"]` to `statements`, `owner` and `admin` in `src/server/auth/access.ts`, granted to **no** `KEY_GRANTS` entry (**S25**); update the exhaustive matrix in `src/server/auth/access.test.ts` for all three roles (contracts/services.md §5)
- [X] T028 [P] Add `STANDING_SERIES_TICK_MAX_SERIES: int(1, 10, 2)` and `STANDING_SERIES_TICK_MAX_POSTS: int(1, 10, 2)` to `src/server/env.ts` in the generator group (contracts/worker.md §7)
- [X] T029 [P] Add `STANDING_SERIES_TICK_MAX_SERIES`/`STANDING_SERIES_TICK_MAX_POSTS` to the `EnvLike` Pick in `schedulerConfig` and add `standingSeriesMaxSeries?`/`standingSeriesMaxPosts?` to `SchedulerConfig`, plus `standingSeriesConfig(config)` returning the shape in contracts/worker.md §4, in `src/server/scheduler/config.ts` (depends on T028)
- [X] T030 [P] Unit tests for `standingSeriesConfig` defaults and overrides in `src/server/scheduler/config.test.ts` (depends on T029)
- [X] T031 [P] Add both variable names to `tests/lint/env-coverage.test.ts`'s `CONFIGURABLE` list (depends on T028, T001)

**Checkpoint**: Foundational phase complete — pure modules, schema, shared refactors, authorization and configuration all exist and are tested in isolation. Run `pnpm vitest run tests/integration/generation tests/integration/jobs src/server/services/generation` now and confirm it is still green (SC-011). User story work can now begin.

---

## Phase 3: DAL — repos and the claim

**Purpose**: The three standing-series repos and the scheduler's claim query, which every user story's producer and service code call. Listed as its own phase because plan.md orders it before `manage`/`read` and the run lifecycle, but it carries no user-story label of its own — it is infrastructure every P1 story needs.

- [X] T032 Create `src/server/dal/standing-series.ts`: `scope.standingSeries` (`insert`, `get`, `list`, `update`, `lockForUpdate`, `lockShared`, `delete`, `nameTaken`), `scope.standingSeriesRuns` (`openRun`, `openFor`, `get`, `listForSeries`, `recentClosedPlans`, `recentClosedOutcomes`, `update`, `close`, `setPlan`), `scope.standingSeriesPositions` (`insertMany`, `listForRun`, `countByStatus`, `nextDue`, `update`, `claimMedia`) — exactly the shapes in contracts/services.md §4 (depends on T008, T013)
- [X] T033 Add the three repos to `src/server/dal/scope.ts`'s `ProjectScope`, with **no** `KEY_GRANTS` entry (depends on T032) (**S25**)
- [X] T034 [P] Unit/integration tests for the three repos in `tests/integration/standing-series/dal.test.ts`: the name-uniqueness throw, `openRun`'s two unique-index throws (period, open-run), `setPlan`'s `WHERE plan IS NULL` guard, `claimMedia`'s `WHERE media_asset_id IS NULL` guard, and `countByStatus` (depends on T032)
- [X] T035 Create `src/server/dal/standing-series-claims.ts`: `claimDueStandingSeries(opts)` — one transaction via `crossProject`, `gateCreditHolds`, `standingSeriesExcludingProjects` for blocked owners, the `SELECT … FOR UPDATE SKIP LOCKED` in contracts/worker.md §3 ordered `next_run_at ASC, last_claimed_at ASC NULLS FIRST, id`, the per-owner probe budget, the claim patch, and the stale-`running`-position reset (finish / requeue-no-attempt for a probe / `interrupted` at the cap / requeue-with-attempt) (depends on T016, T017, T032, T025) (contracts/worker.md §3)
- [X] T036 [P] Integration tests for the claim in `tests/integration/standing-series/claim.test.ts`: two concurrent calls never return the same series, a held owner's series is excluded entirely, a probing owner gets exactly one series through, rotation (`last_claimed_at NULLS FIRST`) prefers the longest-due series, and the three stale-position outcomes (depends on T035)

**Checkpoint**: The DAL is complete and independently tested. The service and worker layers can now be built against it.

---

## Phase 4: User Story 1/2/3 (Priority: P1) 🎯 MVP — a series creates itself, fires on cadence, applies policy with no bypass, and never double-generates

**Goal**: An owner creates a standing series; from then on, without anyone opening the app, it produces the configured number of posts every period, through the exact policy the series was authorised with, and never twice.

**Independent Test** (combines US1, US2, US3's independent tests): create a series, advance the clock past the next boundary, run the worker, find the period's posts with the configured policy treatment; drive two concurrent ticks and a mid-run kill against the same series and assert exactly one run and no duplicate position.

### `manage` and `read` (US1, US5-adjacent but needed to create a series at all)

- [X] T037 [US1] Create `src/server/services/standing-series/manage.ts`: `createStandingSeries`, `updateStandingSeries`, `pauseStandingSeries`, `resumeStandingSeries`, `deleteStandingSeries` following the nine/ten-step orders in contracts/services.md §5 — `requirePermission`, schema parse, `resolvePolicies`, `takeVoice`, `loadAccounts` + `assertGroupLimit`, `unknownPlaceholders` refusal, the storage-only media refusal, `nextBoundaryAfter` for `next_run_at`, the friendly duplicate-name message, and one audit row per action inside `deleteStandingSeries`'s transaction (depends on T006, T027, T032) (FR-002–FR-008, FR-027, FR-028, FR-054–FR-057)
- [X] T038 [P] [US1] Create `src/server/services/standing-series/index.ts` re-exporting `manage.ts` and `read.ts`'s public surface (depends on T037)
- [X] T039 [P] [US1] Create `src/server/services/standing-series/read.ts`: `listStandingSeries`, `getStandingSeries`, both gated by `post: ["view"]` (**S26**), using `generationCreditHold(scope)` for the hold and `countByStatus` for derived run counts (depends on T032) (contracts/services.md §6, FR-052, FR-061)
- [X] T040 [US1] Integration tests for create/edit/pause/resume/delete in `tests/integration/standing-series/manage.test.ts`: name length/uniqueness/trim, template placeholder refusal, cadence bounds, target-account cardinality and group-limit, voice-profile validation, the storage-not-configured refusal for `pool`/`generate`, `nextRunAt` = the next boundary never a passed one, editing not touching `next_run_at` except on a period change, pausing/resuming's exact field writes, deletion cascading runs/positions/failures while leaving posts, and one audit row per action with the five new `membership_action` values (depends on T037) (quickstart.md "SC-001" partial, FR-056, FR-057)

### The run lifecycle (US1, US3 — plan step 6, "tested against the clock with no model call")

- [X] T041 [US1] Create `src/server/services/standing-series/run.ts`: `deriveRunOutcome`, the self-pause check reading the three most recent closed runs' `outcome` (**S35**), and the open-or-resume logic in contracts/services.md §7.1 — closing a stale open run as `incomplete` before opening the new one, computing `missed_periods`, validating the snapshot against live data (`takeVoice` → `voice_profile_missing`, dropped accounts → `no_usable_target`), inserting the run and its positions in one transaction, and the unique-index-violation re-read-and-continue path (depends on T002, T032, T006) (W10, W11, FR-012–FR-015, FR-053)
- [X] T042 [US1,US3] Integration tests for the run lifecycle in `tests/integration/standing-series/run-lifecycle.test.ts`: no-backfill (`missed_periods` recorded, never iterated), a still-open run closed `incomplete` when the next boundary arrives, the blocked-reason immediate-skip-and-close path for a missing voice profile and for no usable target, `deriveRunOutcome`'s four branches, and the self-pause threshold (three `produced_none`/`incomplete`-with-nothing runs in a row) (depends on T041) (quickstart.md "SC-001", "SC-008", self-pause suite)

### The producer and the worker section (US1, US2, US3 — plan step 7, "complete here")

- [X] T043 [US1,US2,US3] Create `src/server/services/standing-series/runner.ts`: `processClaimedSeries` implementing contracts/services.md §7.2–§7.5 — the plan-only-when-`requested_count >= 2`-and-`plan IS NULL` call to `planSeries` with `avoidTitles`, the `setPlan` race (re-read on `false`), the position loop (re-read `enabled`, `nextDue`, the finish-if-already-has-a-post short-circuit, the `runGenerationStep` call with `purpose: "generate.standing_series_post"`, the outcome mapping identical to the batch runner's), the save transaction with a lease re-check via `lockShared` and the unique-violation re-read-and-finish path, and closing the run when every position is terminal (depends on T015, T019, T021, T024, T041, T025) (W14–W24, FR-016–FR-033)
- [X] T044 [US1,US2,US3] Create `src/server/services/standing-series/media.ts`: resolve one position's media per contracts/services.md §7.3 step 4 — `none` (no-op), `pool` (reuse-if-set, else `claimPoolImage` + `claimMedia`, else `pool_exhausted`), `generate` (reuse-if-set, else `createImageGenerator(scope).generate({ projectId, prompt })` outside every transaction, else the three failure-reason branches), then `imagesForModel` and the "only skip when a target actually requires media" rule with `skip_account_id` (depends on T017, T032) (FR-034–FR-041, this task's text-only behaviour feeds US4 but the function is needed by every position, hence placed here)
- [X] T045 [US1,US2,US3] Create `src/server/scheduler/standing-series.ts`: `runStandingSeries` per contracts/worker.md §1 — the `notConfigured`/`notRunnable`/deadline guards, `claimDueStandingSeries`, `Promise.all` over `processClaimedSeries` with per-series isolation (`staleResults++` on a throw), and the `standing_series` heartbeat with every `StandingSeriesCounts` field (depends on T035, T043, T029) (W30–W34, FR-042–FR-049)
- [X] T046 [US1,US2,US3] Wire the new section into `src/server/scheduler/index.ts`'s `Promise.all` and `TickSummary` (`standingSeries: SectionResult<StandingSeriesCounts>`), and add `series_produced=…/series_skipped=…/series_failed=…` to the one-line tick summary in `src/server/scheduler/loop.ts` (depends on T045) (FR-047)
- [X] T047 [US1,US2,US3] Integration tests for cadence firing/not-firing in `tests/integration/standing-series/cadence.test.ts`: a series created mid-week due at the coming Monday with no premature output (US1 AS5), ticking past the boundary producing exactly the configured count with `origin = "generated"` and a `standingSeriesPositionId`, a further tick inside the same week producing nothing, a second period's plan differing from the first's (asserted on the prompt and the stored plan, not model obedience), a 1-post series making **no** planning call, and the no-backfill/`missed_periods` assertion (US1 AS1–AS4, FR-010, FR-011, FR-013, FR-016) (depends on T045)
- [X] T048 [US2] Integration tests for policy application in `tests/integration/standing-series/policy.test.ts`: the four policy configurations (review-required, auto-approve+queue valid, auto-approve+queue with a content-validation failure, auto-approve+leave-as-draft) each asserting the exact review/queue/draft outcome and recorded reason, an unavailable-but-not-invalid account **not** forcing review, and a grep-style assertion that `applyApprovalPolicy` is called from exactly one place in this feature with no standing-series branch in `decidePolicy` (depends on T043) (US2 AS1–AS4, FR-029, FR-030, FR-033, quickstart.md "SC-005")
- [X] T049 [US2] Integration tests for authorization in `tests/integration/standing-series/authz.test.ts`: a member without `generation: ["auto_approve"]` refused at create and at edit regardless of what was posted, an editor refused create/edit/pause/resume/delete through both the server action and a direct service call while still able to read the list and run history, and an API-key scope's `can({ standing_series: ["manage"] })` being false (depends on T037, T027) (US2 AS5, US5 AS5, FR-060, FR-061, SC-009)
- [X] T050 [US3] Integration tests for idempotency in `tests/integration/standing-series/idempotency.test.ts`: two concurrent ticks against one due series yielding exactly one run row and no doubled position, a mid-run kill (abandoned lease, a `running` position with no post) resumed by the next tick reusing the stored plan with the stub planner's call count unchanged, expired-lease recovery finishing a dead run, a too-short deadline releasing a position to `queued` with no attempt counted while written posts stay intact, and a direct insert violating `posts_standing_series_position_uq` (depends on T045) (US3 AS1–AS5, FR-017, FR-021, quickstart.md "SC-002")
- [X] T051 [US3] Integration tests for slot exclusivity in `tests/integration/standing-series/slots.test.ts`: two enabled series of the same project, both auto-approve+queue, both targeting the same account with a small slot grid, driven by two concurrent ticks — every queued target holds a distinct occurrence, `post_targets_occurrence_uq` is never violated, and a target with the queue horizon exhausted stays a draft with the allocator's own reason and is not retried under another policy (depends on T045) (US3 AS4, FR-031, FR-032, quickstart.md "SC-004")
- [X] T052 [US1,US2,US3] Integration tests for prompt/record parity with a manual Generate in `tests/integration/standing-series/parity.test.ts`: byte-identical prompt composition for the same brief/instructions/voice/accounts/angle, a `generationMetadata` record differing only in `mode` and `series.id`, and the post's `reviewState`/`schedulingPolicy`/targets/media/policy decision produced by the same call sites (depends on T043) (quickstart.md "SC-003")
- [X] T053 [P] [US1,US2,US3] Extend `src/server/services/generation/prompt.golden.test.ts`'s snapshots to cover a standing-series plan prompt (depends on T018, T020) — already covered by T020; this task is the golden-file commit step once T043 exercises it end to end

**Checkpoint**: US1, US2 and US3 are complete and independently testable — a series fires on cadence, applies policy with no bypass, and never double-generates under any combination of overlapping ticks, kills and restarts. SC-001 through SC-005, SC-008 and SC-009 are each covered.

---

## Phase 5: User Story 4 (Priority: P2) — a series that needs a picture gets one, or says why not

**Goal**: A series targeting a media-required account either produces a post with a usable image or records why it could not, never emitting a post that cannot publish.

**Independent Test**: run the same series against an Instagram account with a pool of two images and a cadence of three, assert two posts with distinct images and one recorded skip naming the exhausted pool; repeat with generation configured and assert three posts each with its own generated asset.

- [X] T054 [US4] Integration tests for media in `tests/integration/standing-series/media.test.ts`: pool of 3/cadence 3 → 3 distinct images invisible to a concurrent batch job; pool of 1/cadence 3 → 1 post + 2 `pool_exhausted` skips naming the account, with `produced_some` not "with failures"; `generate` with a stub provider → each post its own asset with provenance, request body exactly `prompt + "\n\n" + NO_REAL_PEOPLE`; `generate` not configured → every position skipped `image_generation_not_configured` with the series' `media_source` unchanged; a non-media-required account with `none` → text-only, nothing skipped; storage not configured → creation refused, an existing series skips `media_storage_not_configured`; a restart between reserving and producing reuses the asset (stub call count stays 1); the same image wanted by a batch job and a series in one tick resolves to one winner; a video asset is never eligible (depends on T044, T043) (US4 AS1–AS5, FR-034–FR-041, quickstart.md "SC-006")

**Checkpoint**: US4 is complete. SC-006 is covered.

---

## Phase 6: User Story 5 (Priority: P2) — a member can see what a series is doing, and stop it

**Goal**: Under Batch jobs, a Standing series section lists each series and lets an owner/admin create, edit, pause, resume and delete; a detail page shows recent runs with what they produced, skipped and failed.

**Independent Test**: with a series that has one completed run containing a produced post, a skip and a failure, assert all three are visible with their reasons, and that pause stops the next period from firing while resume restores it.

- [X] T055 [US5] Create `src/app/p/[projectSlug]/jobs/series/actions.ts`: `createStandingSeriesAction`, `updateStandingSeriesAction`, `pauseStandingSeriesAction`, `resumeStandingSeriesAction`, `deleteStandingSeriesAction` — thin `runAction` wrappers over `manage.ts`, validating with the same Zod schema, `refresh()` on success, with the permission check living in the service only (depends on T037, T006) (contracts/ui.md §6, FR-060)
- [X] T056 [US5] Create `src/app/p/[projectSlug]/jobs/series/StandingSeriesForm.tsx`: the client form in contracts/ui.md §4 — Name, brief, instructions (with the no-placeholder help text), voice profile `ChoiceField`, accounts `<fieldset>` (showing which require an image), cadence `<fieldset>` (count + `SegmentedControl` for day/week/month, with the zone-naming help text), the three-option media `ChoiceField` with its conditional tag/prompt fields, the existing `PolicyPicker` with its confirmation checkbox, the authorised-now note, and an `ActionBar` with focus-to-first-invalid-field on submit (depends on T055) (contracts/ui.md §4, FR-063)
- [X] T057 [P] [US5] Create `src/app/p/[projectSlug]/jobs/series/SeriesRowActions.tsx`: pause/resume as one-button forms, delete via a `Dialog` naming the series and stating the post count, following the "switch that saves on activation" pattern (depends on T055) (contracts/ui.md §5, FR-062)
- [X] T058 [P] [US5] Create `src/app/p/[projectSlug]/jobs/series/loading.tsx`, `new/page.tsx`, `[seriesId]/loading.tsx`, `[seriesId]/edit/page.tsx` (depends on T056, T057) (contracts/ui.md §1)
- [X] T059 [US5] Create `src/app/p/[projectSlug]/jobs/series/[seriesId]/page.tsx`: the detail page's four blocks in contracts/ui.md §3 — `PageHeader` with the state badge, the definition-list `Card`, the always-visible FR-064 `Alert`, and the four-column run-history `Table` with the Problems column naming skip/failure/blocked reasons and dropped accounts, with the empty state (depends on T039, T058) (contracts/ui.md §3, FR-059, FR-064)
- [X] T060 [US5] Add the "Standing series" section (empty state, the gated create action, the five-column populated `Table`) to `src/app/p/[projectSlug]/jobs/page.tsx`, rendered below the existing batch-job list and the `CreditHoldNotice` (depends on T039, T059) (contracts/ui.md §2, FR-058)
- [X] T061 [US5] Integration tests for the interface in `tests/integration/standing-series/ui.test.tsx`: the empty state and its create action, the populated list's five columns and state badges, the detail page's four blocks including the FR-064 sentence verbatim, pause stopping the next period and resume setting the next due time to the coming (not a passed) boundary, delete leaving every produced post in the project, and an editor seeing the list and run history with no manage control anywhere (depends on T060) (US5 AS1–AS6, quickstart.md "SC-010")
- [X] T062 [P] [US5] Extend `tests/integration/actions-authz.test.ts` to cover the five new server actions (depends on T055)

**Checkpoint**: US5 is complete. SC-010 is covered, and a person can fully operate a series from the interface.

---

## Phase 7: User Story 6 (Priority: P3) — a broken or unpaid series waits quietly and recovers on its own

**Goal**: A credit hold pauses a series with no state to clear and no human intervention; a genuinely broken series pauses itself and says why.

**Independent Test**: hold the credential owner, tick, and assert nothing was produced, nothing failed, no attempt was counted and the due time did not move; clear the hold, tick, and assert the run continues.

- [X] T063 [US6] Integration tests for credit holds in `tests/integration/standing-series/credit-hold.test.ts`: a held owner's series not claimed at all (nothing generated, no attempt, no failure, `next_run_at` unchanged, run left open, `counts.held === 1`) for both a project-owned and an install-owned credential; the hold clearing and the next tick continuing with no retry/reset/manual step; a mid-run billing refusal requeuing with no attempt and refreshing the hold on the owner actually used; and an unreadable stored key producing the existing fixed sentence with no credential text anywhere (depends on T045, T035) (US6 AS1–AS3, FR-050–FR-052, quickstart.md "SC-007")
- [X] T064 [US6] Integration tests for self-pause and the remaining edge cases in `tests/integration/standing-series/self-pause.test.ts` and `tests/integration/standing-series/edges.test.ts`: three consecutive zero-post closed runs pausing the series with `no_output` and one Resume action restoring it; all-accounts-removed recording `no_usable_target`; an archived voice profile recording `voice_profile_missing`; an account removed between runs recorded in `dropped_account_ids`; a cadence lowered mid-run not truncating the open run; an edit while a run is open changing nothing about that run; a too-short tick budget reporting `notRunnable = 1`; no text provider anywhere claiming no series with `notConfigured = 1` (depends on T041, T045) (US6 AS4–AS5, FR-053, edge cases, quickstart.md "self-pause and edge cases")
- [X] T065 [US6] Add `pruneClosedStandingSeriesRuns` (90-day retention, 200 per call, cascading positions/failures, never an open run) to `src/server/scheduler/housekeeping.ts`, with `standingSeriesRunsPruned` on `HousekeepingCounts`/`emptyHousekeepingCounts` (depends on T013) (**S39**, contracts/worker.md §6)
- [X] T066 [P] [US6] Integration test for housekeeping pruning in the existing housekeeping test file, covering the 90-day cutoff and the open-run exclusion (depends on T065)

**Checkpoint**: All six user stories are independently functional. SC-001–SC-012 are each covered by a runnable check.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Isolation, the security guard, documentation, and the final quality gates.

- [ ] T067 [P] Integration tests for isolation in `tests/integration/standing-series/isolation.test.ts`: two projects each with a due series, a pool, slots and accounts, driven by the same tick, with neither project's series/runs/positions/posts/assets/failures reachable from the other through any service function or the worker path, and a hand-built cross-project id returning `NotFoundError` (depends on T045) (SC-009)
- [ ] T068 [P] Confirm `tests/integration/scope-check.test.ts` picks up the three new tables automatically from `project-owned.ts` and passes with no edits needed (depends on T014) (FR-065)
- [ ] T069 [P] Confirm `tests/lint/db-import.test.ts` has no new raw-client import to catch (FR-065)
- [ ] T070 [P] Extend `tests/integration/security/secret-scan.test.ts` to run a standing series with a pool and a generated image, for all three roles, across `/jobs`, `/jobs/series/[seriesId]` and the worker's log lines, asserting no credential, provider error text or raw payload appears anywhere (depends on T043, T056, T059) (FR-026, quickstart.md "Guards, docs and the final pass")
- [ ] T071 [P] Add the "Standing series" section to `docs/generator.md`: what one is, cadence and period boundaries, no backfill, policy authorization, media sources and the media-required skip, idempotency and the per-tick bounds, the FR-045 concurrency sentence (`GENERATION_TICK_MAX_ITEMS + STANDING_SERIES_TICK_MAX_SERIES`), billing behaviour, self-pausing, and the limits (FR-045, FR-067)
- [ ] T072 [P] Append `## 061 — Standing content series` to `docs/decisions.md` with every decision **W1–W34** (spec) and **S1–S40** (plan) (FR-067)
- [ ] T073 [P] Confirm both `.env.example` blocks from T001 are present and `tests/lint/env-coverage.test.ts` is green (depends on T001, T031)
- [ ] T074 Run the full gate: `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build`, and fix anything that fails (depends on all prior tasks)
- [ ] T075 [HUMAN — needs a browser session signed in as an owner, `pnpm dev`, and real time passing (or a system clock moved past a local midnight); this cannot run inside a pipeline phase] Perform the real-app walkthrough in quickstart.md once: create a daily series with no media and review-required, tick the worker past the boundary, confirm the post appears in Review and the series shows its last/next run, pause and tick again to confirm nothing fires, resume and confirm the next due time is the coming boundary not the passed one, then delete the series and confirm the post is still in Posts. Record the outcome (pass, with specifics, or fail) directly against quickstart.md's "Done when" checklist. If this window closes (e.g. no browser session is ever made available) mark this task as unachievable with that reason, rather than leaving it open indefinitely — do not write it as a before/after comparison against any state this feature changes.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: T001 (Setup) feeds T031 only; everything else in Foundational can start immediately within its own dependency chain. Foundational **blocks** the DAL phase and every user story.
- **DAL (Phase 3)**: Depends on Foundational (schema, the shared refactors). Blocks every user story.
- **User Stories (Phase 4–7)**: All depend on the DAL. Phase 4 (US1/US2/US3) must land before Phase 5 (US4), Phase 6 (US5) and Phase 7 (US6), because each of those phases' tests exercise a producer (`runner.ts`) or a `manage`/`read` surface that Phase 4 creates. Within that constraint, US4/US5/US6 are independent of each other and may proceed in any order or in parallel.
- **Polish (Phase 8)**: Depends on all six user stories being complete.

### Within the Foundational Phase

- Pure modules (T002/T003, T004/T005, T006/T007) are independent of each other and of the schema.
- Schema (T008, T009, T010, T011, T012) → migration (T013) → `project-owned.ts` (T014).
- Shared refactors: T015 (budget) is independent; T016 (blocked-project resolution) depends only on existing code; T017 (media reservation) depends on T008 (the new tables exist to widen the predicate against); T018 → T019 → T020 is a chain; T021 depends on T010; T022 is independent; T023 → T024 is a chain.
- Authorization (T027) and env/config (T028 → T029 → T030, and T031) are independent of the schema and of each other.

### Within the DAL Phase

- T032 (repos) → T033 (wire into scope) and T034 (repo tests) in parallel.
- T035 (claim) depends on T016, T017, T032, T025 (from Foundational) → T036 (claim tests).

### Within Phase 4 (US1/US2/US3)

- `manage.ts` (T037) → `index.ts` (T038) and `read.ts` (T039) in parallel → `manage.test.ts` (T040).
- `run.ts` (T041) depends on the cadence module and the repos, independent of `manage.ts` → `run-lifecycle.test.ts` (T042).
- `runner.ts` (T043) and `media.ts` (T044) depend on T041 and the Foundational refactors; `runner.ts` calls into `media.ts`.
- The scheduler section (T045) depends on T043 and T035 → wiring into the tick (T046).
- All of T047–T053 (the test files) depend on T045/T046 and can run in parallel once the section exists.

### Parallel Opportunities

- All Setup tasks marked [P] (just T001).
- Within Foundational: the three pure-module pairs, the five schema files, and most of the shared refactors can each run in parallel within their group (see the table above for exact dependency edges).
- Within the DAL phase: T034 and T036 are the parallel test tasks once their implementation lands.
- Within Phase 4: T047–T053 (all test files) in parallel once T045/T046 land.
- US4 (Phase 5), US5 (Phase 6) and US6 (Phase 7) can be staffed in parallel once Phase 4's checkpoint is reached.
- Within Phase 6: T057 and T058 in parallel once T056 lands; T062 in parallel with T061.
- Within Phase 7: T064 independent of T063; T066 depends only on T065.
- Within Polish: T067–T073 in parallel; T074 is a sequential gate; T075 is the final, human-only step.

---

## Parallel Example: Foundational Phase pure modules

```bash
# Launch the three independent pure-module/schema groups together:
Task: "Create src/lib/series/cadence.ts and its unit tests"
Task: "Create src/lib/series/avoid.ts and its unit tests"
Task: "Create src/lib/validation/standing-series.ts and its unit tests"
```

## Parallel Example: Phase 4 test files once the producer exists

```bash
Task: "Cadence firing/not-firing tests in tests/integration/standing-series/cadence.test.ts"
Task: "Policy application tests in tests/integration/standing-series/policy.test.ts"
Task: "Idempotency tests in tests/integration/standing-series/idempotency.test.ts"
Task: "Slot exclusivity tests in tests/integration/standing-series/slots.test.ts"
Task: "Prompt/record parity tests in tests/integration/standing-series/parity.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1/2/3 together)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational — pure modules, schema, shared refactors, auth, config. **Blocks everything.**
3. Complete Phase 3: DAL — repos and the claim.
4. Complete Phase 4: US1 + US2 + US3 together (they cannot ship separately — see plan.md's own ordering rule).
5. **STOP and VALIDATE**: run quickstart.md's SC-001, SC-002, SC-003, SC-004, SC-005, SC-008, SC-009 checks; confirm a series fires on cadence, applies policy with no bypass, and never double-generates.

### Incremental Delivery

1. Setup + Foundational + DAL → foundation ready, nothing user-visible yet.
2. Add Phase 4 (US1/US2/US3) → test independently → this is the MVP: SC-001–SC-005, SC-008, SC-009.
3. Add US4 → SC-006 confirmed.
4. Add US5 → SC-010 confirmed; the series is now operable from the interface.
5. Add US6 → SC-007 confirmed; credit holds and self-pause need no new code beyond Phase 4's wiring.
6. Polish: isolation, secrets guard, docs, full gate, the one human-owned real-app walkthrough.

### Notes

- [P] tasks touch different files with no dependency on an incomplete task.
- Commit after each task or logical group, per this project's workflow guidance (the implement phase never auto-commits — leave nothing uncommitted).
- `pnpm db:check` must be green before any task depending on the schema (T014 onward) is considered complete.
- No test makes a live provider call (constitution II): text through a stub `LlmProvider`/`createFakeLlmFetch`, images through `setImageProviderForTests`, time through `clock.runAtTime`. No task in this list makes a live provider call except T075, which is explicitly human-owned and out of every pipeline phase's reach.
- SC-012 (a second occurrence rule costs nothing here) is a structural property of T041/T043 reading only the run's own `config`/`plan`/positions — no dedicated task writes new code for it; its check belongs with `dated-series`.
