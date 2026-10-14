# Phase 0 — Research: date-pegged series

**Feature**: `072-dated-series` | **Date**: 2026-10-14 | **Plan**: [plan.md](./plan.md)

This entry adds **one more way to decide when a run opens**. Everything else — generation, policy,
allocation, media, failure recording, the claim, the lease, the bounds — already exists and is reused.
So § 1 is a file-by-file reading of what exists, with the path each fact came from, and § 2 is the
plan-level decisions (**B1–B34**) the spec left to the plan. § 3 records the one correction to the
spec. § 4 states what is deliberately not asserted.

Nothing here is recalled from memory (constitution I). Every statement names the file it was read
from, in this worktree, at commit `cccc66a`.

---

## 1. What exists on `main`

### 1.1 The pure cadence engine — `src/lib/series/cadence.ts`

Four exported functions, no database, no `Date.now()`:

- `periodStartDate(instant, zone, period) → Temporal.PlainDate`
- `periodStartInstant(date, zone) → Date` — `date.toPlainDateTime({hour:0}).toZonedDateTime(zone, { disambiguation: "compatible" })`. This is already *exactly* "local midnight of a plain date in a zone, with a missing midnight moving forward and a doubled one taking the earlier offset". It is `period`-independent.
- `nextBoundaryAfter(instant, zone, period) → Date`
- `boundariesBetween(from, to, zone, period) → number`

**Consequence for this entry (FR-033).** An occurrence's due instant is
`periodStartInstant(targetDate.subtract({ days: leadDays }), zone)` and the end of its window is
`periodStartInstant(targetDate.add({ days: 1 }), zone)`. Both are the *existing* function called with
a different date. No second implementation of local-midnight resolution is written, and FR-033's
disambiguation clause holds by construction rather than by a new rule (**B7**).

`CADENCE_COUNT_MAX = 10` is also here — the same ten A11 caps rows-per-date at, and the same ten the
run's `requested_count` CHECK allows.

### 1.2 The three tables — `src/server/db/schema/standing-series.ts`

- **`standing_series`**: configuration. `cadence_count smallint NOT NULL`, `cadence_period NOT NULL`, `next_run_at timestamptz NOT NULL`, `template`, `template_fields text[] NOT NULL DEFAULT '{}'`, `media_source`, `media_pool_tag`, `image_prompt`, the requested/resolved policy pair, `enabled`, `auto_paused_reason`, `last_run_at`, the lease triple, `created_by_user_id`. `unique(project_id, id)`, `uniqueIndex(project_id, lower(name))`, a partial claim index on `(next_run_at, last_claimed_at NULLS FIRST, id) WHERE enabled`.
- **`standing_series_runs`**: one period's work. `period standing_series_period NOT NULL`, **`period_start date NOT NULL`** (mode `"string"`), `period_start_at timestamptz`, `requested_count smallint` CHECK 1–10, `config jsonb NOT NULL` (the snapshot), `plan jsonb`, `plan_attempt_count`, `plan_next_attempt_at`, `missed_periods`, `dropped_account_ids uuid[]`, `blocked_reason`, `outcome`, `opened_at`, `closed_at`. `unique(series_id, period, period_start)` and `uniqueIndex(series_id) WHERE closed_at IS NULL`.
- **`standing_series_positions`**: one intended post. `run_id`, `position smallint`, `status` (`queued|running|produced|failed|skipped`), `media_asset_id` (FK `restrict`), `attempt_count`, `next_attempt_at`, `pending_retry jsonb`, `last_error_kind`, `last_error`, `skip_reason`, `skip_account_id`, timestamps. `unique(run_id, position)` and — important here — **`uniqueIndex(project_id, media_asset_id) WHERE media_asset_id IS NOT NULL AND status IN ('queued','running')`**, which *is* the pool reservation.

**Consequence (A14).** A row's named image must **not** be written to `position.media_asset_id`, or
two rows naming one portrait on one date would collide on that index and the portrait would show as
reserved in the library. See **B12**.

