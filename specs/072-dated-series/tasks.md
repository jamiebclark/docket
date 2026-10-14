---

description: "Task list for date-pegged series — content that fires on an anniversary, from a spreadsheet"
---

# Tasks: Date-pegged series — content that fires on an anniversary, from a spreadsheet

**Input**: Design documents from `/specs/072-dated-series/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/services.md, contracts/worker.md, contracts/ui.md, contracts/verified.md, quickstart.md

**Tests**: Requested by the spec's own test list and included below, following quickstart.md's mapping to success criteria.

**Organization**: Tasks are grouped by user story. The Foundational phase (pure module, parser split, schemas, schema/migration, DAL, the shared `queueFloor` helper) and the claim/worker-infra phase are blocking prerequisites the plan calls out — no user story work can begin until both are complete. US1, US2 and US3 are all P1; US1 (firing) is built first because US2 (import) and US3 (edge-case tests) both exercise it, exactly as `071`'s plan ordered its three P1 stories by dependency rather than by label.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1–US6, mapping to spec.md's priorities (US1/US2/US3/US5 = P1, US4/US6 = P2)
- File paths are exact; contract/data-model section references are inline for traceability

---

## Phase 1: Setup

No setup tasks. This entry adds no runtime dependency and no environment variable (FR-005, Technical
Context); `.env.example` and `package.json` are untouched.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The pure dated module, the extended CSV parser, the validation schemas, the schema and
migration, the two new DAL repos plus the extended ones, the shared date-formatting and `queueFloor`
helpers. Nothing in a user-story phase re-derives what belongs here.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete. `src/server/services/jobs/sources/csv.test.ts` must pass with **no edit at all** at the end of this phase — that is the proof of FR-020, checked here where it is cheapest to discover a regression.

### Pure module (no database)

- [X] T001 [P] Create `src/lib/series/dated.ts`: `DATED_ROWS_MAX`, `DATED_ROWS_PER_DATE_MAX`, `LEAD_DAYS_MIN`/`MAX`, `RESERVED_COLUMNS`, `DatedSpec`, `DateParseError`, `parseDatedValue`, `isReservedColumn`, `targetDateFor`, `nextTargetDate`, `isEligible`, `dueInstant`, `windowEnd`, `localToday`, `upcoming` — no database, no `Date.now()`, reusing `periodStartInstant` from `./cadence` (contracts/services.md §1, B7)
- [X] T002 [P] Unit tests for `dated.ts` in `src/lib/series/dated.test.ts` per the required test list in contracts/services.md §1: `parseDatedValue`'s accept/reject sets, `targetDateFor`'s leap rule (never `03-01`), `nextTargetDate`'s rollover/past-year/today-is-inside-window cases, `isEligible` agreeing with `dueInstant <= now < windowEnd` across both DST transitions in `America/New_York` and `Pacific/Auckland` for `leadDays` 0/1/30, `dueInstant`'s disambiguation including `Australia/Lord_Howe` and `Asia/Kathmandu`, and `upcoming`'s ordering (depends on T001)

### The parser, extended not duplicated (B1)

- [X] T003 Extract `parseCsvFile(bytes)` as the tagged core of `src/server/services/jobs/sources/csv.ts` per contracts/services.md §2: every problem carries `scope: "file" | "row"` in today's push order (header problems, then row problems, then the over-500 count); rewrite `parseJobCsv` as the four-line wrapper in the contract
- [X] T004 [P] Confirm `src/server/services/jobs/sources/csv.test.ts` passes with no edit (FR-020's proof); add `src/server/services/jobs/sources/csv-file.test.ts` asserting the file/row tagging table in contracts/services.md §2 against every problem class (depends on T003)

### Validation schemas

- [X] T005 [P] Create `src/lib/validation/dated-rows.ts`: `DATED_KEY_VALUE_MAX`, `IMPORT_PROBLEMS_MAX`, `datedRowInputSchema`, `importDatedListSchema`, `importProblemSchema`, `importRecordSchema` per contracts/services.md §3
- [X] T006 [P] Extend `src/lib/validation/standing-series.ts`: `OCCURRENCE_RULES`, `occurrenceRule`/nullish `cadence`/`leadDays` on create and update schemas with the three `superRefine` rules in contracts/services.md §3; `standingSeriesRunConfigSchema` gains `rule`/`leadDays`/nullable `cadence` while staying `v: 1` (B33); add `datedPositionSchema` per data-model.md §5
- [X] T007 [P] Unit tests for T005/T006 in `src/lib/validation/dated-rows.test.ts` and the extended `standing-series.test.ts`: each `superRefine` message, an old cadence-only config (no `rule`/`leadDays`) still parsing under `standingSeriesRunConfigSchema`, and `datedPositionSchema`'s shape (depends on T005, T006)

### Schema and migration

- [X] T008 [P] Add `standing_series_occurrence_rule` and `standing_series_occurrence_outcome` enums, and `ALTER TYPE … ADD VALUE 'date'` / `'missed'` (each its own statement, unused in the same transaction) to `src/server/db/schema/standing-series.ts` per data-model.md §1
- [X] T009 [P] Add `occurrence_rule`, `lead_days`, `list_version`, `last_import_at`/`filename`/`row_count`/`problems` columns and the four tying CHECKs; drop `NOT NULL` on `cadence_count`/`cadence_period`/`next_run_at` with their paired CHECKs, on `standing_series` in the same file per data-model.md §2 (depends on T008)
- [X] T010 [P] Create `standing_series_dated_rows` (every column, the identity unique index, the month/day/leap CHECKs, the due and list indexes) per data-model.md §3 (depends on T008)
- [X] T011 [P] Create `standing_series_occurrences` (every column, `unique(row_id, year)`, the four CHECKs, the three indexes) per data-model.md §4 (depends on T008, T010)
- [X] T012 [P] Add the `dated` jsonb column and its CHECK to `standing_series_positions`, and the `period <> 'date' OR plan IS NULL` CHECK to `standing_series_runs`, per data-model.md §5–6 (depends on T008)
- [X] T013 [P] Add `queue_not_before timestamptz` (nullable) to `posts` in `src/server/db/schema/posts.ts` per data-model.md §7
- [X] T014 Generate the Drizzle migration for T008–T013 with `pnpm db:generate`, commit the SQL under `drizzle/`, and confirm `pnpm db:check` is green (depends on T008, T009, T010, T011, T012, T013)
- [X] T015 [P] Add `standing_series_dated_rows` and `standing_series_occurrences` (each keyed on `project_id`) to `src/server/db/project-owned.ts` (depends on T010, T011, T014)

### Shared formatting and components

- [X] T016 [P] Add `formatLocalDate` and `formatMonthDay` exports to `src/lib/time/format.ts` (B30); confirm `tests/lint/date-format.test.ts` needs no new allowlist entry
- [X] T017 [P] Unit tests for `formatLocalDate`/`formatMonthDay` in `src/lib/time/format.test.ts` (depends on T016)
- [X] T018 [P] Create `src/components/ui/LocalDate.tsx`: a `<time dateTime="YYYY-MM-DD">` wrapper with no tooltip, mirroring `LocalTime` (contracts/ui.md §2) (depends on T016)
- [X] T019 [P] Move `CsvProblemList` from `src/app/p/[projectSlug]/jobs/new/csv/CsvJobForm.tsx` to `src/components/ui/CsvProblemList.tsx` (B32); update the CSV job form's import

### DAL

- [X] T020 Create `src/server/dal/standing-series-dated.ts`: `DatedRowsRepo` and `DatedOccurrencesRepo` exactly as specified in contracts/services.md §4 (depends on T010, T011, T014)
- [X] T021 [P] Register `scope.datedRows` and `scope.datedOccurrences` on `ProjectScope` in `src/server/dal/scope.ts`, with **no** `KEY_GRANTS` entry (A38, FR-049) (depends on T020)
- [X] T022 [P] Add `MediaRepo.findLiveByFilenames(names)` to `src/server/dal/media.ts` — one query, live rows, every kind (B23)
- [X] T023 [P] Add `StandingSeriesRepo.bumpListVersion(id, expected)` and widen `StandingSeriesPatch` (`occurrenceRule`, `leadDays`, the four `lastImport*` fields, `listVersion`, `nextRunAt: Date | null`) in `src/server/dal/standing-series.ts` (B21) (depends on T009)
- [X] T024 [P] Add `queueNotBefore` to `PostsRepo`'s patch type in `src/server/dal/posts.ts` (depends on T013)
- [X] T025 [P] Integration tests for the new/extended DAL in `tests/integration/standing-series/dated-dal.test.ts`: `insertMany`'s identity-index throw, `advance`'s forward-only guard (`false` on a stale `from`), `firedYears`, `findLiveByFilenames` classifying none/one/more-than-one/video, and `bumpListVersion`'s conflict path (depends on T020, T022, T023)

### The queue floor (shared by the producer and the review path)

- [X] T026 Add `queueFloor(post, now)` to `src/server/services/posts/index.ts` and read it at the three `allocateNextFree` floor call sites (`queueTargetsInTx`, `moveToNextFreeSlot`, `pullForwardBody`) per contracts/services.md §12 (B13) (depends on T024)
- [X] T027 [P] Unit tests for `queueFloor` in `src/server/services/posts/index.test.ts`: `NULL` → `now`, a past floor → `now`, a future floor → the floor; confirm the three existing call sites' tests stay green with every existing post's `NULL` floor (depends on T026)

**Checkpoint**: Run `pnpm vitest run src/server/services/jobs/sources/csv.test.ts tests/integration/standing-series` now and confirm it is still green (SC-011's proof point, checked before anything builds on this phase).

---

## Phase 3: Claim and worker infrastructure

**Purpose**: The scheduler's claim predicate and the tick counts a dated series needs to be claimed and
retired at all. Every user story's producer path depends on this; it carries no story label of its own,
exactly as `071`'s claim phase did not.

- [X] T028 Add the dated-row `OR` branch and the `projects` join to `claimDueStandingSeries` in `src/server/dal/standing-series-claims.ts`, with the explicit `next_run_at ASC NULLS LAST` ordering, per contracts/worker.md §2 (B8) (depends on T010, T023)
- [X] T029 [P] Integration tests for the claim predicate in `tests/integration/standing-series/claim.test.ts` (extended): a dated series claimed while its window is open or already past; `NULLS LAST` ordering a dated series behind a same-tick due cadence series without starving it; a credit-held dated series excluded entirely (depends on T028)
- [X] T030 [P] Add `missed` and `retired` fields to `StandingSeriesCounts`/`emptyStandingSeriesCounts()`, print them in `src/server/scheduler/loop.ts`'s tick summary and the `standing_series` heartbeat (B34)
- [X] T031 [P] Add `pruneSettledOccurrencesBefore(before, limit)` to `src/server/scheduler/housekeeping.ts` (the same 90-day horizon and limit as the run prune; a pending occurrence is never matched) and `standingSeriesOccurrencesPruned` to `HousekeepingCounts` (B27) (depends on T011)
- [X] T032 [P] Integration test for occurrence pruning in the existing housekeeping test file: the 90-day cutoff and the pending-occurrence exclusion (depends on T031)

**Checkpoint**: Foundational and claim/worker infrastructure complete. User-story work can now begin.

---

## Phase 4: User Story 1 - A brand's birthday list posts itself all year (Priority: P1) 🎯 MVP

**Goal**: A dated series, once a list exists, fires exactly one post per due row on its own date, every
year, through the identical generation/policy/media path a cadence series uses.

**Independent Test**: Import a list, advance the clock to one row's date, run the worker, and find one
post for that row with the row's data rendered into it; advance to the next row's date and find the next
post; advance a year and find the first row producing again.

- [X] T033 [US1] Create `src/server/services/standing-series/dated-due.ts`: `evaluateDatedSeries(scope, series, now)` — `MISSED_SWEEP_LIMIT = 50`, `MISSED_RECORD_WINDOW_DAYS = 30`, the retire/record-miss/advance algorithm in contracts/services.md §5 (B24, B25, B26) (depends on T001, T020)
- [X] T034 [US1] Extend `src/server/services/standing-series/manage.ts`: `createStandingSeries` stores `occurrenceRule`/`leadDays`, leaves `cadenceCount`/`cadencePeriod`/`nextRunAt` NULL for a dated series with `template_fields` starting empty; `updateStandingSeries` refuses an `occurrenceRule` change (A2, FR-002) and validates `leadDays`/cadence per branch; `resumeStandingSeries` for a dated series sets `nextRunAt` NULL then calls `evaluateDatedSeries` (A34, FR-043) — per contracts/services.md §8 (depends on T006, T033)
- [X] T035 [US1] Extend `src/server/services/standing-series/run.ts`'s `openOrResumeRun` with the dated branch (evaluate → resume/close-stale/no-run/open with one occurrence per due row inside the run transaction) and extend `closeRun` to settle a `queued`/`running` position `'missed'` when a dated run's window has closed, per contracts/services.md §10 (B9, B15, B17) (depends on T033, T020)
- [X] T036 [US1] Extend `src/server/services/standing-series/runner.ts`'s three-line fork: the plan gate reads `config.rule`, `seriesField` is `null` for a dated run, instructions render `position.dated.values` through `renderTemplate` at the single call site (including the failure-record path), `queueNotBefore` is passed to `saveGeneratedPost`, and the matching occurrence is settled wherever a position reaches `produced`/`failed`/`skipped` — per contracts/services.md §11 (B9, B10, B13) (depends on T026, T035)
- [X] T037 [US1] Extend `src/server/services/standing-series/media.ts`'s `resolvePositionMedia` with the dated-row-asset prefix (scoped `getMany`, `imagesForModel`, no `claimMedia`/`markUsed`) per contracts/services.md §11 (B12) (depends on T022)
- [X] T038 [US1] Extend `src/server/services/standing-series/read.ts`: `occurrenceRule`/`leadDays`/`upcoming`/first-page `rows`/`lastImport`/`templateFields` on `StandingSeriesDetail`, `nextRunAt: Date | null`, `periodStart` on `StandingSeriesRun`, `counts.missed`, `DATED_ROWS_PAGE_SIZE = 50`, `mediaMissing` per contracts/services.md §9 (depends on T020, T033)
- [X] T039 [US1] Extend `src/app/p/[projectSlug]/jobs/series/StandingSeriesForm.tsx`: the occurrence-rule `SegmentedControl` (create-only; a read-only line plus A2's sentence on edit), the conditional cadence/lead-time fields, the dated-series instructions help text, per contracts/ui.md §4 (depends on T034)
- [X] T040 [US1] Extend `src/app/p/[projectSlug]/jobs/series/[seriesId]/page.tsx` and its "What it is" card: the Occurrence/Lead-time rows, the Upcoming dates `Card` (3-column `Table`, `EmptyState` "No upcoming dates…"), and the run-history Period cell showing `LocalDate` + "Dated list" for `period = 'date'`, per contracts/ui.md §3.1, §3.5, §3.6 (depends on T038, T018)
- [X] T041 [US1] Integration tests for due resolution and firing in `tests/integration/dated-series/due.test.ts`: US1 AS1–AS6 — one post per fired row with the row's data rendered, no second post the next day, a new post the following year, nothing produced before the due date with the right "next due" shown, a year-specific row never firing again and shown as past, a named portrait's post carrying it unreserved and reused the next year (depends on T036, T037, T040)
- [X] T042 [P] [US1] Integration test for the simulated-year walk (SC-002) in the same file: a pinned clock walked day by day across the fixture, asserting exactly one post per every-year row per year and exactly one total for the year-specific row, zero duplicates (depends on T041)

**Checkpoint**: US1 complete — a dated series fires, once per row per year, through the identical generation/policy/media path. SC-001 (engine half) and SC-002 are covered.

---

## Phase 5: User Story 2 - A messy spreadsheet imports what it can and says what it could not (Priority: P1)

**Goal**: A real spreadsheet with bad rows imports what it can, reports what it could not with line
numbers, and the report survives a reload.

**Independent Test**: Import a file with each class of bad row and assert the stored rows, the reported
problems with their line numbers, and that the problems survive a reload.

- [X] T043 [US2] Create `src/server/services/standing-series/dated-import.ts`: `importDatedList` per contracts/services.md §6's nine-step order (parse → header/key-column resolution → unknown-placeholder refusal → `findLiveByFilenames` → per-row validation producing the exact messages in the table → the `list_version`-guarded replace transaction → audit row) (depends on T003, T005, T020, T022, T023)
- [X] T044 [US2] Create `src/server/services/standing-series/dated-rows.ts`: `addDatedRow`, `updateDatedRow`, `deleteDatedRow` — the same validation and messages as an import, with `line: null` and the field name, the `list_version` guard, cascaded occurrences on delete, per contracts/services.md §7 (depends on T020, T005)
- [X] T045 [US2] Extend `manage.ts`'s template-placeholder check so a dated series' edit is checked against `series.templateFields`, not `[]` (FR-027) (depends on T034)
- [X] T046 [US2] Add the four server actions (`importDatedListAction`, `addDatedRowAction`, `updateDatedRowAction`, `deleteDatedRowAction`) to `src/app/p/[projectSlug]/jobs/series/actions.ts` per contracts/ui.md §5 (depends on T043, T044)
- [X] T047 [US2] Create `src/app/p/[projectSlug]/jobs/series/DatedListImport.tsx`: the file input, the replace-confirmation `Dialog`, and the pending/refusal/success states per contracts/ui.md §6 (depends on T046)
- [X] T048 [P] [US2] Create `src/app/p/[projectSlug]/jobs/series/DatedRowDialog.tsx` and `DatedRowActions.tsx`: an add/edit dialog with one field per `templateFields` column plus Date/Image, and Edit/Delete with a row-naming confirmation `Dialog`, per contracts/ui.md §7 (depends on T046)
- [X] T049 [US2] Extend `[seriesId]/page.tsx` with the Last import `Alert` + `CsvProblemList`, the five-column Rows `Table` (paginated via `?rows=N`), and the Import / Add-a-row controls, per contracts/ui.md §3.2–3.4 (depends on T047, T048, T019, T038)
- [X] T050 [US2] Integration tests for import validation in `tests/integration/dated-series/import.test.ts`: every row-level problem class with its exact message and line number, every whole-file refusal leaving the list untouched, and the missing-template-column refusal (US2 AS1–AS2, AS4; FR-021–FR-023) (depends on T043)
- [X] T051 [P] [US2] Integration tests for re-import in `tests/integration/dated-series/reimport.test.ts`: an unchanged re-import keeping fire history and firing nothing twice, and one with a row removed and one added updating the stored set and history correctly while leaving every produced post (US2 AS5–AS6, FR-024, FR-025) (depends on T043)
- [X] T052 [P] [US2] Integration tests for row CRUD in `tests/integration/dated-series/rows.test.ts`: add/edit/delete under the same validation and messages, the per-date cap and 500-row cap enforced under `list_version`, delete cascading occurrences and leaving posts (depends on T044)
- [X] T053 [US2] Integration/UI tests in `tests/integration/dated-series/ui.test.tsx` covering the import flow and the last-import survival across a fresh server render (US2 AS3), the rows table's five columns/caption/`th scope`/pagination, and the empty states naming what to upload (depends on T049)

**Checkpoint**: US2 complete — SC-001 (import half) and SC-005 are covered.

---

## Phase 6: User Story 3 - Dates behave at the edges (Priority: P1)

**Goal**: Time zones, DST, leap years, missed windows and shared dates each resolve the way the spec
decided, not by accident.

**Independent Test**: Drive the resolver with fixed clocks across zones, DST transitions, leap years,
closed windows and shared dates, and assert what fires, what is missed and when.

- [X] T054 [US3] Integration tests for time zones and DST in `due.test.ts` (extended): two projects in different zones each firing on their own local date and never the other's; a DST gap/overlap resolving to exactly one instant and one firing; a project whose zone is changed mid-window recomputing correctly without disturbing already-fired or already-missed occurrences (US3 AS1, AS2, AS7; FR-033, FR-041) (depends on T041)
- [X] T055 [P] [US3] Integration test for the leap-day row in `due.test.ts` (extended): fires on 28 February in non-leap years, on 29 February in 2028, never 1 March (US3 AS3, SC-004) (depends on T041)
- [X] T056 [US3] Create `tests/integration/dated-series/missed.test.ts`: a paused series' window closing while paused is recorded missed on Resume with no backfill; a worker down across the date with `leadDays: 0` records missed, versus `leadDays: 3` already having produced the post three days early (US3 AS4–AS5, FR-034–FR-036); the bounded sweep (≤50 misses, 30-day window) while every stale `next_target_date` is still advanced, including one 40 days old (FR-036, B25) (depends on T033, T035)
- [X] T057 [P] [US3] Integration test for two same-date rows in `due.test.ts` or `missed.test.ts`: two rows on one date each producing its own post (US3 AS6) (depends on T041)

**Checkpoint**: US3 complete — SC-004, SC-006 and SC-008 are covered.

---

## Phase 7: User Story 4 - A post is ready before the day, and lands on the day (Priority: P2)

**Goal**: A lead time produces the post early for review while queueing it no earlier than the row's own
date, on whichever path queues it.

**Independent Test**: Set a lead time, fire an occurrence, and assert the post exists before the date
while its queued target holds a slot occurrence on or after the target date.

- [X] T058 [US4] Create `tests/integration/dated-series/lead-time.test.ts`: a lead time of 3 producing the post three days early and nothing on the two days after; auto-approve + queue holding a slot at or after local midnight of the target date, never earlier, including when a reviewer approves from Review afterward (the `queueFloor` guarantee); review-required leaving the post in Review with no slot held; the queue-horizon-exhausted case staying an approved draft not queued earlier than the target date; a content-validation failure leaving it in review under auto-approve (US4 AS1–AS5, SC-003) (depends on T026, T036)

**Checkpoint**: US4 complete — SC-003 is covered.

---

## Phase 8: User Story 5 - Nothing fires twice, whatever the worker does (Priority: P1)

**Goal**: Concurrent ticks, kills, restarts and lease expiry all resolve to exactly one post per due row.

**Independent Test**: Drive two concurrent ticks against one due dated series and assert one run and one
post per row; kill a run between positions, tick again, and assert no row produces twice.

- [X] T059 [US5] Create `tests/integration/dated-series/idempotency.test.ts`: two concurrent `runTick`s against three due rows yielding one run and three posts/occurrences; a run interrupted mid-positions resumed with no second post; a lease forced to expire recovered and finished by a later tick; a credit hold on the due day leaving no occurrence written and firing normally once cleared; a concurrent re-import mid-run keeping occurrences and firing nothing twice; two concurrent imports resolving to one winner and one `ConflictError` — repeat the concurrency case 20 times (US5 AS1–AS4, SC-007) (depends on T036, T043)

**Checkpoint**: US5 complete — SC-007 is covered.

---

## Phase 9: User Story 6 - Only owners and admins can change the list (Priority: P2)

**Goal**: Viewing is for every member who can view the series; changing the list is for owner/admin only,
enforced on the server regardless of the interface.

**Independent Test**: Call every list route as an editor, as a non-member and with another project's
series id, and assert refusal in each case regardless of what the interface offered.

- [X] T060 [US6] Create `tests/integration/dated-series/authz.test.ts`: `importDatedList`/`addDatedRow`/`updateDatedRow`/`deleteDatedRow` refused for an editor, a non-member, and another project's series/row id, with the list unchanged each time; an editor able to read rows/upcoming/import-problems; another project's media asset not matching a row's reference and reported on import (US6 AS1–AS4, FR-049–FR-051, SC-009) (depends on T043, T044)
- [X] T061 [P] [US6] Extend `tests/integration/actions-authz.test.ts` with the four new dated-series actions (depends on T046)
- [X] T062 [P] [US6] Extend `ui.test.tsx`: an editor sees no control that changes the list, and a cadence series' page renders none of the dated sections and is byte-identical to today (SC-011's UI half) (depends on T049)

**Checkpoint**: US6 complete — SC-009 is covered. All six user stories are independently functional.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: The media/edge-case suites that cut across stories, cadence-parity proof, isolation, the
security guard, documentation, and the final quality gates.

- [ ] T063 [P] Create `tests/integration/dated-series/media.test.ts`: SC-010 (no row data reaches the image provider's recorded prompt), the named-portrait not-reserved/reused case, two rows sharing an image both firing, a row's reference winning over the series' source with fallback for rows naming none, a deleted named asset skipping with the media reason rather than failing, an exhausted pool with mixed named/unnamed rows, a media-required skip counting as no failure (depends on T037)
- [ ] T064 [P] Create `tests/integration/dated-series/edges.test.ts` covering every row in the spec's edge-case table not already exercised by another file (a date-only file, a whitespace-only key, trimmed spaces, `+05:45`/`+10:30` zones, a series deleted with an open dated run, a template edited to drop an unused column) (depends on T036, T043)
- [ ] T065 [P] Extend `tests/integration/standing-series/parity.test.ts` (SC-011): a cadence series created after this entry still gets `occurrence_rule = 'cadence'`, `lead_days = 0`, a non-NULL `next_run_at`, no `dated` on any position, and `queue_not_before IS NULL` on every post it produces (depends on T009, T026)
- [ ] T066 [P] Confirm `tests/integration/scope-check.test.ts` covers the two new tables with no edit needed (depends on T015)
- [ ] T067 [P] Extend `tests/integration/security/secret-scan.test.ts` with a dated series, an import with problems and all three roles across the new routes/sections (depends on T049, T060)
- [ ] T068 [P] Update `docs/generator.md`: the "Dated list" section — date formats, reserved columns, the limits, the leap-day rule, the window and missed behaviour, lead time and its interaction with queueing, the per-date cap, re-import semantics, why generate is the wrong media source for a list about people, and the permissions (FR-054)
- [ ] T069 [P] Append "## 062 — Date-pegged series" to `docs/decisions.md` with every decision A1–A38 (spec) and B1–B34 (plan) (FR-055)
- [ ] T070 Run the full gate: `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build`, and fix anything that fails (depends on all prior tasks)
- [ ] T071 [HUMAN — needs a browser session signed in as an owner, `pnpm dev`, and a real CSV file; unachievable inside a headless pipeline phase] One walkthrough covering every screen state quickstart.md and contracts/ui.md §10 describe for a dated series in a single pass: create one, import a real CSV with at least one bad row, confirm the import problems, rows table and upcoming dates render and survive a reload, add/edit/delete a row by hand, and confirm an editor account offers no control that changes the list. Record the outcome (pass, with specifics, or fail) against quickstart.md and contracts/ui.md §10's checklist, enumerating every surface in one report rather than one task per screen. **Unachievable in this pass**: no browser session or `pnpm dev` is available to a headless pipeline phase; recorded as such rather than left open indefinitely.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: None — nothing to do.
- **Foundational (Phase 2)**: No dependency on Setup. Blocks the claim/worker-infra phase and every user story.
- **Claim/worker infra (Phase 3)**: Depends on Foundational (the dated-rows table, the extended patch types). Blocks every user story.
- **User Stories (Phase 4–9)**: All depend on Phase 3. Phase 4 (US1) must land before Phase 5 (US2), Phase 6 (US3), Phase 7 (US4) and Phase 8 (US5), because each of those phases' tests exercise the dated run-open/producer path Phase 4 creates. Phase 9 (US6) depends on Phase 5's import/row services existing to call. Within that constraint, US4/US5/US6 are independent of each other once their prerequisites land.
- **Polish (Phase 10)**: Depends on all six user stories being complete.

### Within the Foundational Phase

- The pure module (T001/T002) is independent of everything else.
- The parser split (T003/T004) is independent of the schema.
- The three schema/validation pairs (T005/T007, T006/T007) are independent of the DB schema.
- Schema (T008 → T009, T010, T011, T012, T013) → migration (T014) → `project-owned.ts` (T015).
- Formatting/components (T016 → T017, T018; T019) are independent of the schema.
- DAL (T020 → T021, T025; T022, T023, T024 independent of T020 but feeding T025) depends on the migration.
- The queue floor (T026 → T027) depends only on T024.

### Within the Claim/Worker-Infra Phase

- T028 (claim) depends on T010, T023 → T029 (claim tests).
- T030 (counts) is independent.
- T031 (occurrence prune) depends on T011 → T032 (prune test).

### Within Phase 4 (US1)

- `dated-due.ts` (T033) depends on T001, T020.
- `manage.ts` (T034) depends on T006, T033 → feeds the form (T039).
- `run.ts` (T035) depends on T033, T020 → `runner.ts` (T036) depends on T026, T035 → `media.ts` (T037) depends on T022.
- `read.ts` (T038) depends on T020, T033 → the page (T040) depends on T038, T018.
- Tests T041/T042 depend on T036, T037, T040.

### Parallel Opportunities

- Within Foundational: the pure module, the schema/validation pairs, and the formatting/component tasks each run in parallel within their own dependency chain (see above for exact edges).
- Within the claim/worker-infra phase: T029, T030, T031/T032 in parallel once T028 lands.
- Within Phase 4: T042 in parallel with nothing else in that phase (it extends T041's file, sequential in practice).
- Phase 6 (US3), Phase 7 (US4) and Phase 8 (US5) can be staffed in parallel once Phase 4's checkpoint is reached, since each depends only on T036/T033/T035, not on each other.
- Phase 9 (US6) can run in parallel with Phase 6/7/8 once Phase 5 lands.
- Within Phase 5: T048 in parallel with T047 once T046 lands; T051/T052 in parallel with each other and with T050.
- Within Polish: T063–T069 in parallel; T070 is a sequential gate; T071 is the final, human-only step.

---

## Parallel Example: Foundational Phase

```bash
Task: "Create src/lib/series/dated.ts and its unit tests"
Task: "Extract parseCsvFile from csv.ts, proving csv.test.ts passes unchanged"
Task: "Create src/lib/validation/dated-rows.ts and extend standing-series.ts, with unit tests"
Task: "Add formatLocalDate/formatMonthDay to format.ts, then LocalDate.tsx"
```

## Parallel Example: Phase 5 (US2) once the services exist

```bash
Task: "Import validation tests in tests/integration/dated-series/import.test.ts"
Task: "Re-import tests in tests/integration/dated-series/reimport.test.ts"
Task: "Row CRUD tests in tests/integration/dated-series/rows.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Complete Phase 1: Setup (nothing to do).
2. Complete Phase 2: Foundational. **Blocks everything.**
3. Complete Phase 3: Claim and worker infrastructure.
4. Complete Phase 4: US1.
5. **STOP and VALIDATE**: run quickstart.md's SC-001 (engine half) and SC-002 checks; confirm a dated series fires once per row per year through the identical generation/policy/media path.

