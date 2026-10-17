# Phase 0 Research: Flake-proof integration-test architecture

**Feature**: 079 | **Date**: 2026-10-17 | **Spec**: [spec.md](./spec.md)

Everything measured here was run on this checkout against the local Postgres 17 container
(`docket-pg`, port 5555 — not the 5432 in `.env.example`) on 2026-10-17. Library facts come from the
installed packages' own types (`node_modules/vitest@5.0.3`), per constitution principle I.

## Starting state

The spec assumed the 2026-10-17 investigation work was unmerged. It is not: `630fccc` merged
`fix/tick-budget-bulletproof` into `main`, so `tests/lint/tick-budget.test.ts`, the pinned budgets
across 216 `runTick` calls, `counts.outOfBudget` on the generation and token-refresh sections and the
per-disposition diagnostics are all on `main` already. This feature builds on them.

Measured on this checkout, correcting two spec figures:

| Thing | Spec says | Measured |
|---|---|---|
| `parkAll*` call sites / files | 305 / 147 | **311 / 150** |
| Test files | — | 735 |
| `it`/`test` cases | — | ~5300 |
| Files touching the database | ~100 | **413** (448 files under `tests/integration`) |
| Tables / FK constraints | — | 58 / 145 |
| Slowest CI test shard | — | **304 s** (run 39036348302: 5:04, 4:45, 3:50, 4:38) |

The SC-007 allowance is therefore ~30 s of added wall clock on the slowest shard.

## R1 — Isolation: per-test delete-all on the worker's database clone

