# Implementation Plan: Date-pegged series — content that fires on an anniversary, from a spreadsheet

**Branch**: `072-dated-series` | **Date**: 2026-10-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/072-dated-series/spec.md`

Roadmap `.specify/roadmaps/content-engine-roadmap.json`, entry **4 of 6**, slug `dated-series`.

---

## Summary

`evergreen-series` built a standing series as configuration that opens a **run** on a cadence, and
deliberately left one seam open: *how* a run becomes due. This entry fills that seam with a second
occurrence rule and changes nothing else — no new worker section, no new generation path, no new
policy branch, no new environment variable, no new runtime dependency.

The design is five parts:

1. **Two tables and four columns.** `standing_series_dated_rows` is the list — a month, a day, an
   optional year, the template fields as text, an optional asset reference, the file line it came
   from, and `next_target_date`, the local date of its next unfired occurrence.
   `standing_series_occurrences` is one firing of one row in one year, under
   **`unique(row_id, year)`** — which *is* "a row fires at most once a year", enforced by the
   database instead of by a prior read. The import record is four columns on `standing_series`,
   because it is one row per series by definition.

2. **Due-ness decided on local dates, with nothing zone-dependent stored.** An occurrence is
   eligible exactly when `target − lead ≤ today ≤ target`, all local dates in the project's zone.
   `next_run_at` becomes nullable and is **always NULL for a dated series**: there is no cached
   instant for a time-zone change to falsify, so FR-041's "reads the zone every time" is structural.
   The due *instant* — needed for "generated on …" and for US3 AS2's single-instant guarantee — is
   `periodStartInstant(target − lead, zone)`, the function `cadence.ts` already exports, so
   FR-033's DST disambiguation has one implementation, not two.

3. **One run per due date, reusing the constraints that already exist.** `standing_series_period`
   gains the value `'date'`: a dated run is `period = 'date'`, `period_start = <target date>`,
   `requested_count = <rows due on it>` (1–10 — the cap A11 chose precisely because a run already
   allows ten positions). `unique(series_id, period, period_start)` becomes "one run per due date"
   and `uniqueIndex(series_id) WHERE closed_at IS NULL` stays "one open run", both already tested.

4. **A three-line fork in the producer.** Skip the angle planner (gated on the run config's `rule`,
   not on `requested_count`); render the row's values into `inputs.instructions` through the same
   `renderTemplate` with the same `⟦ ⟧` data marks a batch job uses; and give `applyApprovalPolicy`
   a queue floor. Everything else — `runGenerationStep`, `applyApprovalPolicy`, `saveGeneratedPost`,
   `resolvePositionMedia`, `recordFailure`, the lease guard, the budget checks, the credit hold, the
   self-pause — is the identical code on the identical path.

5. **The queue floor lives on the post, not in a call argument.** `posts.queue_not_before` is read by
   the one `queueFloor(post, now)` helper at all three `allocateNextFree` floor call sites, so a post
   generated seven days early cannot take a slot before its own date whether the worker queued it or
   a reviewer approved it from Review. Passing the floor only from the worker would have left US4's
   whole guarantee false on the review path — the path a lead time exists to enable.

The parser is **extended, not duplicated**: `parseJobCsv`'s body becomes a core that tags each
problem `file` or `row` and keeps today's push order; `parseJobCsv` is a four-line wrapper that still
refuses on any problem, so `csv.test.ts` passes unchanged and FR-020 is *proved* rather than claimed.

**Scale**: two tables, two new enum types (`standing_series_occurrence_rule`,
`standing_series_occurrence_outcome`) plus one value each on `standing_series_period` and
`standing_series_position_status`; on `standing_series` seven new columns and three relaxed to
nullable; one new column each on `standing_series_positions` and `posts`; one new CHECK on
`standing_series_runs`; one forward-only migration. One pure library module.
**No new runtime dependency, no new infrastructure, no new process, no new environment variable, no
new permission, no API surface, no webhook, no notification, no external date source.**

---

## Technical Context

**Language/Version**: TypeScript (strict), Node 24 LTS, pnpm

**Primary Dependencies**: Next.js 16 (App Router, standalone output), Drizzle ORM
(`drizzle-orm/node-postgres`), Zod 4, `@js-temporal/polyfill`, `csv-parse` (already a dependency, via
the jobs CSV source), Tailwind 4, Vitest. **No new runtime dependency** (constitution VI): the
Temporal polyfill and `csv-parse` are both already in `package.json`, and the second occurrence rule
needs nothing else.

**Storage**: Postgres. Two new project-owned tables (`standing_series_dated_rows`,
`standing_series_occurrences`), two new enum types, one value added to each of
`standing_series_period` and `standing_series_position_status`, seven new columns plus three relaxed
to nullable on `standing_series` (`cadence_count`, `cadence_period`, `next_run_at`), one new jsonb
column on `standing_series_positions`, one new nullable column on `posts`, one new CHECK on
`standing_series_runs`. One forward-only SQL migration, generated and committed, **no backfill** beyond
the `occurrence_rule = 'cadence'` default that every existing row takes.

**Testing**: Vitest. Unit tests for the pure dated module (date parsing, the impossible-date set, the
leap-day rule, next-target-date advance, eligibility in both the date and instant forms across both
DST directions, the upcoming list), the extended parser (the tagged core and the unchanged wrapper),
the validation schemas and the `queueFloor` helper. Integration tests against a real Postgres
(port **5555**) for import validation and the stored problem record, re-import identity matching,
row add/edit/delete, due resolution across two zones and both DST transitions, the leap day, the
closed window and missed recording, lead time and the queue floor on both the worker and review
paths, duplicate dates, idempotency across restarts and overlapping ticks, lease recovery, credit
holds, project isolation, authorization, and the three screens. **No test makes a live provider
call** (constitution II).

**Target Platform**: Linux server — Docker Compose (web, worker, postgres) and Neon with only the
connection string changed. No advisory lock, no `LISTEN`, no session-level Postgres feature; the
import's serialisation is an optimistic version guard (**B21**), not a lock.

**Project Type**: Web application — Next.js App Router monolith plus a worker; services in
`src/server/services/`, data access in `src/server/dal/`, pure helpers in `src/lib/`.

**Performance Goals**: none asserted against a live API. The section's bounds are unchanged
(`STANDING_SERIES_TICK_MAX_SERIES` 2, `STANDING_SERIES_TICK_MAX_POSTS` 2), so
`docs/generator.md`'s existing concurrency arithmetic applies verbatim. A 500-row import is one
parse, one filename query and one transaction; the evaluation pass is bounded to 50 retired rows.

**Constraints**: at most one occurrence per row per year, enforced by `unique(row_id, year)`; at most
one run per due date and one open run per series, both by the existing unique indexes; at most one
post per position, by the existing partial unique index on `posts`; at most 10 rows per calendar
date; at most 500 rows per series; no model, image or storage call inside a held transaction; no
cached zone-dependent value anywhere in the feature; a row's asset used but never reserved or marked
used; a queued dated post never earlier than the start of its target date's local day; a missed
occurrence never produced afterwards; **cadence semantics byte-for-byte unchanged**, proved by the
`071` suite passing with no assertion edited.

**Scale/Scope**: two tables; one migration; one pure library module plus one extended one; two DAL
repos plus three extended; four service modules; three touched shared helpers; one scheduler claim
predicate; three UI sections, one form change and four server actions; roughly eleven new test files
plus ten extended ones; two documents.

**No `NEEDS CLARIFICATION` and no `NEEDS RESEARCH` remains.** The spec left no external fact open —
it consults no calendar, feed or API — and [research.md](./research.md) § 2 closes every plan-level
choice. One correction to the spec is recorded (research § 3): A11's "first ten by file order" needs
a year to count against, and the plan says which years it counts.

---

## Constitution Check

*GATE: passed before Phase 0, re-checked after Phase 1 design. Both evaluations below.*

| Principle | How this design satisfies it | Post-design verdict |
|---|---|---|
| **I. Verified facts over memory** (non-negotiable) | Nothing is recalled. [research.md](./research.md) § 1 is a file-by-file reading of the cadence engine, the three tables, the CSV parser line by line, the template helpers, open/resume/close, the producer, the media resolver, the claim SQL, the policy and allocator, the permission matrix, the formatter and its lint test, and the section config — each with the path and line it came from. Which providers require media comes from `findProvider(key).capabilities.media.required`, never a literal. All date arithmetic is the installed `@js-temporal/polyfill` through the existing `periodStartInstant`. § 1.12 records the three document-level facts and the one schema fact (`media_assets` has no `unique(project_id, id)`) that shaped **B22**. No price, latency or model id is asserted. **This entry consults no external date source of any kind** (FR: "What this entry does not do"), so there is no external fact to research. | **PASS** |
| **II. Nothing is "working" unless it ran** | Every success criterion has a named runnable check in [quickstart.md](./quickstart.md). No live provider call: text through a stub `LlmProvider`, images through `setImageProviderForTests`, time through `clock.runAtTime`, concurrency through two un-awaited `runTick` calls against a real Postgres. SC-002's "a simulated year" is a pinned clock walked across dates, and SC-007's idempotency is asserted **by counting rows**, never inferred from timing. SC-010 (no row data reaches an image provider) is asserted against the **recorded prompt**, not by reading the code. The SQL this design rests on was not reasoned about either: [contracts/verified.md](./contracts/verified.md) records `date - smallint`, the project-local-date expression and the row table's CHECKs and identity index **run** against the project's own Postgres, with the ten inserts that prove A10 and FR-023 are database facts. Everything behavioural is explicitly *not* claimed to work until [quickstart.md](./quickstart.md) runs. | **PASS** |
| **III. Project isolation enforced in one place** | Two new tables, each carrying `project_id`, each added to `src/server/db/project-owned.ts` — which is what makes `tests/integration/scope-check.test.ts` cover them with no new test. Every read and write goes through a repo on `ProjectScope`; the worker uses the same `forJobRunner(projectId, createdByUserId)` scope; the claim's only cross-project query stays inside `crossProject("scheduler: claim due standing series", …)`. The rows and occurrences tables use composite `(project_id, id)` foreign keys up the series chain. The one single-column FK — a row's `media_asset_id` (**B22**, forced by the absence of `unique(project_id, id)` on `media_assets`) — is backed by resolution through the **scoped** media repo and by an explicit isolation test for US6 AS4. The existing `standing_series: ["manage"]` permission is checked in the **service**, so a hand-built POST is refused identically (FR-049). | **PASS** |
| **IV. One service layer, many callers** | One `runGenerationStep` call, one `applyApprovalPolicy` call, one `saveGeneratedPost`, one `resolvePositionMedia`, one `recordFailure`, one `renderTemplate` call site for a dated position. One **`evaluateDatedSeries`** used by the producer, by Resume and by the read path (**B24**). One **`queueFloor`** read by all three `allocateNextFree` floor call sites (**B13**). One local-midnight resolver (`periodStartInstant`, reused — **B7**). One CSV parser with two views (**B1**). One date formatter file gaining two exports rather than a second formatter appearing (**B30**). | **PASS** |
| **V. Providers are plug-ins** | No provider, publishing, composer or schema change. The media-required behaviour is still read from the capability declaration, so a future provider that declares it needs nothing here. The LLM and image providers are untouched: `generate` still receives the series' stored prompt and the fixed real-people instruction and nothing else, so FR-018/SC-010 hold by **adding nothing** to what already composes that call. | **PASS** |
| **VI. Boring, few dependencies** | Nothing added to `package.json`. No queue, no Redis, no second process, no cron, **no new environment variable** (FR-005). The worker pass is the same section with one extra OR branch in its claim. The new concepts are two tables and one pure module. | **PASS** |
| **VII. Secrets never leak** | No credential is read, stored or passed. Every stored message is either a fixed sentence from `llmFailureMessage` / `imageFailureMessage`, an enum (`skip_reason`, `outcome`), or an **import problem composed from the file's own line number and a fixed reason** — never provider text and never a raw payload. `assertAuditDetailsSafe` still guards the audit rows the four new actions write. `tests/integration/security/secret-scan.test.ts` is **extended** with a dated series, an import with problems and all three roles across the new sections — never exempted. | **PASS** |
| **Engineering: Neon-safe, no session-level features** | Plain selects, the existing `FOR UPDATE SKIP LOCKED` claim, plain updates, one additive forward-only migration. The import's mutual exclusion is an optimistic `list_version` guard (**B21**) — an ordinary row lock plus a `WHERE` clause — not an advisory lock, and the alternative `FOR UPDATE NOWAIT` was rejected for being a worse fit for FR-029's "refuse the loser". `ALTER TYPE … ADD VALUE` adds each value without using it in the same transaction, as the existing migrations do. | **PASS** |
| **Engineering: `runTick()` bounded, killable, concurrent-safe** | [contracts/worker.md](./contracts/worker.md). **Bounded**: the same two limits, one run (one date) per claim, the evaluation pass capped at 50 retired rows and 50 recorded misses, the same pre-call budget checks that release rather than overrun. **Concurrent-safe**: the same skip-locked claim and lease; `unique(series_id, period, period_start)` makes a second run for a date impossible; `unique(row_id, year)` makes a second firing of a row in a year impossible; the existing partial unique index makes a second post for a position impossible; `list_version` makes a half-replaced list impossible. **Killable**: an abandoned lease is recovered unchanged; a `running` position whose post exists is finished with no model call; one without a post is requeued with an attempt counted and fails as `interrupted` at the cap. No provider call inside a transaction. | **PASS** |
| **Engineering: UTC storage, Temporal with explicit DST disambiguation** | Every instant column is `timestamptz` and every write takes `clock.now()`. A **date** is stored as `date` and a month/day as two smallints, so nothing zone-dependent is cached (**B4**, **B5**, **B6**) and a zone change needs no migration and no recomputation. The one place a local date becomes an instant is `periodStartInstant` with `disambiguation: "compatible"` — a missing midnight moves forward, a doubled one takes the earlier offset — and a test asserts the local-date and instant forms of eligibility agree in both DST directions. | **PASS** |
| **Engineering: accessibility, server components, `docket-ui`** | [contracts/ui.md](./contracts/ui.md): server components except the import control and the row dialog; shared `Table`/`Row`/`Cell`/`Sub`, `Card`, `Alert`, `Dialog`, `EmptyState`, `Pagination`, `Field`, `SegmentedControl` (never a native `<select>`), `ActionBar`, `LiveRegion`; **five columns** on the rows table with the remaining fields as a `Sub` line and the full row in its editor (**B28**, the one place this plan reinterprets a spec decision, named here so review judges it); labelled controls, `aria-describedby` help, errors announced and focused; `loading.tsx` per route; an empty state that says what to upload; every instant through `LocalTime` and every calendar date through the new `LocalDate`, both backed by the single allowlisted formatter file (**B30**). | **PASS** |
| **Workflow: commits, quality gates, docs** | Conventional Commits with the required trailer, explicit paths only. `pnpm db:check` and `pnpm build` are in the final pass, because the schema and routes change. FR-054's and FR-055's two documents are tasks, not afterthoughts, and so is recording A1–A38 plus B1–B34 under `## 062` in `docs/decisions.md`. | **PASS** |