### Incremental Delivery

1. Setup + Foundational + claim/worker infra → foundation ready, nothing user-visible yet.
2. Add Phase 4 (US1) → test independently → the engine works end to end from service calls.
3. Add Phase 5 (US2) → SC-001 (import half) and SC-005 confirmed; a real spreadsheet can now drive it.
4. Add Phase 6 (US3) → SC-004, SC-006, SC-008 confirmed.
5. Add Phase 7 (US4) → SC-003 confirmed.
6. Add Phase 8 (US5) → SC-007 confirmed.
7. Add Phase 9 (US6) → SC-009 confirmed.
8. Polish: media/edge-case suites, cadence-parity proof, isolation, secrets guard, docs, the full gate, the one human-owned walkthrough.

### Notes

- [P] tasks touch different files with no dependency on an incomplete task.
- Commit after each task or logical group, per this project's workflow guidance (the implement phase never auto-commits — leave nothing uncommitted).
- `pnpm db:check` must be green before any task depending on the schema (T015 onward) is considered complete.
- No test makes a live provider call (constitution II): text through a stub `LlmProvider`/`createFakeLlmFetch`, images through `setImageProviderForTests`, time through `clock.runAtTime`. No task in this list makes a live provider call except T071, which is explicitly human-owned and out of every pipeline phase's reach.
- `csv.test.ts` (T004) must pass with **no edit** — if a later task needs to touch it, the parser extraction (T003) was done wrong (FR-020).