Enums present: `standing_series_period` (`day|week|month`), `..._media_source`, `..._position_status`,
`..._outcome` (`produced_all|produced_some|produced_none|incomplete`), `..._skip_reason` (six values),
`..._block_reason`, `..._pause_reason`.

`posts.standing_series_position_id` plus `uniqueIndex ... WHERE ... IS NOT NULL AND deleted_at IS NULL`
is the one-post-per-position guarantee (`src/server/db/schema/posts.ts:73,117,121`).

### 1.3 The jobs CSV ingestion — `src/server/services/jobs/sources/csv.ts`

`parseJobCsv(bytes)` is pure and, read line by line, does this in order:

1. `> CSV_MAX_BYTES (1_048_576)` → `fail("The file is larger than 1 MB.")` — before decoding.
2. not UTF-8 (`TextDecoder` with `fatal: true`) → `fail("The file is not UTF-8 text.")`.
3. `parse(text, { bom: true, info: true, relax_column_count: true, skip_empty_lines: true })`; a `CsvError` maps to one of three messages carrying the line.
4. Header: each name trimmed; blank → `Column N has no name`; over 64 characters or outside `/^[\p{L}\p{N} _.-]+$/u` → `Column "x" can only use letters, numbers, spaces, _ - and .`; a case-insensitive duplicate → `Columns A and B have the same name`. All pushed onto `problems` at line 1.
5. Each data record: all-blank → skipped silently; `record.length > header.length` → a per-line problem; total value length over `JOB_ITEM_DATA_MAX (50_000)` → a per-line problem; otherwise a `CsvRow { line, values }` keyed by the header.
6. `rows.length === 0 && problems.length === 0` → `fail("The file has no data rows")`.
7. `rows.length > JOB_ITEMS_MAX (500)` → a problem with `line: null`.
8. **any problem at all** → `{ ok: false, problems }`; otherwise `{ ok: true, columns, rowCount, rows, preview }`.

So the function already *computes* a per-row/whole-file distinction and throws it away at step 8.
`src/server/services/jobs/sources/csv.test.ts` (71 lines) asserts the messages and their order;
`parseJobCsv` has exactly two other callers — `csvSource.prepare` in the same file and
`validateCsvAction` in `src/app/p/[projectSlug]/jobs/actions.ts:25`. See **B1**.

### 1.4 Templates — `src/lib/jobs/template.ts`

`PLACEHOLDER = /\{\{\s*([^{}\s][^{}\n]{0,63}?)\s*\}\}/g`; `placeholdersIn`, `unknownPlaceholders`
(both case- and space-insensitive through `normalise`), `renderTemplate(template, values, { mark })`
wrapping each non-empty value in `⟦ ⟧` after stripping those marks from the value, and
`JOB_RENDERED_INSTRUCTIONS_MAX = 10_000`.

`src/server/services/jobs/create.ts:65` `assertRenderedFits(template, items, field, code)` refuses the
**first** item whose rendered instructions exceed that limit, with the message
`"<label>: the instructions would be N characters; the limit is 10,000"`. `jobs/runner.ts:301` then
renders with no further guard, because create already proved every item fits.

`standing-series/manage.ts:45` is where a standing series refuses an unknown placeholder today:
`unknownPlaceholders(parsed.template, [])` → `"Unknown field: x. Available: none"`. The `[]` is the
only reason a cadence series may contain no placeholder; this entry passes the list's columns instead.

### 1.5 Open / resume / close a run — `src/server/services/standing-series/run.ts`

`openOrResumeRun(scope, series, now)`: reads the open run; returns it when its `(period, period_start)`
is the current one; otherwise closes it as stale through `closeRun` (returning `null` when that close
auto-paused the series); then inserts the run, `insertMany(runId, requestedCount, now)` positions and
the `nextRunAt` advance **in one transaction**, recovering from a unique violation by re-reading the
winner. `blockedReason` (missing voice profile / no usable target) skips every position with
`series_not_runnable` and closes the run.

