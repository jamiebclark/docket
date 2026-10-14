# Contract — The worker pass, its claim, its bounds and its configuration

**Feature**: `071-evergreen-series` | [plan](../plan.md) · [services](./services.md) · [research](../research.md)

A seventh bounded section of the existing `runTick()`. No new process, no queue, no broker, no
second loop, no session-level Postgres feature (W30, FR-042, FR-048).

---

## 1. The section

`src/server/scheduler/standing-series.ts`

```text
runStandingSeries(opts: { config: SchedulerConfig; tickId: string; startedAt: Date })
  : Promise<StandingSeriesCounts>
```

Added to `runTick`'s single `Promise.all` inside the existing `section()` wrapper, and to
`TickSummary` as `standingSeries: SectionResult<StandingSeriesCounts>`. A throw inside it therefore
becomes `{ ok: false, counts: empty, error: "section_failed" }` and **cannot** affect publishing,
token refresh, batch generation, housekeeping, webhooks or email (FR-047).

Order of business, mirroring `runGenerationJobs` line for line:

1. `cfg = standingSeriesConfig(opts.config)`; `deadline = startedAt + cfg.timeBudgetMs`.
2. `getLlmStatus().configured || await anyProjectHasCredential()` — false → `notConfigured = 1`,
   heartbeat, return. **No series is claimed** (FR-049).
3. `cfg.timeBudgetMs < cfg.minCallMs + cfg.persistReserveMs` → `notRunnable = 1`, heartbeat, return
   (the last edge case; the batch section already behaves this way).
4. `now + needed > deadline` → heartbeat, return.
5. `claim = await claimDueStandingSeries({ now, limit: cfg.maxSeries, leaseMs: cfg.leaseMs,
   maxAttempts: cfg.maxAttempts })`.
6. `counts.claimed`, `counts.recovered`, `counts.held = claim.held.length > 0 ? 1 : 0`.
7. `await Promise.all(claim.series.map(c => processClaimedSeries(c, { config, deadline, counts })
   .catch(() => { counts.staleResults++; })))` — each series isolated from the others.
8. `writeHeartbeat("standing_series", now, { ...counts })`.

`counts.probed` is set by the **producer** when a probe actually reaches the model, exactly as the
batch section does, so "probed" in the summary and the heartbeat means a call was made. A granted
probe that never became a call rewinds its interval through `rewindCreditProbe`.

## 2. Counts (FR-047)

```text
claimed, recovered, runsOpened, runsClosed, produced, skipped, failed, retried, deferred,
released, finishing, blocked, autoPaused, requeued, staleResults,
notConfigured, notRunnable: 0 | 1, held: 0 | 1, probed: 0 | 1
```

`src/server/scheduler/loop.ts`'s one-line tick summary gains
`series_produced=… series_skipped=… series_failed=…`, so an operator tailing the worker log sees the
section without reading the JSON.

## 3. The claim — `src/server/dal/standing-series-claims.ts`

One transaction, `crossProject("scheduler: claim due standing series", …)`, never waits.

```text
claimDueStandingSeries(opts: { now; limit; leaseMs; maxAttempts }): Promise<{
  series: ClaimedStandingSeries[];
  held: string[];       // credential owners with a hold at claim time
  probing: string[];    // those granted this tick's probe; probing ⊆ held
}>
```

1. `gateCreditHolds(exec, now)` — the **same** function the batch claim calls, so one probe budget
   serves the whole install and a hold on one project's credential never touches another's.
2. `blocked = held \ probing`; `blockedProjectIds(exec, blocked, candidateProjectIds)` where the
   candidates are the distinct project ids of enabled series (**S37**). A held owner's series is
   **not claimed at all** (FR-050).
3. Select and lock:

```sql
SELECT * FROM standing_series s
WHERE s.enabled
  AND (s.lease_until IS NULL OR s.lease_until <= :now)
  AND (
        s.next_run_at <= :now
     OR EXISTS (
          SELECT 1 FROM standing_series_runs r
          WHERE r.project_id = s.project_id AND r.series_id = s.id AND r.closed_at IS NULL
            AND (
                 (r.requested_count >= 2 AND r.plan IS NULL
                    AND (r.plan_next_attempt_at IS NULL OR r.plan_next_attempt_at <= :now))
              OR EXISTS (SELECT 1 FROM standing_series_positions p
                         WHERE p.project_id = r.project_id AND p.run_id = r.id
                           AND ((p.status = 'queued' AND p.next_attempt_at <= :now)
                             OR  p.status = 'running'))
            )
        )
  )
  AND <not in blocked project ids>
ORDER BY s.next_run_at ASC, s.last_claimed_at ASC NULLS FIRST, s.id
LIMIT :limit
FOR UPDATE SKIP LOCKED
```

- `enabled` in the predicate is how a paused series stops being woken (FR-054) and how a
  self-paused one stops asking (FR-053).
- The `EXISTS` is what lets a run span ticks after `next_run_at` has advanced (**S7**), and what
  stops a series whose every position is in backoff from being claimed at all.
- `ORDER BY next_run_at` is "the series due longest first"; `last_claimed_at NULLS FIRST` breaks ties
  so one series and one project cannot starve others (W32, FR-046).
- `FOR UPDATE SKIP LOCKED` is why two concurrent ticks never take the same series (FR-043).

4. Per-owner budget: `probingSet.has(owner) ? 1 : limit`, so a held owner gets exactly one series
   through as a probe.
5. Claim patch per kept series: `{ leaseOwner: randomUUID(), leaseUntil: now + leaseMs,
   lastClaimedAt: now }`. `recovered` is `lease_until <= now` at select time.
6. **Stale positions.** For each claimed series' open run, every position still `running` is reset in
   the same transaction (**S33**):
   - it has a post (`posts.findByStandingSeriesPosition`) → left `running` so the producer finishes
     it with no model call (`kind: finish`, **S34**);
   - else, a **probe** claim → back to `queued` with **no** attempt counted (FR-050);
   - else `attempt_count + 1 >= maxAttempts` → `failed` with `interrupted` and the existing
     `INTERRUPTED_MESSAGE`;
   - else → `queued`, `attempt_count + 1`, `next_attempt_at = now`.
7. Probes granted to owners whose series were not kept are rewound before the transaction returns.

**Nothing is written for a series that is not due**: it is not selected, so FR-011's "left entirely
unchanged" holds literally.

## 4. Bounds (FR-044, FR-045, W31)

`src/server/scheduler/config.ts`:

```text
STANDING_SERIES_MAX_SERIES_DEFAULT = 2
STANDING_SERIES_MAX_POSTS_DEFAULT  = 2

standingSeriesConfig(config) = {
  maxSeries:        config.standingSeriesMaxSeries ?? 2,   // claimed per tick
  maxPosts:         config.standingSeriesMaxPosts  ?? 2,   // posts one claimed series may produce per tick
  minCallMs:        JOB_MIN_CALL_MS,          // 8_000  — shared physical constant (S23)
  persistReserveMs: JOB_PERSIST_RESERVE_MS,   // 3_000
  maxAttempts:      JOB_ITEM_MAX_ATTEMPTS,    // 3
  backoffBaseMs:    JOB_BACKOFF_BASE_MS,      // 60_000
  backoffMaxMs:     JOB_BACKOFF_MAX_MS,       // 900_000
  leaseMs:          config.leaseMs,
  timeBudgetMs:     config.timeBudgetMs,
}
```

`SchedulerConfig` gains `standingSeriesMaxSeries?` and `standingSeriesMaxPosts?`; `schedulerConfig`'s
`EnvLike` Pick gains the two variable names.

**Stopping before the deadline.** Every position's model call is wrapped in the shared
`withinBudget`; the loop in services § 7.3 re-checks
`remaining() - persistReserveMs >= minCallMs` before each call and **releases** the position
(back to `queued`, no attempt) rather than starting one it cannot finish. Nothing is left
half-written: the post and its link are one transaction, and the policy is the batch runner's
already-reviewed finish path (US3 AS5).

