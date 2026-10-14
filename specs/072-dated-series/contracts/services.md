# Contract — services, schemas and the pure module

**Feature**: `072-dated-series` | **Plan**: [../plan.md](../plan.md)

Every signature below is the contract implementation must meet. Paths are repository-relative.
"Throws `ValidationIssuesError`" means the existing error with `{ code, field, message }` issues;
"throws `ConflictError`" and "`NotFoundError`" are the existing errors from `src/server/dal/errors.ts`.

---

## 1. `src/lib/series/dated.ts` — pure

No database, no `Date.now()`, no `process.env`. Imports only `@js-temporal/polyfill` and
`periodStartInstant` from `./cadence` (**B7**).

```ts
export const DATED_ROWS_MAX = JOB_ITEMS_MAX;            // 500 — re-exported, never redefined
export const DATED_ROWS_PER_DATE_MAX = CADENCE_COUNT_MAX; // 10 — the run's own position cap
export const LEAD_DAYS_MIN = 0;
export const LEAD_DAYS_MAX = 30;
export const RESERVED_COLUMNS = ["date", "media"] as const;

/** A row's date: a month and day, optionally pinned to a year. */
export interface DatedSpec { month: number; day: number; year: number | null }

export type DateParseError = "format" | "impossible";

/** `MM-DD` or `YYYY-MM-DD`, zero-padded, hyphens only, after trimming (A9, FR-011). */
export function parseDatedValue(raw: string): DatedSpec | { error: DateParseError };

/** Is `name` one of the reserved columns, case-insensitively (A8, FR-010)? */
export function isReservedColumn(name: string): boolean;

/** The occurrence's target date in `year`: the spec's month/day, with 02-29 constrained to
 *  02-28 in a non-leap year (A24, FR-031). Throws for a year-specific spec and a different year. */
export function targetDateFor(spec: DatedSpec, year: number): Temporal.PlainDate;

/** The local date of the next occurrence not in `firedYears` whose target date is not behind
 *  `today`. `null` when the row has no occurrence left (a year-specific row already recorded, or
 *  one whose year is behind `today`). Forward-only and deterministic (B26). */
export function nextTargetDate(
  spec: DatedSpec,
  today: Temporal.PlainDate,
  firedYears: readonly number[],
): Temporal.PlainDate | null;

/** NORMATIVE eligibility (B4): `target - lead <= today <= target`, all local dates. */
export function isEligible(target: Temporal.PlainDate, leadDays: number, today: Temporal.PlainDate): boolean;

/** Derived, for display only: local midnight of `target - lead` through `periodStartInstant`. */
export function dueInstant(target: Temporal.PlainDate, leadDays: number, zone: string): Date;

/** Derived, for display only: local midnight of `target + 1 day`. */
export function windowEnd(target: Temporal.PlainDate, zone: string): Date;

/** The local date `now` falls on in `zone`. The one place an instant becomes a date. */
export function localToday(now: Date, zone: string): Temporal.PlainDate;

/** The next `limit` occurrences across `rows`, soonest first, each with its generation instant
 *  (FR-044, FR-047). Rows with no next target date are omitted. */
export function upcoming(
  rows: readonly { id: string; keyValue: string; nextTargetDate: string | null }[],
  leadDays: number,
  zone: string,
  limit: number,
): { rowId: string; keyValue: string; target: string; dueAt: Date }[];
```

**Required unit tests** (`src/lib/series/dated.test.ts`):

- `parseDatedValue`: accepts `03-14`, `2027-03-14`, `" 03-14 "`; rejects `3/14`, `14-03`, `Mar 14`, `14 March`, `3-14`, `2027/03/14`, `03-14-2027`, `""` as `"format"`; rejects `02-30`, `13-01`, `00-05`, `04-31`, `2027-02-29` as `"impossible"`; accepts `02-29` with no year and `2028-02-29`.
- `targetDateFor`: `02-29` → `2028-02-29` in a leap year and `2027-02-28` otherwise, and **never** `03-01`.
- `nextTargetDate`: every-year rows roll to the next year once fired; a year-specific row returns its date once and then `null`; a year-specific row whose year is past returns `null`; a row whose date is *today* returns today (it is inside its window).
- `isEligible` ⟺ `dueInstant <= now < windowEnd` for every hour of the day across **both** DST transitions in `America/New_York` and `Pacific/Auckland`, for `leadDays` 0, 1 and 30. This is the test that keeps the two forms from drifting (**B4**).
- `dueInstant` for a date whose local midnight does not exist moves forward, and for one that exists twice takes the earlier offset — exactly one instant, including in `Australia/Lord_Howe` (30-minute offset) and `Asia/Kathmandu` (45-minute offset).
- `upcoming` orders by target date then `ordinal`, and omits rows with `nextTargetDate = null`.

