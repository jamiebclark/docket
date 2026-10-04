# Tasks: Generation jobs, batch mode and item sources

**Input**: Design documents from `/specs/008-generation-jobs/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/{services,runner,ui}.md, quickstart.md

**Tests**: Requested. The spec's quality bar names job-item isolation, idempotency, policy honouring and no-duplicate tests, and quickstart.md maps them to files. Tests use Vitest against real Postgres and the fake LLM (`tests/helpers/fake-llm.ts`). **No live LLM calls.**

**Organization**: Grouped by user story. US1, US2 and US3 are P1; US4 and US5 are P2.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US5 from spec.md

## Execution notes (read first)

- Implementation runs headless: no browser, no dev server, no `curl`. UI is verified by Vitest component/server-render tests (`tests/integration/jobs/ui.test.tsx`), never by `pnpm dev`.
- Test DB: `docker start docket-pg` and `export DATABASE_URL=postgres://docket:docket@127.0.0.1:5433/docket_test` (quickstart §0). If the DB is unreachable, still write the tests, run `pnpm typecheck` and `pnpm lint`, and say so in the task note.
- Read `node_modules/next/dist/docs/01-app/` before UI tasks (AGENTS.md) and follow the `docket-ui` skill.
- Constitution III: no raw DB client outside `src/server/dal/`. Constitution VI: no new dependency (csv-parse is already installed).
- Existing tests `core.test.ts`, the prompt snapshot, and the single/series tests must stay green **unchanged**.

---

## Phase 1: Setup

- [x] T001 Confirm the baseline: run `pnpm vitest run src/server/services/generation tests/lint` and `pnpm typecheck` and record that they pass before changes (no file change).
- [x] T002 [P] Add `GENERATION_TICK_MAX_ITEMS` (integer 1–10, default 2) to Zod env validation in `src/server/env.ts`, document it in `.env.example`, and add accept/reject cases (1, 10 accepted; 0, 11 rejected) to `src/server/env.test.ts`.
- [x] T003 [P] Extend the fake LLM in `tests/helpers/fake-llm.ts` with a per-step `delayMs`, honouring `timeoutMs` and `signal` (reject with the timeout/abort error the real layer maps to `timeout`); add a case in its existing helper test if one exists.

---

## Phase 2: Foundational (blocks all stories)

**Purpose**: schema, DAL, pure modules and the generic core changes every story needs.

