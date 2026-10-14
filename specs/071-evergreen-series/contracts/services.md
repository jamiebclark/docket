# Contract — Services and the pure cadence engine

**Feature**: `071-evergreen-series` | [plan](../plan.md) · [data-model](../data-model.md) · [research](../research.md)

Every function here is reached through a `ProjectScope`; nothing imports the raw database client
(constitution III). Service functions live under `src/server/services/standing-series/`, data access
under `src/server/dal/`, the pure time and prompt helpers under `src/lib/series/`.

---

## 1. `src/lib/series/cadence.ts` — pure, no database, no `Date.now()`

Modelled on `src/lib/email/schedule.ts` and `src/lib/generation/usage-period.ts`. Every wall-time
conversion uses `disambiguation: "compatible"`, the one rule `resolveOccurrence` already uses.

```text
export type CadencePeriod = "day" | "week" | "month";
export const CADENCE_PERIODS: readonly CadencePeriod[];
export const CADENCE_COUNT_MIN = 1;
export const CADENCE_COUNT_MAX = 10;      // W8, matches SERIES_COUNT_MAX

/** The local date on which `instant`'s period starts, in `zone`. */
periodStartDate(instant: Date, zone: string, period: CadencePeriod): Temporal.PlainDate

/** The instant that local date's period begins at. A midnight that does not exist moves forward;
 *  one that exists twice takes the earlier offset. Exactly one instant, always. */
periodStartInstant(date: Temporal.PlainDate, zone: string): Date

/** The first period start strictly after `instant`. Used at create and at resume (FR-010, FR-055). */
nextBoundaryAfter(instant: Date, zone: string, period: CadencePeriod): Date

/** How many boundaries fall in `(from, to]`. `0` when `from >= to`. FR-013's "missed periods". */
boundariesBetween(from: Date, to: Date, zone: string, period: CadencePeriod): number
```

Rules, each a named unit test:

| Period | Boundary |
|---|---|
| `day` | the local date itself |
| `week` | the Monday of that local week (`dayOfWeek` 1–7, subtract `dayOfWeek - 1`) |
| `month` | `with({ day: 1 })` |

- **A series created mid-period is first due at the next boundary** (FR-010): `create` stores
  `nextBoundaryAfter(now)`, never `periodStartInstant(periodStartDate(now))`.
- **No backfill** (FR-013): the producer opens a run for `periodStartDate(now)` and records
  `boundariesBetween(lastBoundary, now) - 1` as `missed_periods`. It never iterates the gap.
- **DST**: a 00:00 boundary inside a spring-forward gap resolves to the instant just after the gap;
  inside an autumn overlap it takes the earlier offset. One run, never two, never none.
- **A changed project time zone** recomputes the next boundary in the new zone and relabels nothing,
  because history is keyed on the stored local `date` (**S4**).

## 2. `src/lib/series/avoid.ts` — pure

```text
export const AVOID_RUNS = 3;      // how many prior closed runs contribute (S30)
export const AVOID_TITLES_MAX = 20;

/** Titles of the most recent runs' plans, newest first, de-duplicated case-insensitively,
 *  capped at AVOID_TITLES_MAX. */
avoidTitles(plans: readonly { angles: { title: string }[] }[]): string[]
```

## 3. `src/lib/validation/standing-series.ts` — Zod, shared by the action, the service and the tests

```text
STANDING_SERIES_NAME_MAX = 100

createStandingSeriesSchema = {
  name:              trim → 1..100
  brief:             trim → 1..BRIEF_MAX
  template:          trim → 1..INSTRUCTIONS_MAX
  voiceProfileId:    uuid
  targetAccountIds:  uuid[] 1..TARGET_ACCOUNTS_MAX, each once
  cadence:           { count: int 1..10, period: enum(CADENCE_PERIODS) }
  media:             discriminatedUnion("source",
                       { source: "none" }
                       { source: "pool",     tag: tagSchema.nullish() }
                       { source: "generate", prompt: trim → 1..IMAGE_PROMPT_MAX })
  approval:          approvalPolicySchema.nullish()
  scheduling:        schedulingPolicySchema.nullish()
  confirmUnreviewedQueue: boolean default false
}
updateStandingSeriesSchema = createStandingSeriesSchema      // a full replace, like the slot form
standingSeriesRunConfigSchema                                // § 6 of data-model.md, v: 1
```

