# Contract: the fold, and why a prune can never outrun it

**Feature**: 083 | Satisfies FR-050 to FR-057, US5, SC-005

## §1 There is no prune pass any more

080 shipped two prune passes that delete snapshots older than `INSIGHTS_RETENTION_DAYS`
(`src/server/services/insights/retention.ts`, called at `housekeeping.ts:166-167`). This entry
**replaces each with a fold-and-delete**, fused into one transaction per batch:

```
foldAndPrune(subject, config, now, shapeFor):
  loop once per pass, bounded by insightsPruneBatch:
    BEGIN
      rows := SELECT … FROM <snapshots>
              WHERE captured_at < now - retentionDays
              ORDER BY captured_at
              LIMIT insightsPruneBatch
              FOR UPDATE SKIP LOCKED
      if rows is empty: COMMIT; return counts
      points := foldRows(rows, shapeFor)            -- pure
      upsert points                                 -- commutative, see §3
      DELETE FROM <snapshots> WHERE id = ANY(rows.id)
    COMMIT
```

This is **stronger than FR-051 reads literally**. FR-051 asks that the fold run before both prune
passes and that a prune delete nothing the fold has not covered; here a row can only be deleted by
the transaction that folded it, so there is no ordering to get wrong, no watermark to compute and no
window in which a snapshot is gone and its point is missing. A reviewer looking for a fold step
ordered before a prune step will not find one — that is deliberate, and recorded here and in
`docs/decisions.md`.

The consequences fall out:

| Requirement | How it holds |
|---|---|
| FR-051 — a prune deletes nothing unfolded | the same transaction does both |
| FR-052 — a failing or incomplete fold deletes nothing | the transaction rolls back; the snapshots stay |
| FR-053 — idempotent, never double-counts | the upsert is commutative (§3); a re-fold is a no-op |
| FR-057 — concurrency-safe, kill-safe | `FOR UPDATE SKIP LOCKED` gives two schedulers disjoint rows; a kill rolls back |
| FR-055 — bounded, reports its own count | one batch of `insightsPruneBatch` per pass, four new count fields |

## §2 What a point is

One row per (subject, metric key, **UTC day**), carrying the value of the **newest reading in that
day** and the real instant that reading was captured. Shapes in
[../data-model.md](../data-model.md) §2-§3.

The grain is a UTC day rather than a stored project-local day because FR-050 and the spec's Time edge
case ("no bucket is stored pre-computed in a local zone") cannot both hold literally. A local day
overlaps at most two UTC days, so UTC-day grain is never coarser; the reader re-buckets from
`captured_at` under the project's *current* time zone and applies FR-013's "newest reading that local
day", reaching the same answer a stored local bucket would have given — and still reaching it after
the project's time zone changes. Full reasoning: [../research.md](../research.md) §3.3.

Only rows **due for pruning** are folded (FR-050: "snapshots due for pruning"). Recent snapshots are
read directly. A day straddling the retention boundary is therefore partly folded and partly live,
which §4 resolves.

## §3 The upsert, and why it is commutative

```sql
INSERT INTO account_metric_rollups
  (project_id, social_account_id, provider_key, metric_key, captured_day, value, captured_at, kind)
VALUES …
ON CONFLICT (project_id, social_account_id, metric_key, captured_day) DO UPDATE
  SET value = EXCLUDED.value, captured_at = EXCLUDED.captured_at, kind = EXCLUDED.kind
  WHERE EXCLUDED.captured_at > account_metric_rollups.captured_at;
```

"The newest capture that day wins" is order-independent. Two schedulers folding different rows of the
same day in either order converge on the same point; folding a row that has already been folded
changes nothing. That is FR-053, and it is also exactly FR-013's drawing rule for a `windowed`
metric, applied once at fold time instead of on every read.

`kind` comes from the provider registry via a `shapeFor(providerKey, surface, metricKey)` function the
scheduler passes down — the DAL never imports the registry (constitution III/V). A key the registry
no longer knows folds as `unknown`.

## §4 Reading folded points and live snapshots together

`FR-054`: exactly one value per subject, metric and day, no day drawn twice.