**The sentence `docs/generator.md` must carry (FR-045).** Enabling standing series raises the
install's total concurrent model calls, because the section runs **alongside** batch generation in
the same tick. The ceiling is `GENERATION_TICK_MAX_ITEMS + STANDING_SERIES_TICK_MAX_SERIES`
(default `2 + 2 = 4`); positions within one series are produced one at a time, so
`STANDING_SERIES_TICK_MAX_POSTS` raises throughput, not concurrency. Lower either variable to bound
it; set `STANDING_SERIES_TICK_MAX_SERIES=1` to make standing series strictly background.

**Throughput, derived not measured.** At the defaults — worker interval 60 s,
`SCHEDULER_TICK_BUDGET_SECONDS=20`, which leaves a 17 s window, and the ~1.3 s per call already
recorded in `docs/generator.md` — a claimed series produces up to
`STANDING_SERIES_TICK_MAX_POSTS` posts a tick, so two series finish a 3-posts-a-week period within
minutes of their boundary. This entry measures nothing new against a live API.

## 5. Credit holds (FR-050 – FR-052, W33)

| Situation | Behaviour |
|---|---|
| Owner held, not probing | the series is **not claimed**: nothing generated, no attempt, no failure, `next_run_at` unchanged, the open run left open. `counts.held = 1` |
| Owner held, probing | exactly one series through, with no attempt counted on a recovered position and no `interrupted` failure |
| Refusal mid-run | the wrapper (`withCreditHold`) sets or refreshes the hold on the owner actually used; the position goes back to `queued` at `now` with **no** attempt counted, `counts.requeued++` |
| Hold clears | the next tick claims the series and continues the open run — no retry, no reset, no manual step |
| Project credential saved/changed/removed | the existing code already clears that project's hold, so a just-fixed key does not wait out a probe interval |

The screens say so through the **existing** `generationCreditHold(scope)`, which answers both
"whose credential" and "since when" — so one notice component serves `/jobs`, `/jobs/[jobId]` and the
standing-series screens (FR-052).

## 6. Housekeeping (**S39**)

`src/server/scheduler/housekeeping.ts` gains one bounded job:

```text
STANDING_SERIES_RUN_RETENTION_DAYS = 90
STANDING_SERIES_RUN_PRUNE_BATCH    = 200
pruneClosedStandingSeriesRuns(now): Promise<number>   // counts.standingSeriesRunsPruned
```

`DELETE FROM standing_series_runs WHERE closed_at IS NOT NULL AND closed_at < now - 90 days`
limited to 200 ids per call; positions and their `generation_failures` cascade. An **open** run is
never pruned. `HousekeepingCounts` and `emptyHousekeepingCounts` gain the field.

## 7. Configuration

`src/server/env.ts`, in the generator group:

```text
STANDING_SERIES_TICK_MAX_SERIES: int(1, 10, 2)
STANDING_SERIES_TICK_MAX_POSTS:  int(1, 10, 2)
```

`ENV_VARIABLES` is `Object.keys(base.shape)`, so both are registered automatically;
`tests/lint/env-coverage.test.ts` then requires the matching `.env.example` block, which is the
third and last place either name appears:

```text
# Optional. Most standing series a single worker tick claims, integer 1-10.
# Default: 2. This adds to GENERATION_TICK_MAX_ITEMS: the two sections run in the same tick.
# STANDING_SERIES_TICK_MAX_SERIES=2

# Optional. Most posts one claimed standing series produces in a single worker tick, integer 1-10.
# Default: 2.
# STANDING_SERIES_TICK_MAX_POSTS=2
```

No other new environment variable, and no new infrastructure (constitution VI).

## 8. What the worker pass does not gain

- No advisory lock, no `LISTEN`/`NOTIFY`, no session-level feature — the design must run on Neon's
  transaction-mode pooler unchanged (FR-048).
- No provider or model call inside a held transaction: the plan call, the post call, the image call
  and `prepareVariants` all run between transactions.
- No second claim limit shared with batch generation (W31), no backfill of missed periods (FR-013),
  no manual trigger, and nothing that runs when no text provider is configured anywhere (FR-049).