---

## 2. `src/server/services/jobs/sources/csv.ts` — extended, not duplicated (B1)

```ts
export interface TaggedCsvProblem extends CsvProblem { scope: "file" | "row" }

export interface CsvFileResult {
  /** Every problem, in today's push order: header problems (line 1), then row problems in line
   *  order, then the over-500 count. */
  problems: TaggedCsvProblem[];
  columns: string[];
  rows: CsvRow[];
}

/** The current body of `parseJobCsv`, with each problem tagged. Pure. */
export function parseCsvFile(bytes: Uint8Array): CsvFileResult;

/** UNCHANGED signature and behaviour: any problem refuses the whole file. */
export function parseJobCsv(bytes: Uint8Array): CsvParseResult;
```

Tagging:

| Problem | Scope |
|---|---|
| larger than 1 MB; not UTF-8; unreadable as CSV (all three `CsvError` messages) | `file` |
| a blank, over-long, invalid or duplicated column name | `file` |
| no data rows | `file` |
| more than 500 data rows | `file` |
| more values than the header; a row longer than 50,000 characters | `row` |

`parseJobCsv` becomes:

```ts
export function parseJobCsv(bytes: Uint8Array): CsvParseResult {
  const r = parseCsvFile(bytes);
  if (r.problems.length > 0) return { ok: false, problems: r.problems.map(({ line, message }) => ({ line, message })) };
  return { ok: true, columns: r.columns, rowCount: r.rows.length, rows: r.rows, preview: r.rows.slice(0, 5) };
}
```

**The acceptance test for this change is that `src/server/services/jobs/sources/csv.test.ts` passes
with no edit at all.** If an assertion has to move, the refactor is wrong (FR-020). `csvSource.prepare`
and `validateCsvAction` are likewise untouched.

---

## 3. `src/lib/validation/dated-rows.ts` — new

```ts
export const DATED_KEY_VALUE_MAX = 500;
export const IMPORT_PROBLEMS_MAX = 100;

/** One row as a person types it in the row dialog. */
export const datedRowInputSchema = z.object({
  date: z.string().trim().min(1, { error: "Enter a date as MM-DD or YYYY-MM-DD" }),
  media: z.string().trim().max(255).nullish(),
  /** Every non-reserved column of the list → its value. Extra or missing keys are refused. */
  fields: z.record(z.string(), z.string().max(JOB_ITEM_DATA_MAX)),
});
export type DatedRowInput = z.infer<typeof datedRowInputSchema>;

export const importDatedListSchema = z.object({ filename: z.string().trim().min(1).max(255) });

export const importProblemSchema = z.object({ line: z.number().int().nullable(), message: z.string().max(300) });
export const importRecordSchema = z.object({
  filename: z.string(), at: z.string(), rowCount: z.number().int().nonnegative(),
  problems: z.array(importProblemSchema).max(IMPORT_PROBLEMS_MAX),
});
```

`src/lib/validation/standing-series.ts` changes:

```ts
export const OCCURRENCE_RULES = ["cadence", "dated_list"] as const;

createStandingSeriesSchema = z.object({ …existing…,
  occurrenceRule: z.enum(OCCURRENCE_RULES).default("cadence"),
  cadence: cadenceSchema.nullish(),          // was required
  leadDays: z.number().int().min(0).max(30).default(0),
}).superRefine(…)
```

`superRefine` rules, each with the field it attaches to:

| Rule | Message | FR |
|---|---|---|
| `occurrenceRule = "cadence"` requires `cadence` | "Choose how often it posts" on `cadence` | FR-001 |
| `occurrenceRule = "dated_list"` refuses `cadence` | "A dated series has no cadence" on `cadence` | FR-004 |
| `occurrenceRule = "cadence"` requires `leadDays === 0` | "Lead time only applies to a dated list" on `leadDays` | A3 |

