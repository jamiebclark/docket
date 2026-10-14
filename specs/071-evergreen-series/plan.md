# Implementation Plan: Standing content series that keep producing posts on a cadence

**Branch**: `071-evergreen-series` | **Date**: 2026-10-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/071-evergreen-series/spec.md`

Roadmap `.specify/roadmaps/content-engine-roadmap.json`, entry **3 of 6**, slug `evergreen-series`.

---

## Summary

Generation on `main` is finite in both its shapes: a batch job freezes a fixed item list and closes,
and the in-request series writes its posts while a person waits. This entry adds the opposite — a
**standing series** that keeps producing until someone stops it — and it does so by reusing, not
copying, every piece of machinery that already exists.

The design is four parts:

1. **Three tables.** `standing_series` is configuration (name, brief, instructions, voice profile,
   targets, cadence, media source, the authorised policy pair, `enabled`, `lastRunAt`/`nextRunAt`).
   `standing_series_runs` is one period's work, and **carries a snapshot of the configuration it
   opened with** — which is the whole of "an edit does not change an open run", with no lock between
   a person and the worker. `standing_series_positions` is one intended post, ending *produced*,
   *skipped* or *failed*, and is the row every idempotency and media-reservation guarantee hangs off.
   The period is keyed by `(period, local date)` with a unique constraint, so "at most one run per
   period" is a database fact rather than a timing argument.

2. **A pure cadence engine**, `src/lib/series/cadence.ts`, in the shape
   `src/lib/email/schedule.ts` already set: no database, no `Date.now()`, every boundary resolved
   through Temporal with `disambiguation: "compatible"`. It answers four questions — which period
   contains an instant, what instant a period starts at, what the next boundary after now is, and how
   many boundaries were missed — and `dated-series` imports it rather than re-deriving it.

3. **A seventh section of the existing tick.** `runStandingSeries` claims due series with
   `FOR UPDATE SKIP LOCKED` plus a lease, oldest-due first, gated by the **same**
   `gateCreditHolds` the batch claim uses, bounded by its **own** two limits, and reports its own
   counts in the tick summary and a `standing_series` heartbeat. Inside a claim, the producer opens
   or resumes a run, plans once (storing the plan before the first post is written), and produces
   positions one at a time through `runGenerationStep` and `applyApprovalPolicy` — **the same**
   functions, with no series-specific prompt, schema, retry, failure kind or policy branch.

4. **One section on `/jobs`** plus three routes under `/jobs/series`, owner/admin behind a new
   `standing_series: ["manage"]` statement that **no API-key permission grants**, so "no public API
   surface" is structural rather than an omission.

Media is resolved per position, immediately before the model call, and the chosen asset is written
onto the position — so a restart reuses the image instead of paying to generate a second one. A pool
image is reserved by the same kind of partial unique index `generation_job_items` already uses, and
the shared reservation predicate in `src/server/dal/media.ts` is widened to cover both tables, which
is what makes "a batch job and a standing series want the same image" resolve itself.

**Scale**: three tables, seven new enums, nine values added across three existing enums
(`generation_mode`, `llm_usage_purpose`, `membership_action`), one new nullable column on `posts`,
two on `generation_failures`, one migration. One new permission, two new environment variables.
**No new runtime dependency, no new infrastructure, no new process, no queue, no API surface, no
webhook, no notification.**

---

## Technical Context

**Language/Version**: TypeScript (strict), Node 24 LTS, pnpm

**Primary Dependencies**: Next.js 16 (App Router, standalone output), Drizzle ORM
(`drizzle-orm/node-postgres`), Zod 4, `@js-temporal/polyfill`, `sharp`, Tailwind 4, Vitest.
**No new runtime dependency** (constitution VI) — the Temporal polyfill, Drizzle, Zod and the
provider SDKs are all already in `package.json`.

**Storage**: Postgres. Three new project-owned tables (`standing_series`,
`standing_series_runs`, `standing_series_positions`), seven new enum types, one nullable column plus
a composite FK (`ON DELETE SET NULL`) and a partial unique index on `posts`, two nullable columns
plus a cascading FK and two CHECKs on `generation_failures`, and nine values added to three existing
enums. One forward-only SQL migration, generated and committed, **no backfill**. S3-compatible
object storage only through the existing `Storage` interface, reached only via `uploadMedia`.

**Testing**: Vitest. Unit tests for the pure cadence engine (week start, month start, both DST
directions, month-end rollover, missed-boundary counting), the avoid-titles cap, the validation
schemas and the section's config defaults. Integration tests against a real Postgres (port **5555**)
for cadence firing and not firing, no backfill, overlapping-tick and restart idempotency, lease
recovery, deadline release, policy application in all four combinations, slot double-booking across
two concurrent series, every media branch, credit holds, self-pause, project isolation, authorization
and the interface. **No test makes a live provider call** (constitution II): text through a stub
`LlmProvider` / `createFakeLlmFetch`, images through `setImageProviderForTests`, time through
`clock.runAtTime`. Everything requiring real credentials is reported as **verified with mocks only**.

**Target Platform**: Linux server — Docker Compose (web, worker, postgres) and Neon with only the
connection string changed. No advisory lock, no `LISTEN`, no session-level Postgres feature.

**Project Type**: Web application — Next.js App Router monolith plus a worker; services in
`src/server/services/`, data access in `src/server/dal/`, pure helpers in `src/lib/`.

**Performance Goals**: none asserted against a live API. The section is bounded by the existing tick
budget: a model call needs `JOB_MIN_CALL_MS` (8 s) plus `JOB_PERSIST_RESERVE_MS` (3 s), and the
default `SCHEDULER_TICK_BUDGET_SECONDS` is 20. Throughput wording in `docs/generator.md` is **derived**
from the ~1.3 s per call already recorded there for `gpt-5.4-mini` on 2026-10-12; this entry measures
nothing new.

**Constraints**: at most one run per series per period and at most one open run, both enforced by
unique indexes; at most one post per position, enforced by a partial unique index on `posts`; no
model, image, storage or sharp work inside a held transaction; no section-level Postgres feature; a
pooled asset reserved so no other series, run or batch job can take it; a position that cannot
satisfy a media requirement **skipped whole** with the cause and the account named; a skip never
counts an attempt and never makes a run "with failures"; no backfill of missed periods; no
credential, provider error text or raw payload in any stored row, log line, message or screen; one
`applyApprovalPolicy` call site with no bypass; one-off Generate, the in-request series and finite
batch jobs behave **exactly** as they do today.

**Scale/Scope**: three tables; one migration; one pure library module plus one sibling; one DAL
claim module plus three repos; four service modules (`manage`, `read`, `runner`, plus the run/plan
helpers); one scheduler section; one new permission; two environment variables; one housekeeping job;
one section and three routes in the interface; roughly twelve new test files plus eight extended
ones; three documents and `.env.example`.

**No `NEEDS CLARIFICATION` and no `NEEDS RESEARCH` remains.** The spec left no external fact open,
and [research.md](./research.md) § 2 closes every plan-level choice. One factual correction to the
spec is recorded (research § 1.5): FR-008's "activity log" is the **audit log** in this codebase.

---

## Constitution Check

*GATE: passed before Phase 0, re-checked after Phase 1 design. Both evaluations below.*

| Principle | How this design satisfies it | Post-design verdict |
|---|---|---|
| **I. Verified facts over memory** (non-negotiable) | Nothing here is recalled. [research.md](./research.md) § 1 is a file-by-file reading of the two existing generation shapes, the core, the prompt builder, the policy function, the allocator, the claim, the credit hold, the media repo, the image generator, the role matrix, the audit and activity logs and the time helpers — each with the path it came from. Which providers require media comes from `caps.media.required` in `src/providers/requirements.ts` and `validation.ts`, never from a literal. Period arithmetic comes from the installed `@js-temporal/polyfill` and follows `resolveOccurrence`'s existing `disambiguation: "compatible"` rule. The one claim the spec made that the code does not support — that configuration changes land in the *activity* log — was checked against `src/lib/activity/outcomes.ts` and corrected (research § 1.5, **S27**). No price, no latency and no model id is asserted. | **PASS** |
| **II. Nothing is "working" unless it ran** | Every success criterion has a named runnable check in [quickstart.md](./quickstart.md). No live provider call anywhere: text through a stub `LlmProvider` or `createFakeLlmFetch`, images through `setImageProviderForTests`, time through `clock.runAtTime`, concurrency through two real un-awaited `runTick` calls against a real Postgres. Idempotency is asserted **by counting rows**, never inferred from timing (SC-002). The planner's actual obedience to "avoid these titles" is explicitly **not** asserted, because asserting it would need a live call — research § 4 says so rather than implying otherwise. | **PASS** |
| **III. Project isolation enforced in one place** | Three new tables, each carrying `project_id`, each added to `src/server/db/project-owned.ts` — which is what makes `tests/integration/scope-check.test.ts` cover them without a new test. Every read and write goes through a repo on `ProjectScope`; the worker uses `forJobRunner(projectId, createdByUserId)`, the same scope the batch runner uses, and the claim's only cross-project query is inside `crossProject("scheduler: claim due standing series", …)` exactly as `claimDueJobItems` is. Every composite FK is `(project_id, id)`, so a row cannot reference another project's. The lint rule keeps raw database access out, and the new permission is checked in the **service**, so a hand-built POST is refused identically. | **PASS** |
| **IV. One service layer, many callers** | One `applyApprovalPolicy` call in this feature, one `runGenerationStep` call, one `planSeries` call, one `queueTargetsInTx` (reached through the policy), one `saveGeneratedPost`, one `createImageGenerator`, one `uploadMedia`, one `nextRetryAt`, one `gateCreditHolds`. The cadence engine is one pure module with one answer per question. The shared pieces the producer needs are **extracted, not copied**: `withinBudget`/`Overran`/the redacted log move to `src/server/scheduler/budget.ts` (**S36**), and the owner→project resolution is generalised once (**S37**). `src/server/dal/media.ts`'s reservation predicate is **widened**, so there is still exactly one definition of "this asset is taken" (**S15**). | **PASS** |
| **V. Providers are plug-ins** | No social provider, scheduler-publishing, composer or publishing-schema change. The media-required behaviour is driven entirely by the capability declaration, so a future provider that declares it needs no change here (spec assumption). The LLM and image providers are untouched: the producer wraps the same decorators from outside. | **PASS** |
| **VI. Boring, few dependencies** | Nothing added to `package.json`. No queue, no Redis, no broker, no second process, no cron. The worker pass is a section of the loop that already exists. Two environment variables, where every other operator setting lives. The only new concepts are three tables and one pure module. | **PASS** |
| **VII. Secrets never leak** | No credential is read, stored or passed anywhere in this feature — the producer resolves the provider through the existing `resolveLlmForProject` / `resolveImageLlmForProject` and never sees a key beyond handing it to `redact()` for the log line (**S36**, the same code the batch runner uses). Every stored message is a fixed sentence from `llmFailureMessage` or `imageFailureMessage`; a skip reason is an **enum**, so no provider text can reach a row or a screen (**S19**). `assertAuditDetailsSafe` refuses a secret-shaped details key. `tests/integration/security/secret-scan.test.ts` is **extended** with a standing series, a pool, a generated image and all three roles across both new screens — never exempted. | **PASS** |
| **Engineering: Neon-safe, no session-level features** | Plain selects, `FOR UPDATE SKIP LOCKED`, plain updates, one additive forward-only migration. No advisory lock, no `LISTEN`/`NOTIFY`, nothing that needs a session (FR-048). `ALTER TYPE … ADD VALUE` adds each value without using it in the same transaction, which is what the existing migrations already do. | **PASS** |
| **Engineering: `runTick()` bounded, killable, concurrent-safe** | The section is the subject of [contracts/worker.md](./contracts/worker.md). Bounded: two documented limits of its own, plus a budget check before every model call that releases rather than overruns. Concurrent-safe: one `FOR UPDATE SKIP LOCKED` claim per series plus a lease, so two ticks never take the same series; two unique indexes make a second run for a period impossible; one partial unique index makes a second post for a position impossible. Killable: an abandoned lease is recovered, a `running` position with a post becomes a no-model-call finish, one without a post is requeued with an attempt counted (never for a probe) and fails as `interrupted` at the cap. No provider call inside a transaction. A failure in the section cannot touch the other six. | **PASS** |
| **Engineering: UTC storage, Temporal with explicit DST disambiguation** | Every instant column is `timestamptz` and every write takes `clock.now()`. All wall-time arithmetic is in one pure module using `toPlainDateTime().toZonedDateTime(zone, { disambiguation: "compatible" })` — a midnight inside a spring-forward gap resolves to one instant just after it, one inside an autumn overlap to the earlier offset, so a boundary is never skipped and never doubled. A run's identity is a **local date**, so changing the project's zone recomputes the next boundary and relabels no history. | **PASS** |
| **Engineering: accessibility, server components, `docket-ui`** | [contracts/ui.md](./contracts/ui.md): server components except one form and one row-actions component; shared `Table`/`Row`/`Cell`/`Sub`, `StatusBadge`, `EmptyState`, `Alert`, `Dialog`, `ChoiceField`/`SegmentedControl` (never a native `<select>`), `TextareaField`, `ActionBar`, `LiveRegion`; five columns on the list and four on the log table; `<fieldset>`/`<legend>` for the two groups; labelled controls, `aria-describedby` help, errors announced, focus to the first invalid field; `loading.tsx` per route, an explained empty state, the route `error.tsx`; every instant through `LocalTime`/`formatLocal`; semantic tokens only; a delete dialog that names the series. | **PASS** |
| **Workflow: commits, quality gates, docs** | Conventional Commits with the required trailer, explicit paths only. `pnpm db:check` and `pnpm build` are in the final pass, because the schema and routes changed. FR-067's three documents (`docs/generator.md`, `docs/decisions.md`, `.env.example`) are tasks, not afterthoughts, and so is the W1–W34 + S1–S40 decision log. | **PASS** |

**No violations. [Complexity Tracking](#complexity-tracking) is therefore empty.**

Five points named so review judges them rather than discovering them:

1. **Three tables is the budget, and all three earn it.** The configuration cannot also be the work
   list (W2), and the run cannot also be the position: a skip, a lasting failure and a produced post
   are three outcomes of one slot, and every idempotency guarantee in SC-002 is a per-slot statement.
   A `jsonb` array of positions on the run would give up the partial unique index that makes the
   image reservation correct and the per-position backoff column that makes FR-022 correct.
2. **A new enum value on `generation_mode` and two on `llm_usage_purpose`.**
   `no-missing-usage-purpose.test.ts` widens from eight call sites to ten; that guard exists precisely
   to make a widening deliberate, and **S13** chose to pay it rather than make a standing series
   indistinguishable from a person's series on the cost screen.
3. **One behaviour change outside this feature, intentional.** Widening
   `src/server/dal/media.ts`'s reservation predicate means an asset held by a live standing-series
   position is no longer offered to a new batch job and shows as reserved in the library. That is the
   spec's own edge case ("one of them gets it and the other treats it as unavailable"), and every
   existing job test stays green because no standing-series rows exist in them.
4. **A new permission statement** (`standing_series: ["manage"]`). Code only — roles live in
   `src/server/auth/access.ts` — so no migration, but `access.test.ts`'s matrix must name it for all
   three roles or the suite fails. It is granted to **no** API-key permission, which is how FR-060
   holds for a hand-built API request.
5. **`src/server/dal/credit-holds.ts` and `gateCreditHolds` are shared, not duplicated.** One probe
   budget serves the whole install across both sections. A consequence worth stating: in a tick where
   a held owner is granted its one probe, that probe may be spent by *either* section. That is
   correct — the probe asks "is this credential spending again?", and either section's call answers
   it.

---

## Project Structure

### Documentation (this feature)

```text
specs/071-evergreen-series/
├── spec.md                 # input (W1–W34)
├── plan.md                 # this file
├── research.md             # Phase 0 — what exists on main, and decisions S1–S40 with their sources
├── data-model.md           # Phase 1 — three tables, seven enums, the changed columns, the lifecycle
├── contracts/
│   ├── services.md         #   the cadence engine, the schemas, the repos, manage/read, the producer
│   ├── worker.md           #   the section, the claim SQL, the bounds, credit holds, housekeeping, config
│   └── ui.md               #   the routes, the section, the detail page, the form, the actions, a11y
├── quickstart.md           # Phase 1 — runnable validation, SC-001…SC-012 plus the edge cases
└── tasks.md                # Phase 2 — /speckit-tasks, NOT created here
```

### Source code (repository root)

```text
src/
├── lib/
│   ├── series/
│   │   ├── cadence.ts                        # NEW  pure: periods, boundaries, missed count
│   │   ├── cadence.test.ts                   # NEW
│   │   ├── avoid.ts                          # NEW  pure: AVOID_RUNS, AVOID_TITLES_MAX, avoidTitles
│   │   └── avoid.test.ts                     # NEW
│   ├── validation/
│   │   ├── standing-series.ts                # NEW  create/update schemas, the run config schema
│   │   ├── standing-series.test.ts           # NEW
│   │   └── generation.ts                     # + "standing_series_post" in generationRecordSchema.mode
│   └── jobs/template.ts                      # untouched (reused for the placeholder refusal)
├── server/
│   ├── db/
│   │   ├── schema/
│   │   │   ├── standing-series.ts            # NEW  three tables, seven enums
│   │   │   ├── index.ts                      # + the re-export
│   │   │   ├── posts.ts                      # + standing_series_position_id, FK, unique index
│   │   │   ├── generation.ts                 # + two generation_mode and two llm_usage_purpose values,
│   │   │   │                                 #   two generation_failures columns, FK and CHECKs
│   │   │   └── audit.ts                      # + five membership_action values
│   │   └── project-owned.ts                  # + three lines
│   ├── auth/access.ts                        # + standing_series:["manage"] on statements, owner, admin
│   ├── env.ts                                # + STANDING_SERIES_TICK_MAX_SERIES / _MAX_POSTS
│   ├── dal/
│   │   ├── standing-series.ts                # NEW  three repos
│   │   ├── standing-series-claims.ts         # NEW  claimDueStandingSeries
│   │   ├── scope.ts                          # + the three repos (no KEY_GRANTS entry)
│   │   ├── media.ts                          # + claimPoolImage; reservations widened (S15, S16)
│   │   ├── posts.ts                           # + findByStandingSeriesPosition
│   │   ├── generation-failures.ts            # + listForRun, two insert fields
│   │   └── credential-owners.ts              # resolveBlockedProjectIds generalised (S37)
│   ├── scheduler/
│   │   ├── standing-series.ts                # NEW  the section, its counts, its heartbeat
│   │   ├── budget.ts                         # NEW  withinBudget / Overran / redacted log (moved, S36)
│   │   ├── index.ts                          # + the seventh section and TickSummary field
│   │   ├── config.ts                         # + standingSeriesConfig and the two optional fields
│   │   ├── loop.ts                           # + three counts on the one-line summary
│   │   └── housekeeping.ts                   # + pruneClosedStandingSeriesRuns (S39)
│   └── services/
│       ├── standing-series/
│       │   ├── index.ts                      # NEW
│       │   ├── manage.ts                     # NEW  create / update / pause / resume / delete
│       │   ├── read.ts                       # NEW  list / get, counts derived from positions
│       │   ├── runner.ts                     # NEW  processClaimedSeries
│       │   ├── run.ts                        # NEW  open-or-resume, close, deriveRunOutcome, self-pause
│       │   └── media.ts                      # NEW  resolve one position's image, or its skip reason
│       ├── generation/
│       │   ├── prompt.ts                     # + avoidTitles on buildSeriesPlanPrompt (empty = identical)
│       │   ├── series.ts                     # + avoidTitles and an explicit purpose on planSeries
│       │   └── save.ts                       # + the fourth GeneratedPostLink variant
│       ├── jobs/runner.ts                    # - withinBudget/Overran/logLine, + the import (no behaviour change)
│       └── media.ts                          # untouched
└── app/p/[projectSlug]/jobs/
    ├── page.tsx                              # + the Standing series section
    └── series/                               # NEW  actions.ts, form, row actions, new/, [seriesId]/{,edit}
                                              #      (see contracts/ui.md § 1 for the file list)

