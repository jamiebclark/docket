---

description: "Task list for the flake-proof integration-test architecture feature"
---

# Tasks: Flake-proof integration-test architecture

**Input**: Design documents from `/specs/079-flake-proof-test-architecture/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md, contracts/

**Tests**: `tests/setup/table-reset.test.ts`, `scripts/flake-report.test.ts`, and the four guard files
under `tests/lint/` are required deliverables named explicitly in plan.md's Project Structure and in
the contracts — they are included as implementation tasks, not as an optional testing phase.

**Organization**: tasks are grouped by user story. Within US2, the `parkAll*` migration is split into
one task per directory (per plan.md: "mechanical once the reset is in place") rather than one task per
file, since each directory's files are disjoint and migrate identically.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1–US6 per spec.md priorities
- Exact file paths are given in every task

---

## Phase 1: Setup

- [X] T001 Verify the local test environment matches quickstart.md's prerequisites: `docker ps` shows
  `docket-pg` on `0.0.0.0:5555->5432/tcp`, `.env`'s `DATABASE_URL` points at `localhost:5555`, and
  `pnpm install --frozen-lockfile` completes cleanly.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: a single shared reference point every later success-criterion comparison (SC-002,
SC-004, SC-007) needs before any code changes.

- [X] T002 Record the pre-change baseline in `docs/decisions.md` as a new entry: the current slowest
  CI shard wall-clock time (304 s, run 39036348302: 5:04/4:45/3:50/4:38 — the SC-007 comparison
  point), the current `parkAll*` call-site count (`grep -rln "parkAll" --include='*.ts' --include='*.tsx' src tests | wc -l` → 150 files, `grep -rn` → 311 call sites — the SC-004 comparison point), and
  the current `setupFiles` order in `vitest.config.ts` (`tests/setup/worker-db.ts` first) so the
  ordering invariant R2 depends on is written down before `tests/setup/reset-database.ts` is added.

**Checkpoint**: baseline numbers are on record; user story work can begin.

---

## Phase 3: User Story 1 — Enumerate every flaky test at once, from evidence (Priority: P1)

**Goal**: a dispatchable, repeatable way to run the suite N times under the gate's own contention
profile and get back one report naming every non-deterministic test with pass/fail counts and
messages.

**Independent Test**: run the reduced local reps in quickstart.md step 6 and confirm the report
classifies tests into the three categories without being told which are flaky.

### Implementation for User Story 1

- [ ] T003 [P] [US1] Implement the pure consolidator in `scripts/flake-report.ts`: parse
  `rep<N>-shard<S>.json` (Vitest `JsonTestResults`) and `rep<N>-shard<S>.meta.json` (exit code, seed,
  stderr tail) from `--input <dir>`; build one `TestVerdict` per test keyed on `file` + `fullName`
  across all inputs; categorize `consistently_passing` / `non_deterministic` / `consistently_failing`
  per the rules in data-model.md section 3; detect `LaneFailure` (`no_output`, `unparseable_output`,
  `exited_without_failures`, `lane_died`) and never let a lane failure alter a `TestVerdict`; dedupe
  `failureMessages` by exact string; write `flake-report.json` (the `FlakeReport` interface verbatim)
  and `flake-report.md` (rendered per contracts/flake-report.md, non-deterministic first then
  consistently failing, consistently-passing tests counted but not listed) to `--out <dir>`; exit `0`
  whenever a report was produced, `1` only when there was no usable input or the output directory is
  not writable.
- [ ] T004 [US1] Add a `flake:report` script to `package.json` that runs `scripts/flake-report.ts`
  through the same `esbuild --bundle --platform=node --target=node24 --format=esm` pattern
  `db:test:clean` already uses, so `pnpm flake:report --input <dir> --out <dir>` works per
  contracts/flake-report.md's CLI table (depends on T003).
- [ ] T005 [P] [US1] Write `scripts/flake-report.test.ts` against JSON fixtures (no database): a test
  failing some repetitions is `non_deterministic`; a test failing every repetition is
  `consistently_failing`; a test passing every repetition is `consistently_passing` and omitted from
  the rendered Markdown but counted in `summary`; a missing or unparseable lane output is a
  `LaneFailure` attributed to no test; a lane that exits non-zero with `numFailedTests === 0` is a
  `LaneFailure`; two distinct failure messages for one test are both kept; `--repetitions`/`--shards`
  are correctly inferred when omitted (depends on T003).
- [ ] T006 [US1] Create `.github/workflows/flake-hunt.yml`: `workflow_dispatch` (inputs `repetitions`
  default `20`, `lanes` default `4`) plus a weekly `schedule`, never `pull_request` or `push`; a `run`
  job matrixed on `shard: [1,2,3,4] × lane: [1..lanes]`, each repetition running
  `DOCKET_SKIP_PERF_TESTS=1 pnpm exec vitest run --shard=<s>/4 --sequence.shuffle.files --sequence.seed=$rep --reporter=json --outputFile=...`,
  recording exit code/seed/stderr tail to the matching `.meta.json`, never failing the job on a test
  failure, uploading `flake-<shard>-<lane>` as an artifact; a `consolidate` job with `needs: run`,
  `if: always()` that downloads every artifact, runs `pnpm flake:report`, uploads `flake-report`, and
  writes `flake-report.md` to `$GITHUB_STEP_SUMMARY` (depends on T004).
- [ ] T007 [US1] Run the local smoke test from quickstart.md step 6: three reduced repetitions of
  `tests/integration/email` and `tests/integration/scheduler` with `--sequence.shuffle.files
  --sequence.seed=$rep --reporter=json`, then `pnpm flake:report --input .flake/in --out .flake` and
  read `.flake/flake-report.md`; confirm it classifies every test into one of the three categories and
  separates any lane failure from test failures (depends on T005, T006).

**Checkpoint**: the flake-report machinery exists, is unit-tested, and has been proven locally. The
full 20×4 dispatch against this feature's finished branch is the single verification task in Phase 10.

---

## Phase 4: User Story 2 — A test can never see another test's leftovers (Priority: P1)

**Goal**: per-test database isolation by default, so a global capped claim can only ever see work the
test itself created, and the `parkAll*` workaround family is gone.

**Independent Test**: run `tests/integration/email/tick.test.ts` and
`tests/integration/scheduler/refresh.test.ts` together in both orders with `--no-file-parallelism` and
confirm both pass both times (quickstart.md step 1, second block).

### Implementation for User Story 2

- [ ] T008 [P] [US2] Implement the pure SQL builder in `tests/setup/table-reset.ts`:
  `resetStatements(tables)` (one `delete from` per table under `session_replication_role = replica`,
  order-independent given the `projects → voice_profiles → projects` FK cycle) and the exported
  `PRESERVED_ROWS` list containing the `notification_change_marker` singleton
  (`id = true`, from migration `0024_luxuriant_bill_hollister.sql`) per data-model.md section 2 and
  research.md R1.
- [ ] T009 [US2] Write `tests/setup/table-reset.test.ts`: resetting a database with rows leaves it
  row-for-row identical (per table) to a freshly migrated template database, proving the preserved-row
  list cannot silently fall behind a new migration (depends on T008).
- [ ] T010 [US2] Implement `tests/setup/reset-database.ts`: a `beforeEach` (registered via
  `setupFiles`) that opens its own `pg.Pool` (never `getDb()`, so `tests/setup/scope-recorder.ts` never
  sees it and `closeDb()` calls elsewhere don't affect it), runs `table-reset.ts`'s statements plus the
  preserved-row re-insert inside one transaction with `session_replication_role = replica`, is a no-op
  when `DOCKET_SKIP_DB_SETUP=1` (matching `tests/setup/worker-db.ts`), and refuses any database whose
  name does not end in `_test` by reusing the existing check in `tests/setup/test-databases.ts`.
  Exports `shareStateWithinFile()` (switches the current file to a `beforeAll`-only reset, idempotent,
  effective however late in the module body it is called) and `resetDatabaseNow()` (depends on T008).
- [ ] T011 [US2] Register `tests/setup/reset-database.ts` in `vitest.config.ts`'s `setupFiles`,
  immediately after `tests/setup/worker-db.ts` and before `tests/setup/scope-recorder.ts` (verified
  hook order per research.md R2: `setup:beforeEach` runs before the file's own `beforeEach`) (depends
  on T010).
- [ ] T012 [US2] Find every file that seeds database state in its own `beforeAll`
  (`grep -rln "beforeAll" tests/integration --include='*.test.ts' | xargs grep -l "getDb\|createVoiceProfile\|factories"`)
  and call `shareStateWithinFile()` at that file's module top level where the setup is genuinely
  expensive to repeat per test (video fixtures, image servers, the MCP bridge) rather than cheap to
  move to `beforeEach`; leave the rest to pick up the new per-test default for free (depends on T011).
- [ ] T013 [US2] Write `tests/integration/isolation/leftovers.test.ts`: a probe test seeds due work,
  runs after a file that deliberately leaves unparked due work behind, and passes with no isolation
  code of its own (SC-011); two `it`s in one file where the first leaves due work behind and the
  second's claim cannot see it (FR-008); a claim path that creates its own state row on first sight of
  an entity (e.g. the generation job-item lease) sees none from an earlier file (FR-010) (depends on
  T011).

**`parkAll*` removal** (311 call sites across 150 files, grouped by directory; each task below touches
disjoint files and can run in parallel once T011 lands):

- [ ] T014 [P] [US2] Remove `parkAll*` calls and now-unused imports from the 21 files under
  `tests/integration/scheduler/` (depends on T011).
- [ ] T015 [P] [US2] Remove `parkAll*` calls and now-unused imports from the 17 files under
  `tests/integration/jobs/` (depends on T011).
- [ ] T016 [P] [US2] Remove `parkAll*` calls and now-unused imports from the 16 files under
  `tests/integration/failures/` (depends on T011).
- [ ] T017 [P] [US2] Remove `parkAll*` calls and now-unused imports from the 10 files under
  `tests/integration/instagram/` (depends on T011).
- [ ] T018 [P] [US2] Remove `parkAll*` calls and now-unused imports from the 9 files under
  `tests/integration/threads/` (depends on T011).
- [ ] T019 [P] [US2] Remove `parkAll*` calls and now-unused imports from the 8 files under
  `tests/integration/facebook/` (depends on T011).
- [ ] T020 [P] [US2] Remove `parkAll*` calls and now-unused imports from the 7 files under
  `tests/integration/api/endpoints/` (depends on T011).
- [ ] T021 [P] [US2] Remove `parkAll*` calls and now-unused imports from the 7 files under
  `tests/integration/activity/` (depends on T011).
- [ ] T022 [P] [US2] Remove `parkAll*` calls and now-unused imports from the 6 files under
  `tests/integration/media/` (depends on T011).
- [ ] T023 [P] [US2] Remove `parkAll*` calls and now-unused imports from the 6 files under
  `tests/integration/engagement/` (depends on T011).
- [ ] T024 [P] [US2] Remove `parkAll*` calls and now-unused imports from the 6 files under
  `tests/integration/email/` (depends on T011).
- [ ] T025 [P] [US2] Remove `parkAll*` calls and now-unused imports from the 5 files under
  `tests/integration/bluesky/` (depends on T011).
- [ ] T026 [P] [US2] Remove `parkAll*` calls and now-unused imports from the 4 files under
  `tests/integration/pinterest/` (depends on T011).
- [ ] T027 [P] [US2] Remove `parkAll*` calls and now-unused imports from the 3 files under
  `tests/integration/x/`, the 3 files under `tests/integration/posts/`, the 3 files under
  `tests/integration/llm/`, and the 3 root-level files directly under `tests/integration/` (depends
  on T011).
- [ ] T028 [P] [US2] Remove `parkAll*` calls and now-unused imports from the 2 files under
  `tests/integration/meta/`, the 2 files under `tests/integration/compose/`, and the single files
  under `tests/integration/tiktok/`, `tests/integration/security/`, `tests/integration/limits/`, and
  `tests/integration/generation/` (depends on T011).
- [ ] T029 [US2] Remove the `parkAll*` definitions themselves — `parkAllJobs` and
  `parkAllStandingSeries` from `tests/helpers/jobs-env.ts`, `parkAllEmail` from
  `tests/helpers/email.ts`, `parkAllEngagementReads` and `parkAllDueTargets` from
  `tests/helpers/scheduling.ts` — along with `clearHolds()`/`clearProjectCredentials()` wherever they
  exist only to undo another test file's rows (not where a test clears its own rows mid-case), now
  that every caller is migrated (depends on T014–T028).
- [ ] T030 [US2] Write `tests/lint/no-parking-helpers.test.ts`: no file may define, export or import a
  `parkAll*` symbol; ship with an empty allow-list (the migration is complete by this point), per
  contracts/test-harness.md (depends on T029).
- [ ] T031 [US2] Run the targeted regression check:
  `pnpm exec vitest run tests/integration tests/setup tests/lint tests/helpers` and fix any test whose
  assertions assumed a leftover row from a sibling file (depends on T030).

**Checkpoint**: every test starts from a clean database by default, no file opts in, and no
`parkAll*` call sites remain.

---

## Phase 5: User Story 3 — No test depends on the wall clock or on exact capacity (Priority: P1)

**Goal**: tests that drive scheduler ticks never depend on how much wall-clock budget remains or on
consuming capacity to the last unit, enforced by guards.

**Independent Test**: probe each new guard with a deliberately bad test per quickstart.md step 3,
confirm it fails naming the file and the rule, then remove the probe.

### Implementation for User Story 3

- [ ] T032 [P] [US3] Add `drainTicks<T>({ tick, until, ceiling, describe })` and the exported
  `SECTIONS` constant (the nine section names) to `tests/helpers/tick.ts`: ticks until `until` holds
  or `ceiling` is reached, then throws naming `describe(n)`'s text and the accumulated per-disposition
  tally on failure (FR-029); leaves `TICK_BUDGET_MS` and `tickConfig()` unchanged per
  contracts/test-harness.md.
- [ ] T033 [US3] Write `tests/lint/tick-drain.test.ts`: forbids a tick loop whose bound is a literal
  greater than `1` (`while (… && ticks < N)`, `for (let i = 0; i < N; i++)` beside a `runTick`/tick
  call in the same block), reusing the balanced-paren argument extractor already written in
  `tests/lint/tick-budget.test.ts`; names the file, the loop, and `drainTicks()` as the replacement;
  carries an in-file exemption set, each entry with a one-line reason, in the same style as
  `OWNS_ITS_BUDGET` (depends on T032).
- [ ] T034 [P] [US3] Write `tests/lint/no-test-retries.test.ts`: asserts the resolved Vitest config
  (`vitest.config.ts`) keeps `retry` and `repeats` at their `0` default, and that no test file passes a
  `retry` option to `it`/`describe`/`test`.
- [ ] T035 [US3] Migrate `tests/integration/email/tick.test.ts`'s "serves 500 due people within 10
  ticks" test off its `while (served < 500 && ticks < 10)` loop onto `drainTicks()` with a generous
  ceiling, so the test tolerates a skip instead of requiring exact zero-slack capacity (depends on
  T032; see also T051 in US6, which gives this test the per-disposition diagnostics it needs to be
  useful on failure).
- [ ] T036 [US3] Search for other fixed-count tick loops sized to a capacity
  (`grep -rln "runTick" tests/integration --include='*.test.ts' | xargs grep -ln "for (let\|while ("`,
  cross-checked against what `tests/lint/tick-drain.test.ts` flags) and migrate each to `drainTicks()`
  until the guard passes with an empty or minimally-justified exemption set (depends on T033, T035).
- [ ] T037 [US3] Run the oversubscription check from quickstart.md step 4 — once unloaded
  (`DOCKET_TEST_WORKERS=1`) and once oversubscribed (`DOCKET_TEST_WORKERS=8`) against
  `tests/integration/scheduler tests/integration/email tests/integration/jobs` — and confirm identical
  pass/fail outcomes (FR-019, SC-003); fix any test whose outcome differs, rather than re-running it
  (depends on T036, and on the isolation work in Phase 4 since that is the usual cause of a
  load-sensitive outcome difference).

**Checkpoint**: no test can pass only when the machine is fast or only when nothing is skipped; both
new guards are green with their probes proven to fail first.

---

## Phase 6: User Story 4 — An operator can always tell a skipped section from an idle one (Priority: P2)

**Goal**: every tick section reports `idle`, `completed`, or `declined` with a reason, surfaced on the
tick response, the heartbeat, and the scheduler's own log line.

**Independent Test**: force a tick where a section has too little remaining budget and confirm the
tick's own report says `declined`/`insufficient_time`, distinct from `idle`, with no test
instrumentation involved (quickstart.md step 5).

### Implementation for User Story 4

- [ ] T038 [US4] Define `DeclineReason`, `SectionOutcome`, and the updated `SectionResult<C>` (adding
  `outcome: SectionOutcome` alongside the unchanged `counts: C`) in a new
  `src/server/scheduler/outcome.ts`, per data-model.md section 1 — the one place `outcome` is derived,
  per constitution IV.
- [ ] T039 [US4] Update `src/server/scheduler/index.ts`'s `section()` helper and `TickSummary` to carry
  `outcome` on every section result (both `ok: true` and `ok: false`), using the new types from
  `outcome.ts`; `counts` keeps its exact current shape on all nine sections so every existing
  assertion over `counts` keeps passing unedited (depends on T038).
- [ ] T040 [P] [US4] `src/server/scheduler/generation.ts`: map the existing `notConfigured` /
  `notRunnable` / `outOfBudget` counts onto `{ kind: "declined", reason: "disabled" | "insufficient_time" }`
  and `{ kind: "completed" }` / `{ kind: "idle" }` otherwise (depends on T039).
- [ ] T041 [P] [US4] `src/server/scheduler/token-refresh.ts`: add `claimed: number` and `lost: number`
  to `RefreshCounts` (per contracts/tick-summary.md — `failed: 0` today is equally consistent with
  "never claimed", "claimed then lease lost", and "provider returned ok"; these two name which),
  increment them on the claim and on a lost lease respectively, and report
  `{ kind: "declined", reason: "insufficient_time" }` on the per-account budget check, `{ kind: "idle" }`
  when nothing was due, `{ kind: "completed" }` otherwise (depends on T039).
- [ ] T042 [P] [US4] `src/server/scheduler/standing-series.ts`: give the silent out-of-budget branch an
  `outOfBudget: 0 | 1` count and `{ kind: "declined", reason: "insufficient_time" }`; `notConfigured`
  maps to `{ kind: "declined", reason: "disabled" }`; otherwise `idle`/`completed` (depends on T039).
- [ ] T043 [P] [US4] `src/server/scheduler/email.ts`: split `skipped` into `skippedStale`,
  `skippedEmpty`, and `skippedOutOfWindow` (with `skipped` staying and equalling their sum, per
  contracts/tick-summary.md); report `{ kind: "declined", reason: "disabled" }` when no mailer is
  configured (today's "zeros, indistinguishable from idle"), `{ kind: "declined", reason: "insufficient_time" }`
  on the per-item `minWindowMs` release, and `idle`/`completed` otherwise (depends on T039).
- [ ] T044 [P] [US4] `src/server/scheduler/webhooks.ts`: add `skippedOutOfWindow: number` separating
  the per-item window release from other skips, and report `{ kind: "declined", reason: "insufficient_time" }`
  for it; `idle`/`completed` otherwise (depends on T039).
- [ ] T045 [P] [US4] `src/server/scheduler/engagement-read.ts`: add `surfacesUnavailable: 0 | 1`
  distinguishing "no provider could be read" from "nothing was due", reporting
  `{ kind: "declined", reason: "disabled" }` in the first case and `{ kind: "idle" }` in the second
  (depends on T039).
- [ ] T046 [P] [US4] `src/server/scheduler/publishing.ts`: give the deadline `break` mid-claim an
  `outOfBudget: number` count (currently counts nothing) and report
  `{ kind: "declined", reason: "insufficient_time" }`; `idle`/`completed` otherwise (depends on T039).
- [ ] T047 [P] [US4] `src/server/scheduler/housekeeping.ts` and `src/server/scheduler/engagement-send.ts`:
  no budget gate in either, so report only `idle`/`completed` (depends on T039).
- [ ] T048 [US4] Update `summaryLine()` in `src/server/scheduler/loop.ts` to append
  `declined=<section>:<reason>,…` (comma-joined, omitted entirely when no section declined), keeping
  every field it prints today (depends on T040–T047).
- [ ] T049 [US4] Confirm `writeHeartbeat` calls across the nine section files (already present in each,
  e.g. `src/server/scheduler/email.ts:77`) carry the new `outcome` field into
  `scheduler_heartbeats.last_summary` by spreading the full `SectionReport` rather than `counts` alone
  (depends on T040–T047).
- [ ] T050 [US4] Write `tests/integration/scheduler/outcomes.test.ts`: iterates `SECTIONS` (not a
  hand-written list, so a tenth section can't be added without a case) and asserts — a section with
  work waiting and too little budget reports `declined`/`insufficient_time` distinct from any count of
  completed work; a section with nothing to do reports `idle`; a section switched off by configuration
  reports `declined`/`disabled`; work a section declined is claimed and completed by the next tick with
  budget available (FR-022); no `outcome` value contains interpolated text (FR-024) (depends on
  T040–T049).
- [ ] T051 [US4] Extend `tests/integration/tick-endpoint.test.ts` and write
  `src/server/scheduler/loop.test.ts` coverage (or extend the existing `loop.test.ts`) asserting the
  tick response body carries `outcome` per section and `summaryLine()` prints
  `declined=<section>:<reason>` when a section declines and omits `declined=` entirely when none does
  (depends on T048).

**Checkpoint**: every section's output distinguishes idle from declined, and declined-for-time from
declined-for-configuration, from the tick response alone.

---

## Phase 7: User Story 5 — Heavy tests pass under full parallelism (Priority: P2)

**Goal**: the three known load-sensitive tests — Bluesky end-to-end publish, the tick endpoint, and
the credit-outage job test — pass as part of the full suite at its normal parallelism, and a test
needing hundreds of ticks has a way to do so that doesn't scale with unrelated section work.

**Independent Test**: run the three named tests inside the full suite (quickstart.md step 7, all four
shards) and confirm none exceeds its time limit; the twenty-run proof is Phase 10's single
verification task, not a local command.

### Implementation for User Story 5

- [ ] T052 [US5] Add the `only?: readonly SectionName[]` option to `runTick()` in
  `src/server/scheduler/index.ts` (defaulting to all nine sections when omitted or when all nine names
  are passed), so a section excluded by `only` reports `{ kind: "idle" }` with empty counts and
  `ok: true` — the summary shape never varies — per contracts/tick-summary.md (depends on T039,
  T052 is otherwise independent of T040–T051's per-section bodies).
- [ ] T053 [US5] Write a test asserting `runTick()` with no `only` (and with all nine `SECTIONS`
  passed explicitly) runs all nine sections, and a `tests/lint/` guard asserting no caller under
  `src/` passes `only` to `runTick` (production never does) — co-locate with
  `tests/integration/scheduler/outcomes.test.ts` or as a new `tests/lint/no-section-filter-in-prod.test.ts`
  (depends on T052).
- [ ] T054 [US5] Record the `runTick({ only })` judgement call in `docs/decisions.md`: why a
  production API parameter was added for a test affordance, and why raising the timeout or extracting
  `runGenerationJobs` directly were rejected (per plan.md's Complexity Tracking table) (depends on
  T052).
- [ ] T055 [US5] Migrate `tests/integration/jobs/credit-outage.test.ts` to call `runTick({ only: [...] })`
  naming only the sections it is about (generation, plus whatever else the 122-tick scenario actually
  exercises), removing roughly eight ninths of its per-tick database work (depends on T052–T054).
- [ ] T056 [US5] Re-measure `tests/integration/tick-endpoint.test.ts` and
  `tests/integration/bluesky/publish-e2e.test.ts` now that Phase 4's isolation work and T055 have
  landed, per research.md R7's deliberately-deferred decision: run each alone and inside
  `pnpm exec vitest run --shard=<its shard>/4` (matching quickstart.md step 7) and record whether
  removing `parkAll*` already fixed the timeout; only add a targeted change (e.g. narrowing to
  `runTick({ only })` where applicable) if the measurement still shows it exceeding its limit (depends
  on T031, T055).

**Checkpoint**: all three named tests pass inside their shard at normal parallelism, locally measured;
the 20-run proof is deferred to Phase 10.

---

## Phase 8: User Story 6 — The two live unexplained flakes are closed with a reason (Priority: P3)

**Goal**: `email/tick.test.ts`'s "serves 500 due people" and `scheduler/refresh.test.ts`'s "flags
needs_reauth on failure" are each either explained and fixed, or shown impossible under the new
architecture — both backed by per-disposition diagnostics and the flake report's zero-failure count.

**Independent Test**: re-run the flake report (Phase 10's single verification task) and confirm zero
failures for both tests; read the `docs/decisions.md` entries for a stated cause or stated
impossibility.

### Implementation for User Story 6

- [ ] T057 [US6] Give `tests/integration/scheduler/refresh.test.ts`'s "flags needs_reauth on failure"
  assertion message the per-disposition diagnostic it needs: on failure, print `claimed`, `refreshed`,
  `failed`, `deferred`, `lost`, and `outOfBudget` together (using the `claimed`/`lost` counts added in
  T041), so the next failure (if any) names which of "never claimed" / "claimed then lease lost" /
  "provider returned ok" occurred, per research.md R8 (depends on T041).
- [ ] T058 [US6] Give `tests/integration/email/tick.test.ts`'s "serves 500 due people" assertion
  message the per-disposition diagnostic: on failure, print `claimed`, `sent`, `skippedStale`,
  `skippedEmpty`, and `skippedOutOfWindow` together (using the split counts added in T043), so a
  future failure names the cause rather than a bare "served 499 of 500" (depends on T043, and on the
  `drainTicks()` migration in T035).
- [ ] T059 [US6] Run `tests/integration/scheduler/refresh.test.ts` and
  `tests/integration/email/tick.test.ts` locally, several times in both file orders with
  `--no-file-parallelism` (quickstart.md step 1's order-independence proof), after Phase 4's isolation
  and Phase 6's `claimed`/`lost` and split-`skipped` counts have landed; if either fails, read the new
  diagnostic and fix the named cause; if neither fails across a reasonable number of local repetitions,
  record that as evidence (not proof — Phase 10's flake-hunt dispatch is the proof) (depends on T057,
  T058, Phase 4 complete).
- [ ] T060 [US6] Write the `docs/decisions.md` entry for each of the two flakes: either the stated
  cause and fix (if T059 reproduced and fixed one), or the stated reason the failure shape can no
  longer occur under the new architecture (e.g. "a second claim over leftover accounts from another
  file is now impossible: Phase 4's per-test reset means no other file's rows exist to be claimed") —
  "stopped reproducing" alone does not satisfy FR-027 (depends on T059).

**Checkpoint**: both flakes have a written cause or a written impossibility argument; the zero-failure
proof across the full repetition count is Phase 10's single verification task.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T061 [P] Write `docs/testing.md`: the isolation guarantee a test gets for free, `shareStateWithinFile()`
  and when to use it, the four guards under `tests/lint/` and what each forbids, and how a section
  outcome is reported — aimed at a test author who has not read spec.md.
- [ ] T062 [P] Add a line to `README.md` (or wherever `docs/*.md` already lists the other quality
  gates) mentioning the `flake-hunt.yml` workflow, its trigger (`workflow_dispatch` + weekly), and that
  it is never a required check — noting for future editors that inbound anchors in `docs/` are only
  checked in CI, so renumbering a heading there breaks links nothing local will catch.
- [ ] T063 Run the full targeted regression sweep before merge:
  `pnpm exec vitest run tests/lint tests/setup tests/helpers tests/integration/isolation tests/integration/scheduler tests/integration/email tests/integration/jobs` plus `pnpm typecheck` plus `pnpm lint`
  (per the project's "checks in proportion" workflow rule); fix anything red before the final
  verification task (depends on every prior phase).

---

## Phase 10: Final Verification (human-owned — needs GitHub Actions compute and `gh` CLI with `actions:write`, not available to this pipeline phase)

One survey task covers every success criterion that depends on a production-contention CI run, so a
single dispatch answers SC-001, SC-002, SC-004 through SC-007, SC-009, and SC-010 together rather than
one CI round-trip per criterion.

- [ ] T064 Once every prior phase is merged to a branch GitHub Actions can run against, dispatch
  `.github/workflows/flake-hunt.yml` with `repetitions=20` and `lanes=4`
  (`gh workflow run flake-hunt.yml -f repetitions=20 -f lanes=4`), wait for it to finish, and read
  `flake-report.md` from the run's job summary. Report, from that one reading:
  - **SC-002**: zero non-deterministic tests across all twenty repetitions.
  - **SC-010 / FR-028**: zero failures for `tests/integration/email/tick.test.ts` "serves 500 due
    people…" and `tests/integration/scheduler/refresh.test.ts` "flags needs_reauth on failure…".
  - **SC-009**: `tests/integration/bluesky/publish-e2e.test.ts`, `tests/integration/tick-endpoint.test.ts`,
    and `tests/integration/jobs/credit-outage.test.ts` each pass all twenty times within their limit.
  - Zero lane failures, or lane failures explained and not attributed to any test (FR-004).
  Then separately read the gating CI run's own timing (`gh run list --workflow=ci.yml --limit 1
  --json databaseId` then `gh run view <id> --json jobs`) and compare the slowest shard against the
  T002 baseline (304 s) for **SC-007** (must be ≤ ~334 s, a 10% allowance).
  **SC-004** and **SC-005**/**SC-006** need no CI run — they were already settled locally in Phase 4
  (empty `parkAll*` allow-list, T030) and Phase 5 (the guard probes in T033/T034, written, seen to
  fail, and removed); confirm they are still true by re-reading those tasks' state rather than
  re-running anything.
  If the window to dispatch has closed before this task runs (the workflow file was never merged, or
  the branch it would run against no longer exists), mark this task unachievable and state why rather
  than leaving it open indefinitely.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup.