**Decision**: keep one migrated database clone per Vitest worker (today's `tests/setup/global-setup.ts`)
and add a `beforeEach`, registered in a new `setupFiles` module, that empties every table over a
dedicated pool in one transaction:

```sql
begin;
set local session_replication_role = replica;   -- FK triggers off: delete order stops mattering
delete from "<every table in public>";          -- one simple query, one round trip, one commit
insert into notification_change_marker (id) values (true) on conflict do nothing;
commit;
```

**Measured** (58 tables, 145 FK constraints, medians of 8–12 repetitions):

| Reset strategy | Already empty | After 80 rows | After 800 rows |
|---|---|---|---|
| `delete from` all 58, children first | **2.3 ms** | **7.5 ms** | 37 ms |
| `delete from` all 58, unordered under `session_replication_role = replica` | — | **9.5 ms** | — |
| `truncate` all 58 `restart identity cascade` | 46.6 ms | 57.7 ms | 60.6 ms |
| `truncate` **one** table `restart identity cascade` | 41.0 ms | 54.3 ms | — |
| `create database … template` (per-file clone) | 37 ms | — | — |

**Rationale**: `TRUNCATE` costs a flat ~50 ms whether it touches one table or all 58 and whether they
hold rows or not, because each one rewrites relation files and fsyncs the commit. `DELETE` costs what
the test actually created. At ~5300 cases, TRUNCATE would add ~265 s of database work to the suite;
DELETE adds ~12–40 s in total, spread across 3–4 workers on each of 4 shards — a few seconds of wall
clock per shard, inside the SC-007 allowance. Removing 311 `parkAll*` calls (several of which update
whole tables, and `parkAllEngagementReads` inserts a row per unparked account) is expected to give
more back than the reset costs.

**`session_replication_role = replica` is required, not an optimisation.** `projects → voice_profiles
→ projects` is a genuine foreign-key cycle (found by walking `pg_constraint`), so no topological
delete order exists. Turning FK triggers off for the reset transaction makes order irrelevant and was
measured working. It needs superuser: verified `pg_user.usesuper = true` for the local `docket` role,
and CI's service container creates `POSTGRES_USER: docket` as its superuser.

**Migration-seeded rows must survive.** `drizzle/0024_luxuriant_bill_hollister.sql` inserts the
`notification_change_marker` singleton (`id = true`), which `src/server/dal/notification-probe.ts`
reads as a scalar subquery — with the row gone that subquery returns NULL instead of a count. The
reset re-inserts it. Migrations 0014/0016/0021 backfill from pre-existing rows only, so an empty
database needs nothing from them. A guard test compares per-table row counts after a reset against a
freshly migrated template database, so the preserved-row list cannot fall silently behind a new
migration.

**Alternatives rejected**:

- *Per-file database clone* (37 ms, the spec's assumed default). Isolates files from each other but
  not the tests inside one file, which FR-008 and US2 acceptance scenario 2 require.
- *Per-test clone*. 37 ms × 5300 ≈ 196 s, and a worker cannot re-point its own pool at a new database
  between tests without tearing down every module that holds a connection.
- *Transaction per test, rolled back*. The code under test claims work with `FOR UPDATE SKIP LOCKED`
  across its own pool, and the concurrency tests deliberately open several connections; none of that
  is visible inside one uncommitted transaction.
- *Schema per test*. Migrations target `public`.
- *Stats-driven selective truncate* (`pg_stat_user_tables` to find written tables). Measured at 3.5 ms
  and looked like the winner until instrumented: `n_tup_ins` reads 0 for rows inserted moments
  earlier, so it truncated **nothing**. Rejected on evidence.

## R2 — Hook ordering: a setup file's `beforeEach` runs before the test file's

**Decision**: register the reset in a `setupFiles` module, so FR-011 holds with no cooperation from
the test author.

**Verified** with a throwaway probe config on vitest 5.0.3. Captured order:

```text
setup:beforeEach | file:beforeEach | test:a | file:afterEach | setup:afterEach | setup:beforeEach | …
```

So the reset runs before every file's own seeding, and a setup-file `afterEach` runs last. Two
consequences:

- The reset goes in `beforeEach`, never `afterEach`, so a failing test's rows survive for inspection.
- The reset uses its own `pg.Pool`, not `getDb()`. That keeps it out of the query observer in
  `tests/setup/scope-recorder.ts` (which would otherwise flag 58 unscoped deletes per test) and
  unaffected by the `closeDb()` calls in `afterAll` hooks across the suite.

## R3 — Shared state inside one file (FR-013)

**Decision**: `shareStateWithinFile()`, called at a test file's module top level, moves that file from
per-test reset to per-file reset. The setup module's `beforeAll` resets unconditionally; its
`beforeEach` becomes a no-op for that file. The file is still isolated from every other file, because
Vitest runs one file at a time per worker.

**Rationale**: 33 files seed in `beforeAll` against the database. Most of them want nothing more than
a cheap fixture and move to `beforeEach`; the handful that build genuinely expensive state (video
fixtures, image servers, the MCP bridge) opt in. The opt-in is a call, not a convention, so the guard
can list every file that made it — which is what FR-003's "exemption is visible in the guard's own
record" asks for in the capacity case and applies equally here.

## R4 — The repeated-run report

**Decision**: a dispatchable GitHub workflow that runs the gate's own command N times per lane, plus a
consolidator script over Vitest's JSON reporter output.

**Reporter**: vitest 5.0.3 still ships the `json` reporter (`ReportersMap` in
`node_modules/vitest/dist/chunks/plugin.d.BsjqSb4-.d.ts`), with `JsonOptions { outputFile, stdout }`.
Its `JsonTestResults` gives exactly what FR-002 and FR-003 need and nothing has to be parsed out of a
log:

```ts
interface JsonTestResults { success: boolean; numFailedTests: number; numTotalTests: number;
  testResults: Array<{ name: string; status: "failed" | "passed"; assertionResults: Array<{
    fullName: string; status: Status; failureMessages: Array<string> | null }> }> }
```

**Contention profile (FR-001)**: each repetition runs the gate's literal command —
`vitest run --shard=<s>/4` with `DOCKET_SKIP_PERF_TESTS=1`, against the same 4-shard,
`maxWorkers = min(4, cores - 1)` layout — so the profile matches by construction instead of by a
copied list of flags.

**Ordering-dependent flakes**: each repetition adds `--sequence.shuffle.files --sequence.seed=<n>`
(both present in vitest 5.0.3's `SequenceOptions`), and the seed goes in the report. A failure that
only happens at one shard position then shows up as non-deterministic *and* stays reproducible.

**Infrastructure failure (FR-004)** is a lane-level fact, recorded against the lane and never against
a test. A lane is infrastructure-failed when its JSON output is missing or unparseable, or when the
process exits non-zero while `numFailedTests === 0`.

**Delivery**: `.github/workflows/flake-hunt.yml` on `workflow_dispatch` (inputs `repetitions`, default
20, and `lanes`, default 4) plus a weekly `schedule`. Matrix is `shard × lane`, each job running
`repetitions / lanes` repetitions and uploading its per-repetition JSON. A final `consolidate` job
downloads every artifact, runs `scripts/flake-report.ts`, and publishes `flake-report.md` and
`flake-report.json` as a run artifact and as the job summary. It is never attached to `pull_request`
or `push` (FR-006). At 304 s a repetition, 20 repetitions over 4 lanes is ~25 min of wall clock —
inside SC-001's "one working session".

**No retries (FR-007)**: `retry` and `repeats` both default to `0` in vitest 5.0.3 and
`vitest.config.ts` sets neither. A guard asserts the resolved config keeps both at 0 and that no test
file passes a `retry` option, so the absence is enforced rather than incidental.

**Alternative considered**: the `blob` reporter plus `vitest --merge-reports`. It merges shards neatly
but produces one combined run, not N comparable ones, and the merge format is internal. The `json`
reporter's shape is public and the consolidator over it is a pure function with a unit test.

## R5 — Guards

**Tick budget (FR-015, FR-016)**: already landed as `tests/lint/tick-budget.test.ts` — every
`runTick(` call's arguments must mention `timeBudgetMs` or `tickConfig`, with `OWNS_ITS_BUDGET` as the
recorded exemption set. No change needed beyond keeping it green as files lose their `parkAll*` calls.

**Zero-slack capacity (FR-017, FR-018)**: the statically detectable shape is a **tick loop bounded by a
literal sized to the capacity** — `while (served < 500 && ticks < 10)` with `emailMaxPerTick: 50`, or
`for (let minute = 0; minute < 120; minute++)`. Decision: a new guard
`tests/lint/tick-drain.test.ts` forbids a tick loop whose bound is a literal greater than 1, and
`tests/helpers/tick.ts` gains `drainTicks(step, until, opts)`, which ticks until the predicate holds
or a generous ceiling is reached and then fails naming what did not drain. The guard reuses the
balanced-paren argument extractor already written in `tick-budget.test.ts` and carries its own
exemption set in the same style, so the exemptions are visible in the guard's own source (US3
acceptance scenario 4).

**Rationale for a loop guard rather than an assertion guard**: "this assertion equals the available
capacity" is not decidable from source — the capacity is a config value resolved at runtime. The loop
bound is. And every instance of the defect in this codebase is a fixed-count loop, so the guard catches
the real shape rather than an approximation of it.

**Parking helpers (FR-012)**: `tests/lint/no-parking-helpers.test.ts` — no file may define, export or
import a `parkAll*` symbol. It ships as a shrinking allow-list of the files that still call one, so the
311-call-site migration can be split across tasks without the gate going red, and the list must reach
empty before the feature is done (SC-004).

## R6 — Section outcomes

Today `SectionResult<C>` is `{ ok: true; counts: C }` or `{ ok: false; counts: C; error }`. Idle and
declined are both `{ ok: true, counts: <all zeros> }`. Survey of all nine sections on this checkout:

| Section | Declining path | What it reports today |
|---|---|---|
| `generation.ts` | `notConfigured` / `notRunnable` / `outOfBudget` | all three, by count (landed `630fccc`) |
| `token-refresh.ts:57` | out of budget per account | `outOfBudget`; **no `claimed`, no `lost`** |
| `standing-series.ts:32` | out of budget | **nothing at all — a silent zero** |
| `email.ts:35` | no mailer configured | zeros, indistinguishable from idle |
| `email.ts:51` | per-item `minWindowMs` release | folded into `skipped` with two other causes |
| `webhooks.ts:45` | per-item `minWindowMs` release | folded into `skipped` |
| `engagement-read.ts:57` | every surface unavailable | zeros, indistinguishable from idle |
| `publishing.ts:88` | `break` on the deadline mid-claim | nothing counted |
| `housekeeping.ts`, `engagement-send.ts` | no budget gate | n/a |

**Decision**: add `outcome` to `SectionResult` — `"idle" | "completed" | "declined"`, with
`reason: "insufficient_time" | "disabled" | "nothing_claimable"` when declined. Each section returns a
small `SectionReport { counts, outcome }`; `index.ts` keeps the single place that assembles
`TickSummary`. `counts` is unchanged in shape, so all 216 pinned call sites and every existing
assertion keep working — this is additive.

**FR-022** ("declined work stays claimable") is already true: each declining path either releases the
lease (`token-refresh.ts` hands it back via `recordRefreshEmitting`, `email.ts` via `releaseClaim`) or
never claims at all. The feature adds a test per section that proves it rather than changing it.

**Operator surface (FR-023)**: `summaryLine()` in `scheduler/loop.ts` is the scheduler's own output; it
gains `declined=<section>:<reason>,…`. `writeHeartbeat` carries the outcome into
`scheduler_heartbeats.last_summary`, and the tick response (`POST /api/internal/tick`) carries it too,
since it serialises `TickSummary` verbatim.

**FR-024**: the outcome is a closed set of literal strings with no interpolated values, so no
credential can reach it. `redact()` and the existing `publish_attempts` rules are untouched.

## R7 — Load-sensitive tests

`tests/integration/jobs/credit-outage.test.ts` drives 120 `runTick()` calls per test, each running all
nine sections, while caring only about generation. **Decision**: `runTick({ only: [...sections] })` —
an explicit section filter that defaults to all nine. A test that needs hundreds of ticks runs only
the section it is about, which removes roughly eight ninths of the per-tick database work and makes it
structurally impossible for another section to perturb it.

This is a production API change made for a test affordance, so it gets a `docs/decisions.md` entry.
Two guards keep it honest: a test asserts the default runs all nine sections, and a lint rule asserts
no caller under `src/` passes `only`.

`tests/integration/tick-endpoint.test.ts` and `tests/integration/bluesky/publish-e2e.test.ts` are
measured again once R1 and R5 have landed before anything is changed in them. Both currently pay for
`parkAll*` on every test, and removing that may be the whole fix; `tasks.md` should not pre-commit to a
rewrite that the measurement may make unnecessary.

## R8 — The two live flakes

Both are unexplained *because the counts cannot explain them* — the same defect as R6, in the tests'
own instrumentation.

- **`scheduler/refresh.test.ts`, "flags needs_reauth on failure"**: `RefreshCounts` has no `claimed`
  and no `lost`. `failed: 0` is equally consistent with the bad account never being claimed, with it
  being claimed and the lease then not matching (`recordRefreshEmitting` returns `changed === false`
  and the `if (kept)` guard skips the increment), and with the provider having returned `ok`. Adding
  `claimed` and `lost` makes the next failure name one of the three. Leading hypothesis: `lost`, via a
  second claim over leftover accounts from other files on the same worker database — which R1 removes
  outright. The counts prove it either way.
- **`email/tick.test.ts`, "serves 500 due people in 10 ticks"**: `EmailCounts.skipped` conflates a
  stale digest, an empty assembly and a deadline-released claim. Splitting it into three counts names
  the cause on the next failure. The test is also the FR-017 violation itself (10 ticks × 50 per tick
  is exactly 500), so it becomes a `drainTicks` loop with a generous ceiling.

FR-028 is settled by the R4 report at its full repetition count, not by argument.

## R9 — Dependencies

Nothing here needs a package that is not installed. The work uses `pg`, `vitest` 5.0.3, `node:*`,
`drizzle-orm` and `esbuild` (already the bundling path for `scripts/*.ts`, following
`db:test:clean`). Constitution VI needs no exception; the one judgement call to log in
`docs/decisions.md` is R7's `runTick({ only })`.