- [x] T004 Create `src/server/db/schema/jobs.ts` with enums `generation_job_status`, `generation_job_item_status`, `generation_job_item_error` and tables `generation_jobs`, `generation_job_items` exactly per data-model.md (composite FKs, CHECKs, partial unique index `generation_job_items_active_media_uq`, claim/recovery indexes); export from `src/server/db/schema/index.ts`.
- [x] T005 Add `generation_job_item_id` (composite FK to `generation_job_items(project_id,id)`) and partial unique index `posts_generation_job_item_uq` (live rows only) to `src/server/db/schema/posts.ts`.
- [x] T006 Register `generation_jobs` and `generation_job_items` in `src/server/db/project-owned.ts`.
- [x] T007 Generate the migration with `pnpm db:generate` (`drizzle/0005_*.sql` plus meta), review the SQL against data-model.md, then run `pnpm db:check`.
- [x] T008 Create `src/server/dal/jobs.ts` with `JobsRepo` (`insert`, `get`, `lockForUpdate`, `lockShared`, `list`, `countsFor`, `update`) and `JobItemsRepo` (`insertMany`, `get`, `listForJob`, `countByStatus`, `updateWithLease`, `retryFailed`, `cancelForJob`); wire as `scope.jobs` / `scope.jobItems` in `src/server/dal/scope.ts`.
- [x] T009 [P] Extend `src/server/dal/media.ts`: `list()` returns `reservedByJobId` and `unused` excludes reserved; add `listIdsForSelection`, `lockForReservation` (FOR NO KEY UPDATE, id order), `reservedAmong`, `usedAmong`. Surface `reservedByJobId` on `MediaView` in `src/server/services/media.ts`.
- [x] T010 [P] Extend `src/server/dal/posts.ts`: `insert` accepts `generationJobItemId`; add `findByJobItemId(itemId, { includeDeleted })`.
- [x] T011 [P] Create `src/lib/jobs/template.ts` (`PLACEHOLDER`, `placeholdersIn`, `unknownPlaceholders`, `renderTemplate` with `⟦ ⟧` marking and stripping, `JOB_RENDERED_INSTRUCTIONS_MAX`) with `src/lib/jobs/template.test.ts` covering every case in quickstart §1.
- [x] T012 [P] Create `src/lib/validation/jobs.ts`: `createJobSchema`, `mediaSelectionSchema`, `itemPayloadSchema` and limit constants (500 items, 2,000 template, 50,000 item data).
- [x] T013 [P] Update `src/lib/validation/generation.ts`: `mode` gains `"job_item"`, optional `job` link, `inputs.itemFields`, `inputs.instructions` max 10,000 (form schemas keep 2,000); confirm existing 007 records still parse.
- [x] T014 Add `runGenerationStep`, `PendingRetry`, `CoreStep`, `timeoutMs` and `itemData` to `src/server/services/generation/core.ts`; recompose `runGeneration` from steps with unchanged behaviour. Add `src/server/services/generation/core-step.test.ts` (deferred retry returns `{ok:"retry"}` after exactly 1 call; resume makes exactly 1 call and records both attempts; `timeoutMs` reaches `llm.generate`). `core.test.ts` must pass untouched.
- [x] T015 [P] Add the optional `itemData` section to `src/server/services/generation/prompt.ts` (byte-identical when `null`; fixed sentence that `⟦ ⟧` values are data); add a new snapshot in `prompt.test.ts` without changing the existing one.
- [x] T016 Extract `saveGeneratedPost` into new `src/server/services/generation/save.ts` and call it from `single.ts` and `series.ts` (behaviour unchanged, `createdByUserId` and `link` explicit). Existing single and series tests pass untouched.
- [x] T017 [P] Add `opts.guard` to `applyApprovalPolicy` in `src/server/services/generation/policy.ts` (runs inside the policy transaction right after `lockPost`; failure rolls back and propagates). Add a unit case; existing callers unchanged.
- [x] T018 [P] Make `regeneratePost` in `src/server/services/generation/regenerate.ts` pass `previous.inputs.itemFields` as `itemData`.
- [x] T019 Create `src/server/services/jobs/status.ts` (`refreshJobStatus`: pure derive plus locked write; sets `started_at`, `finished_at`, clears it when work resumes) with a unit test of the derivation table in data-model.md state transitions.
- [x] T020 [P] Add job and item factories, image helpers and a CSV builder to `tests/helpers/factories.ts`.
- [x] T021 Create `src/server/services/jobs/sources/types.ts` (`SourceItem`, `PreparedSource`, `ItemSource`) and `sources/index.ts` (`ITEM_SOURCES`, `sourceFor`, NotFoundError for unknown kind). Registry lines for media/csv are added in T025 and T040.
- [x] T022 Add a scope-registry check: confirm `generation_jobs` and `generation_job_items` are exercised by the existing scope-enforcement test (`pnpm vitest run tests/lint tests/integration -t scope`) and fix any gap.

**Checkpoint**: `pnpm typecheck`, `pnpm db:check` and the existing generation tests pass.

---

## Phase 3: User Story 1 — One post per image from the media library (P1) 🎯 MVP

**Goal**: create a media job (no model call while waiting) and have ticks process it into posts.

**Independent Test**: four images (one used), fake model, job from `unused` → 3 items, `fake.requests.length === 0` at creation; ticks run to completion → 3 posts with image, targets, job metadata and pinned voice version; job `completed`; images used.

### Tests (write first, expect failure)

