# Implementation Plan: Flake-proof integration-test architecture

**Branch**: `079-flake-proof-test-architecture` | **Date**: 2026-10-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/079-flake-proof-test-architecture/spec.md`

## Summary

Make CI flakes structurally impossible rather than fixing them one at a time, in four pieces that can
land independently:

1. **Per-test database isolation.** A `beforeEach` registered in a Vitest setup file empties every
   table on the worker's database clone in one transaction (measured 2.3 ms empty, 7.5 ms after a
   typical test; `session_replication_role = replica` so the `projects → voice_profiles` FK cycle
   cannot dictate a delete order). Every test starts from a freshly migrated state with no opt-in, so
   a global capped claim can only ever see the work the test itself created — and the 311 `parkAll*`
   call sites across 150 files go away, enforced by a guard.
2. **An empirical flake report.** A dispatchable workflow runs the gate's own sharded command N times
   with shuffled file order, and a consolidator over Vitest's `json` reporter emits one report
   classifying every test as consistently passing, non-deterministic or consistently failing, with
   lane-level infrastructure failures kept separate from test outcomes. Never on a push; no retries
   anywhere.
3. **Honest section outcomes.** Every scheduler tick section reports `idle`, `completed` or
   `declined` with a reason, additively alongside today's `counts`, surfaced in the scheduler's own
   log line, its heartbeat and the tick endpoint's response. `token-refresh` gains `claimed`/`lost`
   and `email` splits `skipped` into its three real dispositions, which is what makes the two live
   flakes self-explaining.
4. **Guards for the two shapes that cause clock- and capacity-dependence.** The existing tick-budget
   guard stays; a new guard forbids fixed-count tick loops in favour of a `drainTicks` helper, and
   `runTick({ only })` lets a test that needs hundreds of ticks run just the section it is about.

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node 24 LTS, pnpm 12.6.0

**Primary Dependencies**: Vitest 5.0.3 (`json` reporter, `sequence.shuffle`, `setupFiles`,
`globalSetup`), `pg` 8.23 (the reset's own pool), Drizzle ORM 0.45.3, Next.js 16.3.8 (the tick route
only). No new runtime or dev dependency — see research R9.

**Storage**: Postgres 17. One migrated base database per run plus one clone per worker
(`tests/setup/global-setup.ts`, unchanged); 58 tables, 145 foreign keys, one FK cycle.

**Testing**: Vitest, real Postgres. 735 test files, ~5300 cases, 413 of which touch the database.
Four CI shards, `maxWorkers = min(4, cores - 1)` per shard.

**Target Platform**: Linux CI runner (4 cores, one Postgres service per shard) and a developer
machine; the same outcomes must hold on both (FR-019, SC-003).

**Project Type**: Web service (Next.js App Router) plus a worker. This feature touches the test
harness, the scheduler's reporting, and one CI workflow.

**Performance Goals**: gating-suite wall clock up by no more than 10 % (SC-007). Baseline from CI run
39036348302: shards at 5:04 / 4:45 / 3:50 / 4:38, so ~30 s of headroom on the slowest shard. Budget
spend: per-test reset ~2.3–7.5 ms × ~1325 cases per shard ≈ 3–10 s of database work spread over 3–4
workers; expected to be more than paid for by deleting 311 `parkAll*` calls.

**Constraints**: the reset needs superuser for `session_replication_role` (verified: the local
`docket` role and CI's `POSTGRES_USER: docket` are both superuser). `SCHEDULER_TICK_BUDGET_SECONDS` is
capped at 25 s, so the clock problem cannot be configured away. Tick work stays well under 30 s; no
session-level Postgres features (constitution: Neon's pooler is transaction-mode).

**Scale/Scope**: 311 `parkAll*` call sites to remove across 150 files; 33 files seeding in `beforeAll`
to migrate or opt in; 9 tick sections to give outcomes; 2 live flakes to close; 3 load-sensitive tests
to make pass under full parallelism; 4 guards (1 existing, 3 new).

## Constitution Check

*GATE: must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Verdict | How this plan satisfies it |
|---|---|---|
| **I. Verified facts over memory** | PASS | Every Vitest fact is read from `node_modules/vitest@5.0.3`'s own types (`ReportersMap`, `JsonTestResults`, `SequenceOptions`, `retry` default). Every Postgres fact is measured on this checkout, not recalled — including one hypothesis (stats-driven truncate) that the measurement killed. No `NEEDS RESEARCH` remains. |
| **II. Nothing is "working" unless it ran** | PASS | Reset costs, clone costs, the FK cycle, superuser status and Vitest's setup-file hook ordering were all executed and recorded in research.md. `quickstart.md` defines what the implement phase must run before claiming any of it works; FR-028 is settled by 20 real repetitions, not by argument. |
| **III. Project isolation enforced in one place** | PASS | No change to `src/server/dal/` scoping. The reset deliberately uses its own `pg.Pool` instead of `getDb()`, so it neither trips nor weakens `tests/setup/scope-recorder.ts`, which keeps running on every test unchanged. |
| **IV. One service layer, many callers** | PASS | Section outcomes are derived in exactly one place (`scheduler/index.ts`) from what each section returns. No per-caller duplication; the tick route and the in-process loop both read the same `TickSummary`. |
| **V. Providers are plug-ins** | PASS | No provider folder, capability or step machine changes. |
| **VI. Boring, few dependencies** | PASS | No new dependency or infrastructure (research R9). The one judgement call — `runTick({ only })`, a production API addition made for a test affordance — is justified below and gets a `docs/decisions.md` entry. |
| **VII. Secrets never leak** | PASS | `outcome` and `reason` are closed sets of literal strings with no interpolation, so no credential can reach the tick response, the heartbeat or the log line. The flake report carries test names and Vitest failure messages only — the same text the console already prints — and runs on CI with no credentials beyond the throwaway test database. |
| **Engineering constraints** | PASS | Tick stays bounded and kill-safe; claims keep `FOR UPDATE SKIP LOCKED` and their lease columns; no advisory locks or `LISTEN`; nothing stored in local time. The reset touches test databases only, and the existing `_test`-suffix refusal in `tests/setup/test-databases.ts` still gates every database this feature creates or empties. |
| **Workflow: quality gates** | PASS | FR-007 keeps the gate retry-free and adds a guard that it stays so. The repeated-run workflow is `workflow_dispatch` plus a weekly schedule, never a required check. |
| **Workflow: checks in proportion** | PASS | Per task: the affected test files plus `pnpm typecheck` when types change. One full `pnpm lint && pnpm typecheck && pnpm test` at the end of the implement phase. |

**No violations. The Complexity Tracking table below records the one deliberate addition.**

## Project Structure

### Documentation (this feature)

```text
specs/079-flake-proof-test-architecture/
├── plan.md              # This file
├── research.md          # Phase 0: measured decisions R1-R9
├── data-model.md        # Phase 1: the four entities from spec.md
├── quickstart.md        # Phase 1: how to prove each story landed
├── contracts/
│   ├── tick-summary.md  # Section outcome: TickSummary, the tick response, the heartbeat, the log line
│   ├── flake-report.md  # Repeated-run report: JSON schema, CLI, workflow inputs
│   └── test-harness.md  # Isolation boundary and the guard rules
└── tasks.md             # Phase 2 output (/speckit-tasks - NOT created here)
```

### Source Code (repository root)

```text
tests/
├── setup/
│   ├── global-setup.ts          # unchanged: run-scoped base database + one clone per worker
│   ├── reset-database.ts        # NEW: the per-test reset, its own pool, shareStateWithinFile()
│   ├── table-reset.ts           # NEW: pure SQL builder + preserved-row list (unit-testable)
│   ├── table-reset.test.ts      # NEW: delete-all leaves a freshly migrated state, row-for-row
│   ├── worker-db.ts             # unchanged
│   └── scope-recorder.ts        # unchanged
├── helpers/
│   ├── tick.ts                  # tickConfig() stays; + drainTicks(), + sections()
│   ├── scheduling.ts            # - parkAllEngagementReads, parkAllDueTargets
│   ├── jobs-env.ts              # - parkAllJobs, parkAllStandingSeries
│   └── email.ts                 # - parkAllEmail
├── lint/
│   ├── tick-budget.test.ts      # unchanged guard (landed 630fccc)
│   ├── tick-drain.test.ts       # NEW: no fixed-count tick loops; exemptions in-file
│   ├── no-parking-helpers.test.ts # NEW: no parkAll* anywhere; shrinking allow-list
│   └── no-test-retries.test.ts  # NEW: resolved config keeps retry/repeats at 0
└── integration/
    ├── scheduler/outcomes.test.ts  # NEW: idle vs declined vs completed, per section
    └── isolation/leftovers.test.ts # NEW: the FR-008/FR-009/FR-010/SC-011 probes