`closeRun` derives the outcome from `countByStatus` (`open = queued + running`) and runs the
three-runs-produced-nothing self-pause (`shouldSelfPause`, decided on the **produced count**, not the
outcome enum).

`configFrom(series)` builds the `v: 1` snapshot: brief, template, templateFields, voiceProfileId,
targetAccountIds, `cadence { count, period }`, media, requested, resolved.

### 1.6 The producer — `src/server/services/standing-series/runner.ts` (475 lines)

`processClaimedSeries(claimed, ctx)`:

1. `forJobRunner(projectId, createdByUserId)` scope, `clock.now()`, `openOrResumeRun`.
2. **plan**, only `if (run.requestedCount >= 2 && plan === null)` — budget check, `avoidTitles(recentClosedPlans)`, `planSeries(...)`, `setPlan` (`WHERE plan IS NULL`), retry/fail bookkeeping on the run.
3. a `while (producedThisTick < cfg.maxPosts)` loop: budget check → re-read `enabled` → `nextDue(run.id, now)` → `null` closes the run only when `hasOpenWork` is false → `posts.findByStandingSeriesPosition` (a restart finishes an already-saved post with no model call) → `loadAccounts(liveAccountIds)` → `resolvePositionMedia` under `withinBudget` → `status: running` → resolve the LLM → `takeVoice` → `groupsForAccounts` → **`seriesField`** (only when `requestedCount >= 2 && angle`) → `runGenerationStep({ inputs: { brief, sourceText: null, instructions: config.template, series: seriesField }, … })` → `saveGeneratedPost` in a transaction guarded by `lockShared(series).leaseOwner === token` → `finishPosition` → `prepareVariants` → `applyApprovalPolicy` under the same guard.
4. After the loop, close the run when nothing is open.

The whole dated fork lives in three of those steps (**B9**, **B10**, **B13**): skip 2, render the
instructions in 3, and give `applyApprovalPolicy` a floor.

`StandingSeriesCounts` has 19 fields plus `emptyStandingSeriesCounts()`;
`src/server/scheduler/loop.ts:31` prints three of them.

### 1.7 Media per position — `src/server/services/standing-series/media.ts`

`resolvePositionMedia(scope, position, media, accounts)`: `accountNeedingMedia` is the first account
whose `findProvider(key).capabilities.media.required` is true; `fail(reason)` returns a **skip** only
when such an account exists and otherwise `{ ok: true, assets: [] }`. `source: "none"` returns empty
immediately. An already-claimed `position.mediaAssetId` is reused. Pool: `claimPoolImage` +
`claimMedia` in one transaction, `pool_exhausted` on nothing. Generate: `generateImageWithKind`
outside every transaction, `credit_exhausted` → `{ requeue: true }`, else one of three skip reasons.
Then `imagesForModel(scope, [asset])` → `media_unusable` on failure.

So "the row's own asset, used not consumed" is a short prefix to this function (**B12**).

### 1.8 The claim — `src/server/dal/standing-series-claims.ts`

One `crossProject` transaction: an early exit when no series is `enabled` at all (so an idle install
never contends for the credit probe), `gateCreditHolds`, `resolveBlockedProjectIds`, then

```text
enabled AND (lease_until IS NULL OR lease_until <= now) AND (
  next_run_at <= now
  OR EXISTS (an open run with planning or position work due)
) AND <not a blocked project>
ORDER BY next_run_at ASC, last_claimed_at ASC NULLS FIRST, id ASC
LIMIT n FOR UPDATE SKIP LOCKED
```

then the claim patch per row, a per-credential-owner budget of 1 during a probe, and the stale
`running` position reset (a position whose post already exists is **left running** so the producer
finishes it; a probe claim never counts an attempt).

`next_run_at` is thus the only "is it due" signal for a series with no open run — and it is a
**cached instant**. That is the fact **B4** turns on.

### 1.9 Policy and allocation

`src/server/services/generation/policy.ts` — `applyApprovalPolicy(scope, postId, resolved, { guard })`
prepares variants, then in one transaction locks the post, runs the guard, gates each draft target,
calls `decidePolicy` (a validation failure forces review even under auto-approve), approves, and calls
`queueTargetsInTx` when the decision queues.

