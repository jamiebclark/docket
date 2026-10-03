# Data Model: Scheduling Engine (002)

Phase 1 output for [plan.md](./plan.md). The schema is written by hand in
Drizzle under `src/server/db/schema/` (001 D9). The SQL migration is
generated with `pnpm db:generate` and committed (`drizzle/0001_*.sql`). All
times are `timestamptz` in UTC, and every new table except
`scheduler_heartbeats` carries `project_id uuid NOT NULL REFERENCES projects(id)
ON DELETE CASCADE`.

New schema files:

- `accounts.ts` (social_accounts, posting_slots)
- `media.ts` (media_assets)
- `posts.ts` (posts, post_media, post_targets)
- `attempts.ts` (publish_attempts)
- `scheduler.ts` (scheduler_heartbeats)

All are re-exported from `schema/index.ts`.

## Registry changes (`src/server/db/project-owned.ts`)

```ts
// projectOwnedTables += 
{ table: "social_accounts",  scopeColumn: "project_id" },
{ table: "posting_slots",    scopeColumn: "project_id" },
{ table: "media_assets",     scopeColumn: "project_id" },
{ table: "posts",            scopeColumn: "project_id" },
{ table: "post_media",       scopeColumn: "project_id" },
{ table: "post_targets",     scopeColumn: "project_id" },
{ table: "publish_attempts", scopeColumn: "project_id" },
// notProjectOwned +=
"scheduler_heartbeats",
```

`project-owned.test.ts` already fails if a schema table is in neither list.
Its `toBeGreaterThanOrEqual(11)` floor rises to 19.

## Enums

| Enum | Values |
|---|---|
| `social_account_status` | `active`, `needs_reauth` |
| `post_status` | `draft`, `needs_review`, `approved`, `scheduled`, `publishing`, `published`, `partially_failed`, `failed` |
| `post_review_state` | `draft`, `needs_review`, `approved` |
| `post_origin` | `manual`, `generated`, `api` |
| `post_target_status` | `draft`, `scheduled`, `publishing`, `published`, `failed`, `ambiguous`, `cancelled` |
| `schedule_kind` | `slot`, `explicit`, `now` |
| `publish_attempt_outcome` | provider results: `continue`, `done`, `retryable_error`, `fatal_error`, `ambiguous`. Engine events: `deferred`, `recovered_retry`, `recovered_ambiguous`, `stale_result`, `account_unavailable`, `did_not_complete`, `released`. User actions: `resolved_published`, `resolved_failed`, `retry_requested` |

Provider keys, post types and step names are `text`, not enums: adding a
provider must not change the schema (FR-012).

## social_accounts

A connection to one platform account in one project.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK `gen_random_uuid()` | |
| `project_id` | uuid NOT NULL FK projects cascade | scope |
| `provider_key` | text NOT NULL | registry key, e.g. `mock` |
| `display_name` | text NOT NULL | 1–100 chars (Zod) |
| `external_account_id` | text NOT NULL | platform id. The mock uses a random id |
| `credentials_encrypted` | text NULL | `enc:v1:…` with AAD `social_account:<id>` (research D16). NULL for the mock unless fake expiry is simulated |
| `credentials_expires_at` | timestamptz NULL | NULL = no known expiry |
| `status` | `social_account_status` NOT NULL default `active` | |
| `last_error` | text NULL | redacted, secret-free |
| `settings` | jsonb NOT NULL default `{}` | non-secret, provider-specific; validated by `provider.settingsSchema` (mock behaviour) |
| `publish_limit_count` | integer NULL, CHECK > 0 | account limit. Enforced **in addition to** the provider default, so the stricter one always wins (D8) |
| `publish_limit_window_seconds` | integer NULL, CHECK > 0 | |
| `refresh_lease_until` | timestamptz NULL | token-refresh claim (D7) |
| `refresh_lease_owner` | uuid NULL | |
| `last_refreshed_at` | timestamptz NULL | |
| `connected_by_user_id` | uuid NULL FK user set null | |
| `removed_at` | timestamptz NULL | soft delete (D12) |
| `created_at`, `updated_at` | timestamptz NOT NULL default now() | |

Constraints and indexes:

- CHECK `(publish_limit_count IS NULL) = (publish_limit_window_seconds IS NULL)`
- CHECK `(refresh_lease_until IS NULL) = (refresh_lease_owner IS NULL)`
- UNIQUE INDEX `social_accounts_external_uq` ON `(project_id, provider_key, external_account_id) WHERE removed_at IS NULL`. Reconnecting the same platform account updates it in place.
- INDEX `social_accounts_project_idx` ON `(project_id) WHERE removed_at IS NULL`
- INDEX `social_accounts_expiry_idx` ON `(credentials_expires_at) WHERE removed_at IS NULL AND status = 'active' AND credentials_expires_at IS NOT NULL` (refresh section)

**State transitions**:

```text
(connect) → active
active --refresh fails--> needs_reauth
needs_reauth --reconnect (saveConnectedAccount, same external id)--> active
active|needs_reauth --remove--> removed (removed_at set, credentials NULL, unpublished targets cancelled)
```

## posting_slots

A weekly weekday + local time for one account.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid NOT NULL FK | scope |
| `social_account_id` | uuid NOT NULL FK social_accounts cascade | |
| `weekday` | smallint NOT NULL CHECK 1–7 | ISO: 1 = Monday (Temporal `dayOfWeek`, research F2) |
| `local_time` | time(0) NOT NULL | wall time in the **project's** time zone, minute precision (Zod `HH:MM`) |
| `paused` | boolean NOT NULL default false | |
| `created_at`, `updated_at` | timestamptz | |

- UNIQUE `(social_account_id, weekday, local_time)` (edge case "duplicate slots")
- INDEX `(project_id, social_account_id)`

Pausing or deleting a slot never touches targets (edge case): `post_targets.slot_id` is `ON DELETE SET NULL`.

## media_assets

A file registered in a project. Upload and storage arrive in entry 3.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid NOT NULL FK | scope |
| `storage_key` | text NOT NULL | |
| `public_url` | text NOT NULL | absolute https URL (Zod) |
| `mime_type` | text NOT NULL | |
| `width`, `height` | integer NULL CHECK > 0 | |
| `byte_size` | integer NOT NULL CHECK > 0 | |
| `alt_text` | text NOT NULL default `''` | travels with each image to the provider |
| `first_used_at` | timestamptz NULL | set when first attached to any post (used-in-post tracking) |
| `created_by_user_id` | uuid NULL FK user set null | |
| `created_at`, `updated_at` | timestamptz | |

- UNIQUE `(project_id, storage_key)`
- INDEX `(project_id, first_used_at)` (the "unused" filter in later entries)

## posts

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid NOT NULL FK | scope |
| `status` | `post_status` NOT NULL default `draft` | **derived** (D11). Written only by `applyDerivedStatus` |
| `review_state` | `post_review_state` NOT NULL default `draft` | editorial state |
| `base_text` | text NOT NULL default `''` | base content |
| `origin` | `post_origin` NOT NULL default `manual` | |
| `generation_metadata` | jsonb NULL | free-form (prompt, model, voice version; generator entry) |
| `created_by_user_id` | uuid NULL FK user set null | |
| `deleted_at` | timestamptz NULL | soft delete (D12) |
| `created_at`, `updated_at` | timestamptz | |

- INDEX `posts_project_status_idx` ON `(project_id, status) WHERE deleted_at IS NULL`

## post_media

The ordered media of a post.

| Column | Type | Notes |
|---|---|---|
| `project_id` | uuid NOT NULL FK | scope |
| `post_id` | uuid NOT NULL FK posts cascade | |
| `media_asset_id` | uuid NOT NULL FK media_assets **restrict** | an attached asset can't be hard-deleted |
| `position` | smallint NOT NULL CHECK ≥ 0 | 0-based order |

- PRIMARY KEY `(post_id, position)`
- UNIQUE `(post_id, media_asset_id)`

Replacing a post's media rewrites its rows in one transaction (delete, then insert).

## post_targets

