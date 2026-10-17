# Data Model: Flake-proof integration-test architecture

**Feature**: 079 | **Date**: 2026-10-17

Four entities, from spec.md "Key Entities". Three are in-memory or on-disk artefacts; one changes a
column's contents but no column's type. **There is no schema migration in this feature.**

## 1. Section outcome

What one scheduler tick section reports for one tick. Replaces today's "success with zero counts",
which conflates idle with declined (FR-020, FR-021).

```ts
export type DeclineReason = "insufficient_time" | "disabled" | "nothing_claimable";

export type SectionOutcome =
  | { kind: "idle" }                              // nothing was claimable and nothing was wrong
  | { kind: "completed" }                         // at least one unit of work was acted on
  | { kind: "declined"; reason: DeclineReason };  // work was waiting; the section did not act

export type SectionResult<C> =
  | { ok: true;  counts: C; outcome: SectionOutcome }
  | { ok: false; counts: C; outcome: SectionOutcome; error: "section_failed" };
```

**Fields**

| Field | Values | Rule |
|---|---|---|
| `kind` | `idle` \| `completed` \| `declined` | Exactly one. `completed` whenever any count of acted-on work is non-zero. |
| `reason` | `insufficient_time` \| `disabled` \| `nothing_claimable` | Present only on `declined`. A closed set of literals — never interpolated, so FR-024 holds by construction. |

**Reason mapping**, one row per declining path found in the survey (research R6):

| Reason | Sections and the condition |
|---|---|
| `insufficient_time` | `generation` (`outOfBudget`, `notRunnable`), `standing-series` (same two), `token-refresh` (per-account budget check), `publishing` (deadline `break`), `email` / `webhooks` (per-item `minWindowMs` release) |
| `disabled` | `email` (no mailer configured), `generation` / `standing-series` (`notConfigured`), `engagement-read` (every declared surface unavailable) |
| `nothing_claimable` | A section that claimed nothing because a *hold* or *lease* blocked it rather than because nothing was due — `generation`'s `held` with no `probed` |

**State transitions**: none. One outcome per section per tick, computed at the end of the section and
never revised.

**Validation rules**

- A section whose counts show acted-on work is `completed`, never `declined` — a partially-declined
  section reports `completed` and its own count (e.g. `outOfBudget: 3`) carries the partial decline.
  The tick never attributes a decline to the tick as a whole (spec edge case: two sections contending).
- `idle` requires that nothing was claimable *and* no decline condition was met.
- Work a section declined must still be claimable by the next tick (FR-022). Already true on every
  declining path; a test per section asserts it.

**Where it is derived**: `src/server/scheduler/outcome.ts`, called from `scheduler/index.ts`. One
place, per constitution IV.

**Where it surfaces** (FR-023)

| Surface | Carries |
|---|---|
| `TickSummary` → `POST /api/internal/tick` response body | `outcome` per section, beside `counts` |
| `scheduler_heartbeats.last_summary` (`jsonb`, existing column) | `outcome` added to the summary each section already writes |
| `summaryLine()` in `scheduler/loop.ts` — the scheduler's own log line | `declined=token_refresh:insufficient_time,email:disabled` |

## 2. Isolation boundary

The unit of guaranteed-clean persistent state a test runs inside (FR-008 to FR-014). Not persisted —
it is a property of the harness.

| Property | Value |
|---|---|
| Default boundary | **One test case.** `beforeEach`, registered in `tests/setup/reset-database.ts`, empties every table on the worker's clone before the test's own hooks run (ordering verified, research R2). |
| Boundary with `shareStateWithinFile()` | **One test file.** `beforeAll` resets once; `beforeEach` is a no-op for that file. |
| Scope | The worker's database clone (`…_w<n>_test`). Files never run concurrently within a worker, so a file-level boundary is still total isolation from every other file. |
| What a test may observe | Only rows it or its own file's setup created, plus the migration-seeded rows below. |
| What a test may never observe | Any row created by another test, in any file, in any order — including rows a *claim* creates lazily on first sight of an entity (FR-010), because those are rows like any other and the delete removes them. |
| Cost | 2.3 ms with nothing to delete, 7.5 ms after a typical test, 37 ms after ~800 rows (measured, research R1). |
| Subset runs (FR-014) | A single-file run pays one worker clone and that file's own resets. Nothing is pre-created for files that are not running. |

**Preserved rows** — the exact set a freshly migrated, never-used database contains:

| Table | Row | Why it must survive | Source |
|---|---|---|---|
| `notification_change_marker` | `(id = true)` | `dal/notification-probe.ts` reads `attention_writes` as a scalar subquery; with no row it returns NULL instead of a count, changing behaviour under test. | migration `0024_luxuriant_bill_hollister.sql` |

Migrations `0014`, `0016` and `0021` also insert, but only by backfilling from pre-existing rows, so an
empty database needs nothing from them.

**Validation rule**: a guard test resets a database and compares per-table row counts against a freshly
migrated template. The preserved list cannot fall behind a future migration without that test failing.

## 3. Repeated-run report

The consolidated outcome of running the whole suite N times (FR-002 to FR-005). An on-disk artefact,
never a database row.

```ts
/** One test across every repetition that ran it. */
interface TestVerdict {
  /** Stable identity: the file plus the full test name, which is what Vitest's json reporter gives. */
  file: string;                 // e.g. "tests/integration/email/tick.test.ts"
  fullName: string;             // e.g. "email tick > serves 500 due people within 10 ticks (SC-009)"
  passed: number;
  failed: number;
  skipped: number;
  /** Deduplicated, in first-seen order; each one as Vitest reported it. */
  failureMessages: string[];
  /** The (repetition, shard, seed) triples the failures happened on, so a flake is reproducible. */
  failedOn: { repetition: number; shard: number; seed: number }[];
  category: "consistently_passing" | "non_deterministic" | "consistently_failing";
}

/** A lane that did not produce a usable result. Never attributed to a test (FR-004). */
interface LaneFailure {
  repetition: number;
  shard: number;
  reason: "no_output" | "unparseable_output" | "exited_without_failures" | "lane_died";
  detail: string;               // exit code, stderr tail, or the parse error
}

interface FlakeReport {
  generatedAt: string;          // ISO 8601, UTC
  repetitions: number;
  shards: number;
  /** The contention profile, recorded so a report can be compared with another (FR-002). */
  profile: { command: string; maxWorkers: number; shuffleFiles: true; seeds: number[] };
  tests: TestVerdict[];         // non-deterministic first, then consistently failing
  laneFailures: LaneFailure[];
  /** Totals, so the headline needs no arithmetic. */
  summary: { total: number; consistentlyPassing: number; nonDeterministic: number; consistentlyFailing: number };
}
```

**Categorisation rules** (FR-003)

| Category | Rule |
|---|---|
| `consistently_passing` | `failed === 0` and `passed > 0`. Omitted from `flake-report.md`; kept in the JSON so `summary` adds up. |
| `non_deterministic` | `passed > 0` **and** `failed > 0`. This is the flake list. |
| `consistently_failing` | `failed > 0` and `passed === 0`. A regression, reported separately so it is never filed as a flake (US1 acceptance scenario 2). |

A test that only ever skipped is `consistently_passing` with `passed === 0` and is counted in
`summary.total` but shown in neither list.

**Validation rules**

- A lane failure never creates or alters a `TestVerdict`. If every lane of a repetition failed, that
  repetition contributes nothing to any test's counts and `repetitions` still reports what was asked
  for, so a report built on half the intended evidence says so.
- `failureMessages` is deduplicated by exact string. Two different messages for one test mean two
  distinct failure modes and both are shown.
- The report is written beside the run that produced it (a workflow artifact plus the job summary) and
  needs no log reading (FR-005).

## 4. Guard rule

An automated pre-merge check (FR-016, FR-018, FR-012, FR-007). Each is a Vitest test under
`tests/lint/`, so the gate runs them with everything else and the exemption list lives in the guard's
own source — visible in code review, which is what "recorded exemption" means here.

| Name | Forbids | Message names | Exemptions |
|---|---|---|---|
| `tick-budget` (exists) | A `runTick(` call whose arguments mention neither `timeBudgetMs` nor `tickConfig` | the file and the call | `OWNS_ITS_BUDGET`: files whose subject is the budget |
| `tick-drain` (new) | A loop that drives ticks a literal number of times greater than 1 | the file, the loop, and `drainTicks()` as the replacement | in-file set, each entry with a one-line reason |
| `no-parking-helpers` (new) | Defining, exporting or importing any `parkAll*` symbol | the file and the symbol | a shrinking allow-list of files not yet migrated; must reach empty (SC-004) |
| `no-test-retries` (new) | A resolved `retry` or `repeats` above 0, in the config or in any test file | the setting and where it was found | none |

**Fields**: `name`, `forbids`, `message`, `exemptions`. **Validation rule**: every guard asserts it
found files to check before asserting it found no offenders, so a broken file walk can never pass as
a clean sweep — the pattern `tick-budget.test.ts` already uses.
