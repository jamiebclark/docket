# Data model: 010 Hardening

Phase 1 of [plan.md](./plan.md). This feature adds **no new table and no new target status**. It adds one migration (`drizzle/0007_*.sql`, plus the meta snapshot), which makes two additive schema changes and touches no existing row. The rest of this file covers derived views, validation rules and the document "entities".

## 1. Schema changes (migration 0007)

| Change | Detail | Why |
|---|---|---|
| `publish_attempt_outcome` enum: add `resolved_not_published` | User action: an ambiguous target was confirmed not published and requeued (or found no slot) | FR-008, research D4 |
| `publish_attempt_outcome` enum: add `requeued` | User action: the target took a slot occurrence; `request_summary = { scheduledAt, slotId }` | FR-008, D4 |
| `webhook_attempt_error` enum: add `address_not_allowed` | A delivery whose resolved address is refused by the `webhook` policy | FR-023, research D20 |
| Index `post_targets_attention_idx` on `post_targets (project_id, updated_at DESC, id) WHERE status IN ('ambiguous','failed')` | Partial index serving the failures list and the ambiguous count | FR-001, FR-005, D5, D7 |

The three enum additions use `ALTER TYPE … ADD VALUE`. The migration only adds the values and never uses them, so it is safe inside Drizzle's migration transaction. `pnpm db:check` must pass after `pnpm db:generate`.

Unchanged and relied on:

- `post_targets_occurrence_uq`: one holder per account occurrence (SC-003).
- `post_targets_live_has_schedule`: a `scheduled` target has `scheduled_at`, `next_attempt_at` and `schedule_kind`.
- `post_targets_published_has_id`: a `published` target has an `external_id` or a `resolved_at`.
- `publish_attempts` stays append-only. The DAL exposes insert and list only.

## 2. Post target state transitions added or changed

The existing statuses are `draft`, `scheduled`, `publishing`, `published`, `failed`, `ambiguous` and `cancelled`.

| From | Action (service) | Guard (re-read under post lock) | To | Attempts appended | Fields written |
|---|---|---|---|---|---|
| `ambiguous` | Mark published (`resolveAmbiguous` `published`) | status = ambiguous | `published` | `resolved_published` (actor) | `published_at = now`, `external_url = url or null`, `last_error = null`, `resolved_by_user_id`, `resolved_at` |
| `ambiguous` | Mark not published + requeue, slot found | status = ambiguous; `gate()` ok | `scheduled` (kind `slot`) | `resolved_not_published`, then `requeued` `{scheduledAt, slotId}` | occurrence held via `allocateNextFree`; `attempt_count = 0`; `last_error`, `step_state`, `in_flight_*`, `first_step_at`, `publish_started_at`, `external_id`, `external_url` = null; `resolved_by_user_id`, `resolved_at` |
| `ambiguous` | Mark not published + requeue, no free slot | status = ambiguous; `gate()` ok | `failed` | `resolved_not_published` (error `no_free_slot`) | `last_error = "Not published — no free posting slot. Retry or schedule it."`; `resolved_*` |
| `ambiguous` | Mark not published + requeue, `gate()` fails | — | **unchanged** (`ConflictError` with the gate message) | none | none |
| `ambiguous` | Mark not published, don't requeue | status = ambiguous | `failed` | `resolved_failed` (actor) | `last_error = "Marked not published by a team member. Retry or schedule it."`; `resolved_*` |
| `failed` | Retry (`retryTarget`, unchanged semantics) | status = failed; account present, `active`, provider registered (`retryBlockedReason`) | `scheduled` (kind unchanged, `next_attempt_at = now`) | `retry_requested` (actor) | as today |
| `publishing` (first step) | Tick: publish-time validation fails (new) | lease token | `failed` | `fatal_error` on step `engine-validate` | `last_error = "Can't publish to <platform>: <limit message>"` |
| `publishing` | Tick: engine failure **before** the provider call (changed) | lease token | `failed` (fatal causes) or `scheduled` with backoff (other causes) | `fatal_error` / `retryable_error` | never `ambiguous` (FR-012) |

Every row above runs `applyDerivedStatus` in the same transaction. Webhook `post.published` and `post.failed` events therefore fire exactly as they do for automatic outcomes (research F11).

**Concurrency.** All user transitions use `withLockedTarget`: post row lock, then the post's target locks, then a re-read. They also use a guarded `UPDATE … WHERE status = <expected>`. The loser of a race gets a `ConflictError`:

- "This post was already resolved." (resolutions);
- "This post is no longer failed." (retry);
- "Publishing in progress. Try again in a moment." (status became `publishing`).

Slot uniqueness comes from the unique index. The lock order is the existing order (post, then targets, then the occurrence index entry), so no new deadlock path appears.

## 3. Derived read models (no storage)

### `FailureRow` (services/failures.ts `listFailures`)

| Field | Source |
|---|---|
| `targetId`, `postId` | `post_targets` |
| `status` | `ambiguous` or `failed` |
| `account` | `{ id, name, providerKey, providerName, status, removed }`. A removed account shows as "Removed account". |
| `excerpt` | `excerptOf(override_text ?? base_text)`: 140 graphemes |
| `intendedAt`, `intendedLocal` | `scheduled_at`, formatted in the project's time zone (`plannedTime`) |
| `scheduleKind` | `slot`, `explicit` or `now` |
| `lastError` | `post_targets.last_error` (already plain language, never a secret) |
| `attemptCount` | `post_targets.attempt_count` |
| `enteredAt` | `post_targets.updated_at` (sort key) |
| `actions` | `{ canMarkPublished, canRequeue, canMarkNotPublished, canRetry, retryBlockedReason?: string }`. Computed from the scope's `post:schedule` right, the status, the account's state and the provider registry. |
| `attempts` | `AttemptEntryView[]` grouped into `AttemptRun[]` (below) |

