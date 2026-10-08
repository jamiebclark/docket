# Data model: Activity history

**Feature**: `020-activity-history` | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

## 1. New table `activity_events` (migration `0012`, generated)

Defined in `src/server/db/schema/activity.ts` and exported from `schema/index.ts`. It is registered in `projectOwnedTables` as `{ table: "activity_events", scopeColumn: "project_id" }`.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` PK, `gen_random_uuid()` | no | Public id (API, notifications entry). |
| `seq` | `bigint GENERATED ALWAYS AS IDENTITY` | no | Tie-breaker in insertion order (P5). Unique. Never exposed except inside the opaque cursor. |
| `project_id` | `uuid` → `projects.id` `ON DELETE CASCADE` | no | Scope column. |
| `occurred_at` | `timestamptz` | no | The transaction's `clock.now()`, or the backfill time. Whole milliseconds only. |
| `kind` | enum `activity_event_kind` | no | See §2. |
| `outcome` | enum `activity_outcome` | no | Fixed by `kind` (CHECK). |
| `post_id` | `uuid` | yes | **No FK** (P4). Set with `post_target_id`. |
| `post_target_id` | `uuid` | yes | **No FK** (P4). |
| `social_account_id` | `uuid` | yes | **No FK** (P4, F11). Required for target and needs-reauth kinds. |
| `provider_key` | `text` | yes | The one platform. Null only for a group-level connect failure. |
| `provider_keys` | `text[]` | no | Every platform the event concerns. Used by the platform filter (P7). |
| `group_key` | `text` | yes | The connect group, for OAuth and paste connect failures. |
| `actor_user_id` | `uuid` → `user.id` `ON DELETE SET NULL` | yes | As `publish_attempts` records it (F8). |
| `actor_api_key_id` | `uuid` | yes | Composite FK `(project_id, actor_api_key_id)` → `api_keys(project_id, id)`. |
| `message` | `text` | no | User-facing, scrubbed, 1–500 code points (P9). |
| `details` | `jsonb` default `'{}'` | no | Strict per-kind shape (§3). At most 2,000 bytes. |
| `created_at` | `timestamptz` default `now()` | no | Insert time (diagnostics only; ordering uses `occurred_at`). |

**Constraints**

- `activity_events_seq_uq` UNIQUE (`seq`).
- `activity_events_api_key_fk` FOREIGN KEY (`project_id`, `actor_api_key_id`) → `api_keys` (`project_id`, `id`).
- `activity_events_kind_outcome` CHECK. The kind ↔ outcome pairs are those in §2.
- `activity_events_message_len` CHECK `char_length(message) BETWEEN 1 AND 500`.
- `activity_events_details_size` CHECK `octet_length(details::text) <= 2000`.
- `activity_events_ms` CHECK `occurred_at = date_trunc('milliseconds', occurred_at)`.
- `activity_events_target_pair` CHECK `(post_id IS NULL) = (post_target_id IS NULL)`.
- `activity_events_target_kinds` CHECK. Target kinds (`target_*`) have `post_target_id`, `social_account_id` and `provider_key` NOT NULL. Account kinds have `post_target_id` NULL.
- `activity_events_needs_reauth_account` CHECK `kind <> 'account_needs_reauth' OR social_account_id IS NOT NULL`.
- `activity_events_provider_keys` CHECK. `cardinality(provider_keys) >= 1`, and `provider_key IS NULL OR provider_keys = ARRAY[provider_key]`.
- `activity_events_group_key_format` CHECK `group_key IS NULL OR group_key ~ '^[a-z0-9-]+$'`.

**Indexes** (P6)

- `activity_events_project_time_idx` on (`project_id`, `occurred_at` DESC, `seq` DESC).
- `activity_events_project_outcome_time_idx` on (`project_id`, `outcome`, `occurred_at` DESC, `seq` DESC).
- `activity_events_project_account_time_idx` on (`project_id`, `social_account_id`, `occurred_at` DESC, `seq` DESC) WHERE `social_account_id IS NOT NULL`.
- `activity_events_project_target_idx` on (`project_id`, `post_target_id`) WHERE `post_target_id IS NOT NULL`.

**Size.** A typical row is about 250–400 bytes plus about 150 bytes per index entry across the four indexes. Expect roughly 0.5 KB per event: 100,000 events ≈ 50 MB. This goes in `docs/activity.md` under retention.

## 2. Enums

`activity_event_kind` → `activity_outcome` (one-to-one today; `kind` leaves room for finer kinds later):

| `kind` | `outcome` | Badge label | Tone | Counts as |
|---|---|---|---|---|
| `target_published` | `published` | Published | success | success |
| `target_failed` | `failed` | Failed | danger | problem |
| `target_ambiguous` | `ambiguous` | Needs your decision | warning | problem |
| `target_retry_scheduled` | `retrying` | Retrying | info | — |
| `target_resolved` | `resolved` | Resolved | neutral | — |
| `account_needs_reauth` | `needs_reauth` | Needs reconnecting | danger | problem |
| `account_connect_failed` | `connect_failed` | Connect failed | danger | problem |

Presets: `successes` = {`published`}; `problems` = {`failed`, `ambiguous`, `needs_reauth`, `connect_failed`}.

These live in a pure module, `src/lib/activity/outcomes.ts`: `ACTIVITY_OUTCOMES`, `KIND_OUTCOME`, `OUTCOME_LABEL`, `OUTCOME_TONE`, `PRESETS`, `SUCCESS_OUTCOMES` and `PROBLEM_OUTCOMES`. The CHECK constraint, the badges, the filters, the counts and the API enum all import or mirror this one table. A unit test compares the CHECK's pairs with `KIND_OUTCOME`.

## 3. `details` shapes (strict Zod union by `kind`, `src/lib/activity/details.ts`)

| `kind` | Shape | Notes |
|---|---|---|
| `target_published` | `{ url?: string \| null, backfilled?: true }` | `url` = `externalUrl` when known (FR-006). |
| `target_failed` | `{ attempt?: int ≥ 1, gaveUp?: true, engine?: EngineReason, backfilled?: true }` | `EngineReason` = `account_unavailable` \| `did_not_complete` \| `invalid_settings` \| `post_gone` \| `interrupted`. |
| `target_ambiguous` | `{ engine?: "recovered_ambiguous", backfilled?: true }` | |
| `target_retry_scheduled` | `{ attempt: int ≥ 1, nextAttemptAt: ISO datetime, interrupted?: true }` | FR-006. |
| `target_resolved` | `{ action: ResolveAction, url?: string \| null, scheduledAt?: ISO, mode?: "now" \| "requeue", requeue?: "no_free_slot" }` | `ResolveAction` = `marked_published` \| `marked_not_published` \| `requeued` \| `retry_now` \| `retry_requeue` \| `retry_at` \| `bulk_retry`. |
| `account_needs_reauth` | `{ reason: "renewal_refused" \| "credentials_invalid", backfilled?: true }` | |
| `account_connect_failed` | `{ via: "oauth" \| "paste" \| "credentials", code: ConnectFailCode }` | `ConnectFailCode` is `platform_error`, `exchange_failed`, `no_candidates` or `too_many` for OAuth. For paste it is `paste_refused`, `paste_unreachable`, `paste_none` or `paste_too_many`. For credentials it is `credentials_refused`, `credentials_unreachable` or `different_account`. |

Validation rules:

- URLs are capped at 2,000 characters.
- Every object is `z.strictObject`, so no free-form keys are accepted.
- `insert` parses `details` with this union and throws on a mismatch, which is a programming error. Any value fails the secret-scan test if it contains a credential.
- Tokens, credentials, request or response bodies and raw platform payloads have no field to go in (FR-007).

## 4. Read model (not stored)

`ActivityRow`, returned by the service for both screens and mapped for the API:

| Field | Source |
|---|---|
| `id`, `kind`, `outcome`, `occurredAt`, `message`, `details` | event |
| `project` `{ id, slug, name, timeZone }` | `projects`, joined in the branch (P11) |
| `platform` `{ key, name } \| null`, `platforms[]` | `provider_key(s)`, names from the provider registry (unregistered → the key) |
| `account` `{ id, name, removed } \| null` | `social_accounts` left join on (`project_id`, `id`). Missing or removed → "Removed account" (D9). |
| `post` `{ id, excerpt, deleted } \| null` | `posts` and `post_targets` left join. `excerptOf(override_text ?? base_text)` (P8). |
| `target` `{ id, currentStatus } \| null` | `post_targets` left join |
| `actor` `{ kind: "scheduler" } \| { kind: "member", name } \| { kind: "api_key", name \| null }` | Same lookup as `toAttemptViews`: the key wins when set; a user who is not a current member is "Former member"; a key that is gone is "Removed API key" (F8). |
| `link` `{ href, label } \| null` | Built by `activityLink(row)` (P15). |

`ActivitySummary` = `{ successes: number, problems: number, label: string }`.

`ActivityFilter` (parsed; §5 of [contracts/services.md](./contracts/services.md)) = `{ outcomes: Set<Outcome> | null, preset: "successes" | "problems" | null, platform: string | null, accountId: string | null, from: PlainDate | null, to: PlainDate | null, range: "today" | "7d" | "30d" | null, projectSlugs: string[] | null, invalidRange: boolean }`.

## 5. Writes by path (state transitions that produce an event)

Each write happens in the transaction listed. "—" means no event (D1).

| Path | Transaction | From → to | Event |
|---|---|---|---|
| `recordStepResult`, applied | record tx | scheduled/publishing → published | `target_published` |
| | | → failed (fatal, including G7/G15/media/credentials/settings/post gone) | `target_failed` |
| | | → failed (retryable, last attempt) | `target_failed` `gaveUp` |
| | | → scheduled/publishing (retryable) | `target_retry_scheduled` |
| | | → ambiguous | `target_ambiguous` |
| | | `continue` | — |
| `recordStepResult`, stale | record tx | (unchanged) | — |
| `claimDueTargets` decision | claim tx | → failed (engine settle or interrupted too often) | `target_failed` `engine` |
| | | → ambiguous (recovered may-publish) | `target_ambiguous` |
| | | publishing → publishing / deferred after `recovered_retry` | `target_retry_scheduled` `interrupted` |
| | | deferral only, or lease only | — |
| `release()` | release tx | restored | — |
| `retryLockedTarget` | `withLockedTarget` tx | failed → scheduled | `target_resolved` (`retry_now` \| `retry_requeue` \| `retry_at` \| `bulk_retry`) |
| | | requeue, no free slot (stays failed) | — |
| `resolveAmbiguous` | `withLockedTarget` tx | ambiguous → published | `target_resolved` `marked_published` |
| | | ambiguous → failed | `target_resolved` `marked_not_published` (± `requeue: "no_free_slot"`) |
| | | ambiguous → scheduled | `target_resolved` `requeued` |
| | | lost race (`ConflictError`) | — (rolled back) |
| `recordRefreshEmitting` / `markInvalidEmitting` | their tx | account active → needs_reauth | `account_needs_reauth` |
| `handleOAuthCallback` | tx with `connectAttempts.complete` | (none) | `account_connect_failed` for `platform_error`, `exchange_failed`, `no_candidates` and `too_many` |
| `pasteConnectToken` | own insert | (none) | `account_connect_failed` for the four refusals |
| `connectWithCredentials` | own insert | (none) | `account_connect_failed` for refused, unreachable and different account |

## 6. Backfill (migration `0013`, custom SQL)

The candidate sets, their times and their actors are given in research P14. It is idempotent through `NOT EXISTS`:

- for targets, on (`project_id`, `post_target_id`);
- for accounts, on (`project_id`, `social_account_id`, `kind = 'account_needs_reauth'`).

All times go through `date_trunc('milliseconds', …)`. Messages are clipped with `left(…, 499) || '…'` when `char_length > 500`.

## 7. Registry and harness changes (not tables)

- `projectOwnedTables` gains `activity_events`.
- `ObservedQuery` gains `projectSet?: { reason: string; projectIds: readonly string[] }`.
- `QueryRecord` gains the same field. `checkScope` enforces that every scope-column pin parameter of such a record is in `projectIds` (research P11).
