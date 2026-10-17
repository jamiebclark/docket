# Quickstart: validating the flake-proof test architecture

**Feature**: 079 | **Date**: 2026-10-17

Runnable checks that prove each story landed. Every one is a command plus an expected outcome — no
implementation detail. Run them in order; the later ones depend on the earlier work being in place.

## Prerequisites

```bash
# Postgres must be up. On this machine the test database is on 5555, NOT the 5432 in .env.example.
docker ps --format '{{.Names}}\t{{.Ports}}' | grep docket-pg     # expect 0.0.0.0:5555->5432/tcp
grep '^DATABASE_URL' .env                                        # expect ...@localhost:5555/docket
pnpm install --frozen-lockfile
```

Two cautions for anyone running these locally:

- **The full suite takes over an hour here.** Use the targeted commands below; CI is the place the
  whole thing runs.
- **ffmpeg-dependent video tests skip locally.** Local green is weaker than CI green on those files.

## 1. The isolation guarantee holds, and nothing opts in (US2, FR-008 to FR-011, SC-011)

```bash
pnpm exec vitest run tests/integration/isolation/leftovers.test.ts tests/setup/table-reset.test.ts
```

Expect:

- A test that seeds work, runs after a file that leaves unparked due work behind, and passes with no
  isolation code of its own (SC-011).
- Two tests in one file where the first leaves due work behind and the second cannot claim it.
- A claim that creates its own state rows lazily sees none from an earlier file (FR-010).
- Per-table row counts after a reset equal those of a freshly migrated template database — the
  preserved-row list is honest (data-model.md section 2).

Then the order-independence proof, which needs no new test file:

```bash
# Both orders, same lane, no parking helpers. Both must pass both times.
pnpm exec vitest run tests/integration/email/tick.test.ts tests/integration/scheduler/refresh.test.ts --no-file-parallelism
pnpm exec vitest run tests/integration/scheduler/refresh.test.ts tests/integration/email/tick.test.ts --no-file-parallelism
```

## 2. No parking helpers remain (FR-012, SC-004)

```bash
pnpm exec vitest run tests/lint/no-parking-helpers.test.ts
grep -rn "parkAll" --include='*.ts' --include='*.tsx' src tests | wc -l    # expect 0, from 311
grep -rln "parkAll" --include='*.ts' --include='*.tsx' src tests | wc -l   # expect 0, from 150
```

The guard's allow-list must be empty. While the migration is in progress the guard stays green with a
shrinking list; the feature is not done until the list is gone.

## 3. The guards reject the shapes they exist for (US3, FR-016, FR-018, SC-005, SC-006)

```bash
pnpm exec vitest run tests/lint/tick-budget.test.ts tests/lint/tick-drain.test.ts tests/lint/no-test-retries.test.ts
```

Then probe each one deliberately — this is the acceptance criterion, not an optional extra:

- **A**: add a `runTick()` call with no pinned budget. Expect `tick-budget` to fail, naming the file
  and the rule.
- **B**: add a fixed-count tick loop sized to the capacity. Expect `tick-drain` to fail, pointing at
  `drainTicks()`.
- **C**: add `retry: 2` to a test file. Expect `no-test-retries` to fail, naming the setting and the
  file.

Each probe must be **written, run, seen to fail, and removed**. A guard nobody has watched fail is a
guard nobody knows works.

## 4. The suite survives oversubscription (FR-019, SC-003)

```bash
# More lanes than cores, all on one database server, which is CI's profile exaggerated.
DOCKET_TEST_WORKERS=8 pnpm exec vitest run tests/integration/scheduler tests/integration/email tests/integration/jobs
# The same files unloaded, for comparison.
DOCKET_TEST_WORKERS=1 pnpm exec vitest run tests/integration/scheduler tests/integration/email tests/integration/jobs
```

Expect identical pass/fail outcomes. A difference between the two is the defect this feature exists to
remove, not a flake to re-run.

## 5. Section outcomes distinguish idle from declined (US4, FR-020 to FR-024, SC-008)

```bash
pnpm exec vitest run tests/integration/scheduler/outcomes.test.ts src/server/scheduler/
```

Expect, with no test instrumentation involved:

- A section with work waiting and too little remaining budget reports
  `{ kind: "declined", reason: "insufficient_time" }` — separately from any count of completed work.
- A section with nothing to do reports `{ kind: "idle" }`.
- A section switched off by configuration reports `{ kind: "declined", reason: "disabled" }`.
- Work a section declined is claimed and completed by the next tick with budget available (FR-022).
- All nine sections report an outcome — assert over `SECTIONS`, not a hand-written list, so a tenth
  section cannot be added without one.
