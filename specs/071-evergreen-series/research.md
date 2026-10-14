# Phase 0 — Outline & Research: Standing content series

**Feature**: `071-evergreen-series` | **Date**: 2026-10-13 | **Spec**: [spec.md](./spec.md)

This document closes every unknown the spec left to the plan and records the forty plan-level
decisions (**S1 – S40**) the design rests on. Each one names the file it was read from, because
constitution I forbids deciding any of this from memory.

Nothing here needed the web. The spec's own facts section already states that no new external fact
is required: the providers that declare media required come from the capability declarations and
`docs/limits.md`, period boundaries come from the installed Temporal polyfill, and throughput wording
is derived from the latency already recorded in `docs/generator.md`. **No `NEEDS CLARIFICATION` and
no `NEEDS RESEARCH` remains.**

---

## 1. What exists on `main`, read file by file

Every claim below was read, not recalled.

### 1.1 The two finite generation shapes

| Thing | File | What it does |
|---|---|---|
| Batch job table | `src/server/db/schema/jobs.ts` | `generation_jobs` holds `sourceKind`, `voiceProfileId` **and** `voiceProfileVersionId` (both pinned), `template`, `templateFields text[]`, `targetAccountIds uuid[]`, `requestedApproval`/`requestedScheduling`, resolved `approvalPolicy`/`schedulingPolicy`, a derived `status`, `itemCount`, `open`, `lastClaimedAt`. Composite FKs `(project_id, voice_profile_id)` and `(project_id, voice_profile_version_id)`; CHECKs for template length (1–2000) and target cardinality (1–50). |
| Batch job items | same | `generation_job_items` holds `position`, `payload jsonb`, `mediaAssetId`, `status`, `attemptCount`, `nextAttemptAt`, `leaseOwner`/`leaseUntil`, `pendingRetry jsonb`, `lastErrorKind`/`lastError`. `unique(job_id, position)`; **`generation_job_items_active_media_uq`** = partial unique index on `(project_id, media_asset_id)` where the status is `queued`/`running`/`failed` — this *is* the image-reservation mechanism. CHECKs pair the lease with `running` and bound `lastError` at 500 characters. |
| Status derivation | `src/server/services/jobs/status.ts` | `deriveJobStatus` + `refreshJobStatus`: status is **derived from the items** and written in exactly one place, under the job lock. |
| Item runner | `src/server/services/jobs/runner.ts` | The whole lifecycle of one claimed item: lease-checked `commit`, `fail`/`retryLater`/`requeueForCredit`/`release`/`skip`/`finish`, a `withinBudget` race against the tick deadline, `Overran`, a `GuardLost` guard inside the policy transaction, `redact`ed one-line log. `TEMPORARY` = `timeout, rate_limited, unavailable, internal, interrupted`. |
| In-request series | `src/server/services/generation/series.ts` | `planSeries` (2–10 angles, one correction retry, `checkSeriesPlan`), `startSeries` (stores the edited plan and the resolved policies, **no model call**), `writeSeriesPost` (one post per angle, `findBySeriesPosition` first, unique-violation → re-read the winner), `getSeries`. `SERIES_COUNT_MIN = 2`, `SERIES_COUNT_MAX = 10`. |
| Series table | `src/server/db/schema/generation.ts` | `generation_series` is the **in-request** plan: `brief`, `plan jsonb`, `request jsonb`, `plannedCount smallint` with a CHECK `BETWEEN 2 AND 10`. |

### 1.2 Generation core, prompt, policy, save

| Thing | File | What it does |
|---|---|---|
| Core step | `src/server/services/generation/core.ts` | `runGenerationStep(scope, CoreRequest, llm, opts)` → `CoreOutcome | { ok: "retry", pending }`. Wraps the provider in `recorder.wrap(withCreditHold(llm, owner))`, prepares images, builds the output schema from the group keys, one correction retry gated by `retryWindowMs()`. `CoreRequest.inputs.series` is `{ angle, otherAngles, position }`. |
| Prompt | `src/server/services/generation/prompt.ts` | `buildGenerationPrompt`, `buildSeriesPlanPrompt({ voice, platforms, groups, instructions, brief, sourceText, count, retry, brand })`, `brandOf`, `platformRulesFor`, `promptGroupsFor`. The plan prompt's one series line is `SERIES PLAN: Plan a series of exactly N posts…`. Golden snapshots live in `prompt.golden.test.ts` / `__snapshots__`. |
| Policy | `src/server/services/generation/policy.ts` | `decidePolicy` (blocking validation → review, else `review_required` → review, else `add_to_queue` → approved+queued, else approved), `resolvePolicies` (role check for `auto_approve`, `CONFIRM_UNREVIEWED_QUEUE_MESSAGE` when auto-approve meets add-to-queue), `applyApprovalPolicy(scope, postId, resolved, { guard })` — prepares variants **outside** the transaction, then locks the post, gates every draft target, decides, approves, calls `queueTargetsInTx`, applies the derived status and writes the decision back into the last generation record. |
| Save | `src/server/services/generation/save.ts` | `saveGeneratedPost(tx, { accounts, groups, variants, assets, imageAltTexts, record, schedulingPolicy, createdByUserId, createdByApiKeyId, link, external })`; `GeneratedPostLink` is a union of `{ generationRequestId }`, `{ seriesId, seriesPosition }`, `{ generationJobItemId }`. |
| Failures | `src/server/services/generation/failures.ts` | `recordFailure(scope, …)` stores the **fixed** message for the kind. `generation_failures` has `mode generation_mode`, `seriesId`/`seriesPosition` with a pair CHECK and a cascading composite FK. |
| Ledger | `src/server/db/schema/generation.ts`, `src/server/llm/usage.ts` | `llm_call_usage` is insert-only, one row per call that **reached** the provider; `llm_usage_purpose` currently has eight values; `createUsageRecorder({ projectId, purpose, source })` buffers and `flush(link)`es. `src/server/llm/no-missing-usage-purpose.test.ts` guards that every purpose has a call site. |
| Groups | `src/lib/generation/groups.ts`, `src/server/services/generation/groups.ts` | `GROUP_LIMIT = 16`, `groupLimitMessage`, `groupsForAccounts(accounts, instructionsOf?)`. |
| Limits | `src/lib/validation/generation.ts` | `BRIEF_MAX = 2000`, `INSTRUCTIONS_MAX = 2000`, `JOB_INSTRUCTIONS_MAX = 10_000`, `TARGET_ACCOUNTS_MAX = 50`. `src/lib/validation/jobs.ts`: `JOB_TEMPLATE_MAX = INSTRUCTIONS_MAX`. |
| Templates | `src/lib/jobs/template.ts` | `PLACEHOLDER`, `placeholdersIn`, `unknownPlaceholders(template, fields)`, `renderTemplate(…, { mark })`, `JOB_RENDERED_INSTRUCTIONS_MAX = 10_000`. `src/server/services/jobs/create.ts`'s `checkTemplate` produces the exact refusal sentence FR-003 must reuse: `Unknown ${what}: … Available: … / none`. |