The count bounds are stated with the existing wording shape (`Choose between 1 and 10 posts`); the
`SERIES_COUNT_MAX` constant is imported, never re-typed, so `tests/lint/ui-limit-literals.test.ts`
has nothing to catch.

**Placeholders (FR-003, S29).** `createStandingSeries` calls
`unknownPlaceholders(template, [])` and, when it returns names, throws the **existing**
`ValidationIssuesError` with the sentence `checkTemplate` already produces:
`Unknown field: ${names.join(", ")}. Available: none`.

---

## 4. `src/server/dal/standing-series.ts` — three repos on `ProjectScope`

```text
scope.standingSeries: StandingSeriesRepo
  insert(input): StandingSeriesRecord            // throws on the name unique index
  get(id): StandingSeriesRecord | null
  list({ page, pageSize }): { rows, total }      // ordered by lower(name)
  update(id, patch): StandingSeriesRecord | null
  lockForUpdate(id): StandingSeriesRecord | null  // FOR UPDATE, own statement
  lockShared(id): StandingSeriesRecord | null     // FOR SHARE, for the policy guard
  delete(id): boolean
  nameTaken(name, exceptId?): boolean            // for the friendly message before the index fires

scope.standingSeriesRuns: StandingSeriesRunsRepo
  openRun(input): RunRecord                      // throws on the open/period unique indexes
  openFor(seriesId): RunRecord | null            // closed_at IS NULL
  get(id): RunRecord | null
  listForSeries(seriesId, { limit }): RunRecord[]        // opened_at DESC
  recentClosedPlans(seriesId, limit): unknown[]          // for avoidTitles (S30)
  recentClosedOutcomes(seriesId, limit): Outcome[]       // for the self-pause check (S35)
  update(id, patch): RunRecord | null
  close(id, outcome, at): RunRecord | null       // UPDATE ... WHERE closed_at IS NULL
  setPlan(id, plan): boolean                     // UPDATE ... WHERE plan IS NULL  (S8)

scope.standingSeriesPositions: StandingSeriesPositionsRepo
  insertMany(runId, count): PositionRecord[]
  listForRun(runId): PositionRecord[]
  countByStatus(runId): Record<PositionStatus, number>
  nextDue(runId, now): PositionRecord | null     // status queued & next_attempt_at <= now, or running
  update(id, patch): PositionRecord | null
  claimMedia(id, assetId): boolean               // UPDATE ... WHERE media_asset_id IS NULL
```

`src/server/dal/media.ts` gains one method and one widened expression:

```text
scope.media.claimPoolImage(opts: { tag: string | null }): MediaRow | null
```

One statement: live `image` assets of the project with `first_used_at IS NULL`, not reserved by a job
item **or** a standing-series position, matching `tag` when given, `ORDER BY created_at, id`,
`LIMIT 1 FOR UPDATE SKIP LOCKED` (**S16**). The private `reservations` expression is widened to
count both tables (**S15**), which `listIdsForSelection({ unusedOnly })`, `reservedAmong` and
`list` all read — so a pooled asset held by a live position is invisible to a new batch job, and the
Media library shows it as reserved.

`src/server/dal/generation-failures.ts` gains `listForRun(runId)` and the two new insert fields.
`src/server/dal/posts.ts` gains `findByStandingSeriesPosition(positionId, { includeDeleted? })`,
a copy of `findByJobItemId`.

---

## 5. `src/server/services/standing-series/manage.ts` — create, edit, pause, resume, delete

Each needs `standing_series: ["manage"]` through `requirePermission` (**S25**), so owner/admin only,
server-side, whatever the interface showed (FR-060). Each writes one audit row (**S27**).

```text
createStandingSeries(scope, input): { seriesId }
```

1. `requirePermission(scope, { standing_series: ["manage"] })`
2. `createStandingSeriesSchema.parse(input)`
3. `resolvePolicies(scope, { approval, scheduling, confirmUnreviewedQueue })` — the **same**
   function the Generate form and `createJob` use, so the auto-approve role check and the
   `CONFIRM_UNREVIEWED_QUEUE_MESSAGE` confirmation are the existing ones (FR-028)
4. `takeVoice(scope, voiceProfileId)` — refuses a missing or archived profile (FR-007)
5. `loadAccounts(scope, targetAccountIds)` then `assertGroupLimit(groupsForAccounts(accounts))`
   (FR-006)