`src/server/services/posts/index.ts:487` `queueTargetsInTx(tx, post, targets, { expected })` sorts
targets by account id (deadlock order), gates each, and calls
**`allocateNextFree(tx, { id, accountId }, { after: now })`** — the floor is hard-coded to `now`.

`src/server/services/queue/index.ts:39` `freeCandidates(tx, accountId, after, exclude, ownOccurrence)`
searches `[after, after + horizonMs]`. The other two callers of `allocateNextFree` with a floor are
`moveToNextFreeSlot` (`after: now`) and `pullForwardBody` (`after` walking forward from `now`).

**Consequence (FR-039).** A floor of "the start of the target date's local day" has to be honoured by
every queueing path, not only the worker's, or a reviewer approving a lead-time post from Review would
queue it days early — the exact failure US4 exists to prevent. See **B13**.

### 1.10 Permissions, isolation, formatting

- `src/server/auth/access.ts` already carries `standing_series: ["manage"]` in the statement list and
  on owner and admin, granted by **no** API-key permission. FR-049 therefore needs no new permission —
  only `need(scope, { standing_series: ["manage"] })` in each new service function.
- `src/server/db/project-owned.ts` lists all three standing-series tables, and
  `tests/integration/scope-check.test.ts` covers any table listed there. Two new tables mean two new
  lines and no new test.
- `src/server/dal/scope.ts:150-152,255-257` registers the three repos on `ProjectScope`.
- `src/lib/time/format.ts` has exactly two exports, `formatLocal` and `formatFull`, both taking an
  **instant**. `tests/lint/date-format.test.ts` bans `Intl.DateTimeFormat` everywhere except a
  six-file allowlist that already contains `src/lib/time/format.ts`.
- `docs/design-system.md` § 14 and the `docket-ui` skill both state the hard rule: **five columns or
  fewer**, qualifying facts stacked as `Sub` lines, never a column that is "—" on most rows.

### 1.11 Scheduler section and config

`src/server/scheduler/standing-series.ts` is 50 lines: the LLM-configured check, the budget check,
`claimDueStandingSeries`, `Promise.all(processClaimedSeries)` and one heartbeat.
`standingSeriesConfig` yields `maxSeries` (2), `maxPosts` (2), `minCallMs` (8 s), `persistReserveMs`
(3 s), `maxAttempts` (3), the backoff pair, `leaseMs`, `timeBudgetMs`. **Nothing here changes**
(FR-005), and no environment variable is added.

`src/server/scheduler/housekeeping.ts:143` prunes closed runs older than 90 days through
`pruneClosedStandingSeriesRunsBefore(before, limit)`.

### 1.12 Facts taken from documents, not memory

- Media is **required** by Instagram and TikTok and **not** by Facebook, Threads, Bluesky and X —
  read through `findProvider(key).capabilities.media.required`, never from a literal, exactly as
  `media.ts` already does.
- `@js-temporal/polyfill` is in `package.json` and is the only date library used for wall-time maths.
  **No new runtime dependency is needed** for this entry.
- `media_assets` has `unique(project_id, storage_key)` but **no** `unique(project_id, id)`, so a new
  table referencing an asset cannot use a composite project-pinned foreign key the way the
  series/run/position chain does. See **B6**.

---

## 2. Plan decisions

Thirty-four decisions the spec left to the plan. They are recorded in `docs/decisions.md` under
`## 062 — Date-pegged series` after the spec's A1–A38.

### The parser (A17, FR-019, FR-020)