### 1.3 The worker tick

| Thing | File | What it does |
|---|---|---|
| Tick | `src/server/scheduler/index.ts` | `runTick` builds the config, takes `startedAt` from `clock.now()`, and runs **six** sections concurrently in one `Promise.all`, each inside a `section()` wrapper that catches and returns `{ ok: false, counts: empty, error: "section_failed" }`. `TickSummary` names each section. |
| Generation section | `src/server/scheduler/generation.ts` | `runGenerationJobs`: bails with `notConfigured` when neither the install nor any project has a credential, bails with `notRunnable` when `timeBudgetMs < minCallMs + persistReserveMs`, claims, then `Promise.all`s the items, and writes one heartbeat. |
| Claim | `src/server/dal/job-claims.ts` | `claimDueJobItems`: one transaction, `gateCreditHolds` first, blocked owners resolved to project ids, jobs locked `FOR UPDATE SKIP LOCKED` ordered `lastClaimedAt ASC NULLS FIRST, createdAt, id`, due items locked in position order, round-robin interleave, per-owner budget of 1 while probing, `kind: "finish"` when a recovered item already has a post, `attemptCount` incremented on recovery (never for a probe), `lastClaimedAt` stamped, granted-but-unused probes rewound. |
| Config | `src/server/scheduler/config.ts` | `SchedulerConfig` plus one `xxxConfig(config)` helper per section filling defaults. `jobConfig` → `maxItems` (`GENERATION_TICK_MAX_ITEMS`, default 2), `JOB_MIN_CALL_MS = 8_000`, `JOB_PERSIST_RESERVE_MS = 3_000`, `JOB_ITEM_MAX_ATTEMPTS = 3`, `JOB_BACKOFF_BASE_MS = 60_000`, `JOB_BACKOFF_MAX_MS = 900_000`. |
| Env | `src/server/env.ts` | `SCHEDULER_TICK_BUDGET_SECONDS: int(5, 25, 20)`, `SCHEDULER_LEASE_SECONDS: int(60, 3600, 300)`, `GENERATION_TICK_MAX_ITEMS: int(1, 10, 2)`. `ENV_VARIABLES` is `Object.keys(base.shape)`, so registration is automatic once the key exists; `tests/lint/env-coverage.test.ts` then demands a `.env.example` entry. |
| Heartbeat | `src/server/dal/heartbeats.ts` | `writeHeartbeat(section, at, summary)` upserts one row per section name. |
| Credit hold | `src/server/dal/credit-holds.ts`, `src/server/dal/credential-owners.ts` | `gateCreditHolds(exec, now)` → `{ held, probing }`, `rewindCreditProbe`, `CREDIT_PROBE_INTERVAL_MS = 5 min`; `credentialOwnerFor(projectId)`, `projectCredentialOwner`, `INSTALL_CREDENTIAL_OWNER`, and `jobsExcludingProjects(ids, allBlocked)` — a predicate written **against `generation_jobs`**. |
| Backoff | `src/server/scheduler/backoff.ts` | `nextRetryAt(now, attempts, cfg)`. |
| Housekeeping | `src/server/scheduler/housekeeping.ts` | Bounded deletes, one small batch per tick, each with its own named batch constant and count. |

### 1.4 Queueing, media, isolation, time