One post going to one account; the unit the scheduler works on.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid NOT NULL FK | scope |
| `post_id` | uuid NOT NULL FK posts cascade | |
| `social_account_id` | uuid NOT NULL FK social_accounts **restrict** | accounts are soft-deleted |
| `status` | `post_target_status` NOT NULL default `draft` | |
| `schedule_kind` | `schedule_kind` NULL | NULL while `draft` |
| `scheduled_at` | timestamptz NULL | the instant it is meant to go out |
| `slot_id` | uuid NULL FK posting_slots set null | which slot produced the occurrence (display only) |
| `slot_occurrence_at` | timestamptz NULL | **the held occurrence** (D3). NULL = holds none |
| `override_text` | text NULL | per-platform override of `base_text` |
| `step_state` | jsonb NULL | provider step-machine state between steps |
| `in_flight_step` | text NULL | step leased right now (D5) |
| `in_flight_may_publish` | boolean NULL | from `provider.stepFor(state).mayPublish` |
| `first_step_at` | timestamptz NULL | for the multi-step maximum (FR-041) |
| `publish_started_at` | timestamptz NULL | counted by publish limits (D8) |
| `attempt_count` | integer NOT NULL default 0 | failed attempts at the current step (D9) |
| `next_attempt_at` | timestamptz NULL | when it is next eligible to be claimed |
| `lease_until` | timestamptz NULL | |
| `lease_owner` | uuid NULL | per-claim token (D4) |
| `last_error` | text NULL | redacted |
| `external_id` | text NULL | platform post id |
| `external_url` | text NULL | |
| `published_at` | timestamptz NULL | |
| `resolved_by_user_id` | uuid NULL FK user set null | ambiguous resolution |
| `resolved_at` | timestamptz NULL | |
| `created_at`, `updated_at` | timestamptz | |

Constraints and indexes:

- UNIQUE `(post_id, social_account_id)` (FR-004)
- **UNIQUE INDEX `post_targets_occurrence_uq` ON `(social_account_id, slot_occurrence_at) WHERE slot_occurrence_at IS NOT NULL`** (FR-018)
- CHECK `slot_occurrence_at IS NULL OR schedule_kind = 'slot'`
- CHECK `(lease_until IS NULL) = (lease_owner IS NULL)`
- CHECK `status NOT IN ('scheduled','publishing') OR (next_attempt_at IS NOT NULL AND scheduled_at IS NOT NULL AND schedule_kind IS NOT NULL)`
- CHECK `status <> 'published' OR external_id IS NOT NULL OR resolved_at IS NOT NULL` (marking an ambiguous target as published, with no id, is allowed)
- INDEX `post_targets_due_idx` ON `(next_attempt_at) WHERE status IN ('scheduled','publishing')` (claim)
- INDEX `post_targets_started_idx` ON `(social_account_id, publish_started_at) WHERE publish_started_at IS NOT NULL` (limit counting)
- INDEX `post_targets_account_sched_idx` ON `(social_account_id, scheduled_at) WHERE status = 'scheduled'` (proximity warnings, pull-forward)
- INDEX `(project_id, post_id)`

**Effective content** for validation and publishing: `text = override_text ?? posts.base_text`, and media = the post's `post_media` in `position` order joined to `media_assets` (url, mime, width, height, bytes, alt).

### Target state machine

```text
                 queue / schedule / now
   draft ───────────────────────────────▶ scheduled ◀──────────── retry ── failed
     ▲ │                                    │  │ ▲                            ▲
     │ │cancel                    move/swap/│  │ │ retryable (no step done)   │
     │ ▼                          pull fwd  │  │ │                            │
 cancelled ◀───────cancel──────────────────┘  │ │                            │
     ▲                                     claim│ │                            │
     │ cancel (unleased, between steps)        ▼ │                            │
     └──────────────────────────────────── publishing ──fatal / cap / max-duration /
                                             │  │ ▲      account unavailable ─┘
                                        done │  │ │ continue (persist state, release lease)
                                             ▼  │ │
                                       published│ └ retryable after a step done (stays publishing)
                                             ▲  │
                         resolve: published  │  ▼ ambiguous result / unsafe recovery / throw on mayPublish step
                                             └─ ambiguous ──resolve: failed──▶ failed
```

Rules:

- **Queueable**: `draft` or `cancelled` targets, on a post whose `review_state` is `draft` or `approved` (not `needs_review`), on an `active` account whose provider is registered. Error-level validation issues block it.
- **Re-schedulable** (move, swap, pull forward, explicit reschedule): `scheduled` targets only.
- **Cancellable**: `draft`, `scheduled`, or `publishing` **with no live lease** (`lease_until IS NULL OR lease_until < $now`). A leased target → `ConflictError("Publishing in progress")`. `published`, `failed` and `ambiguous` targets can't be cancelled.
- **Cancel / delete / move** clear `slot_occurrence_at` (frees the occurrence) and, for cancel, `next_attempt_at`, `step_state`, `in_flight_*`.
- **Retry**: `failed` only. Resets the fields in D9. Refused if the account is `needs_reauth`, removed, or its provider is unregistered.
- **Resolve**: `ambiguous` only. `published` (optional `external_url`, `resolved_*` set) or `failed` (`last_error` = "Marked failed by <user>"). Each writes a `resolved_*` attempt row.
- **No automatic path leaves `ambiguous`**: the claim predicate excludes it (FR-034, SC-006).

### Post status derivation (FR-029), `derivePostStatus(reviewState, statuses)`

1. `live = statuses − {draft, cancelled}`
2. `live` empty → `reviewState`. (When a cancel empties `live`, the cancel service first sets `review_state = 'draft'`.)
3. any `publishing` → `publishing`
4. else any `scheduled` → `scheduled`
5. else all `published` → `published`
6. else none `published` → `failed` (`ambiguous` counts as not published)
7. else → `partially_failed`

It runs in every transaction that changes a target's status, after locking the
`posts` row (`SELECT … FOR UPDATE` as its own statement) and re-reading the
post's targets.

## publish_attempts (append-only)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid NOT NULL FK | scope |
| `post_target_id` | uuid NOT NULL FK post_targets cascade | the cascade only fires on project deletion (targets are never hard-deleted once they have attempts, D12) |
| `step` | text NOT NULL | provider step name, or `engine` / `user` |
| `outcome` | `publish_attempt_outcome` NOT NULL | |
| `request_summary` | jsonb NOT NULL default `{}` | redacted (D16). Includes `lateBySeconds` on a first step |
| `response_summary` | jsonb NOT NULL default `{}` | redacted |
| `error` | text NULL | redacted |
| `duration_ms` | integer NULL | provider call time |
| `tick_id` | uuid NULL | correlates the rows of one tick |
| `actor_user_id` | uuid NULL FK user set null | user actions only |
| `created_at` | timestamptz NOT NULL | the clock's `now` |

- INDEX `(project_id, post_target_id, created_at)`
- The DAL exposes **insert and list only** (FR-006), like `membership_audit_log`.

## scheduler_heartbeats (system-wide, **not** project-owned)

| Column | Type | Notes |
|---|---|---|
| `section` | text PK | `publishing`, `token_refresh` (later `generation`) |
| `last_success_at` | timestamptz NOT NULL | |
| `last_summary` | jsonb NOT NULL default `{}` | counts only |
| `updated_at` | timestamptz NOT NULL | |

It is written by `INSERT … ON CONFLICT (section) DO UPDATE` only when a section completes (FR-039).

## Validation rules (Zod, shared in `src/lib/validation/scheduling.ts`)

| Field | Rule |
|---|---|
| account `displayName` | trimmed, 1–100 chars |
| `weekday` | integer 1–7 |
| `localTime` | `^([01]\d|2[0-3]):[0-5]\d$` |
| publish limit | `count` integer 1–100000, `windowSeconds` integer 60–2592000 (30 days). Both or neither. `null` clears it |
| `baseText` / `overrideText` | string ≤ 100,000 chars. Platform limits are enforced by provider validation, not here |
| `mediaIds` | ≤ 20 distinct uuids of the same project's assets |
| `targets` | 1–20 distinct account ids of active, non-removed accounts in the project |
| explicit `at` | ISO-8601 instant with offset or `Z`, strictly after `$now` (else `in_past`: "That time has passed. Use Publish now instead.") |
| media `publicUrl` | absolute `https://` URL (`http://` allowed when `NODE_ENV !== "production"`) |
| `generationMetadata` | JSON object ≤ 64 KB serialised |