6. `unknownPlaceholders(template, [])` → the existing refusal (FR-003)
7. media: `pool` or `generate` with `getStorage()` falsy → refuse with the shared
   `MEDIA_STORAGE_NOT_SET_UP` sentence (FR-041); `generate` with
   `getImageStatus().configured` false is **allowed** (it may be configured later) but the form says
   so — only storage is a hard refusal, because without it nothing can be written at all
8. `nextRunAt = nextBoundaryAfter(await clock.now(), scope.project.timezone, period)` (FR-010)
9. insert; a unique-index violation on the name becomes the field error
   `A standing series called "…" already exists in this project.` (FR-002)
10. `scope.audit.insert({ action: "standing_series_create", details: { seriesId, name } })`

```text
updateStandingSeries(scope, seriesId, input): void
```

Steps 1–7 and 9–10 with `standing_series_update`. **Does not touch `next_run_at`** and does not read
or write any run: the open run finishes under its own snapshot (FR-056). Changing the cadence
*period* recomputes `next_run_at = nextBoundaryAfter(now)` — the stored one is a boundary of the old
period and would otherwise be meaningless.

```text
pauseStandingSeries(scope, seriesId): void     // enabled=false, auto_paused_reason=null  (FR-054)
resumeStandingSeries(scope, seriesId): void    // enabled=true, auto_paused_reason=null,
                                               // next_run_at = nextBoundaryAfter(now)   (FR-055)
deleteStandingSeries(scope, seriesId): void    // one delete; runs/positions/failures cascade,
                                               // posts keep everything but the link     (FR-057)
```

`deleteStandingSeries` runs in `scope.transaction` and writes its audit row inside it, so a failed
delete logs nothing.

## 6. `src/server/services/standing-series/read.ts`

```text
listStandingSeries(scope, { page }): { items: StandingSeriesView[]; total: number }
getStandingSeries(scope, seriesId): StandingSeriesDetail     // + runs, + credit hold
```

Both begin `if (!scope.can({ post: ["view"] })) throw new ForbiddenError()` (**S26**, FR-061). The
hold comes from the existing `generationCreditHold(scope)` so one sentence serves both Batch jobs
screens and this one (FR-052). Run counts are derived with `countByStatus` (**S3**).

---

## 7. `src/server/services/standing-series/runner.ts` — the producer

One claimed series per call. Mirrors `jobs/runner.ts` structure and vocabulary; shares
`withinBudget` / `Overran` and the redacted log line from `src/server/scheduler/budget.ts`
(**S36**).

```text
processClaimedSeries(claimed: ClaimedStandingSeries, ctx: StandingSeriesContext): Promise<void>
ctx = { config: SchedulerConfig; deadline: number; counts: StandingSeriesCounts; llm?: LlmProvider }
```

### 7.1 Open or resume the run

`scope = await forJobRunner(series.projectId, series.createdByUserId)` — the same actor the batch
runner uses, so every write is scoped and attributed identically.

1. `open = await scope.standingSeriesRuns.openFor(series.id)`.
2. `currentStart = periodStartDate(now, zone, series.cadencePeriod)`.
3. If `open` and its `(period, period_start)` is **older** than the current period →
   `close(open.id, deriveRunOutcome(countByStatus(open.id)) → "incomplete", now)`, `runsClosed++`,
   and fall through to open a new one (W11, FR-014).