| Thing | File | What it does |
|---|---|---|
| Allocator | `src/server/services/posts/index.ts` | `queueTargetsInTx(tx, post, targets, { expected })` — the body of `addToQueue` for callers already holding the post lock; holds occurrences in **account order** so two posts sharing accounts cannot deadlock; `allocateNextFree` walks candidates against `post_targets_occurrence_uq`. |
| Occurrences | `src/server/services/queue/occurrences.ts` | `resolveOccurrence(date, time, zone)` uses `disambiguation: "compatible"` — the one rule for a wall time that does not exist or exists twice. |
| Media repo | `src/server/dal/media.ts` | `listIdsForSelection({ unusedOnly, tag, … })`, `lockForReservation` (`FOR NO KEY UPDATE`, id order), `reservedAmong`, `usedAmong`, `markUsed`, `lockShared`. The `reservations` SQL counts **`generation_job_items`** rows only; `notReserved` is `… = 0` because the scope checker rejects a negation in a predicate. |
| Media source | `src/server/services/jobs/sources/media.ts` | Already refuses a video: `row.kind !== "image"` counts as unusable. |
| Media required | `src/providers/validation.ts`, `src/providers/requirements.ts` | `media_required` and `text_only_not_allowed` issues come from `caps.media.required` / `caps.textOnlyAllowed`; `mediaRequired` is surfaced to the UI as `caps?.media.required ?? false`. |
| Image generation | `src/server/services/media-generate.ts`, `src/server/llm/image-generation.ts` | `createImageGenerator(scope)` returns the declared `ImageGenerator` bound to a scope and refusing another project's id; `generateImage` needs `media: ["generate"]`, returns `{ ok: false, message }` for storage-off / unconfigured / key-unreadable / provider refusal, appends `NO_REAL_PEOPLE` and **nothing else**, and lands the bytes through `uploadMedia` with provenance. `IMAGE_PROMPT_MAX = 1000`, `IMAGE_ASPECTS`, `DEFAULT_IMAGE_ASPECT`. |
| Scope | `src/server/dal/scope.ts` | `ProjectScope` with one repo per table, `can(request)`, `transaction`, `forProject`, `forJobRunner(projectId, actorUserId)` (acts as an `editor` with `actor.kind === "job_runner"`), `crossProject(reason, fn)`. |
| Roles | `src/server/auth/access.ts` | `statements` + three roles. Owner/admin-only capabilities are expressed as an action editors lack (`slot: ["manage"]`, `voice: ["manage"]`, `media: ["generate"]`, `generation: ["auto_approve"]`). `KEY_GRANTS` in `scope.ts` decides what an API key can do. |
| Project-owned list | `src/server/db/project-owned.ts` | One line per table; `tests/integration/scope-check.test.ts` reads it. |
| Audit | `src/server/db/schema/audit.ts`, `src/server/dal/audit.ts` | `membership_audit_log` with a `membership_action` enum that already carries `account_posting_instructions_update`, `llm_credential_update`, `project_brand_update`; the repo refuses details keys matching `/token|url|password|secret/i`. |
| Activity | `src/lib/activity/outcomes.ts` | `ACTIVITY_KINDS` are **publish and connect outcomes only** — `target_published`, `target_failed`, `target_ambiguous`, `target_retry_scheduled`, `target_resolved`, `account_needs_reauth`, `account_connect_failed`. |
| Time | `src/lib/generation/usage-period.ts`, `src/lib/email/schedule.ts` | The precedent for a **pure** Temporal module in `src/lib/`: no database, no `Date.now()`, local date → instant via `toPlainDateTime().toZonedDateTime(zone, { disambiguation: "compatible" })`. |
| Clock | `src/server/dal/clock.ts` | `clock.now()` reads the database clock; `runAtTime(date, fn)` pins it for tests — this is how every cadence test advances time. |
| Jobs UI | `src/app/p/[projectSlug]/jobs/` | `page.tsx` (list, `CreditHoldNotice`, `loadPrerequisites`, `mediaStatus`), `new/`, `[jobId]/`, `actions.ts` with `runAction(slug, fn)`. `tests/lint/section-placeholders.test.ts` requires `jobs/page.tsx` to exist. |

### 1.5 The one factual correction this research makes to the spec

**FR-008 says "the project's activity log, as other project configuration changes already are."**
The log that records configuration changes in this codebase is the **audit log**
(`membership_audit_log`, read on the Settings page behind `audit: ["view"]`), not `activity_events`.
`activity_events` has a kind/outcome CHECK pair, a `provider_keys` cardinality ≥ 1 CHECK and a
target-kind CHECK, all of which a series edit would have to be contorted to satisfy, and the
precedent FR-008 itself cites — "as posting-instruction edits already are", from the roadmap text —
is `account_posting_instructions_update`, a **`membership_action`**. Resolved as **S27**: five new
`membership_action` values. The spec's requirement is honoured exactly; only its name for the log is
corrected.

---

## 2. Decisions

Format: *Decision / Rationale / Alternatives considered.* Recorded in `docs/decisions.md` under
`## 061 — Standing content series` after the spec's W1–W34.

### Storage shape

**S1 — Three tables: `standing_series`, `standing_series_runs`, `standing_series_positions`.**
*Rationale*: W2 splits configuration from work, and the run must carry positions, counts, outcomes
and failures. A position is a row because every success criterion about idempotency (SC-002) is a
statement about a *per-position uniqueness*, and because a skip, a failure and a produced post are
three outcomes of the same slot — the exact shape `generation_job_items` already has.
*Alternatives*: positions as a `jsonb` array on the run (no uniqueness to lean on, no partial unique
index for the image reservation, no per-position backoff column); two tables with the run's work
inferred from the posts (cannot represent a skip or a failure at all).

