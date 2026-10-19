# Phase 1 data model: trends, comparisons, the fold and the first-engagement record

**Feature**: 083-insights-schedule-intelligence | **Date**: 2026-10-18

One migration. **Three new tables, one new enum type, no change to any existing column**, plus one
optional field added to a jsonb document that needs no migration at all.

Everything below is derived from [spec.md](./spec.md)'s Key Entities and FR-050 to FR-057; the design
decisions behind the shapes are in [research.md](./research.md) §2-§4.

---

## §1 `metric_kind` (new enum type)

```sql
CREATE TYPE metric_kind AS ENUM ('cumulative', 'windowed', 'unknown');
```

Mirrors the `MetricShape` discriminant (research §1). Stored on a rollup point so a point's
provenance is complete without consulting the provider registry — which matters when a provider is
later removed or reclassified and a 400-day-old point must still say what it was.

The window length and the `unknown` reason are **not** stored: they are declaration facts, identical
for every row of a key, and the registry is the one place they live (constitution IV). A point whose
key the registry no longer knows is read as `unknown` and is absent from trends, per FR-004.

---

## §2 `account_metric_rollups` (new)

One durable point per account, per metric key, per UTC day. Written only by the fold, immediately
before the snapshots it came from are deleted, in the same transaction (research §3.1). **Never
pruned** — that is the point.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` pk | `gen_random_uuid()` |
| `project_id` | `uuid` not null | → `projects.id` `ON DELETE CASCADE` (FR-056) |
| `social_account_id` | `uuid` not null | → `social_accounts.id` `ON DELETE CASCADE` (FR-056, US5.6) |
| `provider_key` | `text` not null | the platform's key, so a trend labels itself without a join |
| `metric_key` | `text` not null | the platform's own key, verbatim |
| `captured_day` | `date` not null | the **UTC** day of `captured_at` (research §3.3) |
| `value` | `double precision` not null | the chosen reading's value |
| `captured_at` | `timestamptz` not null | the real instant the chosen reading was captured — what the reader re-buckets and what "as of" shows |
| `kind` | `metric_kind` not null | the key's shape at fold time |
| `created_at` | `timestamptz` not null | `defaultNow()` |

Constraints and indexes:

- `unique (project_id, social_account_id, metric_key, captured_day)` — the upsert target, and the
  one-point-per-day guarantee (FR-050).
- `check char_length(provider_key) between 1 and 50`
- `check char_length(metric_key) between 1 and 100`
- `check captured_at = date_trunc('milliseconds', captured_at)` — matches both snapshot tables.
- `index (project_id, social_account_id, captured_day)` — the trend read's range scan.

**Not** CHECK-enforced: that `captured_day` is the UTC day of `captured_at`. Both candidate
expressions are STABLE rather than IMMUTABLE for a `timestamptz`, so Postgres rejects them in a
CHECK. The invariant is written by the fold and asserted by test — the same posture
`schema/insights.ts:7` already takes for the snapshot tables' append-only property.

---

## §3 `post_metric_rollups` (new)

Identical in shape and purpose, for a post target. One generic fold writes both (research §3.4).

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` pk | |
| `project_id` | `uuid` not null | → `projects.id` cascade |
| `post_target_id` | `uuid` not null | → `post_targets.id` cascade |
| `social_account_id` | `uuid` not null | → `social_accounts.id` cascade — carried so a comparison can group by platform without joining back to the target |
| `provider_key` | `text` not null | |
| `metric_key` | `text` not null | |
| `captured_day` | `date` not null | UTC day |
| `value` | `double precision` not null | |
| `captured_at` | `timestamptz` not null | |
| `kind` | `metric_kind` not null | |
| `created_at` | `timestamptz` not null | |

- `unique (project_id, post_target_id, metric_key, captured_day)`
- the same three CHECKs as §2
- `index (project_id, post_target_id, captured_day desc)` — "the latest value per target" for a
  comparison
- `index (project_id, social_account_id, captured_day)` — the per-platform range scan

### Why `double precision` and not `integer`

Snapshot `metrics` is jsonb and the filter that writes it only keeps JSON numbers; nothing guarantees
they are integers. Pinterest's analytics response carries fractional values
(`VIDEO_AVG_WATCH_TIME: 2507.75`) and although Docket declares none of those keys today, a later entry
that does must not need a migration — and a silent truncation would be worse than a wide column.

---

## §4 `target_first_engagement` (new)

One row per published target, written once per fact and never rewritten (FR-040, FR-043). Instants,
not intervals; **no inbox identifier, author, handle, URL or text** (research §4).

