# Phase 1 — Data model: date-pegged series

**Feature**: `072-dated-series` | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

Two new tables, three enum additions, two new enums, eight changed columns across three existing
tables, one forward-only migration. Every new table carries `project_id` and is added to
`src/server/db/project-owned.ts`.

Column names below are the SQL names; the Drizzle definitions live in
`src/server/db/schema/standing-series.ts` and `src/server/db/schema/posts.ts`.

---

## 1. New enums

```sql
CREATE TYPE standing_series_occurrence_rule AS ENUM ('cadence', 'dated_list');
CREATE TYPE standing_series_occurrence_outcome AS ENUM ('produced', 'failed', 'skipped', 'missed');

ALTER TYPE standing_series_period ADD VALUE 'date';            -- B15
ALTER TYPE standing_series_position_status ADD VALUE 'missed';  -- B16
```

`ALTER TYPE … ADD VALUE` is in its own statement and the value is not used in the same transaction,
matching the existing migrations.

**Why `'date'` on the period enum (B15).** A dated run is one local date's work. Reusing `period` and
`period_start` makes the existing `unique(series_id, period, period_start)` mean "one run per due
date" (FR-037) and keeps `uniqueIndex(series_id) WHERE closed_at IS NULL` meaning "one open run". A
nullable `period` would have voided that unique constraint silently, because NULLs do not collide.

**Why `'missed'` on the position status enum (B16).** A position whose window closed before it
produced is neither a failure nor a skip (FR-035). A dedicated status keeps
`(status = 'skipped') = (skip_reason IS NOT NULL)` intact, keeps a non-skip out of the skip-reason
enum, and gives `deriveRunOutcome` / `hasOpenWork` a terminal state to count.

---

## 2. `standing_series` — changed

| Column | Type | Change | Why |
|---|---|---|---|
| `occurrence_rule` | `standing_series_occurrence_rule` NOT NULL DEFAULT `'cadence'` | **new** | A1. Every existing row takes the default; no backfill statement is written. |
| `lead_days` | `smallint` NOT NULL DEFAULT `0` | **new** | A25, FR-032. CHECK `BETWEEN 0 AND 30`. |
| `list_version` | `integer` NOT NULL DEFAULT `0` | **new** | B21. The optimistic guard every list write passes through. |
| `last_import_at` | `timestamptz` | **new** | A20, FR-026. |
| `last_import_filename` | `text` | **new** | A20. CHECK length 1–255 when present. |
| `last_import_row_count` | `smallint` | **new** | A20. CHECK `>= 0`. |
| `last_import_problems` | `jsonb` | **new** | A20. An array of `{ line, message }`; CHECK `jsonb_typeof = 'array' AND jsonb_array_length <= 100`. |
| `cadence_count` | `smallint` | **NOT NULL dropped** | A3. CHECK `(occurrence_rule = 'cadence') = (cadence_count IS NOT NULL)`. |
| `cadence_period` | `standing_series_period` | **NOT NULL dropped** | A3. CHECK `(occurrence_rule = 'cadence') = (cadence_period IS NOT NULL)` and `cadence_period IS DISTINCT FROM 'date'`. |
| `next_run_at` | `timestamptz` | **NOT NULL dropped** | B5. CHECK `(occurrence_rule = 'cadence') = (next_run_at IS NOT NULL)`. Always NULL for a dated series: nothing zone-dependent is cached, so FR-041 is structural. |
| `template_fields` | `text[]` | unchanged shape, now **used** | A7, W3/W4. For a dated series it holds the list's non-reserved columns in file order; element 0 is the key column. Still `'{}'` for a cadence series. |

Four more CHECKs tie the import record together and keep a dated series' cadence fields empty:

```sql
CHECK ((last_import_at IS NULL) = (last_import_filename IS NULL))
CHECK (last_import_at IS NULL OR occurrence_rule = 'dated_list')
CHECK (occurrence_rule = 'dated_list' OR lead_days = 0)
CHECK (occurrence_rule = 'dated_list' OR cardinality(template_fields) = 0)
```

The claim index stays `(next_run_at, last_claimed_at NULLS FIRST, id) WHERE enabled`. A dated series
has `next_run_at IS NULL`, so it sorts last under the explicit `NULLS LAST` ordering — see
[contracts/worker.md](./contracts/worker.md) § 2 and plan point 5.

---

## 3. `standing_series_dated_rows` — new