```sql
-- per subject and metric key, ascending by instant
SELECT … FROM (
  SELECT social_account_id, m.key AS metric_key, (m.value #>> '{}')::double precision AS value, captured_at
    FROM account_metric_snapshots
    CROSS JOIN LATERAL jsonb_each(metrics) AS m(key, value)
   WHERE project_id = $1 AND social_account_id = ANY($2)
     AND captured_at >= $3 AND captured_at < $4
     AND jsonb_typeof(m.value) = 'number'
  UNION ALL
  SELECT social_account_id, metric_key, value, captured_at
    FROM account_metric_rollups
   WHERE project_id = $1 AND social_account_id = ANY($2)
     AND captured_at >= $3 AND captured_at < $4
) rows
```

The reader then buckets by project-local day and keeps the row with the greatest `captured_at` per
(subject, key, day). A surviving snapshot therefore beats a point derived from an older reading of the
same day, and a point beats nothing — one value per day either way, with no union-of-days arithmetic
and no `DISTINCT` that could pick arbitrarily.

Both arms are pinned on `project_id = $1`, which is what `tests/helpers/scope-check` requires.

## §5 Where it runs

`runHousekeeping` (`src/server/scheduler/housekeeping.ts`) gains one step and reorders nothing else:

```
… existing steps …
recordFirstEngagement(config, now)      -- new; see first-engagement.md
pruneEngagementItems(config, now)       -- unchanged, now strictly after the step that reads its rows
foldAndPruneAccountSnapshots(config, now, shapeFor)   -- replaces pruneAccountMetricSnapshots
foldAndPrunePostSnapshots(config, now, shapeFor)      -- replaces prunePostMetricSnapshots
```

No new tick section, no new `SectionResult`, no new heartbeat, and **no new environment variable**:
the fold reuses `INSIGHTS_PRUNE_BATCH` (the batch it is fused with) and `INSIGHTS_RETENTION_DAYS`
(the boundary it folds at). The spec's fallback — "if planning finds it cannot fit there, it gets its
own `SectionResult`" — is not needed: `runHousekeeping` has no time deadline, every step is
batch-bounded, and the fold's work per pass is capped at `insightsPruneBatch` rows.

The two existing count fields keep their names and meaning (snapshot rows deleted). Four fields are
added: `accountMetricPointsFolded`, `postMetricPointsFolded`, `firstEngagementRecorded`,
`firstEngagementScanned`.

## §6 Growth, stated because nothing prunes these tables

- **Accounts**: `accounts × declared account keys` rows per day, forever. Four accounts across three
  platforms ≈ 12 rows/day ≈ 4.4k rows/year. This is the cost of US5 and it is the point of the table.
- **Posts**: the decaying poll schedule gives a target roughly 8-15 readings over its life, which fold
  to ~8 days × 4-7 keys. A target polled four times a day folds four rows into one, so against the
  snapshots they replace the rollups are a **net reduction**.
- Both cascade with their subject and with the project (FR-056), so deleting an account takes its
  trend with it (US5.6) and no orphan survives.

## §7 Tests this contract owes

`tests/integration/insights/fold.test.ts`:

1. 500 days of account snapshots, 400-day retention, housekeeping to completion → the trend still
   draws 500 days and snapshots older than 400 days are gone (US5.1, SC-005).
2. the upsert made to fail → **no** snapshot row is deleted, and the pass reports the failure
   (US5.2, FR-052).
3. a batch smaller than the backlog → nothing newer than what was folded is deleted, however old
   (US5.3, FR-051).
4. housekeeping run twice over the same days → points unchanged (US5.4, FR-053).
5. a day with both a point and a surviving snapshot → exactly one value for that day (US5.5, FR-054).
6. an account deleted → its points are gone (US5.6, FR-056).
7. two concurrent `foldAndPrune` calls over the same backlog → no double-written point, no row
   deleted without a point, counts sum to the rows processed (FR-057).
8. `captured_day` is the UTC day of `captured_at` for every point written (the invariant no CHECK can
   hold).
9. a pass that folds nothing reports zero in its own field rather than being indistinguishable from a
   pass that did not run (FR-055).