- No `outcome` value contains any interpolated text (FR-024).

Then check the operator surface:

```bash
pnpm exec vitest run tests/integration/tick-endpoint.test.ts src/server/scheduler/loop.test.ts
```

Expect the tick response body to carry `outcome` per section, and `summaryLine()` to print
`declined=<section>:<reason>` when a section declines and to omit it when none does.

## 6. The flake report finds the known flakes without being told (US1, FR-001 to FR-006, SC-001)

Locally, on a reduced repetition count, to prove the machinery:

```bash
mkdir -p .flake/in
for rep in 1 2 3; do
  DOCKET_SKIP_PERF_TESTS=1 pnpm exec vitest run tests/integration/email tests/integration/scheduler \
    --sequence.shuffle.files --sequence.seed=$rep \
    --reporter=json --outputFile=".flake/in/rep$rep-shard1.json" || true
done
pnpm flake:report --input .flake/in --out .flake
cat .flake/flake-report.md
```

Expect a report that classifies every test as consistently passing, non-deterministic or consistently
failing, lists no consistently passing test, and separates lane failures from test failures. Then the
unit tests over fixtures, which are where the categorisation rules are actually pinned:

```bash
pnpm exec vitest run scripts/flake-report.test.ts
```

Expect: a test failing some repetitions is non-deterministic; a test failing every repetition is
consistently failing; a missing or unparseable lane output is a lane failure attributed to no test; a
lane that exited non-zero with zero failed tests is a lane failure.

## 7. Heavy tests pass inside the full suite (US5, FR-025, FR-026, SC-009)

```bash
# Each named test inside its own shard's worth of company, not alone.
DOCKET_SKIP_PERF_TESTS=1 pnpm exec vitest run --shard=1/4
DOCKET_SKIP_PERF_TESTS=1 pnpm exec vitest run --shard=2/4
DOCKET_SKIP_PERF_TESTS=1 pnpm exec vitest run --shard=3/4
DOCKET_SKIP_PERF_TESTS=1 pnpm exec vitest run --shard=4/4
```

Expect `tests/integration/bluesky/publish-e2e.test.ts`, `tests/integration/tick-endpoint.test.ts` and
`tests/integration/jobs/credit-outage.test.ts` all inside their time limits. The twenty-run proof is
the flake report (section 9), not these four commands.

## 8. Wall clock stayed inside the allowance (SC-007)

Baseline, CI run 39036348302: shards at **5:04, 4:45, 3:50, 4:38** — slowest 304 s, so the allowance
is about 30 s on the slowest shard.

```bash
gh run list --workflow=ci.yml --limit 1 --json databaseId
gh run view <id> --json jobs --jq '.jobs[] | select(.name|startswith("test")) | "\(.name): \(.startedAt) -> \(.completedAt)"'
```

Expect the slowest shard at or under about 334 s. If it is over, the reset is not the first suspect:
removing 311 whole-table `parkAll*` updates should have *reduced* the total, so an increase means
something else was added.

## 9. The twenty-run proof (SC-002, SC-010, FR-028)

The gate, twenty times, on unchanged code:

```bash
gh workflow run flake-hunt.yml -f repetitions=20 -f lanes=4
# wait for it to finish, then read flake-report.md from the run's job summary
```

Expect, and nothing less counts as done:

- Zero non-deterministic tests across all twenty repetitions (SC-002).
- Zero failures for `tests/integration/email/tick.test.ts` "serves 500 due people..." and for
  `tests/integration/scheduler/refresh.test.ts` "flags needs_reauth on failure..." (SC-010, FR-028).
- Zero lane failures, or lane failures explained and not attributed to any test.

## 10. The written record (FR-027, FR-029)

Not a command, but part of done:

- `docs/decisions.md` has an entry for `runTick({ only })` and an entry for each of the two live
  flakes, each giving **either a stated cause and fix or a stated reason the failure shape can no
  longer occur**. "Stopped reproducing" does not satisfy FR-027.
- `docs/testing.md` tells a new test author the isolation guarantee they get for free, the guards that
  can fail their PR, and how to opt a file into shared state.
- `README.md` / `docs/*.md` mention the flake-hunt workflow where the other quality gates are listed.
  Inbound anchors in `docs/` are only checked in CI, so renumbering a heading there breaks links that
  nothing local will catch.