One line of the list.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK, `gen_random_uuid()` | |
| `project_id` | `uuid` NOT NULL → `projects.id` CASCADE | constitution III |
| `series_id` | `uuid` NOT NULL | composite FK `(project_id, series_id)` → `standing_series(project_id, id)` CASCADE |
| `ordinal` | `smallint` NOT NULL | file order, 0-based; display order and the per-date cap's tie-break |
| `month` | `smallint` NOT NULL | 1–12 |
| `day` | `smallint` NOT NULL | 1–31, constrained per month below |
| `year` | `smallint` | NULL = every year (A6, FR-008) |
| `key_value` | `text` NOT NULL | the key column's value as written; CHECK `btrim(key_value) <> ''` and length ≤ 500 |
| `fields` | `jsonb` NOT NULL | every non-reserved column → its string value, including the key column |
| `media_filename` | `text` | what the row named, kept for display and re-import |
| `media_asset_id` | `uuid` → `media_assets.id` **ON DELETE SET NULL** | B22 |
| `next_target_date` | `date` | the local date of the next unfired occurrence; NULL = no more (B6) |
| `source_line` | `integer` | the file line it came from; NULL for a hand-added row |
| `created_at` / `updated_at` | `timestamptz` NOT NULL | `$onUpdate` |

Constraints:

```sql
unique (project_id, id)
unique (series_id, ordinal)

-- B18: identity is date + key, case-insensitive after trimming (A10, FR-012)
CREATE UNIQUE INDEX standing_series_dated_rows_identity_uq
  ON standing_series_dated_rows (series_id, month, day, coalesce(year, 0), lower(btrim(key_value)));

-- B19: the stored month/day must be a date that can exist in some year (FR-023)
CHECK (month BETWEEN 1 AND 12)
CHECK (day >= 1 AND day <= CASE month
          WHEN 2 THEN 29
          WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30
          ELSE 31 END)
CHECK (year IS NULL OR year BETWEEN 1 AND 9999)
-- a year-specific 02-29 must be a leap year
CHECK (year IS NULL OR month <> 2 OR day <> 29
       OR (year % 4 = 0 AND (year % 100 <> 0 OR year % 400 = 0)))
CHECK (jsonb_typeof(fields) = 'object')
CHECK (media_filename IS NULL OR char_length(media_filename) BETWEEN 1 AND 255)
CHECK (next_target_date IS NULL OR year IS NULL
       OR extract(year from next_target_date) = year)

CREATE INDEX standing_series_dated_rows_due_idx
  ON standing_series_dated_rows (series_id, next_target_date)
  WHERE next_target_date IS NOT NULL;
CREATE INDEX standing_series_dated_rows_list_idx
  ON standing_series_dated_rows (project_id, series_id, ordinal);
```

**Not expressible as a CHECK, enforced in the service (B20):** at most 500 rows per series
(FR-014) and at most 10 rows per calendar date (FR-013). Both are counted inside the same
transaction as the write, under the `list_version` guard, so a concurrent add cannot slip past them.
The parser independently refuses a file of more than 500 data rows.

**`next_target_date` is a *date*, deliberately.** A date is zone-independent; an instant is not. This
is the one cached value in the feature, it only moves forward, it is advanced in the same transaction
that fires or retires the occurrence, and the claim compares it to the project's current local date
computed in SQL (B4, B6, B8).

---

## 4. `standing_series_occurrences` — new

One firing of one row in one year. This table *is* FR-040.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `project_id` | `uuid` NOT NULL → `projects.id` CASCADE | |
| `series_id` | `uuid` NOT NULL | composite FK → `standing_series(project_id, id)` CASCADE |
| `row_id` | `uuid` NOT NULL | composite FK `(project_id, row_id)` → `standing_series_dated_rows(project_id, id)` **CASCADE** — deleting a row deletes its fire history (A22, FR-028) |
| `year` | `smallint` NOT NULL | 1–9999 |
| `target_date` | `date` NOT NULL | the resolved local date, **after** the Feb-29 constraint (A24) |
| `outcome` | `standing_series_occurrence_outcome` | NULL = pending |
| `position_id` | `uuid` | composite FK `(project_id, position_id)` → `standing_series_positions(project_id, id)` **ON DELETE SET NULL** — a pruned run leaves the history row |
| `recorded_at` | `timestamptz` NOT NULL DEFAULT now | |
| `settled_at` | `timestamptz` | set when `outcome` stops being NULL |

Constraints:

```sql
unique (project_id, id)

-- FR-040 / A31: a row fires at most once per year, in the database, not by a prior read
unique (row_id, year)

CHECK (extract(year from target_date) = year)
CHECK (outcome <> 'missed' OR position_id IS NULL)       -- a miss never had a position
CHECK (outcome IS NOT NULL OR position_id IS NOT NULL)   -- pending always has one
CHECK ((outcome IS NULL) = (settled_at IS NULL))

CREATE INDEX standing_series_occurrences_series_idx
  ON standing_series_occurrences (project_id, series_id, target_date DESC);
CREATE INDEX standing_series_occurrences_row_idx
  ON standing_series_occurrences (project_id, row_id, year DESC);
CREATE INDEX standing_series_occurrences_prune_idx
  ON standing_series_occurrences (recorded_at) WHERE outcome IS NOT NULL;
```

**Why the occurrence is inserted at run-open, pending (B17).** The run, its positions and one
occurrence per due row are written in **one transaction**. `unique(row_id, year)` is therefore the
thing two overlapping ticks collide on, and the loser re-reads the winner's open run exactly as
`openOrResumeRun` already does for `unique(series_id, period, period_start)`. Checking first and then
inserting would be a race; this is not.

---

## 5. `standing_series_positions` — changed

| Column | Type | Change | Why |
|---|---|---|---|
| `dated` | `jsonb` | **new**, nullable | B11. The position's whole dated payload, NULL for a cadence position. |

```sql
CHECK (dated IS NULL OR jsonb_typeof(dated) = 'object')
```

Shape, validated by `datedPositionSchema` at the boundary exactly as the run's `config` is:

```ts
{ v: 1,
  rowId: string,            // the row it came from; may now be deleted
  year: number,
  targetDate: string,       // "YYYY-MM-DD", local
  keyValue: string,
  values: Record<string, string>,   // the row's field values, snapshotted at run-open
  mediaAssetId: string | null,      // the row's own asset — used, never reserved (A14)
  mediaFilename: string | null }
```

**One jsonb column, not five columns (B11).** It mirrors the run's `config` snapshot, needs no new
foreign keys, and — decisively — puts the asset id **where the `media_asset_id` reservation index
cannot see it**:

```sql
uniqueIndex (project_id, media_asset_id)
  WHERE media_asset_id IS NOT NULL AND status IN ('queued','running')
```

That index is the pool reservation. If a row's portrait went into `media_asset_id`, two rows naming
one portrait on one date would collide on it (the spec's edge case requires both to fire) and the
portrait would show as reserved in the library (A14 forbids it). Keeping it inside `dated` makes
"used, not consumed" structural rather than remembered.

`emptyPositionCounts()` gains a `missed: 0` key, and `nextDue`'s `CASE` is unchanged (`'missed'` is
terminal, so it is neither due nor open).

---

## 6. `standing_series_runs` — unchanged shape, one new CHECK

No new column. A dated run is:

| Field | Value for a dated run |
|---|---|
| `period` | `'date'` |
| `period_start` | the target date, `YYYY-MM-DD`, local |
| `period_start_at` | `periodStartInstant(targetDate, zone)` |
| `requested_count` | the number of rows due on that date, 1–10 (inside the existing CHECK) |
| `missed_periods` | always `0` — a dated series has no periods to miss; misses are occurrences |
| `plan` | always NULL |
| `config` | the snapshot below |

```sql
-- B9: a dated run never plans (A29, FR-038)
CHECK (period <> 'date' OR plan IS NULL)
```

The config schema stays `v: 1` (**B33**), so every snapshot `071` already stored parses unchanged:

```ts
{ v: 1,
  rule: "cadence" | "dated_list",   // NEW, defaults to "cadence" when absent
  brief, template, templateFields, voiceProfileId, targetAccountIds,
  cadence: { count, period } | null,  // now nullable
  leadDays: number,                   // NEW, 0 for a cadence series
  media, requested, resolved }
```

---

## 7. `posts` — changed

| Column | Type | Change | Why |
|---|---|---|---|
| `queue_not_before` | `timestamptz` | **new**, nullable | B13, FR-039. The earliest instant a **queue** allocation may place this post. |

Every existing post has NULL, so `queueFloor(post, now) = max(now, post.queueNotBefore ?? now)`
returns `now` and the three existing call sites behave exactly as they do today. Set to
`periodStartInstant(targetDate, zone)` when a dated position's post is saved. Explicit scheduling
(`scheduleAt`, `publishNow`) is a deliberate human act and is not floored.