- **B1 — One parser, one pass, two views.** `parseJobCsv`'s body becomes `parseCsvFile(bytes)`, which returns `{ problems: TaggedProblem[], columns, rows }` where every problem carries `scope: "file" | "row"` and the array keeps **today's push order** (header problems at line 1, then row problems in line order, then the over-500 count). `parseJobCsv(bytes)` becomes a four-line wrapper: any problem at all → `{ ok: false, problems: problems.map(({ line, message }) => ({ line, message })) }`, else `{ ok: true, … }`. Message text, ordering and the early returns are untouched, so `csv.test.ts` passes **unchanged** — which is how FR-020 is proved rather than asserted.
- **B2 — The dated importer consumes the tagged result directly.** `problems.filter(p => p.scope === "file")` non-empty → refuse whole (FR-021); `scope === "row"` problems become per-row problems carried through to the import record (FR-022). The three early returns (size, encoding, unreadable CSV) are file-scope by construction.
- **B3 — Over-length rendered instructions are a row problem.** A row whose `renderTemplate(template, values, { mark })` exceeds `JOB_RENDERED_INSTRUCTIONS_MAX` is reported and skipped, reusing `assertRenderedFits`'s message shape. FR-023 does not enumerate this case, but FR-022's general rule covers it and the alternative — storing a row that cannot be rendered for a year — is the silent failure FR-022 exists to prevent. Checked again on every write that could cause it: import, row add, row edit, and a series template edit (which refuses, since the rows are already stored).

### Due resolution: local dates, not cached instants

- **B4 — Eligibility is decided on local *dates*, and the local-date form is normative.** An occurrence is eligible exactly when `target − lead ≤ today ≤ target`, all three being local dates in the project's zone. This is identical to `dueInstant ≤ now < windowEnd` (§ 1.1) because local midnight is the boundary of both, and a test asserts the two forms agree across both DST directions. The date form is the one the code branches on, because it is the form that survives a time-zone change with nothing stored to migrate — which is the whole of A32/FR-041. The instant form is **derived, for display only** ("generated on …").
- **B5 — `standing_series.next_run_at` becomes nullable and is always NULL for a dated series.** A cached due instant is the one thing a zone change could falsify (a LA→Auckland move shifts local midnight by 21 hours, and a lead-0 window is 24 hours), so this entry stores no such cache. The next due date shown on screen is computed from the rows at read time, in the zone read at that moment. CHECK: `(occurrence_rule = 'cadence') = (next_run_at IS NOT NULL)`.
- **B6 — Each row stores `next_target_date date` — the local date of its next unfired occurrence, or NULL when it has none.** This is a *date*, so it is zone-independent, and it is the one column the claim's SQL compares against the project's current local date. It only ever moves forward, and it is advanced in the same transaction that fires or retires the occurrence.
- **B7 — The due instant and the window end reuse `periodStartInstant`.** No new local-midnight resolver, so FR-033's disambiguation is one implementation (constitution IV).
- **B8 — The claim gains one OR branch, joined to `projects` for the zone.**

  ```sql
  OR EXISTS (
    SELECT 1 FROM standing_series_dated_rows r
    WHERE r.project_id = s.project_id AND r.series_id = s.id
      AND r.next_target_date IS NOT NULL
      AND r.next_target_date - s.lead_days <= (now_param AT TIME ZONE p.timezone)::date
  )
  ```

  One predicate covers both jobs: a date inside its window (`target − lead ≤ today ≤ target`) and a date already past (`target < today`, which also satisfies it) that needs retiring. It is bounded because the evaluation pass always advances `next_target_date`, so the predicate goes false. `now_param` is the engine clock, never `now()`, so a pinned test clock is honoured. The ordering clause becomes an explicit `next_run_at ASC NULLS LAST`: a dated series is picked after same-tick due cadence series, which is acceptable because a cadence series stops being due the moment its run opens while a dated window lasts at least a full day — and a test asserts a dated series is claimed while cadence series are also due.

### The dated fork in the producer