src/server/scheduler/
├── index.ts            # SectionResult gains `outcome`; runTick gains `only`
├── outcome.ts           # NEW: the SectionOutcome type and the one place it is derived
├── token-refresh.ts     # + claimed, + lost; declines reported
├── standing-series.ts   # the silent out-of-budget branch gets a count and an outcome
├── email.ts             # skipped split into three; "no mailer" becomes declined/disabled
├── webhooks.ts          # per-item window release counted separately
├── engagement-read.ts   # "every surface unavailable" becomes declined/disabled
├── publishing.ts        # the deadline `break` gets a count and an outcome
├── generation.ts        # existing counts mapped onto the outcome
├── housekeeping.ts      # idle vs completed only
├── engagement-send.ts   # idle vs completed only
└── loop.ts              # summaryLine() names declined sections

scripts/
├── flake-report.ts      # NEW: pure consolidator over Vitest json output
└── flake-report.test.ts # NEW: unit tests over JSON fixtures, no database

.github/workflows/
├── ci.yml               # unchanged (the gate stays one run, no retries)
└── flake-hunt.yml       # NEW: workflow_dispatch + weekly, shard x lane matrix, consolidate job

docs/
├── testing.md           # NEW or extended: the isolation guarantee and the guards, for test authors
└── decisions.md         # + the runTick({ only }) entry
```

**Structure Decision**: the existing layout is kept exactly. Test infrastructure stays under
`tests/setup/` (loaded by `vitest.config.ts`), guards stay under `tests/lint/` beside the twelve
already there, and the consolidator joins `scripts/` with the `esbuild`-bundled pattern `db:test:clean`
already uses. The only production code touched is `src/server/scheduler/`, and only its reporting.

## Phasing and dependencies

The spec's six stories map onto four landable groups. Order matters in one place only: the flake report
(group A) must exist before groups C and D can be *proved*, and the isolation work (group B) is what the
report is used to verify.

| Group | Stories | Depends on | Why it can land alone |
|---|---|---|---|
| **A. Flake report** | US1 | nothing | Reads the suite; changes no test. Produces the baseline list of flakes against today's `main`, which is also the before-picture for SC-002. |
| **B. Isolation** | US2, part of US3 | A (to prove it) | The reset is additive; `parkAll*` removal is file-by-file behind a shrinking allow-list, so the gate never goes red mid-migration. |
| **C. Section outcomes** | US4, part of US6 | nothing | Additive to `SectionResult`; `counts` shape unchanged, so the 216 pinned call sites are untouched. Supplies the `claimed`/`lost` and split-`skipped` counts US6 needs. |
| **D. Clock, capacity, load** | US3, US5, US6 | B and C | The guards can only go green once `parkAll*` is gone (B) and the drain helper has honest counts to drain against (C). |

Within B, the `parkAll*` removal is the long pole: 311 call sites in 150 files. It is mechanical once
the reset is in place (delete the call, delete the import), and the allow-list in
`no-parking-helpers.test.ts` is the progress meter.

## Complexity Tracking

| Addition | Why needed | Simpler alternative rejected because |
|---|---|---|
| `runTick({ only })` — a production API parameter that only tests pass | `credit-outage.test.ts` drives 120 ticks per test through nine sections to exercise one. Nine times the database work is what makes it exceed its limit beside 79 other files (FR-025), and any future test of this shape inherits the problem (FR-026). | Raising the test's timeout is what is there now and it already failed. Extracting `runGenerationJobs` and calling it directly would bypass the concurrent-sections behaviour the test is partly about, and would duplicate the config assembly `runTick` does — against constitution IV. A filter keeps one code path, defaults to all nine sections, and is guarded both ways (a test asserts the default, a lint rule asserts no `src/` caller passes it). Logged in `docs/decisions.md`. |
| `shareStateWithinFile()` — an opt-out from per-test reset | 33 files seed in `beforeAll`, a few of them expensively (video fixtures, image servers, the MCP bridge). FR-013 requires that shape to stay expressible. | Forcing every file to `beforeEach` would re-pay real setup cost per case on the slowest files in the suite, against SC-007. Making the reset opt-*in* instead would break FR-011 outright. The opt-out is a call, not a convention, so the guard can enumerate every file that took it. |
| A guard on tick *loops* rather than on capacity *assertions* | FR-018 asks for detection of zero-slack capacity assertions. "Equals the available capacity" is not decidable from source — the capacity is a runtime config value. | Every instance of the defect in this codebase is a fixed-count tick loop sized to the capacity, which *is* decidable from source. The guard therefore forbids the shape that produces the defect and points at `drainTicks()`, rather than approximating the assertion check and producing false positives on legitimate equality assertions. |

## Constitution Check — re-evaluated after Phase 1 design

Nothing in the design changed a verdict. Three points were sharpened by designing it:

- **I (verified facts)** got stronger, not weaker: one candidate mechanism (selective truncate driven
  by `pg_stat_user_tables`) looked like the winner at 3.5 ms and was killed by instrumenting it —
  `n_tup_ins` reads 0 for rows inserted moments earlier, so it truncated nothing. It is recorded in
  research.md as a rejected alternative precisely because the number was convincing and wrong.
- **III (project isolation in one place)** is why the reset got its own `pg.Pool` rather than reusing
  `getDb()`. Through `getDb()` the reset's 58 unscoped deletes would reach the query observer in
  `tests/setup/scope-recorder.ts` on every test, and the only ways out are to exempt them (weakening
  the scope check on 5300 cases) or to wrap them in `runCrossProject` (adding a cross-project reason
  to the summary 5300 times). A separate pool leaves the scope check exactly as it is.
- **VII (secrets never leak)** shaped the `SectionOutcome` type: `reason` is a union of three literals
  rather than a string, so there is no place for a provider message, an account identifier or a token
  to be interpolated into the tick response, the heartbeat or the log line. The flake report carries
  only test names and the failure text Vitest already prints to the console.

**Requirements coverage**: all 29 functional requirements and all 11 success criteria from spec.md are
addressed in this plan, research.md, data-model.md, quickstart.md or contracts/ — audited by reference,
not by assertion.

**One spec assumption corrected**: the spec assumed the 2026-10-17 investigation work was unmerged on
`fix/tick-budget-bulletproof`. It merged in `630fccc` and is on `main`, so it is this feature's
starting state rather than a dependency to carry forward. Three measured figures also differ from the
spec's: 311 `parkAll*` call sites across 150 files (not 305/147), and 413 database-touching test files
(not ~100), which makes the US2 migration roughly four times the size the spec estimated. The per-test
reset cost is low enough that the larger number does not threaten SC-007, but it does make the
`parkAll*` removal the longest task in the feature.

## Open question for the implement phase

**None blocking.** One thing is deliberately left to measurement rather than decided here: whether
`tests/integration/tick-endpoint.test.ts` and `tests/integration/bluesky/publish-e2e.test.ts` need any
change at all. Both pay for `parkAll*` on every test today, and removing it may be the whole fix
(research R7). `tasks.md` should measure them after group B lands and only then decide, rather than
pre-committing to a rewrite the measurement may make unnecessary.