4. If no open run and `next_run_at > now` → nothing (the claim cannot produce this; defensive).
5. Opening, in **one** transaction:
   - validate the snapshot's inputs against live data: `takeVoice` (a throw → `blocked_reason =
     'voice_profile_missing'`), `loadAccounts` filtered to accounts that still exist (the difference
     becomes `dropped_account_ids`; none left → `blocked_reason = 'no_usable_target'`)
   - `missed = max(0, boundariesBetween(lastBoundaryBefore(next_run_at), now) - 1)`
   - insert the run with `config` (**S2**), `period`, `period_start`, `period_start_at`,
     `requested_count = cadenceCount`, `missed_periods`, `dropped_account_ids`, `blocked_reason`
   - insert `requested_count` positions
   - `series.update({ lastRunAt: now, nextRunAt: nextBoundaryAfter(period_start_at, zone, period) })`
   - a unique-index violation on either run index means another worker won: re-read and continue
     (US3 AS1)
   - `runsOpened++`
6. A run with a `blocked_reason` immediately skips every queued position as
   `series_not_runnable`, closes `produced_none`, and returns (`blocked++`).

### 7.2 Plan

Only when `requested_count >= 2` and `plan IS NULL` (W14, FR-016):

- budget check first: `remaining() - persistReserveMs < minCallMs` → release, `released++`
- `avoid = avoidTitles(await recentClosedPlans(series.id, AVOID_RUNS))`
- `planSeries(scope, { ...fromConfig, count, avoidTitles: avoid }, ctx.llm)` — the **existing**
  function, with one new input (**S31**), recording usage under
  `generate.standing_series_plan`
- success → `setPlan(run.id, { angles })`; `false` → it already wrote a `standing_series_plan`
  failure row, so: `credit_exhausted` → requeue with no attempt (FR-051); other temporary →
  `plan_attempt_count + 1`, `plan_next_attempt_at = nextRetryAt(...)`, and at the cap treat as
  lasting; lasting → every queued position `failed` with that kind and message, run closed
  `produced_none`
- `setPlan` returning false means another worker planned it: re-read and use theirs (FR-017)

A `requested_count` of 1 makes **no** planning call at all (W14, US1 AS4).

### 7.3 Produce positions, one at a time (**S24**)

Loop while `produced-this-tick < cfg.maxPosts` and the budget allows:

1. Re-read `enabled`; false → stop, leaving the rest `queued` (**S32**, FR-054).
2. `position = nextDue(run.id, now)`; none → close the run (§ 7.5).
3. If `posts.findByStandingSeriesPosition(position.id, { includeDeleted: true })` returns a post →
   **finish** it (§ 7.4), `finishing++`, continue (**S34**).
4. **Media** (FR-034 – FR-041), before any model call:
   - `none` → `assets = []`
   - `pool` → if `position.media_asset_id` is already set, reuse it (**S14**); else
     `claimPoolImage({ tag })` in a short transaction and `claimMedia(position.id, asset.id)`. Null →
     skip `pool_exhausted`
   - `generate` → reuse `position.media_asset_id` if set; else `createImageGenerator(scope)
     .generate({ projectId, prompt: config.media.prompt })` **outside** every transaction
     (constitution), then `claimMedia`. `{ ok: false }` → skip
     `image_generation_not_configured` when `getImageStatus().configured` is false or the message is
     the not-configured one, `media_storage_not_configured` when it is the storage sentence, else
     `image_generation_failed`
   - then `imagesForModel(scope, assets)`; `ok: false` → skip `media_unusable`
   - **the skip only happens when it matters**: if no target account declares
     `caps.media.required` (and all allow text-only), a missing image is not a skip — the position
     produces a text-only post (US4 AS5). When one does,
     `skip_account_id` is that account (FR-038), and `skipped++`.
5. Claim the position: `update(position.id, { status: "running", startedAt })`.
6. `runGenerationStep(scope, { label: "generate.standing_series_post", purpose:
   "generate.standing_series_post", voice, groups, assets, inputs: { brief, sourceText: null,
   instructions: template, series: { id: run.id, position, angle, otherAngles } }, timeoutMs },
   llm, { pending: position.pending_retry, owner, recorder, retryWindowMs })` — byte-for-byte the
   same composition the batch runner uses, with the plan's angle in the place
   `writeSeriesPost` puts it (FR-019).
   A one-post run passes `series: null`, which is the single-post path.
7. Outcomes, exactly the batch runner's mapping: `ok: "retry"` → `pending_retry`, `deferred++`, no
   attempt; `credit_exhausted` → queued at `now`, **no attempt**, `requeued++` (FR-051);
   `TEMPORARY` → `retryLater`, `retried++`; otherwise `fail`, `failed++`, one
   `generation_failures` row with `standing_series_run_id` and `standing_series_position`.
8. Save, in one transaction: a lease re-check on the series (`lockShared` → `lease_owner === token`,
   else `staleResults++` and return), then `saveGeneratedPost(tx, { …, link:
   { standingSeriesPositionId: position.id } })`. A unique violation means another writer won:
   re-read the winner and finish it (FR-021).
9. `recorder.flush({ postId })` (FR-024), then **finish** (§ 7.4), then `produced++`.

### 7.4 Finish a position

`prepareVariants` inside `withinBudget` (an `Overran` leaves the position `running` with an expired
series lease, so the next tick finishes it), then `applyApprovalPolicy(scope, postId, config.resolved,
{ guard })` where the guard re-reads the series lease and throws `GuardLost("stale")` on a lost one.
Then `update(position.id, { status: "produced", finishedAt })`.

**No bypass** (FR-029, FR-030): there is exactly one call to `applyApprovalPolicy` in this feature
and it passes the snapshot's `resolved` pair unchanged. The gate inside it forces review on a
validation failure even under auto-approve, and `queueTargetsInTx` runs **inside** its transaction,
so two series and two workers cannot hold one occurrence (FR-031, SC-004). A target with no free
occurrence stays a draft with the allocator's own reason and is not retried under another policy
(FR-032).

### 7.5 Close the run

When every position is `produced`, `failed` or `skipped`:
`close(run.id, deriveRunOutcome(counts), now)` where

```text
deriveRunOutcome({ produced, requested, open }) =
  open > 0                       -> "incomplete"      // only from § 7.1 step 3
  produced === 0                 -> "produced_none"
  produced === requested         -> "produced_all"
  otherwise                      -> "produced_some"