- **B9 — A dated run never plans, gated on the run config's `rule`, not on `requested_count`.** A dated run of three rows has `requested_count = 3`, so the existing `requestedCount >= 2` gate would plan it. The gate becomes `config.rule === "cadence" && run.requestedCount >= 2 && plan === null`, and a CHECK (`period <> 'date' OR plan IS NULL`) makes a dated plan impossible to store. `seriesField` stays `null` for a dated position, so the prompt builder receives exactly what a one-post cadence run gives it (A29, FR-038).
- **B10 — The row's values are rendered into `inputs.instructions` at the single existing call site.** `instructions: position.dated ? renderTemplate(config.template, position.dated.values, { mark: true }) : config.template`. The same `⟦ ⟧` data marks a batch job uses, the same `runGenerationStep`, the same schema, the same retry, the same usage purpose (`generate.standing_series_post`) and the same `generation_mode` (`standing_series_post`). **No new enum value on `generation_mode`, `llm_usage_purpose` or `generation_job_item_error`** (FR-006).
- **B11 — The per-position dated payload is one `dated jsonb` column on `standing_series_positions`**, NULL for a cadence position, shaped by a Zod schema at the boundary exactly as the run's `config jsonb` is: `{ rowId, year, targetDate, keyValue, values, mediaAssetId, mediaFilename }`. One column instead of five, no new foreign keys, and — decisively — the row's asset id lives **inside** jsonb where the `media_asset_id` reservation index cannot see it, which is how A14's "used, not consumed" becomes structural rather than remembered.
- **B12 — `resolvePositionMedia` gains a prefix, not a branch.** When `position.dated?.mediaAssetId` is set, the asset is loaded through `scope.media.getMany` (project-scoped, live rows only), validated through the same `imagesForModel`, and returned **without** `claimMedia` and without `markUsed`. A missing or unusable asset falls through to the existing `fail("media_unusable")`, which is exactly the spec's edge case for a named file deleted from the library. Rows with no reference fall through to today's pool/generate/none code unchanged (A15, A17, FR-046).
- **B13 — The queue floor is stored on the post: `posts.queue_not_before timestamptz` (nullable).** One new helper, `queueFloor(post, now) = max(now, post.queueNotBefore ?? now)`, is read by all three `allocateNextFree` floor call sites (`queueTargetsInTx`, `moveToNextFreeSlot`, `pullForwardBody`), so a dated post never takes a slot before its own date whichever path queues it — the worker, a reviewer approving from Review, a pull-forward. Explicit scheduling (`scheduleAt`, `publishNow`) is a deliberate human act and is **not** floored; `docs/generator.md` says so. Passing the floor only from the generation path was rejected: it would leave US4's guarantee false on the review path, which is the path a lead time exists to enable.

### The tables