| Column | Type | Notes |
|---|---|---|
| `post_target_id` | `uuid` pk | → `post_targets.id` `ON DELETE CASCADE` |
| `project_id` | `uuid` not null | → `projects.id` cascade |
| `social_account_id` | `uuid` not null | → `social_accounts.id` cascade |
| `published_at` | `timestamptz` not null | copied at record time, so the interval survives everything |
| `exact_first_at` | `timestamptz` null | the `said_at` of the earliest inbox item parented to this target. Inbox-sourced; preferred at read time (FR-041) |
| `bound_before_at` | `timestamptz` null | the `captured_at` of the first snapshot showing any declared engagement metric above zero |
| `bound_after_at` | `timestamptz` null | the `captured_at` of the snapshot immediately before it. `null` while `bound_before_at` is set means "already present in the very first reading" → the upper bound FR-042 requires |
| `scanned_through` | `timestamptz` null | watermark: the newest `captured_at` examined. Moves forward every pass; not a figure |
| `first_recorded_at` | `timestamptz` null | when the first of the two figures was written. `null` until one is |
| `created_at`, `updated_at` | `timestamptz` not null | |

Constraints and indexes:

- `check exact_first_at is null or exact_first_at >= published_at`
- `check bound_before_at is null or bound_before_at > published_at`
- `check bound_after_at is null or bound_before_at is not null` — a lower bound without an upper one
  is meaningless
- `check bound_after_at is null or bound_after_at < bound_before_at`
- `check bound_after_at is null or bound_after_at >= published_at`
- `check (first_recorded_at is null) = (exact_first_at is null and bound_before_at is null)`
- `check` ms truncation on all five timestamps, as the snapshot tables do
- `index (project_id, social_account_id)` — the comparison's read

### Write-once is a DAL property, not a CHECK

A CHECK cannot see the previous row. Each write is a compare-and-set —
`UPDATE … SET exact_first_at = $1, first_recorded_at = coalesce(first_recorded_at, $1) WHERE
post_target_id = $2 AND project_id = $3 AND exact_first_at IS NULL` — which is simultaneously the
write-once guarantee (FR-043) and the concurrency guarantee (FR-057): two schedulers racing produce
one winner and no overwrite. The repo exposes no `set` that can clear or replace either figure.
`scanned_through` is the one column that moves, and it is explicitly not one of the figures.

### The states this row can be in, and what each means

| `exact_first_at` | `bound_before_at` | `scanned_through` | Reported as |
|---|---|---|---|
| set | — | — | an exact interval, inbox-sourced (FR-041) |
| — | set, `bound_after_at` set | — | "between X and Y after publication", snapshot-sourced (FR-042) |
| — | set, `bound_after_at` null | — | "within the first reading" — an upper bound only (FR-042, US6.2) |
| — | — | set | "no engagement yet, as of `scanned_through`" (FR-044) |
| — | — | null | not yet examined — reported as neither, and counted as such |

A target frozen `gone`, `expired` or `unqueryable` with `exact_first_at` and `bound_before_at` both
null is reported **"never observed"** and excluded from the timing average with the exclusion stated
(FR-044, US6.7). The freeze is read from `post_metric_poll_states.frozen_reason`, not stored here.

---

## §5 `MetricKeyDeclaration.shape` (G38) — a type change, not a schema change

```ts
export type MetricShape =
  | { kind: "cumulative" }
  | { kind: "windowed"; windowMs: number | null }
  | { kind: "unknown"; reason: string };

export interface MetricKeyDeclaration {
  key: string;
  label: string;
  /** G38 (FR-001, FR-002). Required: a key cannot be declared without saying what shape it is. */
  shape: MetricShape;
}
```

Required with no default, so `tsc` rejects a provider that omits it (FR-002). All 46 declared keys
across eight providers are classified in [research.md](./research.md) §1.1. Nothing else about any
declaration changes: no key added or removed, no label, no scope, no `maxPostsPerRead`, no
`readBudget`, no request (FR-005).

---

## §6 `generationRecordSchema.standingSeries` — jsonb, no migration

```ts
standingSeries: z.object({
  id: z.string(),
  name: z.string(),
  occurrenceRule: z.enum(["cadence", "dated_list"]),
}).nullish(),
```

Written by the standing-series runner through `saveGeneratedPost`. `nullish`, so every record already
stored still parses. This is the durable home for the series-kind dimension; the reason it is needed
at all — a closed run is pruned at 90 days and nulls `posts.standing_series_position_id` — is
[research.md](./research.md) §2.2.

Read order for the dimension, in this precedence:

1. the recorded `standingSeries` on the post's latest generation record;
2. the live `posts.standing_series_position_id → … → standing_series.occurrence_rule` join, for posts
   that predate this entry and whose run has not yet been pruned;
3. otherwise the post is a **stated exclusion**: "Docket no longer records which series this post came
   from" (FR-036), never a post that performed badly.

---

## §7 Read models (no storage)