**S2 — The run carries a configuration snapshot (`config jsonb`), written when it opens; the
producer reads the run, never the series.**
*Rationale*: this is the whole of FR-056 and of the first edge case ("edited while a run is open:
the open run finishes under what it started with"), with no locking between a person's edit and the
worker. It also makes the run history honest: a run shows what it actually ran with. The shape is
validated with Zod on read, exactly as `series.ts` validates `generation_series.request` through
`seriesRequestSchema`.
*Alternatives*: lock the series for the life of the run (a run spans ticks, so the lock would span
ticks — impossible); version the series row and have the run name a version (a second table and a
second migration for no extra truth); read live configuration and accept that an edit changes an
open run (contradicts FR-056).

**S3 — Run counts are **derived** from its positions; only `outcome` is stored, once, at close.**
*Rationale*: `refreshJobStatus` already establishes that a parent's rollup is derived and written in
one place, and that is precisely the rule that keeps counters from double-counting under retries and
overlapping ticks. FR-015's "durably record how many it produced / skipped / failed" is satisfied by
the positions themselves, which are durable and are deleted only with the series. `outcome` is
stored because the self-pause rule (FR-053) reads the three most recent closed runs and must not
re-count positions to do it.
*Alternatives*: stored counters incremented per position (the classic double-count bug under lease
recovery); deriving the outcome too (three extra grouped queries on every list render).

**S4 — A period is identified by `(period, period_start)` where `period_start` is a **local
`date`**, with `unique(series_id, period, period_start)`.**
*Rationale*: FR-012 wants the database, not timing, to enforce one run per period. The local date is
the stable key: changing the project's time zone does not relabel history (edge case), and a
boundary inside a DST transition still has exactly one date. `period` is part of the key because the
cadence is editable — lowering `week` to `day` would otherwise collide a Monday `day` run with the
`week` run whose `period_start` is that same Monday.
*Alternatives*: a `timestamptz` key (moves when the zone changes, so the unique index would admit a
second run for the "same" period); a text key like `2026-W42` (a second formatting rule to keep in
step with Temporal).

**S5 — The cadence engine is a pure module, `src/lib/series/cadence.ts`.**
*Rationale*: `src/lib/email/schedule.ts` and `src/lib/generation/usage-period.ts` are the precedent —
no database, no `Date.now()`, every boundary resolved through
`toPlainDateTime().toZonedDateTime(zone, { disambiguation: "compatible" })`. A pure module is the
only way to test leap days, month ends and both DST directions exhaustively and cheaply, and it is
what `dated-series` will import rather than re-derive (SC-012).
*Alternatives*: boundary arithmetic inside the DAL query (untestable without a database, and SQL
`date_trunc('week')` is ISO-Monday but would put the zone logic in two languages).

**S6 — The claim unit is the **series**, leased on the series row (`lease_owner`, `lease_until`,
`last_claimed_at`); positions carry no lease.**
*Rationale*: one holder per series makes FR-014 ("at most one run open") true by construction, makes
the per-series post budget (FR-044) enforceable, and makes "two ticks, one run" (US3 AS1) a property
of a single `FOR UPDATE SKIP LOCKED` row rather than of an interleaving argument. A second lease on
positions would add a failure mode (a live position lease under a dead series lease) with nothing to
show for it.
*Alternatives*: lease the run (a due series with no open run still needs a claim, so both would be
needed); lease the position like a job item (then two workers could hold two positions of one run
and both would try to plan it).

**S7 — Claim predicate: `enabled AND lease free AND (next_run_at <= now OR EXISTS (an open run with
work due))`.**
*Rationale*: `next_run_at` advances when a run **opens**, so without the second disjunct a run that
spans ticks would never be picked up again. "Work due" means the plan is needed and its backoff has
expired, **or** a position is `queued` with `next_attempt_at <= now`, **or** a position is left
`running` — the direct analogue of the `EXISTS` sub-select in `claimDueJobItems`. It also keeps a
series whose every position is in backoff from being claimed at all, so a rate-limited provider is
not hammered.
*Alternatives*: advance `next_run_at` only when the run closes (then a run that cannot finish holds
the series past its next boundary, and W11's "a new period closes a still-open run" becomes
unreachable); poll every enabled series each tick and decide in application code (unbounded work per
tick).

**S8 — Positions are created when the run opens, in the same transaction; the plan is written
before the first post with `UPDATE … WHERE plan IS NULL`.**
*Rationale*: FR-015 needs "how many it was asked for" durable at open; FR-016/FR-017 need the plan
stored before the first post and reused on resume. The `WHERE plan IS NULL` guard makes "a restart
must not re-plan" a database fact rather than a sequencing hope.
*Alternatives*: create positions after planning (a crash between open and plan leaves a run that
records nothing about what it was asked for); store the plan on the series (it is per-period data —
W2).

**S9 — Plan retry bookkeeping is two columns on the run: `plan_attempt_count`,
`plan_next_attempt_at`.**
*Rationale*: a plan call is a model call and must obey FR-022's rule — temporary kinds retry under
the shared cap and `nextRetryAt`, lasting kinds do not. Without a backoff column the claim predicate
would re-plan on every tick after a rate limit. Two columns, no new table, and the failure's kind and
message live where every other failure's does (`generation_failures`), so nothing is duplicated.
*Alternatives*: hang the plan's retry state off position 0 (overloads a row that means something
else); a run-level `pending_retry` for the plan's *correction* retry — not needed, because
`planSeries` already does its one correction retry in-request within the same call.