---

## 8. Entities, in the spec's words

| Spec entity | Where it lives |
|---|---|
| **Standing series (extended)** | `standing_series` + `occurrence_rule`, `lead_days`, the four import columns; `cadence_*` and `next_run_at` relaxed to nullable; `template_fields` finally used. |
| **Dated row** | `standing_series_dated_rows`. Identity = `(series_id, month, day, coalesce(year,0), lower(btrim(key_value)))`. |
| **Occurrence** | `standing_series_occurrences`. One per `(row_id, year)`, by unique constraint. |
| **Import record** | Four columns on `standing_series`, replaced whole by the next successful import (**B14** — not a fifth table: one row per series by definition, no independent lifetime). |
| **Run and position (existing)** | `standing_series_runs` with `period = 'date'`; `standing_series_positions` with `dated`. |

---

## 9. The occurrence lifecycle

```text
                     import / add a row
                              │
                              ▼
                    next_target_date = <the first year whose
                    target date is not already behind today>
                              │
        ┌─────────────────────┴──────────────────────┐
        │ target − lead ≤ today ≤ target             │ target < today
        ▼ (eligible, B4)                             ▼ (window closed)
  run opens for that date                      evaluation pass (B25)
  ├─ occurrence INSERT (outcome NULL, position_id set)   ├─ ≤ 30 days old → INSERT outcome='missed'
  ├─ position INSERT with `dated`                        └─ always: advance next_target_date
  └─ next_target_date advanced in the SAME transaction
        │
        ▼ the producer, unchanged path
  ┌─────┴─────┬──────────────┬───────────────┐
  ▼           ▼              ▼               ▼
produced    failed        skipped      window closes first
(post)    (terminal)    (media)        (position → 'missed')
  │           │              │               │
  └───────────┴──────────────┴───────────────┘
                  outcome written, settled_at set, run closed
```

Rules this diagram encodes:

- **FR-040** — `unique(row_id, year)` is crossed exactly once, at run-open, inside the transaction
  that also creates the position and advances `next_target_date`. Two ticks, an expired lease, a
  restart, a recovered run and an identical re-import all resolve to one occurrence.
- **FR-034 / A26** — eligibility is `target − lead ≤ today ≤ target` in local dates. After that the
  occurrence is `missed` and never fires. A paused series and a down worker are the same case.
- **FR-035 / FR-036** — a miss is a distinct outcome, recorded only for windows closed within 30
  days, at most 50 per pass; the *advance* is unbounded by age so no row's date can get stuck in the
  past (**B25**).
- **A24 / FR-031** — `02-29` resolves to `02-28` in a non-leap year; `target_date` stores the
  resolved date, so history is unambiguous.
- **A19 / FR-024** — a re-import matches on the identity index: matched rows are `UPDATE`d (their
  occurrences survive by FK), absent rows are `DELETE`d (occurrences cascade), new rows are inserted.
  Nothing touches a `posts` row.
- **A22 / FR-028** — deleting a row cascades its occurrences and leaves its posts, because a post
  references the *position*, not the row.
- **FR-025** — no import or row write touches `posts`, `post_targets` or `standing_series_positions`.

---

## 10. Migration

One forward-only SQL file, `drizzle/<n>_dated_series.sql`, generated with `pnpm db:generate` and
committed, in this order:

1. `CREATE TYPE` × 2.
2. `ALTER TYPE standing_series_period ADD VALUE 'date';` and
   `ALTER TYPE standing_series_position_status ADD VALUE 'missed';` — each its own statement, neither
   value used in the same transaction.
3. `ALTER TABLE standing_series` — add seven columns with defaults, drop three `NOT NULL`s, add the
   CHECKs.
4. `ALTER TABLE standing_series_positions ADD COLUMN dated jsonb` + its CHECK.
5. `ALTER TABLE standing_series_runs ADD CHECK (period <> 'date' OR plan IS NULL)`.
6. `ALTER TABLE posts ADD COLUMN queue_not_before timestamptz`.
7. `CREATE TABLE standing_series_dated_rows` + indexes.
8. `CREATE TABLE standing_series_occurrences` + indexes.

**No backfill, no data migration, no destructive step.** Existing rows take
`occurrence_rule = 'cadence'`, `lead_days = 0`, `list_version = 0` and `queue_not_before = NULL`,
which is byte-for-byte today's behaviour. `pnpm db:check` must be clean afterwards.
