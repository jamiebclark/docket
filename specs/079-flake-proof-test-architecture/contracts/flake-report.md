# Contract: the repeated-run flake report

**Feature**: 079 | A maintainer-facing CLI, a workflow and a report format. Nothing here runs on a
push (FR-006).

## CLI

```text
pnpm flake:report --input <dir> [--out <dir>] [--repetitions <n>] [--shards <n>]
```

| Argument | Meaning | Default |
|---|---|---|
| `--input <dir>` | Directory of Vitest JSON outputs named `rep<N>-shard<S>.json`, plus `rep<N>-shard<S>.meta.json` for the lane's exit code, seed and stderr tail | required |
| `--out <dir>` | Where `flake-report.json` and `flake-report.md` are written | `.` |
| `--repetitions <n>` | What was asked for, so a report built on fewer says so | inferred from the inputs |
| `--shards <n>` | Shards per repetition | inferred from the inputs |

**Exit codes**

| Code | Meaning |
|---|---|
| `0` | A report was produced. Produced whether or not flakes were found — the report is the deliverable, not a verdict. |
| `1` | No usable input at all, or the output directory is not writable. |

Deliberately **not** exit 1 on finding flakes: this is a diagnostic, and a non-zero exit would make it
awkward to run from a workflow step that must still upload the artifact.

## Report format

`flake-report.json` is exactly the `FlakeReport` interface in
[data-model.md](../data-model.md#3-repeated-run-report). `flake-report.md` is the same data rendered,
and is what gets posted as the workflow job summary:

```markdown
# Flake report — 20 repetitions × 4 shards

Generated 2026-10-17T18:41:02Z. Profile: `vitest run --shard=<s>/4` (DOCKET_SKIP_PERF_TESTS=1),
maxWorkers 3, shuffled file order, seeds 1–20.

5280 tests: 5278 consistently passing, 2 non-deterministic, 0 consistently failing.
Lane failures: 0.

## Non-deterministic (2)

### tests/integration/email/tick.test.ts
**email tick › serves 500 due people within 10 ticks (SC-009)** — 17 passed, 3 failed
Failed on rep 4 shard 2 (seed 4), rep 11 shard 2 (seed 11), rep 18 shard 2 (seed 18).
<details><summary>1 distinct failure</summary>

    served 499 of 500 in 10 ticks; dispositions {"claimed":500,"sent":499,"skipped":1,…}
</details>

## Consistently failing (0)

_None._

## Lane failures (0)

_None. A lane failure is an infrastructure fault and is never attributed to a test._
```

**Rules**

- Consistently passing tests are counted but not listed — the report is for what is broken (FR-005).
- A consistently failing test is listed under its own heading, never under non-deterministic (FR-003).
- `failureMessages` is deduplicated by exact string; the count of distinct messages is shown.
- Every failure carries its repetition, shard and seed, so an ordering-dependent flake is reproducible
  with `--sequence.seed=<seed> --shard=<shard>/4`.

## Workflow

`.github/workflows/flake-hunt.yml`

| Trigger | Shape |
|---|---|
| `workflow_dispatch` | inputs `repetitions` (default `20`) and `lanes` (default `4`) |
| `schedule` | weekly |

Never `pull_request` or `push` (FR-006).

**Jobs**

1. `run` — matrix `shard: [1,2,3,4] × lane: [1..lanes]`, each job running `repetitions / lanes`
   repetitions. Each repetition runs the gate's own command and nothing else:

   ```bash
   DOCKET_SKIP_PERF_TESTS=1 pnpm exec vitest run \
     --shard=${{ matrix.shard }}/4 \
     --sequence.shuffle.files --sequence.seed=$rep \
     --reporter=json --outputFile="$out/rep$rep-shard${{ matrix.shard }}.json"
   ```

   The step records exit code, seed and a stderr tail into the matching `.meta.json` and **does not
   fail the job** on a test failure — a red repetition is the data being collected. It uploads
   `flake-<shard>-<lane>` as an artifact.
2. `consolidate` — `needs: run`, `if: always()`, downloads every artifact, runs
   `pnpm flake:report --input … --out …`, uploads `flake-report` and writes `flake-report.md` to
   `$GITHUB_STEP_SUMMARY`.

**Guarantees**

- The contention profile is the gate's, by construction: the same `--shard=<s>/4`, the same
  `DOCKET_SKIP_PERF_TESTS=1`, the same `maxWorkers` from `vitest.config.ts` (FR-001).
- A lane that dies still produces a `.meta.json`, or produces nothing at all; either way
  `consolidate` runs (`if: always()`) and records it as a lane failure, never as a test failure
  (FR-004).
- The report is retained with the run that produced it, as an artifact and as the job summary
  (FR-005).

## Retry prohibition

The gating run keeps `retry: 0` and `repeats: 0`, which are Vitest 5.0.3's defaults and are set
nowhere in `vitest.config.ts`. `tests/lint/no-test-retries.test.ts` asserts the resolved config keeps
both at 0 and that no test file passes a `retry` option, so a flake always surfaces on the gate rather
than being absorbed (FR-007).