```

Skips do **not** make an outcome worse than the posts justify, and never make a run "with failures"
(FR-039). Then the self-pause check (**S35**): three most recent closed runs all `produced_none` (or
`incomplete` with nothing produced) → `enabled = false`, `auto_paused_reason = 'no_output'`,
`autoPaused++` (FR-053).

---

## 8. Changes to existing modules

| File | Change | Behaviour change? |
|---|---|---|
| `src/server/services/generation/prompt.ts` | `buildSeriesPlanPrompt` takes `avoidTitles: readonly string[]` and appends one `TITLES TO AVOID: …` line **only** when non-empty (**S31**) | No, for `[]` |
| `src/server/services/generation/series.ts` | `planSeries` accepts and forwards `avoidTitles` (default `[]`) and an explicit `purpose`, so the standing-series plan is recorded under its own purpose | No |
| `src/server/services/generation/save.ts` | `GeneratedPostLink` gains `{ standingSeriesPositionId }` | No |
| `src/lib/validation/generation.ts` | `generationRecordSchema.mode` gains `"standing_series_post"` | No (a union widening) |
| `src/server/services/generation/failures.ts` | nothing — `recordFailure` already spreads its input | No |
| `src/server/llm/usage.ts` | two new `UsagePurpose` values | No |
| `src/server/dal/media.ts` | the `reservations` expression counts positions too; `claimPoolImage` added (**S15**, **S16**) | Yes, and intended: an asset a live position holds is no longer offered to a new job |
| `src/server/dal/posts.ts` | `findByStandingSeriesPosition` | No |
| `src/server/dal/generation-failures.ts` | `listForRun`, two insert fields | No |
| `src/server/dal/credential-owners.ts` | `resolveBlockedProjectIds` generalised to take candidate project ids; `standingSeriesExcludingProjects` added (**S37**) | No |
| `src/server/scheduler/budget.ts` | **new**: `withinBudget`, `Overran`, `redactedLog` moved out of `jobs/runner.ts` (**S36**) | No |
| `src/server/dal/scope.ts` | three repos on `ProjectScope`; no `KEY_GRANTS` entry (**S25**) | No |
| `src/server/auth/access.ts` | `standing_series: ["manage"]` on `statements`, `owner`, `admin` | No |
| `src/server/db/project-owned.ts` | three lines | No |

SC-011 is the assertion that this table is honest: `tests/integration/generation/**`,
`tests/integration/jobs/**` and `prompt.golden.test.ts`'s existing snapshots must pass **unchanged**.

---

## 9. What the service layer does not gain

- No second generation path, prompt, output schema, correction retry, failure kind or policy
  function. One `applyApprovalPolicy` call, one `runGenerationStep` call, one `planSeries` call.
- No explicit-time scheduling, no per-post override, no editing a run's plan, no re-running a closed
  run, no manual "run now".
- No public API operation, no webhook event, no notification, no email (**S40**).
- No change to `one-off Generate`, the in-request series or finite batch jobs beyond the table in
  § 8 (FR-066).