- **US1 (Phase 3)**: depends on Foundational only. Independent of every other story (plan.md group A).
- **US2 (Phase 4)**: depends on Foundational. Technically independent of US1, but US1's report (once
  it exists) is how US2's isolation claims get proven at scale (plan.md: "A, to prove it").
- **US3 (Phase 5)**: depends on Foundational for the guard files themselves (T032–T034), but the
  oversubscription check (T037) and the loop migrations (T035–T036) are far more meaningful once
  Phase 4's isolation has landed — plan.md group D depends on group B.
- **US4 (Phase 6)**: depends on Foundational only. Fully independent of US2/US3 (plan.md group C).
- **US5 (Phase 7)**: depends on US4's `outcome.ts`/`index.ts` changes landing first (T052 touches the
  same `runTick()` signature T039 extends) and benefits from US2's isolation work for T056's
  re-measurement (plan.md group D depends on B and C).
- **US6 (Phase 8)**: depends on US4's `claimed`/`lost` and split-`skipped` counts (T041, T043) and on
  US2's isolation (Phase 4) to test the "no longer occurs" hypothesis (plan.md group D).
- **Polish (Phase 9)**: depends on all six stories.
- **Final Verification (Phase 10)**: depends on Phase 9; human-owned, needs GitHub Actions compute.