These are derived shapes, computed per request and cached nowhere (the spec's "nothing is cached
across ranges").

### 7.1 `TrendSeries`

```ts
interface TrendPoint { day: string; value: number; capturedAt: Date }   // day is a project-local ISO date
interface TrendSeries {
  accountId: string; accountName: string; providerKey: string; platform: string;
  metricKey: string; label: string; shape: MetricShape;
  points: TrendPoint[];        // ascending; a day with no reading is simply absent (FR-014)
  range: { from: string; to: string };
  asOf: Date | null;           // the newest point's capturedAt (FR-016)
  lastSuccessfulReadAt: Date | null;  // US1.5: what to say when polling has been failing
}
```

Belongs to exactly one account and therefore exactly one platform. There is no type in this entry
that can hold two platforms' values — "never sum across platforms" is enforced by the shape, not by
a rule anyone must remember (FR-011).

### 7.2 `Comparison`, `ComparisonGroup`, `Exclusion`

```ts
type GroupVerdict = "ranked" | "provisional";                 // "suppressed" never reaches a group
type Conclusion = "ranked" | "not_enough_posts";

interface ComparisonGroup {
  key: string; label: string;
  removed: boolean;                 // the slot/profile/series/account behind it is gone (FR-037)
  sampleSize: number;               // >= PROVISIONAL_MIN, always stated (FR-031)
  mean: number; median: number;
  singleAccount: { id: string; name: string } | null;  // "Thursday wins" that is really one account
  verdict: GroupVerdict;
}

interface Exclusion { reason: ExclusionReason; count: number }
type ExclusionReason =
  | "no_external_id" | "no_snapshot" | "not_slot_scheduled"
  | "frozen_without_reading" | "series_unrecorded" | "metric_shape_unknown";

interface Comparison {
  dimension: "slot" | "day_of_week" | "series_kind" | "voice_profile" | "origin";
  providerKey: string; platform: string;        // exactly one (FR-034)
  metricKey: string; label: string; shape: MetricShape;
  range: { from: string; to: string }; timeZone: string;
  groups: ComparisonGroup[];        // ordered by value only when conclusion is "ranked" (FR-033)
  suppressedGroupCount: number;     // below the floor, counted and stated (FR-032)
  exclusions: Exclusion[];
  conclusion: Conclusion;
  asOf: Date | null;
}
```

The floor lives in one place as two constants, not configuration (the spec's assumption — a knob here
would let an operator turn the honesty off):

```ts
export const RANK_MIN = 8;          // FR-032: ranking, superlatives and ordering need 8
export const PROVISIONAL_MIN = 4;   // FR-032: below 4 a group is not drawn at all
```

`conclusion` is `"ranked"` only when at least two groups reach `RANK_MIN` — one arm is not a
comparison (the spec's "Not enough data" edge case). Otherwise `"not_enough_posts"`, and the groups
are returned in a stable non-value order (label order) so the layout implies nothing (FR-033).

### 7.3 `FirstEngagementFigure`

```ts
type FirstEngagementFigure =
  | { kind: "exact"; afterMs: number }                               // inbox-sourced
  | { kind: "bounded"; afterAtLeastMs: number; afterAtMostMs: number } // snapshot-sourced
  | { kind: "within_first_reading"; afterAtMostMs: number }
  | { kind: "none_yet"; asOf: Date }
  | { kind: "never_observed"; asOf: Date; frozenReason: string }
  | { kind: "not_examined" };
```

Rendered with its own source and resolution every time (FR-040). `none_yet` and `never_observed` are
counted and reported separately, never averaged in as zero and never dropped from the stated sample
size (FR-044).

---

## §8 Housekeeping counts

`HousekeepingCounts` gains four fields; the two existing prune counts keep their names and meaning
(rows deleted), so 080's retention test still reads as before.

```ts
postMetricPointsFolded: number;        // rollup points written or advanced
accountMetricPointsFolded: number;
firstEngagementRecorded: number;       // figures written this pass
firstEngagementScanned: number;        // targets examined — so a pass that found nothing is visible
```

FR-055's "a pass that folded nothing is visible rather than silent" is why `firstEngagementScanned`
exists beside `firstEngagementRecorded`: zero recorded with hundreds scanned is a working pass, zero
and zero is a stalled one, and the two must be distinguishable in `TickSummary`.

---

## §9 Migration

One file, generated by `pnpm db:generate` (FR-083), numbered after `0046_low_colleen_wing.sql`:

1. `CREATE TYPE metric_kind`;
2. `CREATE TABLE account_metric_rollups` + its constraints and indexes;
3. `CREATE TABLE post_metric_rollups` + its constraints and indexes;
4. `CREATE TABLE target_first_engagement` + its constraints and index.

No backfill statement. Every historical figure this entry needs is derivable by the two bounded
housekeeping steps as they run (FR-046), so nothing in the migration has to walk a large table while
holding a lock. `pnpm db:check` must be green, and the generated number must be verified against
`drizzle/` rather than assumed — 082 had to renumber one.

All three tables are added to `src/server/db/project-owned.ts` with `scopeColumn: "project_id"`, which
is what makes `tests/helpers/scope-check` fail any unscoped query against them.