- [x] T023 [P] [US1] `tests/integration/jobs/create.test.ts`: US1 setup, pick/filter/`includeUsed`, limits (501 refused), empty-selection messages, not-configured refusal, editor auto-approve refusal, unconfirmed unreviewed-queue refusal, pinned voice version stored, creation under 3 s with 100 images (quickstart §2).
- [x] T024 [P] [US1] `tests/integration/jobs/processing.test.ts`: tick-to-completion test, ≤ `jobMaxItems` per tick, pinned version after a mid-job profile edit, template substitution `⟦cats, sunset⟧` plus `<item_data>`, edge cases (soft-deleted image, removed target, no targets, archived profile, deleted creator) (quickstart §3).

### Implementation

- [x] T025 [US1] Implement the media source in `src/server/services/jobs/sources/media.ts` (pick/filter/unused, 500 cap, drop deleted/used, fields `alt_text|tags|filename`, labels, brief, summary) and register it in `sources/index.ts`.
- [x] T026 [US1] Implement `createJob`, `previewJob`, `insertItems` in `src/server/services/jobs/create.ts` per contracts/services.md steps 1–10 (reuse `resolvePolicies`, `takeVoice`, `loadAccounts`, `assertMediaFits`; lock + re-check + insert in one transaction; one retry on unique violation then `ConflictError`).
- [x] T027 [P] [US1] Implement `listJobs`, `getJob`, `listJobItems` in `src/server/services/jobs/read.ts` and the public surface in `src/server/services/jobs/index.ts`.
- [x] T028 [US1] Create `src/server/dal/job-claims.ts`: `claimDueJobItems` (SKIP LOCKED, rotation by `last_claimed_at`, the four claim decisions in contracts/runner.md, `refreshJobStatus` per touched job) and `forJobRunner`; export from `scope.ts`.
- [x] T029 [US1] Implement `processClaimedItem` in `src/server/services/jobs/runner.ts` per contracts/runner.md: finish/run paths, image prep with `withinBudget`, step API with deadline-capped window, SAVE transaction with job lock and lease check, FINISH with policy guard, RETRY_LATER/FAIL/RELEASE, fixed error sentences, per-item log line through `redact()`.
- [x] T030 [US1] Create `src/server/scheduler/generation.ts` (`runGenerationJobs`, `GenerationCounts`, not-configured and not-runnable handling) and add the third `generation` section plus heartbeat to `src/server/scheduler/index.ts`; extend `config.ts` (`jobMaxItems`, `jobMinCallMs`, `jobPersistReserveMs`, `jobMaxAttempts`, backoff, overridable via `runTick({config})`) and the summary line in `loop.ts`.
- [x] T031 [P] [US1] Bundle the LLM layer and job runner in the worker: update `src/worker.ts` (one log line when generation is not configured), `src/server/startup/index.ts` (log when the budget cannot fit a job item), and the `build:worker` expectations; rewrite `tests/lint/generation-imports.test.ts` to assert the worker includes the job runner and imports no `next/*` (keep `worker-bundle.test.ts` green: `sharp` stays external).
- [x] T032 [US1] Run T023 and T024 until green.

**Checkpoint**: a media job created via service functions runs to completion through `runTick()`.

---

## Phase 4: User Story 2 — Independent, retryable, never duplicated items (P1)

**Goal**: one item's failure never fails the job; retries and recovery never duplicate posts.

**Independent Test**: item 2 of 5 fails → others have posts, job `completed_with_failures`; retry yields exactly one post; killed-tick recovery yields one post.

- [x] T033 [P] [US2] `tests/integration/jobs/isolation.test.ts`: item 2 of 5 refused, unexpected exception recorded as `internal` while the sibling finishes, temporary failures back off 60 s then 120 s and fail at 3 attempts, lasting failures fail at once (quickstart §4).
- [x] T034 [P] [US2] `tests/integration/jobs/idempotency.test.ts`: retry gives exactly 1 post, second retry says "Only failed items can be retried.", retry on a cancelled job refused, concurrent `runTick()` pairs never double-process, second live post for one item raises `23505`.
- [x] T035 [P] [US2] `tests/integration/jobs/recovery.test.ts`: killed before save, killed after save before policy (no model call, policy applied, item `done`), three interruptions fail with "Generation was interrupted too many times.", live lease never recovered; unit assertion that min lease (60 s) > max budget (25 s) + reserve.
- [x] T036 [US2] Implement `retryItem` and `retryFailedItems` in `src/server/services/jobs/manage.ts` (job lock first, messages per contracts/services.md); export from `index.ts`.
- [x] T037 [US2] Fix any runner/claim gaps the T033–T035 tests expose (lease checks, internal-error catch per item, finish-without-model-call), then run them until green.