**S10 — `posts` gains exactly **one** nullable column, `standing_series_position_id`, with a
composite FK `(project_id, standing_series_position_id)` **`ON DELETE SET NULL`** and a partial
unique index where it is not null and the post is live.**
*Rationale*: this is simultaneously FR-021's uniqueness constraint (a position row *is* a (run,
position) pair, so a unique index on the post's reference to it is a unique index on the link),
FR-057's "deleting a series keeps its posts" (SET NULL), and the Key Entities line "a post produced
by a standing series can be traced back to its series, run and position". It mirrors
`posts_generation_job_item_uq` exactly, so `findByStandingSeriesPosition` is a copy of
`findByJobItemId` and the runner's already-has-a-post branch transfers unchanged.
*Alternatives*: `positions.post_id` instead (then `saveGeneratedPost` has no `link` to pass, the
unique index would have to live on the positions side, and the post→series direction becomes a
reverse scan); both columns (two links to keep consistent); two columns on `posts` mirroring
`series_id`/`series_position` (then the pair CHECK and `ON DELETE SET NULL` contradict each other —
SET NULL nulls only the FK's own columns).

**S11 — `GeneratedPostLink` gains a fourth variant `{ standingSeriesPositionId }`;
`GenerationRecord.mode` gains `"standing_series_post"`.**
*Rationale*: `saveGeneratedPost` requires a link; a fourth variant is one line and keeps the
stored generation record self-describing. SC-003 asks that nothing *differ* because a post came from
a series — it does not ask the record to lie about where it came from, and a stored `mode` is how
every other path identifies itself.
*Alternatives*: reuse `{ generationRequestId }` with a synthesised id (there is no deterministic
uuid helper in the repository, and a random one would break the idempotency that column exists for);
reuse `{ seriesId, seriesPosition }` (points at `generation_series`, a different table with a
`2..10` CHECK on its count — a cadence of 1 could not be represented).

**S12 — `generation_failures` gains `standing_series_run_id` + `standing_series_position smallint`;
`generation_mode` gains `standing_series_plan` and `standing_series_post`; the FK cascades from the
run.**
*Rationale*: the exact mirror of the existing `series_id`/`series_position` pair, so
`recordFailure`, the fixed message map and the failures screen need no new vocabulary (FR-023).
`position` is nullable because a **plan** failure belongs to the run and has no position. CASCADE is
right because FR-057 removes the run history with the series, and a failure is run history.
*Alternatives*: a separate `standing_series_failures` table (a second failure vocabulary — exactly
what FR-019 forbids); reuse `series_id` by pointing it at the new table (its FK names
`generation_series`).

**S13 — Two new `llm_usage_purpose` values (`generate.standing_series_plan`,
`generate.standing_series_post`) and **no new column** on `llm_call_usage`.**
*Rationale*: FR-024 asks for provider, model, outcome and credential source "under the same rules as
every other generation call". A post call flushes with its `postId`, exactly as a manual Generate
does; a plan call flushes with `{}`, exactly as `generate.series_plan` does. Adding a run column
would make the ledger's shape differ for one caller, which is what SC-003 argues against.
`no-missing-usage-purpose.test.ts` widens from eight call sites to ten, deliberately.
*Alternatives*: reuse `generate.series_post` (then the cost screen cannot tell an unattended series
from a person's work, which is the one distinction an operator reading a bill actually wants);
a `standing_series_run_id` column (unused by any requirement).

### Media

**S14 — Media is resolved **per position**, immediately before that position's model call, and the
chosen asset id is written onto the position.**
*Rationale*: the position must hold its asset before the call because the asset is part of the
prompt (`imagesForModel`) and of the saved post — the same reason a batch job item holds
`media_asset_id` from creation. Writing it on the position means a restart **reuses** the image
rather than reserving or, worse, *generating and paying for* a second one. Per-position rather than
all-at-open also makes US4 AS2 fall out naturally (a pool of one and a cadence of three produces one
post and two recorded skips) and lets a pool refilled mid-run work.
*Alternatives*: reserve every image when the run opens (a run would commit to an exhausted pool it
might not have needed, and the `generate` source cannot be pre-resolved at all without spending);
resolve after the model call (the image could not be in the prompt, and a post would be written that
then had to be deleted).

**S15 — The pool reservation is a partial unique index on
`standing_series_positions (project_id, media_asset_id)` where the asset is set and the status is
`queued` or `running`; `src/server/dal/media.ts`'s reservation predicate is widened to count **both**
tables.**
*Rationale*: FR-035's "no other series, run or batch job can take the same asset" and the edge case
"the same image would be taken by a batch job and a standing series in the same tick" are one
requirement, and the mechanism for it already exists — the partial unique index that
`generation_job_items` uses. Widening the shared `reservations` expression is the shared refactor
FR-066 contemplates: it only ever *adds* exclusions, so every existing job test stays green with no
standing-series rows in the database. `failed` is deliberately **not** in the predicate: a lasting
position failure is never retried (FR-022), so its image must go back to the pool, unlike a job
item's, which a person can retry.
*Alternatives*: a `media_reservations` table (a third mechanism for one idea); an application-level
"is it taken" check (a race by construction).

**S16 — The pool claim is one short transaction: `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1` over live
image assets with `first_used_at IS NULL`, unreserved, matching the tag, oldest first — then the
write that takes the unique index.**
*Rationale*: `SKIP LOCKED` plus the unique index is exactly how `allocateNextFree` and
`claimDueJobItems` already make "one of them gets it and the other walks on" true without waiting.
Oldest-first drains a pool predictably, which is what an operator stocking one expects.
*Alternatives*: `lockForReservation` over a candidate list (it is `FOR NO KEY UPDATE` and *waits*,
which inside a tick means a tick that blocks on another tick); random choice (unreproducible tests).

**S17 — The `generate` source calls `createImageGenerator(scope)` with the series' stored prompt and
nothing else.**
*Rationale*: FR-036 and W27 are explicit — the prompt is the person's own wording plus the fixed
real-people instruction, with no post text, no brand fields and no voice profile. `generateImage`
already appends `NO_REAL_PEOPLE` and already composes nothing else, so satisfying FR-036 means
**calling it and adding nothing**, and the assertion in quickstart § 6 is "the request body equals
`prompt + NO_REAL_PEOPLE`". The call happens outside every transaction (constitution:
no provider call inside a held transaction).
*Alternatives*: a series-specific image prompt composer (would have to be argued against W27 and
re-tested); passing the planned angle's title (the first step onto the slope W27 closes).

**S18 — `last_error_kind` on a position reuses the existing `generation_job_item_error` pgEnum.**
*Rationale*: it already carries exactly the fourteen kinds this feature can produce, including
`interrupted`, `image_deleted`, `image_unavailable`, `no_targets` and `credit_exhausted`, and reusing
it means `llmFailureMessage` and the `TEMPORARY` set map identically — FR-019's "no series-specific
failure kind", literally. The name is mildly job-flavoured; a comment in the schema says so.
*Alternatives*: a new `standing_series_error` enum (a second list to keep in step with the first, and
a second place for a reviewer to check that `TEMPORARY` agrees).

**S19 — A new `standing_series_skip_reason` enum with six values, plus `skip_account_id`.**
Values: `pool_exhausted`, `image_generation_not_configured`, `image_generation_failed`,
`media_unusable`, `media_storage_not_configured`, `series_not_runnable`.
*Rationale*: FR-038 requires a reason naming **both the cause and the account** whose requirement
failed, and FR-039 requires a skip to be a distinct, neutral outcome — an enum plus an account id is
the smallest thing that renders both without free text. `media_unusable` is the planner-refused case
(`imagesForModel` returning `ok: false`, or a non-image asset). `series_not_runnable` is the blocked
run's remaining positions (**S20**).
*Alternatives*: a free-text reason (unrenderable as a badge, untestable as an assertion,
and a place for provider text to leak); reusing `generation_job_item_error` (a skip is explicitly
not a failure — FR-039).

**S20 — The run carries `outcome` (`produced_all` | `produced_some` | `produced_none` |
`incomplete`) and `blocked_reason` (`voice_profile_missing` | `no_usable_target`); a blocked run
closes `produced_none` and skips its remaining positions as `series_not_runnable`.**
*Rationale*: FR-025 names three outcomes, FR-014 adds "closed as incomplete". FR-007 and US6 AS5
each describe a run that cannot proceed for a reason that is a property of the *series*, not of a
position, so it belongs on the run. Note that voice profiles in this codebase are **archived**, never
deleted (`src/server/dal/voice.ts` has no delete; `takeVoice` throws for `archivedAt`), so the spec's
"deleted voice profile" edge case is the archived case, and the composite FK is safe.
*Alternatives*: a `blocked` outcome value (then "produced nothing" has two spellings and the
self-pause query has to know both); recording the reason per position only (US6 AS5 asks for it at
the run level).

**S21 — The run records `dropped_account_ids uuid[]`.**
*Rationale*: the edge case "a target account is removed between runs: the series drops it **and
records that it did**". One array column on the run is the whole of it.
*Alternatives*: an activity or audit row per dropped account (the worker is not an actor in the audit
log, and the fact belongs to the run).

### The worker pass

**S22 — A seventh section, `src/server/scheduler/standing-series.ts`, inside the existing
`runTick()`.**
*Rationale*: W30/FR-042 are explicit, and the existing `section()` wrapper already gives FR-047's
"a failure inside it cannot affect publishing" for free. `runStandingSeries({ config, tickId,
startedAt })` returns `StandingSeriesCounts`, writes one heartbeat under the section name
`standing_series`, and is added to `TickSummary`.
*Alternatives*: fold it into `runGenerationJobs` (one section's failure would then take both down,
and the two per-tick limits W31 insists on separating would share a budget); a second loop or process
(forbidden by W30 and by constitution VI).

**S23 — Two environment variables with the section's own limits; the physical per-call constants are
shared.**
`STANDING_SERIES_TICK_MAX_SERIES: int(1, 10, 2)` and `STANDING_SERIES_TICK_MAX_POSTS: int(1, 10, 2)`
in `src/server/env.ts` and `.env.example`; `standingSeriesConfig(config)` fills them, and reuses
`JOB_MIN_CALL_MS`, `JOB_PERSIST_RESERVE_MS`, `JOB_ITEM_MAX_ATTEMPTS`, `JOB_BACKOFF_BASE_MS` and
`JOB_BACKOFF_MAX_MS`.
*Rationale*: W31 requires the **claim limits** to be its own, so a quiet batch queue does not change
how fast a series runs. It does not require a second opinion about how long one model call takes or
how many times a timeout should be retried — those are facts about the provider and the tick budget,
and two copies would drift. `ENV_VARIABLES` picks the names up automatically; `env-coverage` then
demands the `.env.example` lines.
*Alternatives*: one shared `GENERATION_TICK_MAX_ITEMS` (W31 forbids it); five more variables (an
operator surface nobody asked for).

**S24 — Series are processed concurrently (up to `maxSeries`); positions **within** a run are
produced sequentially. The install's extra concurrent model calls are therefore at most
`STANDING_SERIES_TICK_MAX_SERIES`.**
*Rationale*: positions of one run share a plan, a pool and a per-series post budget; producing them
concurrently would make the pool claim contend with itself and the budget accounting non-local, for
no throughput gain — at the default 20 s budget, `minCallMs + persistReserveMs` leaves room for one
call per series per tick anyway. Sequential positions also make "the posts already written are
intact, nothing is half-written" (US3 AS5) a trivially true statement. This is the sentence
FR-045 requires `docs/generator.md` to state: the ceiling is
`GENERATION_TICK_MAX_ITEMS + STANDING_SERIES_TICK_MAX_SERIES`, and it is bounded by lowering either.
*Alternatives*: concurrent positions (contention on the pool, and a tick that can start
`maxSeries × maxPosts` calls at once — a rate-limit generator).

**S25 — One new access statement, `standing_series: ["manage"]`, granted to `owner` and `admin`, with
**no** `KEY_GRANTS` entry.**
*Rationale*: the established way to express owner/admin-only is an action editors lack
(`slot: ["manage"]`, `media: ["generate"]`). Granting it to no API-key permission is how
"no public API surface" is enforced structurally rather than by omission — an API-key scope's `can()`
answers false, so FR-060's server-side refusal holds for a hand-built API request too.
`src/server/auth/access.test.ts`'s matrix is exhaustive by construction and fails until all three
roles name it.
*Alternatives*: reuse `generation: ["auto_approve"]` (conflates two different permissions, and would
let an editor pass once the project default is auto-approve); a database-backed permission (roles
live in code here).

**S26 — Viewing the list and the run history is gated by `post: ["view"]`.**
*Rationale*: FR-061 says exactly that, and it is what the Jobs page already uses (`canView` in
`jobs/read.ts`). No new view permission.

**S27 — FR-008's log is the **audit log**; five new `membership_action` values:
`standing_series_create`, `standing_series_update`, `standing_series_pause`,
`standing_series_resume`, `standing_series_delete`.**
*Rationale*: § 1.5 above. The details payload carries the series id and name only — the repo's
`assertAuditDetailsSafe` refuses a key matching `/token|url|password|secret/i`, and a series holds
no secret anyway.
*Alternatives*: `activity_events` (its CHECKs are written for publish outcomes; see § 1.5); no log at
all (FR-008).

**S28 — No posting-instructions snapshot on a series or a run.**
*Rationale*: FR-019 requires that "posting instructions MUST compose exactly as they do for a manual
Generate", and a manual Generate reads them **live** through `groupsForAccounts(accounts)` with no
snapshot — the `postingInstructionsSnapshot` column exists on `generation_jobs` because a batch job
freezes a fixed item list at creation, which a standing series explicitly does not do (W2). FR-056's
"an edit does not change an open run" is about the **series'** own configuration, which **S2**
snapshots; an account's posting instructions are the account's, not the series'.
*Alternatives*: snapshot at run open (then a corrected posting instruction would not reach a series
until its next period, and the series would prompt differently from a manual Generate — SC-003).

**S29 — `template_fields` must be empty, enforced in Zod, not by a CHECK.**
*Rationale*: FR-003 requires emptiness for every series **created by this entry**; W3 keeps the
column precisely so `dated-series` can fill it. A CHECK would force `dated-series` to ship a second
migration to undo it, which is the cost W3 exists to avoid. The refusal sentence is the existing one
from `checkTemplate` — `Unknown field: … Available: none` — reached by calling
`unknownPlaceholders(template, [])`.
*Alternatives*: a `cardinality = 0` CHECK (see above); no validation (a stored placeholder would
render as itself into the prompt).

**S30 — Avoid-titles: the angle titles of the **3** most recent closed runs, capped at **20**
titles.**
*Rationale*: FR-018 and the spec's assumption leave the number to the plan, bounded by prompt
length. Three runs is a month of a weekly series and a fortnight of a twice-weekly one; 20 titles at
the `ANGLE_TITLE_MAX` ceiling is a few hundred characters against a 2,000-character brief, so it
cannot crowd the prompt. Both are named constants in `src/lib/series/cadence.ts`'s sibling
`src/lib/series/avoid.ts` so a test can assert the cap rather than the behaviour's shape.
*Alternatives*: all prior runs (an unbounded prompt — exactly the failure mode `incomplete` exists
for); one run (a fortnightly repeat is still a repeat).

**S31 — `buildSeriesPlanPrompt` gains an `avoidTitles: readonly string[]` input and emits **nothing**
when it is empty.**
*Rationale*: FR-018 requires the golden tests to cover the new context "with and without prior
runs", and FR-066 requires the in-request series to behave exactly as it does today — which both
hold iff the empty case produces a byte-identical prompt. The in-request caller passes `[]`.
*Alternatives*: a separate prompt builder for standing series (a second prompt to keep in step —
FR-019 forbids a series-specific prompt).

**S32 — The producer re-reads `enabled` before each position and stops when it is false.**
*Rationale*: FR-054's "stop an open run producing further posts **at the next safe point**". The
boundary between positions is the only safe point, and the check is the same shape as the job
runner's cancelled guard. Positions already produced are untouched; the remainder stay `queued`.
*Alternatives*: interrupt mid-position (there is nothing to interrupt safely — the provider call is
already in flight); mark the remainder skipped on pause (resuming would then produce nothing for a
period it still owes, and W12 says posts already produced are untouched, implying the rest are
merely not produced).

**S33 — A position left `running` is reset by the next claim, counting an attempt — unless the claim
is a credit probe.**
*Rationale*: the series lease gates everything, so a `running` position under an expired lease is
unambiguously abandoned; this is `claimDueJobItems`'s recovery branch, including the rule that a
probe claim must not increment `attempt_count` (FR-050's "no attempt counted"). After
`JOB_ITEM_MAX_ATTEMPTS` the position fails with the existing `interrupted` kind and
`INTERRUPTED_MESSAGE`.
*Alternatives*: a second lease on positions (S6); never counting an attempt on recovery (a position
that kills its worker every time would retry forever).

**S34 — A position that already has a post but no applied policy is a **finish** position: variants,
policy, no model call.**
*Rationale*: `saveGeneratedPost` and `applyApprovalPolicy` cannot share one transaction — the policy
prepares variants (sharp work) outside it — so a crash between them is reachable. The job runner's
`kind: "finish"` branch already solves exactly this, and reusing its shape means the recovery is
already-reviewed behaviour rather than new behaviour. Detected by
`posts.findByStandingSeriesPosition(id)` returning a post while the position is not yet `produced`;
`produced` is written **only after** the policy is applied.
*Alternatives*: a `policy_applied_at` column (the post's own `reviewState` and last generation
record already answer the question — the runner's `finish` reads exactly that).

**S35 — Self-pause reads the three most recent **closed** runs' stored `outcome`, on close.**
*Rationale*: FR-053's threshold, evaluated at the only moment it can change, with one indexed query
(`ORDER BY closed_at DESC LIMIT 3`), which is why **S3** stores the outcome. `incomplete` runs that
produced nothing count: a series that cannot finish a period is as broken as one that refuses it.
The pause sets `enabled = false` and `auto_paused_reason = 'no_output'`, and the same Resume control
clears both (W34).
*Alternatives*: a consecutive-failure counter on the series (a counter to reset correctly in six
places); evaluating it at claim time (one extra query every tick for a condition that can only change
at close).

**S36 — `withinBudget` / `Overran` and the redacted one-line log move to
`src/server/scheduler/budget.ts`; `jobs/runner.ts` imports them.**
*Rationale*: the deadline race and the `redact`ed log line are needed verbatim by the new producer,
and copying them would put two copies of a secret-redaction rule in the tree. A pure move with no
behaviour change, proved by the job runner's existing tests staying green unchanged (FR-066).
*Alternatives*: copy them (two redaction rules); import them from `jobs/runner.ts` (a scheduler
section importing a job service for a timer).

**S37 — `resolveBlockedProjectIds` is generalised to take the candidate project ids; the standing
series claim supplies its own.**
*Rationale*: `jobsExcludingProjects` is written against `generation_jobs` and cannot answer for
`standing_series`. Splitting the owner→project resolution (`blockedProjectIds(exec, owners,
candidateProjectIds)`) from the per-table predicate keeps one credential-owner rule — constitution
IV — with one small predicate per table.
*Alternatives*: a second copy of the resolution (two places to get the `allBlocked` shortcut right);
a generic predicate taking a Drizzle column (harder to read than two three-line functions).

### Interface, docs, housekeeping

**S38 — A **Standing series** section on `/jobs`, with `/jobs/series/new`,
`/jobs/series/[seriesId]` and `/jobs/series/[seriesId]/edit`.**
*Rationale*: FR-058 says the section appears under the existing Batch jobs area, and FR-059 needs a
per-series view with run history, which cannot be a section of a list page. A static `series` segment
beside the existing `[jobId]` is already-proven routing (`jobs/new` does it today) and cannot
collide, because a job id is a uuid. `jobs/page.tsx` keeps existing, so
`tests/lint/section-placeholders.test.ts` stays green.
*Alternatives*: a top-level `/series` route (contradicts FR-058 and adds a nav entry the roadmap did
not ask for); everything on `/jobs` (no room for run history).

**S39 — Run history is pruned by housekeeping: closed runs older than 90 days, one bounded batch of
200 per tick.**
*Rationale*: the spec's assumption leaves the retention to the plan, "consistent with how generation
failures are already kept". `housekeeping.ts` is the established place, with one named batch constant
and one count per job, and 90 days matches the webhook and email retention defaults' order of
magnitude while keeping a quarter of a monthly series' history visible. Positions and their failures
cascade. A run that is still **open** is never pruned.
*Alternatives*: keep forever (a monthly series is fine; a daily series at ten posts a day is 3,650
positions a year per series); an environment variable (an operator surface nobody asked for — the
constant is documented instead).

**S40 — No webhook, no notification, no API, no real-time push.**
*Rationale*: the spec's assumptions and out-of-scope list say so explicitly. In particular
`emitEvent(tx, "job.finished", …)` has **no** standing-series sibling: a run closing emits nothing,
and the posts a run produces emit whatever a post already emits.

---

## 3. Two readings of the spec that had to be resolved

Named here so the implementation phase does not rediscover them and review judges the resolution.

1. **FR-008's "activity log" versus the shape of `activity_events`.** Resolved as **S27**: the audit
   log. See § 1.5 for the evidence.

2. **FR-021's "uniqueness constraint on the run and position" versus FR-057's "deleting a series
   keeps its posts".** A composite FK from `posts` to the run with a pair CHECK cannot satisfy both:
   `ON DELETE SET NULL` nulls only the referencing columns, which breaks the pair. Resolved as
   **S10**: the post references the **position** through a single column, so SET NULL is coherent and
   the unique index on that one column is exactly the uniqueness FR-021 asks for.

---

## 4. What this feature still does not know

- **Nothing new about any provider.** No live call, no new endpoint, no new limit. Every provider
  behaviour is exercised through the existing seams (`createFakeLlmFetch`, a stub `LlmProvider`, a
  stub `ImageProvider`) and is therefore **verified with mocks only**, as constitution II requires.
- **Real-world throughput.** `docs/generator.md` records about 1.3 s a call for `gpt-5.4-mini`
  measured on 2026-10-12; this entry measures nothing new and derives its throughput sentence from
  that figure and the tick budget. A different model's latency is unknown and nothing in the design
  depends on it.
- **Whether a planner asked to avoid 20 titles actually avoids them.** The prompt carries the titles
  and the golden test asserts the prompt; model obedience is not asserted, because asserting it would
  need a live call. US1 AS3's "its angles are not the same as the previous period's" is tested
  against a stubbed provider that echoes what it was asked to avoid.