drizzle/
└── <n>_standing_series.sql                   # NEW  pnpm db:generate, committed

tests/
├── integration/standing-series/
│   ├── cadence.test.ts                       # NEW  US1, SC-001, SC-008
│   ├── policy.test.ts                        # NEW  US2, SC-005
│   ├── idempotency.test.ts                   # NEW  US3, SC-002
│   ├── slots.test.ts                         # NEW  SC-004
│   ├── media.test.ts                         # NEW  US4, SC-006
│   ├── credit-hold.test.ts                   # NEW  US6 AS1–AS3, SC-007
│   ├── self-pause.test.ts                    # NEW  US6 AS4
│   ├── manage.test.ts                        # NEW  create/edit/pause/resume/delete + audit rows
│   ├── authz.test.ts                         # NEW  FR-060, FR-061, SC-009
│   ├── isolation.test.ts                     # NEW  SC-009
│   ├── parity.test.ts                        # NEW  SC-003
│   ├── edges.test.ts                         # NEW  the spec's edge-case list
│   └── ui.test.tsx                           # NEW  US5, SC-010
├── integration/scope-check.test.ts           # covers the three tables from project-owned.ts
├── integration/security/secret-scan.test.ts  # EXTENDED
├── integration/actions-authz.test.ts         # EXTENDED — the five new actions
├── lint/env-coverage.test.ts                 # EXTENDED by the two .env.example blocks
└── (unit) src/server/auth/access.test.ts, src/server/scheduler/config.test.ts,
        src/server/llm/no-missing-usage-purpose.test.ts,
        src/server/services/generation/prompt.test.ts + prompt.golden.test.ts   (all EXTENDED)