**Checkpoint**: SC-003 and SC-004 hold under test.

---

## Phase 5: User Story 3 — "All unused images" never duplicates, even across jobs (P1)

**Goal**: the reservation guarantees disjoint jobs; cancel releases images; the library reflects reservation.

**Independent Test**: ten unused images, two concurrent `unused` jobs × 25 runs → every image in exactly one job.

- [x] T038 [P] [US3] `tests/integration/jobs/reservation.test.ts`: concurrent creation ×25 on fresh images (each image in exactly one job; loser with nothing refused with "No unused images left to generate for"), reserved image absent from `unused` and carries `reservedByJobId`, reserved images skipped and counted on `pick`, cancel releases images and a third job picks them up.
- [x] T039 [US3] Implement `cancelJob` in `src/server/services/jobs/manage.ts` (job lock, queued/failed/running-without-post → `cancelled`, images released, status `cancelled`, idempotent messages) and make the runner's SAVE and policy guard honour cancellation; run T038 until green.
- [x] T040 [P] [US3] Media library UI: add a checkbox slot and "In a job" badge (linking to `/jobs/[jobId]`) to `src/components/media/MediaCard.tsx`; add `src/app/p/[projectSlug]/media/MediaSelection.tsx` (client; selection bar "Generate posts for {n} selected", "Clear selection"); update `media/page.tsx` with the filter link and **"Generate for all unused images ({n})"** (disabled "No unused images to generate for" at 0), gated on `generation: run`.

**Checkpoint**: SC-002 holds; Story 3 scenarios 1–6 covered.

---

## Phase 6: User Story 4 — One post per CSV row (P2)

**Goal**: CSV upload validated before any job exists; columns usable in the template.

**Independent Test**: valid 3-row CSV → 3 posts with each row's values; each invalid file refused with a specific message; unknown column refused.

- [x] T041 [P] [US4] `src/server/services/jobs/sources/csv.test.ts`: one case per rule in research D17 (BOM, 1 MB + 1, invalid UTF-8, unclosed quote with line number, empty/duplicate/unusable column, long row, short rows padded, comma-only rows skipped, 0 and 501 rows, multiple problems listed, 500 rows parse under 2 s).
- [x] T042 [US4] Implement `parseJobCsv` (pure, csv-parse/sync, `TextDecoder` fatal) and the CSV source in `src/server/services/jobs/sources/csv.ts`; register it in `sources/index.ts`; throw `ValidationIssuesError` with `Line {n}:` messages.
- [x] T043 [US4] Extend `create.test.ts` and `processing.test.ts` with CSV cases: "Unknown column: missing. Available: …" with no job row, 3-row job yields 3 posts with row values, "ignore previous instructions" appears only inside `⟦ ⟧` and `<item_data>`, empty-value rows, rendered-instructions limit.

---

## Phase 7: User Story 5 — Progress, cancel and policies (P2)

**Goal**: Jobs list and job page with live counts, retry/cancel controls; the policy matrix honoured.

**Independent Test**: one job per policy combination including an invalid-output item; cancel mid-run saves no post.

