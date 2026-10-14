# Contract — the worker

**Feature**: `072-dated-series` | **Plan**: [../plan.md](../plan.md)

A dated series uses **the same section, the same claim, the same lease, the same deadline, the same
credit-hold behaviour and the same two per-tick limits** as a cadence series (A4, FR-005). This
document says exactly what changes and, as importantly, what does not.

---

## 1. Unchanged

| Thing | Where | Why it needs no change |
|---|---|---|
| The section | `src/server/scheduler/standing-series.ts` | A dated series is claimed by the same query and processed by the same function. No second loop, no new process. |
| The limits | `STANDING_SERIES_TICK_MAX_SERIES` (2), `STANDING_SERIES_TICK_MAX_POSTS` (2) | FR-005: no new environment variable. `docs/generator.md`'s concurrency arithmetic applies verbatim. |
| The budget checks | `minCallMs` 8 s, `persistReserveMs` 3 s, `withinBudget`, `Overran` | A dated position's model call is the same call. |
| The lease | `lease_owner` / `lease_until` on the series, the `lockShared` guard around the save and the policy | One holder per series still makes "one open run" true by construction. |
| Credit holds | `gateCreditHolds`, the one probe, `rewindCreditProbe`, the per-owner budget of 1 | FR-045: a held series is not claimed at all, nothing is generated, no attempt is counted, no failure is recorded and **no occurrence is consumed** — the occurrence is only written when a run opens, which a held series never reaches. |
| Stale `running` reset | `claimDueStandingSeries` | A position whose post already exists is left `running` and finished with no model call; one without a post is requeued with an attempt counted, or fails `interrupted` at the cap; a probe claim counts nothing. |
| Self-pause | `shouldSelfPause` on the produced count of the last three closed runs | W34 unchanged. A33 holds because an empty list opens **no run**, so there is nothing to count. |
| Section isolation | the existing `section()` wrapper | A failure in this section still cannot touch the other six. |
| Housekeeping of runs | `pruneClosedStandingSeriesRunsBefore` | Unchanged; occurrences get their own bounded prune (§ 6). |

---

## 2. The claim predicate (B8)

`claimDueStandingSeries` gains **one OR branch** and a join to `projects` for the zone. The rest of
the function — the idle-install early exit, `gateCreditHolds`, `resolveBlockedProjectIds`, the
per-owner budget, the claim patch, the stale-position reset — is untouched.

```sql
SELECT s.*
  FROM standing_series s
  JOIN projects p ON p.id = s.project_id
 WHERE s.enabled
   AND (s.lease_until IS NULL OR s.lease_until <= $now)
   AND (
         -- cadence, unchanged
         s.next_run_at <= $now
         -- an open run with planning or position work due, unchanged
      OR EXISTS ( … )
         -- NEW: a dated row whose window is open or already past
      OR EXISTS (
           SELECT 1 FROM standing_series_dated_rows r
            WHERE r.project_id = s.project_id AND r.series_id = s.id
              AND r.next_target_date IS NOT NULL
              AND r.next_target_date - s.lead_days <= ($now AT TIME ZONE p.timezone)::date
         )
       )
   AND <not a blocked project>
 ORDER BY s.next_run_at ASC NULLS LAST, s.last_claimed_at ASC NULLS FIRST, s.id ASC
 LIMIT $limit
   FOR UPDATE OF s SKIP LOCKED;
```

Five things to note, each of which a test asserts:

1. **One predicate, two jobs.** `next_target_date - lead_days <= today` is true both when the
   occurrence is inside its window (`target - lead ≤ today ≤ target`) and when its window has already
   closed (`target < today`). The first case fires the row; the second retires it. There is no third
   case, and no separate "sweep" query.
2. **It is bounded.** The evaluation pass always advances `next_target_date` (§ 3), so the predicate
   goes false for a retired row. A series with 400 open windows is claimed repeatedly, but each claim
   does at most `maxPosts` posts and at most 50 retirements — the same bound every other section has.
3. **`$now` is the engine clock**, passed as a parameter, never `now()`. `clock.runAtTime` must move
   the claim, or the date tests cannot pin a day.
4. **`AT TIME ZONE p.timezone` is the project's own zone, read on every tick** (A32, FR-041). Nothing
   zone-dependent is stored, so changing a project's zone moves every unfired occurrence on the next
   tick and rewrites no fired one.
5. **`NULLS LAST` is explicit.** A dated series has `next_run_at IS NULL` (**B5**), so it is ordered
   after same-tick due cadence series. This cannot starve a date: a cadence series stops being due the
   moment its run opens, while a dated window lasts at least a full local day. The `FOR UPDATE OF s`
   is needed because the query now joins `projects`, which must not be locked.

`standingSeriesExcludingProjects` and the blocked-project logic apply unchanged, so a credit-held
owner's dated series is excluded before any of this matters.

---

## 3. Opening a dated run

`processClaimedSeries` → `openOrResumeRun` → the dated branch
([services.md](./services.md) § 10). Restating only the worker-relevant guarantees:

- **`evaluateDatedSeries` runs first**, inside the claim, before any run is opened. It retires closed
  windows, records up to 50 misses, and reports the **oldest** due date (A28, FR-037).
- **One run per claim.** The producer opens the oldest due date's run, works it under `maxPosts`, and
  returns. The next date's run is opened by a later tick, found by the same claim predicate. A
  backlog therefore drains **oldest date first**, under the existing bounds, and rows whose window
  closes while they wait are recorded as missed — the honest outcome the spec asks for.
- **One transaction writes the run, its positions and its occurrences.** The three unique constraints
  that make this safe are `unique(series_id, period, period_start)` ("one run per due date"),
  `uniqueIndex(series_id) WHERE closed_at IS NULL` ("one open run") and **`unique(row_id, year)`**
  ("one firing per row per year"). A violation on any of them rolls the whole transaction back and
  the winner's open run is re-read — the existing `isUniqueViolation` → `openFor` recovery.
- **`next_run_at` is never written for a dated series.** It stays NULL; `last_run_at` is set.

---

## 4. The missed pass, bounded (FR-035, FR-036)

Per evaluation:

| Bound | Value | Reason |
|---|---|---|
| rows examined | 50 (`MISSED_SWEEP_LIMIT`) | one `ORDER BY next_target_date LIMIT 50` query |
| misses recorded | at most 50 | one per examined row, `ON CONFLICT DO NOTHING` |
| age of a recorded miss | window closed within 30 days | FR-036; older ones are retired silently |
| retirements | at most 50, **not** age-bounded | **B25** — an age-bounded advance would leave a 40-day-old date stuck in the past forever, and the row would never fire again |

A series switched back on after a year therefore writes at most 50 history rows per tick and only
for the last 30 days, and converges in a few ticks. `recordMissed` is idempotent, so a tick killed
mid-pass repeats harmlessly.

The three evaluation points (**B24**) are the producer, `resumeStandingSeries` and nothing else. A
read never writes.

---

## 5. Counts and the heartbeat (B34)

`StandingSeriesCounts` gains two fields, and `emptyStandingSeriesCounts()` two zeros:

| Field | Meaning |
|---|---|
| `missed` | occurrences recorded as missed this tick (by the sweep **and** by a run closing over a shut window) |
| `retired` | rows whose `next_target_date` moved forward this tick |

`src/server/scheduler/loop.ts`'s one-line summary adds `missed=` and `retired=` beside the three
counts it already prints, and the `standing_series` heartbeat payload carries them with the rest. No
new heartbeat, no new section name.

---

## 6. Housekeeping (B27)

`src/server/scheduler/housekeeping.ts` gains one bounded step beside the closed-run prune:

```ts
pruneSettledOccurrencesBefore(before: Date, limit: number): Promise<number>
```

Deletes at most `limit` occurrences with `outcome IS NOT NULL AND recorded_at < before`, using the
**same 90-day horizon and limit** the run prune uses, and reports `standingSeriesOccurrencesPruned`
in the housekeeping counts. A **pending** occurrence (`outcome IS NULL`) is never matched, exactly as
an open run is never pruned.

Pruning cannot resurrect a firing: `next_target_date` moved past the occurrence when it was recorded,
and nothing reads an occurrence older than 30 days except the history display.

---

## 7. Kill-safety and concurrency, case by case

Each row is a required integration test (`tests/integration/dated-series/idempotency.test.ts` unless
noted).

| Case | Guarantee | Enforced by |
|---|---|---|
| two ticks claim at once | one claim wins | `FOR UPDATE SKIP LOCKED` + the lease |
| two ticks reach run-open for one date | one run, `requested_count` positions, one occurrence per row | `unique(series_id, period, period_start)`, `unique(row_id, year)` |
| three rows due, two ticks | exactly three posts | the above plus `posts_standing_series_position_uq` |
| worker killed between positions | the next tick continues from the first unfinished position, no row produces twice | the position status machine, unchanged |
| worker killed after the post was saved but before the position was marked produced | the next tick finishes it with **no model call** | `posts.findByStandingSeriesPosition`, unchanged |
| the lease expires mid-run | a later tick recovers the run and finishes it | the lease reset in the claim, unchanged |
| the same file re-imported mid-run | matched rows keep their occurrences; nothing fires twice | the identity index + `unique(row_id, year)` |
| two imports at once | one wins, the other is a conflict, the list is never half-replaced | `list_version` (**B21**) — `import.test.ts` |
| a credit hold on the day a row is due | not claimed, nothing generated, no attempt, no failure, **no occurrence**; fires normally when the hold clears inside the window | `gateCreditHolds` + occurrences written only at run-open — `credit-hold` case in `due.test.ts` |
| the project's zone changes mid-window | the window is recomputed in the new zone and the row fires if still inside it; fired and missed occurrences are untouched | nothing zone-dependent stored (**B4**, **B5**, **B6**) — `due.test.ts` |
| the tick budget runs out before a call | the position is released `queued` and untouched | the existing pre-call budget check |