docs/
├── generator.md            # + "Standing series" after "Jobs", incl. the concurrency sentence (FR-045)
├── decisions.md            # + "## 061 — Standing content series" with W1–W34 and S1–S40
└── .env.example            # + the two variables in the generator group
```

**Structure Decision**: the existing single-app layout, unchanged. The cadence engine is a **pure**
`src/lib/` module because `src/lib/email/schedule.ts` and `src/lib/generation/usage-period.ts`
already establish that wall-time rules live there, testable without a database and importable by
`dated-series`. The claim is a DAL module because it is a cross-project scheduler query, beside
`job-claims.ts`. The producer is a service because it writes project-owned rows (constitution IV).
The section is one file in `src/server/scheduler/`, beside the six it joins. The interface adds no
nav entry: it lives under the Jobs item the roadmap named.

---

## Plan decisions

Forty decisions, **S1–S40**, recorded in `docs/decisions.md` under `## 061 — Standing content
series` after the spec's W1–W34. Full rationale, alternatives and the file each was read from are in
[research.md](./research.md) § 2.

| # | Decision |
|---|---|
| **S1** | Three tables: `standing_series`, `standing_series_runs`, `standing_series_positions`. A position is a row because every idempotency guarantee is a per-slot statement. |
| **S2** | The run carries a **configuration snapshot** (`config jsonb`) written at open; the producer reads the run, never the series. This is the whole of FR-056, with no lock between a person's edit and the worker. |
| **S3** | Run counts are **derived** from positions; only `outcome` is stored, once, at close — the `refreshJobStatus` rule, which is what keeps counters from double-counting under retries. |
| **S4** | A period is `(period, local date)` with `unique(series_id, period, period_start)`. The local date is stable across a time-zone change; `period` is in the key because the cadence is editable. |
| **S5** | The cadence engine is a pure module, `src/lib/series/cadence.ts`, following `src/lib/email/schedule.ts`. |
| **S6** | The claim unit is the **series**, leased on the series row. One holder makes "one open run" true by construction; positions need no second lease. |
| **S7** | Claim predicate: `enabled AND lease free AND (next_run_at <= now OR EXISTS (an open run with work due))` — because `next_run_at` advances when a run **opens**. |
| **S8** | Positions are created when the run opens; the plan is written with `UPDATE … WHERE plan IS NULL`, so "a restart must not re-plan" is a database fact. |
| **S9** | Plan retry bookkeeping is two run columns, `plan_attempt_count` and `plan_next_attempt_at`; the kind and message live in `generation_failures` like every other failure's. |
| **S10** | `posts` gains **one** nullable column, `standing_series_position_id`, FK `ON DELETE SET NULL`, with a partial unique index — simultaneously FR-021's uniqueness, FR-057's "deleting keeps posts", and the traceability Key Entities asks for. |
| **S11** | `GeneratedPostLink` gains `{ standingSeriesPositionId }`; `GenerationRecord.mode` gains `standing_series_post`. |
| **S12** | `generation_failures` gains `standing_series_run_id` + `standing_series_position` (nullable, so a **plan** failure belongs to the run); `generation_mode` gains two values; the FK cascades. |
| **S13** | Two new `llm_usage_purpose` values and **no** new column on `llm_call_usage`: a post call flushes with its `postId` exactly as a manual Generate does. |
| **S14** | Media is resolved **per position**, before the model call, and written onto the position — so a restart reuses the image instead of paying to generate a second one. |
| **S15** | The pool reservation is a partial unique index on positions; `src/server/dal/media.ts`'s reservation predicate is **widened** to count both tables. `failed` is excluded, because a lasting failure is never retried and must release its image. |
| **S16** | The pool claim is `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1` over unused, unreserved, tag-matching live images, oldest first, then the write that takes the unique index. |
| **S17** | The `generate` source calls `createImageGenerator(scope)` with the series' stored prompt and nothing else — satisfying FR-036 by **adding nothing** to what `generateImage` already composes. |
| **S18** | A position's `last_error_kind` reuses the existing `generation_job_item_error` enum, so `llmFailureMessage` and the `TEMPORARY` set map identically. |
| **S19** | A new `standing_series_skip_reason` enum of six values plus `skip_account_id` — an enum, so no provider text can reach a row or a screen. |
| **S20** | The run carries `outcome` (four values) and `blocked_reason` (two). Voice profiles are **archived**, never deleted, so the spec's "deleted voice profile" edge case is the archived case and the composite FK is safe. |
| **S21** | The run records `dropped_account_ids uuid[]`. |
| **S22** | A seventh section, `src/server/scheduler/standing-series.ts`, inside the existing `runTick()` — so the existing `section()` wrapper gives FR-047's isolation for free. |
| **S23** | Two environment variables for the section's **own** claim limits; the physical per-call constants (`minCallMs`, `persistReserveMs`, attempts, backoff) are shared, because two copies of "how long a model call takes" would drift. |
| **S24** | Series are processed **concurrently**, positions within a run **sequentially**. The extra concurrency ceiling is therefore `STANDING_SERIES_TICK_MAX_SERIES`, and that is the sentence FR-045 requires in `docs/generator.md`. |
| **S25** | One new statement, `standing_series: ["manage"]`, for `owner` and `admin`, with **no** `KEY_GRANTS` entry — so "no public API surface" is structural. |
| **S26** | Viewing the list and run history is gated by `post: ["view"]`, as FR-061 says and as the Jobs page already does. |
| **S27** | FR-008's log is the **audit log**: five new `membership_action` values. `activity_events` is publish-and-connect outcomes only (research § 1.5). |
| **S28** | **No** posting-instructions snapshot: a manual Generate reads them live, and FR-019 requires the prompt to compose exactly as a manual Generate's does. |
| **S29** | `template_fields` emptiness is enforced in Zod, not by a CHECK, so `dated-series` needs no second migration; the refusal reuses `checkTemplate`'s sentence. |
| **S30** | Avoid-titles: the **3** most recent closed runs, capped at **20** titles, both named constants. |
| **S31** | `buildSeriesPlanPrompt` gains `avoidTitles` and emits **nothing** when empty, so today's committed golden snapshots stay byte-identical. |
| **S32** | The producer re-reads `enabled` before each position — the only safe point FR-054's "next safe point" can mean. |
| **S33** | A position left `running` is reset by the next claim, counting an attempt unless the claim is a credit probe; at the cap it fails as `interrupted` with the existing message. |
| **S34** | A position that already has a post but no applied policy is a **finish** position: variants and policy, no model call — the batch runner's already-reviewed recovery, reused. |
| **S35** | Self-pause reads the three most recent closed runs' stored `outcome`, at close, in one indexed query. |
| **S36** | `withinBudget` / `Overran` / the redacted log line move to `src/server/scheduler/budget.ts`; `jobs/runner.ts` imports them. A pure move, proved by its existing tests staying green. |
| **S37** | `resolveBlockedProjectIds` is generalised to take candidate project ids; each table keeps its own three-line exclusion predicate. |
| **S38** | A **Standing series** section on `/jobs`, plus `/jobs/series/new`, `/jobs/series/[seriesId]` and `…/edit`. A static segment beside `[jobId]` is what `jobs/new` already does. |
| **S39** | Housekeeping prunes closed runs older than **90 days**, 200 per tick; positions and failures cascade; an open run is never pruned. |
| **S40** | No webhook, no notification, no email, no API, no real-time push: a run closing emits nothing, and a post emits whatever a post already emits. |

### Three places where the spec needed a resolution, resolved

Named here so the next phase does not rediscover them and review judges the resolution rather than
the surprise.

1. **FR-008's "activity log" does not exist in the shape the spec assumes.**
   `activity_events` is publish-and-connect outcomes only, with a kind/outcome CHECK pair, a
   `provider_keys` cardinality CHECK and a target-kind CHECK. The log that records configuration
   changes — and the precedent FR-008 itself cites, posting-instruction edits — is
   `membership_audit_log`. Resolved as **S27**: five new `membership_action` values. The requirement
   is honoured exactly; only its name for the log is corrected.

2. **FR-021's "uniqueness constraint on the run and position" and FR-057's "deleting a series keeps
   its posts" cannot both be satisfied by a two-column link from `posts`.** `ON DELETE SET NULL`
   nulls only the FK's own columns, which would break a `(run_id IS NULL) = (position IS NULL)` pair
   CHECK. Resolved as **S10**: the post references the **position** through one column, so SET NULL
   is coherent and the unique index on that one column is exactly the uniqueness FR-021 asks for.

3. **"The voice profile a series names is deleted" is not a reachable state.** `src/server/dal/voice.ts`
   has no delete; profiles are **archived**, and `takeVoice` already throws for an archived one.
   Resolved as **S20**: the edge case is implemented as the archived case, recorded on the run as
   `blocked_reason = 'voice_profile_missing'`, and the composite FK stays `NO ACTION` exactly as
   `generation_jobs`' does.

---

## Phase 0 — Outline & Research

**Output**: [research.md](./research.md) — complete.

§ 1 is a file-by-file reading of everything on `main` this entry builds on, in six tables: the two
finite generation shapes; the core, prompt, policy, save, failures, ledger and limits; the worker
tick, its claim, its config, its heartbeat, its credit hold, its backoff and its housekeeping; the
allocator, the occurrence resolver, the media repo, the media-required declaration, the image
generator, the scope, the roles, the project-owned list, the audit and activity logs, the clock and
the Jobs interface. § 1.5 records the one factual correction this research makes to the spec. § 2 is
the forty decisions **S1–S40**, each *Decision / Rationale / Alternatives considered* with its
source. § 3 resolves the three readings above. § 4 states plainly what this feature still does not
know — nothing new about any provider, no new throughput measurement, and no assertion that a
planner told to avoid twenty titles actually avoids them.

## Phase 1 — Design & Contracts

**Outputs**: [data-model.md](./data-model.md),
[contracts/services.md](./contracts/services.md), [contracts/worker.md](./contracts/worker.md),
[contracts/ui.md](./contracts/ui.md), [quickstart.md](./quickstart.md) — complete.

- **data-model.md** — the three tables column by column with every CHECK, unique index and composite
  FK and the requirement each serves; the seven new enums; the changes to `posts`,
  `generation_failures` and the three widened enums; the in-memory shapes
  (`StandingSeriesRunConfig`, `StandingSeriesPlan`, `ClaimedStandingSeries`,
  `StandingSeriesCounts`, the two views); the lifecycle event by event; and what the data model
  deliberately does not gain.
- **contracts/services.md** — the pure cadence engine's four functions and the boundary rules as a
  table; the avoid-titles module; the Zod schemas and the exact placeholder refusal sentence; the
  three repos and the two media-repo changes; `manage` step by step with the permission, the policy
  resolution and the audit row; `read`; and the producer in five parts — open-or-resume, plan,
  produce, finish, close — with the "no bypass" argument stated where the single
  `applyApprovalPolicy` call lives. Ends with a change table for every existing module, marked for
  behaviour change, and what the service layer does not gain.
- **contracts/worker.md** — the section's eight ordered steps; its counts; the claim as actual SQL
  with the reason for each clause; the two bounds, the config helper, the deadline rule and the
  concurrency sentence `docs/generator.md` must carry; the five credit-hold situations as a table;
  the housekeeping job; the two environment variables with their `.env.example` blocks; and what the
  worker pass does not gain.
- **contracts/ui.md** — the file list and why a static `series` segment is safe; the section on
  `/jobs` with its empty state and its five columns; the detail page's four blocks including the
  FR-064 sentence verbatim and the four-column run log; the form field by field with its help text;
  the row actions and the delete dialog's copy; the five server actions; an accessibility checklist;
  and what the interface does not gain.
- **quickstart.md** — a runnable check per success criterion **SC-001 – SC-012** plus the self-pause
  and edge-case suites, the guard tests, the final pass, a real-app walkthrough and a "done when"
  list.

## Phase 2 — Tasks

**Not produced by this command.** `/speckit-tasks` generates `tasks.md` from these artifacts.

Suggested ordering, following the spec's own priorities. The guiding rule: **US1, US2 and US3 are all
P1 and must land together**, because a standing series that fires but can bypass policy, or that can
double-generate, is worse than no standing series at all.

1. **The pure modules first**: `src/lib/series/cadence.ts` and `avoid.ts` with their unit tests, and
   `src/lib/validation/standing-series.ts`. They need no database and nothing depends on them being
   wrong.
2. **Schema + migration + `project-owned.ts` + `pnpm db:check`.** Nothing else can land without the
   tables, and `scope-check.test.ts` starts covering them the moment the list grows.
3. **The shared refactors, before anything consumes them** (**S36**, **S37**, **S15**, **S31**,
   **S11**): `scheduler/budget.ts`, the generalised owner→project resolution, the widened media
   reservation and `claimPoolImage`, `avoidTitles` on the plan prompt, the fourth
   `GeneratedPostLink` variant, the new permission and the two environment variables. Each is a
   no-behaviour-change move or an empty-case-identical addition, so SC-011's suites must be green at
   the **end of this step** — which is the cheapest moment to discover they are not.
4. **The DAL**: the three repos, the claim, `findByStandingSeriesPosition`, `listForRun`.
5. **`manage.ts` and `read.ts`** with `manage.test.ts` and `authz.test.ts` — create, edit, pause,
   resume, delete, the audit rows, the role refusals. A series that can be created and inspected is
   testable before the worker exists.
6. **The run lifecycle** (`run.ts`): open-or-resume, the no-backfill rule, closing a stale run as
   incomplete, `deriveRunOutcome`, the self-pause check. Tested against the clock with no model call
   at all — this is where **SC-001 and SC-008** land.
7. **The producer and the section** (`runner.ts`, `media.ts`, `scheduler/standing-series.ts`,
   `config.ts`, `index.ts`, `loop.ts`): **US1, US2 and US3 complete here**, and with them SC-002,
   SC-003, SC-004 and SC-005. The idempotency and slot tests belong in this slice, not after it.
8. **Media** — **US4**, SC-006: the pool branch, the generate branch, every skip reason, the
   restart-reuses-the-image assertion and the batch-job contention case.
9. **Credit holds and self-pause** — **US6**, SC-007: these need no new code beyond step 7's wiring,
   only the tests and the notice reuse.
10. **The interface** — **US5**, SC-010: the section on `/jobs`, the three routes, the form, the row
    actions, the five server actions, the extended `actions-authz` and `secret-scan`.
11. **Docs and the final pass**: FR-067's `docs/generator.md` section (including FR-045's
    concurrency sentence), `docs/decisions.md` `## 061` with W1–W34 and S1–S40, the two
    `.env.example` blocks, then `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check &&
    pnpm build`.