`updateStandingSeriesSchema` keeps `occurrenceRule` so the service can compare it, and the **service**
refuses a change (FR-002) rather than the schema, because the message must name the existing rule.

`standingSeriesRunConfigSchema` gains `rule: z.enum(OCCURRENCE_RULES).default("cadence")`,
`leadDays: z.number().int().min(0).max(30).default(0)` and `cadence: cadenceSchema.nullable()` —
still `v: 1`, so every config `071` stored parses unchanged (**B33**).

New `datedPositionSchema` for the position's `dated` jsonb, shape as
[../data-model.md](../data-model.md) § 5.

---

## 4. `src/server/dal/standing-series-dated.ts` — new

```ts
export interface DatedRowRecord { /* the table row, `nextTargetDate` as a "YYYY-MM-DD" string */ }
export interface DatedOccurrenceRecord { /* the table row */ }

export interface DatedRowsRepo {
  /** File order. Throws 23505 on the identity index. */
  insertMany(seriesId: string, rows: readonly NewDatedRow[]): Promise<DatedRowRecord[]>;
  insert(seriesId: string, row: NewDatedRow): Promise<DatedRowRecord>;
  get(id: string): Promise<DatedRowRecord | null>;
  /** All rows of a series, `ordinal ASC`. Used by the importer's identity match and `upcoming`. */
  listForSeries(seriesId: string): Promise<DatedRowRecord[]>;
  /** One page, `ordinal ASC`, plus the total (FR-047's paginated table). */
  page(seriesId: string, opts: { page: number; pageSize: number }): Promise<{ rows: DatedRowRecord[]; total: number }>;
  count(seriesId: string): Promise<number>;
  update(id: string, patch: DatedRowPatch): Promise<DatedRowRecord | null>;
  delete(id: string): Promise<boolean>;
  deleteMany(ids: readonly string[]): Promise<number>;
  /** Rows whose window is open or past, `next_target_date ASC` then `ordinal ASC`, limit `n`.
   *  `today` is the project's local date as "YYYY-MM-DD", from the engine clock. */
  dueOrPast(seriesId: string, today: string, leadDays: number, limit: number): Promise<DatedRowRecord[]>;
  /** Rows whose `next_target_date` equals `date`, `ordinal ASC`. The run's positions (A28). */
  dueOn(seriesId: string, date: string): Promise<DatedRowRecord[]>;
  /** `UPDATE … SET next_target_date = $2 WHERE id = $1 AND next_target_date = $3`.
   *  `false` means another worker already advanced it — forward-only, never backwards. */
  advance(id: string, to: string | null, from: string): Promise<boolean>;
  /** Fired years per row, for `nextTargetDate`. One query for a set of rows. */
  firedYears(rowIds: readonly string[]): Promise<Map<string, number[]>>;
}

export interface DatedOccurrencesRepo {
  /** Throws 23505 on `unique(row_id, year)` — the FR-040 guard. */
  insert(input: NewDatedOccurrence): Promise<DatedOccurrenceRecord>;
  /** `ON CONFLICT (row_id, year) DO NOTHING`, then a re-select. For the bounded missed pass. */
  recordMissed(input: { seriesId: string; rowId: string; year: number; targetDate: string; at: Date }): Promise<void>;
  get(id: string): Promise<DatedOccurrenceRecord | null>;
  forPosition(positionId: string): Promise<DatedOccurrenceRecord | null>;
  /** Writes `outcome` and `settled_at` WHERE outcome IS NULL. `false` means already settled. */
  settle(id: string, outcome: DatedOutcome, at: Date): Promise<boolean>;
  listForSeries(seriesId: string, opts: { limit: number }): Promise<DatedOccurrenceRecord[]>;
  listForRow(rowId: string, opts: { limit: number }): Promise<DatedOccurrenceRecord[]>;
}
```

Both are registered on `ProjectScope` as `scope.datedRows` and `scope.datedOccurrences`, with **no**
`KEY_GRANTS` entry (no API-key permission reaches a dated list — A38, FR-049).

Extensions to existing repos:

- `MediaRepo.findLiveByFilenames(names: readonly string[]): Promise<{ filename: string; id: string; kind: string }[]>` — one query, live rows only, `lower(original_filename) IN (…)`, every kind (so a video can be *reported as* a video rather than silently unmatched) (**B23**).
- `StandingSeriesRepo.bumpListVersion(id: string, expected: number): Promise<boolean>` — `UPDATE … SET list_version = list_version + 1 WHERE id = ? AND list_version = ?` (**B21**).
- `StandingSeriesPatch` gains `occurrenceRule`, `leadDays`, the four `lastImport*` fields and `listVersion`; `nextRunAt` becomes `Date | null`.
- `PostsRepo`'s patch type gains `queueNotBefore`.

---

## 5. `src/server/services/standing-series/dated-due.ts` — new

The one answer to "which rows are due" (**B24**).

```ts
export const MISSED_SWEEP_LIMIT = 50;          // FR-036
export const MISSED_RECORD_WINDOW_DAYS = 30;   // FR-036

export interface DatedEvaluation {
  /** The oldest due target date, "YYYY-MM-DD", or null when nothing is due (A28, FR-037). */
  dueDate: string | null;
  /** Occurrences recorded as missed by this pass. */
  missed: number;
  /** Rows whose `next_target_date` this pass moved forward. */
  retired: number;
}

/**
 * Retires every row whose window has closed and reports the oldest date still due.
 * Reads `scope.project.timezone` on every call (A32, FR-041) and takes the engine clock's `now`.
 * Called by the producer before opening a run, by `resumeStandingSeries`, and never by a read path.
 */
export async function evaluateDatedSeries(
  scope: ProjectScope, series: StandingSeriesRecord, now: Date,
): Promise<DatedEvaluation>;
```

Algorithm, in order:

1. `today = localToday(now, scope.project.timezone)`.
2. `rows = scope.datedRows.dueOrPast(series.id, today, series.leadDays, MISSED_SWEEP_LIMIT)`.
3. For each row with `nextTargetDate < today` (the window closed):
   - when `today - nextTargetDate <= 30` days: `recordMissed(...)` (`ON CONFLICT DO NOTHING`, so a re-run is free);
   - **always**: `advance(row.id, nextTargetDate(spec, today, firedYears), nextTargetDate)` — the advance is **not** bounded by age, so no row can get stuck with a date in the past (**B25**).
4. `dueDate` = the smallest `nextTargetDate` among rows where `isEligible(target, leadDays, today)`.
5. Return the counts.

The pass writes no post, calls no provider, and holds no transaction across more than one row.

---

## 6. `src/server/services/standing-series/dated-import.ts` — new

```ts
export interface ImportProblem { line: number | null; message: string }
export interface ImportResult {
  rowCount: number;          // rows stored
  problems: ImportProblem[]; // ≤ 100, each with its file line and reason
  added: number; updated: number; removed: number;
}

/** Owner/admin. FR-019 … FR-026, FR-029. */
export async function importDatedList(
  scope: ProjectScope, seriesId: string, file: { name: string; bytes: Uint8Array },
): Promise<ImportResult>;
```

Order of operations:

1. `need(scope, { standing_series: ["manage"] })`; load the series or `NotFoundError`; refuse a cadence series with "Only a dated series has a list".
2. `parseCsvFile(file.bytes)`. **Any `scope: "file"` problem** → `ValidationIssuesError` with every file problem, nothing written (FR-021).
3. Header: find `date` (required — absent → a file-level refusal naming it) and `media` (optional), both case-insensitively; the remaining columns in file order are the template fields, and the **first** of them is the key column (A10). No non-reserved column → the list has a date column only, which is allowed (edge case) and makes `template_fields` empty.
4. `unknownPlaceholders(series.template, fields)` non-empty → refuse **whole** with the existing message `"Unknown field: x. Available: a, b"` (A21, FR-021, FR-027).
5. `scope.media.findLiveByFilenames(the distinct non-empty media values)` — one query (**B23**).
6. Per row, in file order, collecting a problem and skipping on the first failure:

   | Check | Message |
   |---|---|
   | `parseDatedValue` → `"format"` | `Line N: "3/14" is not a date. Use MM-DD or YYYY-MM-DD.` |
   | `parseDatedValue` → `"impossible"` | `Line N: 02-30 is not a real date.` |
   | a year-specific date already past in the project's zone | `Line N: 2026-03-14 has already passed.` |
   | the key column's value is blank after trimming | `Line N: "<key column>" is empty.` |
   | the identity already used by an earlier row of this file | `Line N: 03-14 and "Ada Lovelace" are already on line M.` |
   | the eleventh row resolving to one calendar date | `Line N: 03-14 already has 10 rows.` |
   | a media reference matching nothing | `Line N: no image called "ada.jpg" is in the library.` |
   | a media reference matching more than one live asset | `Line N: more than one file is called "ada.jpg".` |
   | a media reference matching a video | `Line N: "ada.mp4" is a video; a row's image must be an image.` |
   | rendered instructions over 10,000 characters (**B3**) | `Line N: the instructions would be 12,431 characters; the limit is 10,000.` |

   Plus every `scope: "row"` problem the parser already produced, merged by line number so the
   report reads in file order.