- [x] T045 [P] [US5] `tests/integration/jobs/policy.test.ts`: the four-combination matrix (SC-005) including an Instagram text-only item that must land in review and unscheduled under every policy; no-slots case (approved, target unscheduled, item `done`); slots taken in item order.
- [x] T046 [P] [US5] `tests/integration/jobs/cancel.test.ts`: cancel mid-run with a blocked fake model (running item saves no post, ends `cancelled`, queued/failed cancelled, done kept, job `cancelled`, no later post — SC-007); cancel between save and policy leaves the post in review; double cancel and cancel-after-complete change nothing.
- [x] T047 [P] [US5] `tests/integration/jobs/fairness.test.ts`: a 20-item job and a later 2-item job with `jobMaxItems: 2`; the second finishes within 2 ticks.
- [x] T048 [P] [US5] `tests/integration/jobs/budget.test.ts`: with `timeBudgetMs 4000, jobMinCallMs 1000, jobPersistReserveMs 500` a 6 s fake is cut off, tick ends within 4,500 ms, correction retry deferred (`counts.deferred === 1`, attempts unchanged), next tick makes exactly 1 more call; not-configured leaves items `queued` with `notConfigured: 1`.
- [x] T049 [P] [US5] `tests/integration/jobs/no-secrets.test.ts`: extend 007's no-secrets check to job item rows, log lines and prompt records.
- [x] T050 [US5] Add `src/components/ui/AutoRefresh.tsx` (client, `router.refresh()` while `active`, 5 s) and job/item statuses to `src/components/ui/StatusBadge.tsx`.
- [x] T051 [US5] Jobs list: `src/app/p/[projectSlug]/jobs/page.tsx` + `loading.tsx` per contracts/ui.md (table, pagination 50, empty/not-configured states, unreviewed-queue label); delete the `src/app/p/[projectSlug]/[section]/page.tsx` placeholder and update `tests/lint/section-placeholders.test.ts`.
- [x] T052 [US5] Shared job form: `src/app/p/[projectSlug]/jobs/new/page.tsx`, `loading.tsx`, `JobForm.tsx` (source summary, voice, template with field chips and marked preview, targets with Instagram warning, existing `PolicyPicker` with confirmed unreviewed-queue option, "Start job ({n} items)"), and `createJobAction` in `jobs/actions.ts`.
- [x] T044 [US4] (moved after T052: needs `JobForm.tsx` from T052) `src/app/p/[projectSlug]/jobs/new/csv/page.tsx` and `CsvJobForm.tsx` (file input, problem list "This file can't be used:", row/column summary, first-five-rows table, then shared `JobForm`), and `validateCsvAction` in `jobs/actions.ts` (size checked before reading body). — PARTIAL: validateCsvAction, CsvJobForm (takes the shared form as a render-prop child) and csv/page.tsx are written; rendering shared `JobForm` inside it is owed to T052, which creates JobForm.
- [x] T053 [US5] Job page: `jobs/[jobId]/page.tsx`, `loading.tsx`, `JobItemsTable.tsx`, `CancelJobDialog.tsx`, `RetryButtons.tsx`, plus `retryItemAction`, `retryFailedAction`, `cancelJobAction`; counts `LiveRegion`, `AutoRefresh active` only while queued/running, notices for not-configured and not-runnable.
- [x] T054 [US5] `tests/integration/jobs/ui.test.tsx` (server-rendering as in `accounts-ui.test.ts`): Jobs list empty/populated/not-configured, job page counts and item rows with post links and review state, Retry on failed rows, cancel dialog naming the job, `AutoRefresh` active only while queued/running, media page "Generate for all unused images (n)" with disabled state at 0 and "In a job" badge, CSV form problem list with line numbers.
- [x] T055 [US5] Add rows to `tests/integration/actions-authz.test.ts` (editor can create/retry/cancel and cannot auto-approve unless default; non-member gets not-found for every action).
- [x] T056 [US5] Run T045–T049, T054, T055 until green; fix runner/policy gaps found.

---

## Phase 8: Polish and cross-cutting