Step 3 is the one that is tempting to defer and must not be: writing the producer against copied
helpers and refactoring afterwards is how two redaction rules and two "this asset is taken"
definitions get into a tree.

---

## Complexity Tracking

No constitution violations, so this section is empty by design.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| *(none)* | | |

---

## What this plan does not do

Carried from the spec's own out-of-scope list; each item has a named owner or a stated reason.

- **No date-pegged occurrences.** Anniversaries, a spreadsheet of rows, lead time, leap days and
  missed-window handling belong to `dated-series`, which adds a second way to decide when a run
  opens. SC-012 is the assertion that it will cost nothing here: everything about a run's work reads
  the run's own snapshot, plan and positions (**S2**).
- **No change to one-off Generate, the in-request series or finite batch jobs**, beyond the change
  table in [contracts/services.md § 8](./contracts/services.md#8-changes-to-existing-modules) — one
  pure move, four empty-case-identical additions and one intended widening of the media reservation.
  Their existing tests pass unchanged (SC-011).
- **No public API, MCP or webhook surface.** Enforced structurally: the new permission is granted to
  no API-key permission (**S25**), and no `emitEvent` sibling exists for a run closing (**S40**).
  `setup-write-api` owns the API; the roadmap explicitly says it does not add series endpoints.
- **No notifications or email** about runs, skips or failures beyond what a post already produces and
  what the screens show.
- **No explicit-time scheduling** — the `scheduling_policy` enum has only two values, so FR-033 holds
  by construction — **no per-post override, no editing a run's plan, no re-running a closed run and
  no "run now"**.
- **No backfill** of periods missed while the worker was down (W10). A series that wakes up admits
  it lost three weeks.
- **No cross-period deduplication of post text.** Recent angle titles are passed as titles to avoid;
  Docket does not compare produced copy, and does not assert that the model obeyed (research § 4).
- **No video.** A pooled asset is an image, and nothing generates or attaches a video.
- **No per-series provider, model, credential, rate limit or spend cap**, and no change to
  `LLM_RATES`. Docket reports what was spent and does not predict or limit it.
- **No real-time push.** The screens reflect current state when loaded, as the Batch jobs screens
  already do.
- **No new infrastructure**: no queue, no Redis, no broker, no second process, no cron, no
  session-level Postgres feature (W30, FR-048, constitution VI).