**No violations. [Complexity Tracking](#complexity-tracking) is therefore empty.**

Five points named so review judges them rather than discovering them:

1. **`posts.queue_not_before` changes behaviour outside this feature, intentionally.** Three existing
   call sites learn a floor, and a post carrying one can no longer be queued or pulled forward before
   it. Every existing post has `NULL` there, so `queueFloor` returns `now` and every existing test
   stays green — but this is a shared-path change and **B13** states why the narrower alternative
   (pass the floor from the worker only) leaves US4 false on the review path.
2. **Two enum values on existing enums.** `standing_series_period += 'date'` is what lets
   `unique(series_id, period, period_start)` serve as "one run per due date" without a nullable
   column silently voiding it (**B15**); `standing_series_position_status += 'missed'` is what keeps a
   closed window out of the skip-reason enum (**B16**). Both are additive; `countByStatus`'s zero map
   and the run problem view widen with them.
3. **The parser is edited, and its existing tests are the proof.** `parseJobCsv` keeps its exact
   messages, ordering and early returns; the extraction is a pure refactor beneath an unchanged
   signature. **`csv.test.ts` must pass with no edit at all** — if a task needs to touch it, the
   refactor is wrong (FR-020).
4. **The rows table shows five columns, not the file's own columns.** **B28**. The design-system rule
   is absolute and a 12-column file would break it; every field is still visible in the row editor
   and the import preview. This is the one place the plan reads a spec decision (A37) in the spirit
   rather than the letter.
5. **A dated series is ordered after same-tick due cadence series in the claim.** `next_run_at` is
   NULL for a dated series (**B5**), so the explicit `NULLS LAST` puts it second. A cadence series
   stops being due as soon as its run opens, while a dated window lasts at least a full day, so this
   cannot starve a date — and a test asserts a dated series is still claimed while cadence series
   are due.

---

## Project Structure

### Documentation (this feature)

```text
specs/072-dated-series/
├── spec.md                 # input (A1–A38)
├── plan.md                 # this file
├── research.md             # Phase 0 — what exists on main, and decisions B1–B34 with their sources
├── data-model.md           # Phase 1 — two tables, the changed columns, the occurrence lifecycle
├── contracts/
│   ├── services.md         #   the pure dated module, the parser split, the schemas, the repos,
│   │                       #   import/rows/evaluate, and the producer's three-line fork
│   ├── worker.md           #   the claim predicate, the run open, the missed pass, the bounds
│   ├── ui.md               #   the three sections, the form change, the four actions, a11y
│   └── verified.md         #   the SQL this plan depends on, RUN against the real Postgres
├── quickstart.md           # Phase 1 — runnable validation, SC-001…SC-011 plus the edge cases
└── tasks.md                # Phase 2 — /speckit-tasks, NOT created here
```

### Source code (repository root)

```text
src/
├── lib/
│   ├── series/
│   │   ├── dated.ts                          # NEW  pure: parse a date, target date, leap rule,
│   │   │                                     #      next target date, eligibility, upcoming
│   │   ├── dated.test.ts                     # NEW
│   │   └── cadence.ts                        # untouched (periodStartInstant reused — B7)
│   ├── validation/
│   │   ├── standing-series.ts                # + occurrenceRule, leadDays, nullable cadence,
│   │   │                                     #   datedRow schemas, config `rule` (B33)
│   │   ├── standing-series.test.ts           # EXTENDED
│   │   └── dated-rows.ts                     # NEW  the row/import input schemas and their limits
│   ├── jobs/template.ts                      # untouched (reused for rendering and the refusal)
│   └── time/format.ts                        # + formatLocalDate, formatMonthDay (B30)
├── components/ui/
│   ├── LocalDate.tsx                         # NEW  a <time dateTime="YYYY-MM-DD"> (B30)
│   └── CsvProblemList.tsx                    # MOVED here from the jobs/new/csv route (B32)
├── server/
│   ├── db/
│   │   ├── schema/
│   │   │   ├── standing-series.ts            # + two tables, two enums, 'date', 'missed',
│   │   │   │                                 #   five columns, two relaxed to nullable, `dated`
│   │   │   └── posts.ts                      # + queue_not_before
│   │   └── project-owned.ts                  # + two lines
│   ├── dal/
│   │   ├── standing-series-dated.ts          # NEW  the rows and occurrences repos
│   │   ├── standing-series.ts                # + the new patch fields, list_version guard
│   │   ├── standing-series-claims.ts         # + the dated OR branch and the projects join (B8)
│   │   ├── scope.ts                          # + the two repos (no KEY_GRANTS entry)
│   │   ├── media.ts                          # + findLiveByFilenames (B23)
│   │   └── posts.ts                          # + queueNotBefore in the patch type
│   ├── scheduler/
│   │   ├── housekeeping.ts                   # + prune occurrences older than 90 days (B27)
│   │   ├── standing-series.ts                # untouched
│   │   └── loop.ts                           # + the two new counts (B34)
│   └── services/
│       ├── standing-series/
│       │   ├── dated-import.ts               # NEW  parse → classify → replace the list (B2, B21)
│       │   ├── dated-rows.ts                 # NEW  add / edit / delete one row
│       │   ├── dated-due.ts                  # NEW  evaluateDatedSeries, the missed pass (B24–B26)
│       │   ├── run.ts                        # + the dated branch of openOrResumeRun
│       │   ├── runner.ts                     # + the three-line fork (B9, B10, B13)
│       │   ├── media.ts                      # + the row-asset prefix (B12)
│       │   ├── manage.ts                     # + the rule/lead fields, the edit refusal, Resume
│       │   └── read.ts                       # + upcoming, rows, lastImport, the run's date
│       ├── jobs/sources/csv.ts               # parseCsvFile extracted; parseJobCsv a wrapper (B1)
│       ├── generation/policy.ts              # + the queue floor passes through
│       ├── posts/index.ts                    # + queueFloor, used at three call sites (B13)
│       └── queue/index.ts                    # untouched (already takes `after`)
└── app/p/[projectSlug]/jobs/series/
    ├── actions.ts                            # + four actions: import, add, edit, delete a row
    ├── StandingSeriesForm.tsx                # + the rule picker and the lead-time field (B31)
    ├── DatedListImport.tsx                   # NEW  client: file input, preview, problems
    ├── DatedRowDialog.tsx                    # NEW  client: add / edit one row
    └── [seriesId]/page.tsx                   # + Upcoming, Last import, Rows (B28, B29)

drizzle/
└── <n>_dated_series.sql                      # NEW  pnpm db:generate, committed

tests/
├── integration/dated-series/
│   ├── import.test.ts                        # NEW  US2, SC-005
│   ├── reimport.test.ts                      # NEW  US2 AS5–AS6, FR-024
│   ├── rows.test.ts                          # NEW  FR-028, the per-date cap, the key rules
│   ├── due.test.ts                           # NEW  US1, US3 AS1–AS3, AS6–AS7, SC-002, SC-004, SC-006
│   ├── missed.test.ts                        # NEW  US3 AS4–AS5, SC-008
│   ├── lead-time.test.ts                     # NEW  US4, SC-003
│   ├── idempotency.test.ts                   # NEW  US5, SC-007
│   ├── media.test.ts                         # NEW  FR-015–FR-018, SC-010
│   ├── authz.test.ts                         # NEW  US6, SC-009
│   ├── edges.test.ts                         # NEW  the spec's edge-case list
│   └── ui.test.tsx                            # NEW  FR-047, FR-053
├── integration/standing-series/parity.test.ts # EXTENDED — SC-011, cadence unchanged
├── integration/scope-check.test.ts            # covers the two tables from project-owned.ts
├── integration/security/secret-scan.test.ts   # EXTENDED
├── integration/actions-authz.test.ts          # EXTENDED — the four new actions
└── (unit) src/server/services/jobs/sources/csv.test.ts            (UNCHANGED — the FR-020 proof)
        src/lib/series/dated.test.ts, src/lib/validation/*.test.ts,
        src/server/services/posts/*.test.ts                        (NEW / EXTENDED)

docs/
├── generator.md            # + "Dated list" inside "Standing series" (FR-054)
└── decisions.md            # + "## 062 — Date-pegged series" with A1–A38 and B1–B34 (FR-055)
```

**Structure Decision**: the existing single-app layout, unchanged. The date rules go in a **pure**
`src/lib/series/dated.ts` beside `cadence.ts`, which `071` established as where wall-time rules live —
testable with no database and importable by the UI for the upcoming list. The import, row editing and
due evaluation are **services** because they write project-owned rows (constitution III/IV). The two
repos are a DAL module beside `standing-series.ts`. The claim stays one cross-project DAL query. The
interface adds **no new route**: the list lives on the series detail page the roadmap already placed
under Jobs, and the four writes are server actions in the existing `actions.ts`.

---

## Phase 0 — research

See [research.md](./research.md). § 1 reads the eleven places on `main` this entry touches or reuses,
with paths and line numbers. § 2 records plan decisions **B1–B34**. § 3 records the one correction to
the spec. § 4 states what is deliberately not asserted.

## Phase 1 — design

- [data-model.md](./data-model.md) — the two tables, the changed columns, the three enum additions,
  the occurrence lifecycle, the identity and cap rules, and what each constraint guarantees.
- [contracts/services.md](./contracts/services.md) — the pure dated module's signatures, the parser
  split, the Zod schemas, the two repos, `importDatedList` / `addDatedRow` / `updateDatedRow` /
  `deleteDatedRow` / `evaluateDatedSeries`, and the producer's fork.
- [contracts/worker.md](./contracts/worker.md) — the claim predicate, opening a dated run, the
  bounded missed pass, the counts, the housekeeping and the unchanged bounds.
- [contracts/ui.md](./contracts/ui.md) — the three sections, the form change, the four actions, the
  five-column rows table, and the accessibility rules each screen must meet.
- [contracts/verified.md](./contracts/verified.md) — the SQL this design depends on, **run** against
  the project's own Postgres: `date - smallint`, the project-local-date expression the claim uses,
  and the row table's five CHECKs and identity index exercised with ten inserts.
- [quickstart.md](./quickstart.md) — how to run every one of SC-001…SC-011 and the edge-case list.

## Complexity Tracking

> Fill ONLY if the Constitution Check has violations that must be justified.

*No violations. This section is intentionally empty.*