7. Usable rows beyond 500 → a file-level refusal (the parser's own 500-row check normally catches
   this first; the service re-checks because a hand-added row could have raised the stored count).
8. One transaction:
   - `bumpListVersion(seriesId, series.listVersion)` → `false` → `ConflictError("The list changed while this import was running. Reload and try again.")` (**B21**, FR-029);
   - match each usable row against the stored rows by identity: matched → `update` (fields, media, filename, ordinal, source line) keeping its occurrences; unmatched stored rows → `deleteMany` (their occurrences cascade); new rows → `insertMany`;
   - compute `next_target_date` for every added row, and for an updated row **only when it is NULL** (a matched row keeps its place in the year — FR-024's "keep their fire history");
   - renumber `ordinal` to file order;
   - write `template_fields`, the four `last_import_*` columns (problems clipped to 100) and an audit row `standing_series_dated_import` with `{ seriesId, filename, rowCount, problemCount }`;
   - re-check the 500-row and per-date caps against the final stored set.
9. Return the result. **No `posts` row is read or written** (FR-025).

A unique violation on the identity index inside step 8 means two writers raced past the version
guard; it is mapped to the same `ConflictError`, never to a 500.

---

## 7. `src/server/services/standing-series/dated-rows.ts` — new

```ts
export async function addDatedRow(scope: ProjectScope, seriesId: string, input: unknown): Promise<{ rowId: string }>;
export async function updateDatedRow(scope: ProjectScope, seriesId: string, rowId: string, input: unknown): Promise<void>;
export async function deleteDatedRow(scope: ProjectScope, seriesId: string, rowId: string): Promise<void>;
```

All three: `need(scope, { standing_series: ["manage"] })` at the top **and** again inside the
transaction; `NotFoundError` for another project's series or row; the `list_version` guard as the
transaction's first statement; the **same** validation and the **same** messages as an import, with
`line: null` and the field name instead of a line number (A22, FR-028); an audit row each.

- `addDatedRow` appends at `ordinal = count`, and refuses when the series already holds 500 rows or the date already holds 10.
- `updateDatedRow` re-checks the identity, the cap and the rendered length; when the date changes it recomputes `next_target_date` from today and **deletes no occurrence** (the row's past firings stay).
- `deleteDatedRow` cascades the row's occurrences and leaves every post (FR-028).

A template edit that removes a field the rows need is handled in `manage.ts`, not here: `resolveInput`
passes `series.templateFields` (not `[]`) to `unknownPlaceholders` for a dated series, so FR-027's
existing message does the work.

---

## 8. `manage.ts` — changed

- `createStandingSeries`: `occurrenceRule` and `leadDays` stored; for `dated_list`, `cadenceCount`/`cadencePeriod`/`nextRunAt` are **NULL** and `template_fields` starts empty, so the placeholder check at create passes only for a template with no placeholder — the list supplies the fields at import (A7, FR-027). The create form says so.
- `updateStandingSeries`: `parsed.occurrenceRule !== existing.occurrenceRule` → `ValidationIssuesError` on `occurrenceRule`, "A series keeps the occurrence rule it was created with. To change it, create another series." (A2, FR-002). For a dated series it refuses a cadence (FR-004), validates `leadDays`, leaves `nextRunAt` NULL, and checks the template against `existing.templateFields`.
- `resumeStandingSeries`: for a dated series, sets `enabled: true`, `autoPausedReason: null`, `nextRunAt: null`, then calls `evaluateDatedSeries` so the windows that closed while it was paused are recorded as missed and the next due date is the next one still ahead or still inside its window (A34, FR-043, US3 AS4).
- `pauseStandingSeries` and `deleteStandingSeries`: unchanged. Rows and occurrences cascade with the series; posts keep everything but the position link (W13).

## 9. `read.ts` — changed

```ts
export interface UpcomingOccurrence { rowId: string; keyValue: string; target: string; dueAt: Date }
export interface DatedRowView { id: string; date: string; year: number | null; keyValue: string;
  fields: Record<string, string>; mediaFilename: string | null; mediaMissing: boolean;
  nextTargetDate: string | null; lastOutcome: DatedOutcome | null }

export interface StandingSeriesDetail extends StandingSeriesView {
  …existing…,
  occurrenceRule: "cadence" | "dated_list";
  leadDays: number;
  /** Dated only. Up to 10, soonest first (FR-047). Computed from the rows, never cached (B5). */
  upcoming: UpcomingOccurrence[];
  /** Dated only, the first page (FR-047). */
  rows: { items: DatedRowView[]; total: number; page: number };
  lastImport: { filename: string; at: Date; rowCount: number; problems: ImportProblem[] } | null;
  templateFields: string[];
}
```

- `nextRunAt` on `StandingSeriesView` becomes `Date | null`; for a dated series the screen shows
  `upcoming[0]` or "No upcoming dates" (A33, FR-042, FR-044).
- `StandingSeriesRun` gains `periodStart: string` so the run history can name the date a dated run
  fired for (FR-048), and `counts` gains `missed`.
- `canView` stays `need(scope, { post: ["view"] })` for all of it (FR-050).
- `DATED_ROWS_PAGE_SIZE = 50`, matching `STANDING_SERIES_PAGE_SIZE`.
- `mediaMissing` is `media_filename IS NOT NULL AND media_asset_id IS NULL` — the asset was deleted
  after import, so the screen can say the occurrence will skip.

## 10. `run.ts` — the dated branch of `openOrResumeRun`

`openOrResumeRun(scope, series, now)` forks once, on `series.occurrenceRule`.

For `dated_list`:

1. `evaluateDatedSeries(scope, series, now)` → `dueDate`.
2. An open run exists and `run.periodStart === dueDate` → resume it (`opened: false`).
3. An open run exists for a different date → `closeRun` it (stale), `null` when that auto-paused.
4. `dueDate === null` → return `null`: no run, no error, no pause (A33, FR-042).
5. `rows = scope.datedRows.dueOn(series.id, dueDate)` (ordinal order, at most 10).
6. One transaction:
   - `openRun({ period: "date", periodStart: dueDate, periodStartAt: periodStartInstant(dueDate, zone), requestedCount: rows.length, config: configFrom(series), missedPeriods: 0, droppedAccountIds, blockedReason })`;
   - one position per row, `position = index`, `dated = { v: 1, rowId, year, targetDate: dueDate, keyValue, values: row.fields, mediaAssetId, mediaFilename }`, `nextAttemptAt = now`;
   - one `datedOccurrences.insert({ seriesId, rowId, year, targetDate: dueDate, positionId })` per row — **`unique(row_id, year)` is the guard** (FR-040);
   - `datedRows.advance(row.id, nextTargetDate(spec, today, firedYears ∪ {year}), dueDate)` per row;
   - `standingSeries.update(series.id, { lastRunAt: now })` — **`nextRunAt` stays NULL**.
7. Any unique violation (the run's period index, the open-run index or `unique(row_id, year)`) → the
   whole transaction rolls back and the winner's open run is re-read, exactly as the cadence branch
   already does.
8. `blockedReason` handling (missing voice profile, no usable target) is **unchanged**: every
   position is skipped `series_not_runnable` and the run closes. Each position's occurrence is
   settled `skipped`.

`configFrom(series)` gains `rule: series.occurrenceRule`, `leadDays: series.leadDays` and
`cadence: series.occurrenceRule === "cadence" ? { count, period } : null`.

`closeRun` is extended in one place: before deriving the outcome, any position still `queued` or
`running` whose run is a dated run **whose window has closed** (`today > run.periodStart`) becomes
`status: 'missed'` and its occurrence is settled `missed` (FR-034, FR-035). `deriveRunOutcome` and
`hasOpenWork` then see a terminal state, and the self-pause check is unchanged (A33, W34).

## 11. `runner.ts` — the three-line fork

Nothing is copied; three expressions change and one is added.

1. **Plan gate** (**B9**): `if (config.rule === "cadence" && run.requestedCount >= 2 && plan === null)`.
2. **`seriesField`**: already `null` unless `requestedCount >= 2 && angle`; the extra `config.rule === "cadence"` guard makes it `null` for a dated run explicitly, so the prompt receives what a one-post cadence run gives it (A29, FR-038).
3. **Instructions** (**B10**): `const instructions = position.dated ? renderTemplate(config.template, position.dated.values, { mark: true }) : config.template;` used in **both** the `runGenerationStep` inputs and the `recordFailure` / `GenerationRecord` inputs, so the stored record shows what was actually sent.
4. **The queue floor** (**B13**): `saveGeneratedPost` is given `queueNotBefore: position.dated ? periodStartInstant(position.dated.targetDate, zone) : null`, and `finishPosition` passes nothing extra — `applyApprovalPolicy` reads the floor off the post.
5. **Settling the occurrence**: wherever a position reaches `produced`, `failed` or `skipped`, the
   matching occurrence is settled with the same word, inside the same statement sequence. A position
   with no occurrence (a cadence position) is a no-op.

`resolvePositionMedia` gains the prefix (**B12**):

```ts
if (position.dated?.mediaAssetId) {
  const [asset] = await scope.media.getMany([position.dated.mediaAssetId]);   // scoped, live only
  if (!asset) return fail("media_unusable");
  const prepared = await imagesForModel(scope, [asset]);
  if (!prepared.ok) return fail("media_unusable");
  return { ok: true, assets: [asset] };      // no claimMedia, no markUsed (A14, FR-016)
}
```

A15 is satisfied by position: the prefix runs before the `media.source` switch, so the row's
reference wins and a row with none falls through to the series' source untouched.

## 12. `policy.ts`, `posts/index.ts` — the floor (B13)

```ts
/** The earliest instant a QUEUE allocation may place `post`. Never earlier than now. */
export function queueFloor(post: PostRecord, now: Date): Date {
  const floor = post.queueNotBefore;
  return floor && floor.getTime() > now.getTime() ? floor : now;
}
```

Read at exactly three places, all of which pass `after` to `allocateNextFree`:

| Call site | Before | After |
|---|---|---|
| `queueTargetsInTx` | `{ after: now }` | `{ after: queueFloor(post, now) }` |
| `moveToNextFreeSlot` | `{ after: await clock.now() }` | `{ after: queueFloor(target's post, now) }` |
| `pullForwardBody` | `after = now`, walking forward | `after = max(after, queueFloor(post, now))` per target |

`scheduleAt` and `publishNow` are **not** floored: an explicit instant is a deliberate human act.
`applyApprovalPolicy` needs no new parameter — it already loads the post inside its transaction.

Every existing post has `queue_not_before = NULL`, so `queueFloor` returns `now` and every existing
test stays green. Required new unit tests: `queueFloor` returns `now` for NULL, for a past floor and
for `now` itself, and the floor for a future one.

## 13. Error messages, once each

| Situation | Message | FR |
|---|---|---|
| a non-owner/admin calls any list route | the existing permission refusal | FR-049 |
| another project's series or row by id | `NotFoundError` | FR-051 |
| a cadence series' list route | "Only a dated series has a list." | FR-001 |
| changing the occurrence rule | "A series keeps the occurrence rule it was created with. To change it, create another series." | FR-002 |
| a cadence submitted for a dated series | "A dated series has no cadence." | FR-004 |
| a template placeholder naming no column | the existing `"Unknown field: x. Available: …"` | FR-027 |
| an import missing a column the template uses | the same message, as a **file-level** refusal | FR-021 |
| two list writes racing | "The list changed while this import was running. Reload and try again." | FR-029 |

No message in this feature contains provider text, a payload, a credential or a stack (constitution
VII); every row-level reason is composed from the file's own line number and a fixed sentence.