- [X] T057 [P] Add the jobs report to `scripts/llm-check.ts` (+ test): without a key print `latency: unmeasured; live path verified with mocks only` and exit 0; with a key print the `job_call` and `jobs budget_ms=…` lines.
- [ ] T058 🛑 BLOCKED: needs a real LLM API key — run `pnpm llm:check` once with a key configured and copy its output into the 008 entry of `docs/decisions.md` (FR-031). Without a key, T057's "unmeasured" line is the recorded result.
- [X] T059 [P] Docs: Jobs section in `docs/generator.md` (throughput ≈120 items/hour at defaults, limits), README Jobs section, and 008 entries in `docs/decisions.md` for D1–D28 changes (including "series stays in-request", each generic change with how to reverse it).
- [X] T060 Final gates, once: `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build` all exit 0; record any failure verbatim instead of marking done. (First full-suite run had 3 load-induced timeouts — instagram/limits, jobs/processing, scheduler/concurrency — all passing alone and in a clean second full run; lint 0 errors, typecheck, db:check, build exit 0.)

---

## Dependencies and order

- Phase 1 → Phase 2 (blocks everything) → US1 (MVP) → US2 → US3 → US4 → US5 → Polish.
- US2 depends on the US1 runner; US3 `cancelJob` (T039) is reused by US5; US4 reuses `createJob`; US5 screens reuse services from US1–US3 and the media UI from US3.
- Within Phase 2: T004→T005→T006→T007; T008 needs T004–T005; T014 before T029; T016 before T029; T017 before T029; T019 before T026/T028.
- Tests inside each story are written before their implementation tasks.

## Parallel opportunities

- Phase 1: T002, T003.
- Phase 2: T009, T010, T011, T012, T013, T015, T017, T018, T020 after the schema tasks.
- US2 tests T033–T035 together; US5 tests T045–T049 together; T040 and T044 are independent UI files.

## Implementation strategy

1. MVP = Phases 1–3 (US1): media job → tick → posts.
2. Add US2 and US3 (both P1) before any UI beyond the media actions: they carry the safety guarantees.
3. Then CSV (US4) and screens/policies (US5), then docs and final gates.

---

## Phase 9: Review remediation

- [ ] T061 Commit the existing 008 work before any fix, in small Conventional Commits grouped by layer and story: schema plus migration, DAL, services, scheduler and worker, UI, tests, docs, and spec artifacts including `tasks.md` and `review.md`. Stage explicit paths only (never `git add -A`, `git add .` or `git commit -a`), and end each message with the Co-Authored-By trailer. Delete the stray `specs/008-generation-jobs/tasks.md-E`; do not commit it — review F5 (MAJOR), .specify/memory/constitution.md:84
- [ ] T062 Add a "Generate posts for these {n} images" action to the media library when a tag, missing-alt or search filter is active. Link it to `/p/{slug}/jobs/new?mode=filter&…` with the filter carried over, gate it on `generation: run`, and add a case in `tests/integration/jobs/ui.test.tsx` — review F1 (MAJOR), src/app/p/[projectSlug]/media/page.tsx:90
- [ ] T063 Make filter-mode selections count and report already-used images. List the matched ids including used ones, and let `sources/media.ts` drop and count them as pick mode does, so the job form shows "N already used … left out" and the "Include images already used in posts" toggle. Add a create/preview test for filter + `includeUsed: false` that expects `already_used: 1` — review F2 (MAJOR), src/server/dal/media.ts:185
- [ ] T064 Make `cancelJob` finish items that already have a post instead of skipping them: set status `done`, clear the lease, set `finished_at`, and leave the post in review. No item of a cancelled job may stay `running` or `queued`. Extend the save-then-cancel case in `tests/integration/jobs/cancel.test.ts` to assert that the item ends `done` and the counts show `running: 0` — review F3 (MAJOR), src/server/dal/jobs.ts:216
- [ ] T065 Fix the docs per FR-032. In `docs/generator.md`, replace the stale "Background jobs, batch mode … out of scope" line and add to the Jobs section: the media field names, the CSV header rules, retry and cancel behaviour, and the media reservation rule. Append the missing 008 judgement calls and generic changes listed in review F4 to `docs/decisions.md`, each with how to reverse it — review F4 (MAJOR), docs/generator.md:54