- **B14 — Two new tables, not three.** `standing_series_dated_rows` (the list) and `standing_series_occurrences` (one firing of one row in one year). The import record is **four columns on `standing_series`**, not a fifth table: it is one row per series by definition, replaced whole by the next successful import, and it has no independent lifetime (A20, FR-026).
- **B15 — `standing_series_period` gains the value `'date'`.** A dated run is one local date's work: `period = 'date'`, `period_start = <target date>`, `period_start_at = periodStartInstant(target, zone)`, `requested_count = <rows due on it>` (1–10, inside the existing CHECK). This reuses `unique(series_id, period, period_start)` as "one run per due date" (A28, FR-037) and `uniqueIndex(series_id) WHERE closed_at IS NULL` as "one open run" — both already-tested database facts. The alternative, a nullable `period`, would have silently voided that unique constraint, since NULLs do not collide. The series' own `cadence_period` is CHECKed to never hold `'date'`.
- **B16 — `standing_series_position_status` gains the value `'missed'`.** A position whose window closed before it produced is neither a failure nor a skip (FR-035). Giving it its own status keeps `skip_reason`'s CHECK pair intact, keeps the skip-reason enum free of a non-skip, and gives `deriveRunOutcome`/`hasOpenWork` a terminal state to count. `countByStatus`'s zero map gains a key.
- **B17 — An occurrence is inserted when the run opens, with `outcome` NULL meaning pending, under `unique(row_id, year)`.** That constraint — not a prior read — is FR-040/A31: two overlapping ticks, an expired lease, a restart, a recovered run and a re-import of an identical row all collide on it, and the loser re-reads the winner exactly as `openOrResumeRun` already does for the run. A missed occurrence is inserted directly with `outcome = 'missed'` and no position.
- **B18 — The row's identity is a unique index over `(series_id, month, day, coalesce(year, 0), lower(btrim(key_value)))`.** `coalesce(year, 0)` makes an every-year row distinct from a year-specific one (no real year is 0) while keeping NULLs from defeating the index, and `lower(btrim(...))` is A10's case-insensitive, trimmed comparison in the database rather than in a service (A10, FR-012).
- **B19 — The stored month/day must be a date that can exist in some year.** Two CHECKs: `day <= CASE month WHEN 2 THEN 29 WHEN 4,6,9,11 THEN 30 ELSE 31 END`, and for a year-specific row the only month/day that is valid in some years but not others — `02-29` — is gated on an explicit leap-year expression. `02-30`, `13-01` and `2027-02-29` are therefore impossible to store even by a direct write, not merely refused by a validator (FR-023).
- **B20 — The per-date cap and the 500-row cap are service rules, with the parser enforcing 500 per file.** Neither is expressible as a table CHECK. The import counts in one pass; the row editor re-counts under the list-version guard (B21), so a concurrent add cannot slip an eleventh row past the cap (A11, FR-013, FR-014).
- **B21 — Every list write is serialised by an optimistic `list_version` on the series.** The transaction's first statement is `UPDATE standing_series SET list_version = list_version + 1 WHERE id = ? AND list_version = ?`; zero rows updated → `ConflictError`. The second of two concurrent imports blocks on that row lock, then sees zero rows and rolls back having written nothing — the list is never half-replaced and the loser is refused as a conflict, which is FR-029 exactly. A plain `FOR UPDATE` was rejected: it serialises imports into last-write-wins, and the spec asks for a refusal. No advisory lock, nothing session-level (Neon-safe).
- **B22 — `media_asset_id` on a row is a single-column FK with `ON DELETE SET NULL`**, because `media_assets` has no `unique(project_id, id)` to pin a composite key against (§ 1.12). Cross-project reference is prevented where it is actually decided — the import resolves filenames through the **scoped** `scope.media` repo, so another project's asset simply does not match (US6 AS4) — and is covered by an isolation test rather than by a constraint. `SET NULL` is also the behaviour the spec's edge case asks for: the row survives a deleted asset and the occurrence skips with the media reason.
- **B23 — The import resolves every filename in one query, not one per row.** `findLiveByFilenames(names)` returns `(lower(original_filename), id, kind)` for live assets in the project; the importer classifies in memory into none / more than one / a video / one image. A 500-row import is one query, and "more than one" deliberately includes an image and a video sharing a name.

### Evaluation, missed occurrences, pruning