### Within Each User Story

- US2: T008 (pure builder) → T009 (its test) and T010 (the reset) → T011 (wired into config) → T012
  (opt-outs) and T013 (probe test) in parallel → T014–T028 (directory removals, all parallel) → T029
  (definitions removed) → T030 (guard) → T031 (regression sweep).
- US4: T038 (types) → T039 (index.ts wiring) → T040–T047 (nine section files, all parallel, disjoint
  files) → T048 (log line) and T049 (heartbeat) → T050 (outcomes test) → T051 (endpoint/log test).

### Parallel Opportunities

- All of T014–T028 (the directory-grouped `parkAll*` removals) run in parallel — 15 tasks, disjoint
  files, once T011 lands.
- All of T040–T047 (the per-section outcome mapping) run in parallel — 8 tasks, disjoint files, once
  T039 lands.
- T003/T005 (US1), T032/T034 (US3), T061/T062 (Polish) are each parallel pairs within their phase.

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Setup (Phase 1) + Foundational (Phase 2).
2. Phase 3 (US1): the flake-report machinery, proven locally.
3. **STOP and VALIDATE**: run quickstart.md step 6; the report should already name the two known live
   flakes against today's `main` without being told about them.

### Incremental Delivery

1. Foundation ready → Phase 3 (US1) → a report exists, even if nothing else has landed.
2. Phase 4 (US2) → `parkAll*` is gone, isolation is structural → re-run Phase 3's report to see the
   isolation-shaped flakes disappear.
3. Phase 5 (US3) → the two remaining clock/capacity shapes are guarded and migrated.
4. Phase 6 (US4) → section outcomes are honest; US5 and US6 can now use `claimed`/`lost` and the
   `declined` reasons.
5. Phase 7 (US5) and Phase 8 (US6) → the three load-sensitive tests and the two named flakes are
   closed, each backed by what Phase 6 made visible.
6. Phase 9 (Polish) → the written record.
7. Phase 10 → the one human-owned dispatch that proves all of it at CI's own contention profile.