The list is paged at 25 rows, ordered by `(status = 'ambiguous') DESC, updated_at DESC, id`. It returns `totals: { ambiguous, failed }` and the page metadata.

### `AttemptEntryView` / `AttemptRun`

`AttemptEntryView`: `{ id, at, step, outcome, request, response, error, actor: { kind: "member", name } | { kind: "system" } }`.

- `request` and `response` are the stored summaries, which were already redacted when written.
- `actor` is resolved from `actor_user_id` through one batched user-name lookup. "Former member" is shown when the user has been deleted.

`AttemptRun`: `{ step, outcome, error, count, entries: AttemptEntryView[] }`. Consecutive entries with an identical `step`, `outcome` and `error` form one run. `count` is always `entries.length`, so nothing is dropped (FR-003).

### `RequeuePreview` (services/failures.ts `previewRequeue`)

One of:

- `{ ok: true, scheduledAt, localTime, slotId }`, from `peekNextFree`;
- `{ ok: false, code: "no_active_slots" | "no_free_occurrence" | "account_unavailable" | "validation", message }`.

### `PostViewTarget` (existing, extended)

It gains three things:

- `attemptCount` (003 F9);
- the same `actions` object as `FailureRow`;
- `attempts` as `AttemptEntryView[]` with actor.

## 4. Validation rules

| Rule | Where | Detail |
|---|---|---|
| External URL | `externalUrlSchema` in `src/lib/validation/scheduling.ts`; used by `resolveAmbiguous` | trimmed; 1–2,000 chars; `new URL()` parses; protocol `http:` or `https:`; no username or password. Fragment, query and non-ASCII host are allowed. Otherwise the field error is "Enter an http or https address." |
| Rendering a stored external URL | `safeExternalHref()` in `src/lib/safe-redirect.ts` (beside the existing helper) | returns the href only for `http(s)`; otherwise the UI shows text |
| Resolve input | `resolveSchema`, a discriminated union on `outcome`: `published` (+url) or `not_published` (+`requeue: boolean`, `expected?: ISO`); `failed` is accepted as an alias of `not_published, requeue: false` | FR-007, FR-008 |
| Failures list query | `failuresQuerySchema`: `status ∈ {all, ambiguous, failed}` (default `all`), `account?: uuid`, `page: int 1–100000` (default 1) | FR-004. An unknown account id gives an empty list, never an error. |
| Webhook URL | `webhookUrlSchema` (existing) **plus**: refuse an IP literal outside the `webhook` policy; refuse `localhost` and `*.localhost`; the service then resolves the hostname and refuses refused addresses | FR-023, research D20 |
| Request body | `readBodyWithin(request, limit)`: refuse a declared length over `limit`; stop reading and refuse once the streamed total exceeds `limit` | FR-025 |

## 5. Configuration "entity": environment variables

Each variable belongs to exactly one group in `.env.example`:

- Core;
- Auth;
- Scheduler;
- Media storage;
- Generator (LLM);
- Meta;
- Threads;
- Public API and webhooks (no variables; constants named);
- Compose-only;
- Smoke script.

Each entry carries:

- a description;
- `Required.`, `Optional.` or `Group.` (all-or-none);
- a default, or "no default";
- a safe example.

`validateConfiguration` (research D25) is the single validator. For each group:

| Group state | Result |
|---|---|
| Required variable missing | issue → exit 1 before migrations |
| Any set variable malformed | issue → exit 1 |
| Optional group partly set (storage, LLM, Meta, Threads) | issue per missing member → exit 1 |
| Optional group wholly absent | starts; one `Docket: <feature> not configured (…)` line; the feature shows "not configured" in the UI |
| Empty value (`NAME=`) | treated as unset by every reader (`||`) |

The registry sets, which the coverage test reads (research D26 and D27), are:

- `ENV_VARIABLES` (env schema keys);
- `LLM_VARIABLES`;
- each connect group's `environment.variables`;
- `INTERNAL_VARIABLES` (each with a reason);
- `COMPOSE_ONLY_VARIABLES`.

## 6. Document entities

### Limits inventory row (`docs/limits.md`)

One Markdown table per provider, with the columns `Limit | Value | Counting / unit | Source | Status | Enforced in | Test`.

- `Limit`: one of `text`, `text-bytes`, `images-max`, `images-min`, `bytes-per-image`, `formats`, `width`, `height`, `aspect`, `alt-text`, `media-required`, `text-only`, `post-types`, `publish-limit`, `session-limit`.
- `Status`: `verified`, `approximate (U3)`, `interim, UNVERIFIED (005 R<n>)`, `adaptation`, or `NEEDS RESEARCH (U2/U4)`.
- `Test`: `path/to/file.test.ts › test title`.

The doc test parses these tables (research D13).

### Security finding (`docs/security.md`)

One table with the columns `# | Area | Checked | Finding | Severity (none, low, medium, high) | Fix or accepted reason | Test`. The areas are the FR-028 list:

- secrets in logs, responses, UI, attempt logs and errors;
- CSRF;
- tick secret;
- webhook secrets and destinations;
- headers;
- request size;
- outbound fetches;
- session cookie attributes;
- sign-in rate limits;
- existence leaks across projects;
- audit detail keys;
- engine ambiguity on pre-call failures.