- **B24 — One evaluation pass, called from three places.** `evaluateDatedSeries(scope, series, now)` retires closed windows and reports the next due date; it is called by the producer before opening a run, by `resumeStandingSeries` (so US3 AS4's "recorded as missed on resume" holds), and by the read service in a read-only mode for the upcoming list. One implementation of "which rows are due" (constitution IV).
- **B25 — Retiring is always done; recording a miss is bounded.** The pass advances `next_target_date` for every row whose window has closed (up to 50 rows per pass) and writes a `missed` occurrence **only** for windows that closed within the last 30 days (FR-036). The split matters: if retiring were also bounded to 30 days, a row whose window closed 40 days ago would keep its stale date forever and never fire again.
- **B26 — Advancing is deterministic and forward-only.** For an every-year row, the next target date is the row's month/day in the first year whose target date is not already behind today and has no occurrence recorded, with `02-29` constrained to `02-28` in a non-leap year (A24, FR-031) — the same "constrain into the month" rule `periodStartDate`'s monthly branch relies on. For a year-specific row it is that year's date or, once recorded, NULL.
- **B27 — Occurrences are pruned by age in the existing housekeeping pass**, older than the same 90-day horizon that prunes closed runs, bounded by the same limit. Tying them to runs was rejected: a `missed` occurrence has no run. A pruned occurrence cannot resurrect a firing, because `next_target_date` moved past it when it was recorded.

### Interface

- **B28 — The rows table is five columns, and the full row lives in its editor.** Date · Subject (the key value, with the remaining fields as one truncated `Sub` line) · Image · Next due · Actions. A37 asks for "a plain table of the file's own columns", but a 12-column file would break the five-column rule `docs/design-system.md` § 14 and the `docket-ui` skill both state as absolute, and a 60-column file would be unreadable. The columns are all visible — in the row editor and in the import preview — and the table answers the questions a row list is read for. Recorded here so review judges the trade rather than finding it.
- **B29 — Three sections and one control on the existing detail page, in A35's order**: `Upcoming` (the next 10 occurrences, with the generation date when the lead time is non-zero), `Last import` (the problems, with the file name and when it ran, shown until a later successful import replaces them), `Rows` (paginated, `?rows=N` as a search param so the URL is shareable), and the Import control. No new route except the row dialogs' server actions. The run history table already on the page gains the fired-for date (FR-048).
- **B30 — Two new exports in the one formatter file, plus one component.** `formatLocalDate("2027-03-14")` → "Sat, Mar 14, 2027" and `formatMonthDay("03-14")` → "Mar 14", both in `src/lib/time/format.ts` — the file `tests/lint/date-format.test.ts` already allowlists, so the one-date-format rule (entry 050, FR-052) is kept by putting the new shape *in the one place* rather than by exempting a new one. `LocalDate` mirrors `LocalTime` with a plain `<time dateTime="YYYY-MM-DD">` and no tooltip, because a calendar date has no instant to disambiguate.
- **B31 — The occurrence rule is a `SegmentedControl` with `cards`, shown only on create.** On edit it is rendered as a read-only line with A2's sentence ("To change this, create another series"), and the server refuses a changed rule. Cadence fields are not rendered for a dated series and are refused by the schema (FR-004); the lead time is a number field, 0–30, shown for a dated series only.
- **B32 — The import reuses the existing CSV file input and `CsvProblemList`.** `src/app/p/[projectSlug]/jobs/new/csv/CsvJobForm.tsx` already exports `CsvProblemList`; it is moved to `src/components/ui/` so both screens import one component rather than one importing from the other's route folder.

### Schema versioning and counts

- **B33 — The run config stays `v: 1`.** `rule` is added with a `"cadence"` default, `cadence` becomes nullable and `leadDays` is added, so every config already stored by `071` parses unchanged and no migration of jsonb is written.
- **B34 — Two new tick counts, `missed` and `retired`.** They join `StandingSeriesCounts` and the one-line tick summary, so "nothing posted on the 14th" is answerable from the worker log as well as from the series screen.

---

## 3. Corrections to the spec

- **A11 vs. the import's "first ten by file order".** A11 caps rows per calendar date at 10, and the
  edge-case list says "the first ten by file order are imported, the eleventh is reported and
  skipped". The cap counts every-year and year-specific rows **together** against a concrete calendar
  date, so counting needs a year. The plan counts against the date's own year for a year-specific row
  and against **each of the next two years** for an every-year row — which is the smallest window in
  which `03-14` and `2027-03-14` can be seen to collide. Recorded, not silently narrowed.
- **No other correction.** Every other fact the spec asserts about `main` was checked against the file
  it names and holds.

## 4. Deliberately not asserted

- No live model, image or platform call is made by any test in this entry. Text goes through a stub
  `LlmProvider` / `createFakeLlmFetch`, images through `setImageProviderForTests`, time through
  `clock.runAtTime`. Everything needing real credentials is reported as **verified with mocks only**
  (constitution II).
- No throughput, latency or cost figure is measured or claimed. The per-tick bounds are unchanged, so
  `docs/generator.md`'s existing concurrency arithmetic still applies verbatim.
- The model's obedience to the rendered row data is not asserted — only that the rendered
  instructions reaching `runGenerationStep` contain the row's values inside the data marks.
- "A year of posts" is asserted by driving a pinned clock across simulated dates, not by waiting.
