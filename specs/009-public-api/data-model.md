# Data model: Public API, keys, idempotency and webhooks (009)

One migration, `drizzle/0006_*.sql`, generated with `pnpm db:generate` from the hand-written Drizzle schema (decision 001 #9) and committed.

- Every new table carries `project_id` and is added to `src/server/db/project-owned.ts` (constitution III).
- All times are `timestamptz` in UTC. The clock is the DB clock (`clock.now()`).
- New schema files: `src/server/db/schema/api.ts` and `schema/webhooks.ts`, both exported from `schema/index.ts`.
- Changed files: `schema/posts.ts`, `schema/jobs.ts`, `schema/media.ts` and `schema/audit.ts`.
- Composite FKs `(project_id, x_id)` pin every cross-table reference to one project, as in 008.

## Enums

| Enum | Values | Note |
|---|---|---|
| `api_key_permission` (new) | `read \| write_posts \| generate \| auto_approve \| manage_jobs` | |
| `api_idempotency_state` (new) | `in_progress \| completed` | |
| `webhook_event_type` (new) | `post.published \| post.failed \| job.finished \| account.needs_reauth \| ping` | |
| `webhook_delivery_status` (new) | `pending \| delivering \| succeeded \| failed` | |
| `webhook_attempt_error` (new) | `timeout \| connect \| dns \| tls \| redirect \| http_status \| endpoint_disabled \| internal` | `http_status` means a non-2xx response; `redirect` means any 3xx (redirects are not followed). |
| `membership_action` (changed) | adds `api_key_create`, `api_key_revoke`, `webhook_create`, `webhook_update`, `webhook_delete`, `webhook_rotate_secret`, `webhook_enable`, `webhook_disable` | `ALTER TYPE … ADD VALUE`. The values are not used inside the migration itself. The members activity list gains labels for them. |

## api_keys

| Column | Type | Rules |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `project_id` | uuid NOT NULL | FK `projects.id` ON DELETE CASCADE |
| `name` | text NOT NULL | 1–64 characters, trimmed (CHECK on length) |
| `key_hash` | text NOT NULL | SHA-256 hex of the full key. UNIQUE (global: the lookup happens before the project is known). |
| `last4` | text NOT NULL | the last 4 characters of the key. CHECK `char_length = 4` |
| `permissions` | api_key_permission[] NOT NULL | CHECK `cardinality >= 1`. Distinctness is enforced by Zod. |
| `rate_limit_per_minute` | integer NOT NULL default 60 | CHECK `BETWEEN 1 AND 1000` |
| `expires_at` | timestamptz NULL | null = never |
| `created_by_user_id` | uuid NULL | FK `user.id` ON DELETE SET NULL |
| `created_at` | timestamptz NOT NULL | default now |
| `last_used_at` | timestamptz NULL | changes at most once a minute (research D4) |
| `revoked_at` | timestamptz NULL | set once, never cleared |
| `revoked_by_user_id` | uuid NULL | FK `user.id` ON DELETE SET NULL |
| `rate_window_start` | timestamptz NULL | the minute the counter belongs to |
| `rate_window_count` | integer NOT NULL default 0 | |

Constraints and indexes:

- `UNIQUE (project_id, id)`, the target of the attribution FKs.
- `UNIQUE (key_hash)`.
- CHECK `revoked_by_user_id IS NULL OR revoked_at IS NOT NULL`. A revoker implies a revoked time, while the revoker may later become null if their user is deleted.
- INDEX `(project_id, created_at DESC)` for the list.

The plaintext key and its `dkt_` prefix are never stored. The prefix is a constant, and the display form is `dkt_…<last4>`.

**States** (derived, not stored):

| State | Condition |
|---|---|
| `revoked` | `revoked_at` is set |
| `expired` | not revoked, and `expires_at ≤ now` |
| `active` | otherwise |

Only `active` keys authenticate, and only `active` keys count towards the cap of 25.

```text
active ──revoke──▶ revoked (final)
active ──time passes expires_at──▶ expired (final; revoking is still allowed and recorded)
```

## api_idempotency_keys

| Column | Type | Rules |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid NOT NULL | FK `projects.id` ON DELETE CASCADE |
| `api_key_id` | uuid NOT NULL | composite FK `(project_id, api_key_id)` → `api_keys(project_id, id)` ON DELETE CASCADE |
| `method` | text NOT NULL | `POST \| PATCH \| DELETE` (CHECK) |
| `route` | text NOT NULL | the concrete path without the query, for example `/posts/7d1…/queue`. At most 512 characters. |
| `idem_key` | text NOT NULL | 1–255 printable ASCII characters (CHECK `idem_key ~ '^[\x21-\x7E]{1,255}$'`) |
| `body_hash` | text NOT NULL | SHA-256 hex of the canonical body (research D9) |
| `state` | api_idempotency_state NOT NULL | |
| `lock_token` | uuid NULL | set while `in_progress` |
| `hold_until` | timestamptz NULL | set while `in_progress` |
| `response_status` | smallint NULL | set when `completed`. CHECK `< 500` |
| `response_body` | jsonb NULL | set when `completed` |
| `created_at` | timestamptz NOT NULL | |
| `completed_at` | timestamptz NULL | |
| `expires_at` | timestamptz NOT NULL | `created_at + 7 days` (reset on takeover) |

Constraints and indexes:

- **`UNIQUE (api_key_id, method, route, idem_key)`**, the database guarantee for FR-016.
- CHECK `(state = 'in_progress') = (lock_token IS NOT NULL AND hold_until IS NOT NULL)`.
- CHECK `(state = 'completed') = (response_status IS NOT NULL AND completed_at IS NOT NULL)`.
- INDEX `(expires_at)` for housekeeping.

**State transitions** (research D8):

```text
(absent | expired) ──claim──▶ in_progress(token T)
in_progress(T) ──effect+completion commit──▶ completed (replayable until expires_at)
in_progress(T) ──5xx──▶ (row deleted WHERE lock_token = T)
in_progress(T) ──hold expires──▶ claimable again ──takeover──▶ in_progress(T′)
completed ──expires_at passes──▶ claimable as new (housekeeping deletes it later)
```

## webhook_endpoints

| Column | Type | Rules |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid NOT NULL | FK `projects.id` ON DELETE CASCADE |
| `url` | text NOT NULL | `http(s)` URL, at most 2,000 characters, with no userinfo (Zod) |
| `description` | text NOT NULL default `''` | at most 200 characters |
| `events` | webhook_event_type[] NOT NULL | CHECK `cardinality >= 1`. `ping` is not selectable (Zod). |
| `enabled` | boolean NOT NULL default true | |
| `disabled_reason` | text NULL | `gone \| failing \| manual`. CHECK `enabled OR disabled_reason IS NOT NULL` |
| `secret_encrypted` | text NOT NULL | `enc:v1:…`, with AAD `webhook_endpoint:<id>` |
| `previous_secret_encrypted` | text NULL | the overlap secret |
| `previous_secret_expires_at` | timestamptz NULL | CHECK `(previous_secret_encrypted IS NULL) = (previous_secret_expires_at IS NULL)` |
| `consecutive_failures` | integer NOT NULL default 0 | counts failed **deliveries** (research D16). Reset on success and on re-enable. |
| `created_by_user_id` | uuid NULL | FK `user.id` ON DELETE SET NULL |
| `created_at`, `updated_at` | timestamptz NOT NULL | |

Constraints and indexes:

- `UNIQUE (project_id, id)`.
- INDEX `(project_id) WHERE enabled`, used by `hasSubscribers` and fan-out.
- The cap of 10 endpoints per project is checked under the project lock at creation.

## webhook_events

| Column | Type | Rules |
|---|---|---|
| `id` | uuid PK | the event id sent to receivers, stable across retries and resends |
| `project_id` | uuid NOT NULL | FK `projects.id` ON DELETE CASCADE |
| `type` | webhook_event_type NOT NULL | |
| `subject_id` | uuid NOT NULL | the post, job or account id (for display and filtering) |
| `body` | jsonb NOT NULL | the full event JSON (FR-036), built in the changing transaction |
| `created_at` | timestamptz NOT NULL | |

Constraints and indexes: `UNIQUE (project_id, id)`; INDEX `(project_id, created_at DESC)`.

The raw bytes sent are `JSON.stringify(body)`. Postgres `jsonb` does not keep key order, so the serialisation is produced once per attempt from `body`, and the signature covers exactly the bytes sent. Receivers verify the raw bytes they received, never a re-serialisation.

## webhook_deliveries

| Column | Type | Rules |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid NOT NULL | |
| `event_id` | uuid NOT NULL | composite FK → `webhook_events(project_id, id)` ON DELETE CASCADE |
| `endpoint_id` | uuid NOT NULL | composite FK → `webhook_endpoints(project_id, id)` ON DELETE CASCADE |
| `status` | webhook_delivery_status NOT NULL default `pending` | |
| `attempt_count` | integer NOT NULL default 0 | CHECK `BETWEEN 0 AND 8` |
| `next_attempt_at` | timestamptz NOT NULL | default now |
| `lease_owner` | uuid NULL | |
| `lease_until` | timestamptz NULL | CHECK `(lease_owner IS NULL) = (lease_until IS NULL)`; CHECK `(status = 'delivering') = (lease_owner IS NOT NULL)` |
| `last_status_code` | smallint NULL | |
| `last_error_kind` | webhook_attempt_error NULL | |
| `resend_of` | uuid NULL | the delivery this one re-sends (UI "Resend") |
| `created_at`, `finished_at` | timestamptz | `finished_at` is set at `succeeded` or `failed` |

Constraints and indexes:

- `UNIQUE (project_id, id)`.
- INDEX `(next_attempt_at) WHERE status = 'pending'`, for the claim.
- INDEX `(lease_until) WHERE status = 'delivering'`, for recovery.
- INDEX `(project_id, endpoint_id, created_at DESC)`, for the log.

**Transitions** (research D16):

```text
pending ──claim──▶ delivering ──2xx──▶ succeeded
delivering ──fail, attempts < 8──▶ pending (next_attempt_at = now + backoff)
delivering ──fail, attempts = 8──▶ failed (endpoint.consecutive_failures += 1; at 20 → endpoint disabled 'failing')
delivering ──410──▶ failed (endpoint disabled 'gone')
delivering ──lease expired──▶ pending (attempt counted as `internal`)
pending ──endpoint disabled or deleted──▶ failed with `endpoint_disabled` (disable) / row deleted (delete cascade)
```

## webhook_delivery_attempts

| Column | Type | Rules |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid NOT NULL | |
| `delivery_id` | uuid NOT NULL | composite FK → `webhook_deliveries(project_id, id)` ON DELETE CASCADE |
| `attempt` | smallint NOT NULL | 1–8 |
| `at` | timestamptz NOT NULL | |
| `status_code` | smallint NULL | |
| `error_kind` | webhook_attempt_error NULL | CHECK `status_code IS NOT NULL OR error_kind IS NOT NULL` |
| `duration_ms` | integer NOT NULL | |
| `response_excerpt` | text NULL | the first 1,000 characters, passed through `redact()` |

INDEX `(project_id, delivery_id, attempt)`. The table is append-only: the DAL exposes insert and list. Rows older than 30 days are deleted by housekeeping.

## Changes to existing tables

| Table | Change | Why |
|---|---|---|
| `posts` | + `created_by_api_key_id uuid NULL`, composite FK `(project_id, created_by_api_key_id)` → `api_keys(project_id, id)` | attribution (research D3). Keys are never deleted, so the FK has no ON DELETE action. Project deletion cascades both tables. |
| `generation_jobs` | + `created_by_api_key_id`, `cancelled_by_api_key_id` (same FK form); + `open boolean NOT NULL default false`; + `closed_at timestamptz NULL`; CHECK `item_count BETWEEN 1 AND 500` → `BETWEEN 0 AND 500` plus CHECK `open OR item_count >= 1 OR status = 'cancelled'` | open jobs (research D18) |
| `media_assets` | + `created_by_api_key_id` (same FK form) | attribution |
| `membership_audit_log` | enum values only | FR-008, FR-033 |

`posts.origin` already has `api`, and nothing changes there.

## Project-owned registry

`src/server/db/project-owned.ts` adds `api_keys`, `api_idempotency_keys`, `webhook_endpoints`, `webhook_events`, `webhook_deliveries` and `webhook_delivery_attempts`, each with `project_id`. The scope check (`tests/helpers/scope-check.ts`) then covers them automatically. The cross-project queries are each wrapped in `crossProject("<reason>")`:

- key authentication by hash;
- the delivery claim;
- delivery recovery;
- housekeeping.

## Validation rules (Zod, `src/lib/validation/api.ts`)

| Rule | Where it is enforced |
|---|---|
| Key name 1–64 characters, trimmed; permissions a non-empty unique subset; rate limit an integer 1–1000; expiry `never \| 30 \| 90 \| 365` | `createApiKeySchema` (form and service) |
| Idempotency key `^[\x21-\x7E]{1,255}$` | pipeline (400 `invalid_idempotency_key`) |
| Webhook URL `http(s)` with no userinfo, ≤ 2,000 characters; description ≤ 200; events a non-empty subset of the four | `webhookEndpointSchema` |
| API item fields: ≤ 50 names, unique, placeholder grammar; items 1–100 per call, values strings, ≤ 50,000 characters per item; label ≤ 200; `mediaId` uuid | `apiSourceSchema`, `appendItemsSchema` |
| Lists: `limit` 1–100 (default 50); `cursor` an opaque base64url string | `pageQuerySchema` |
| Schedule: `at` RFC 3339 **with an offset** (`z.iso.datetime({ offset: true })`) | the operation body schema; the past-instant check stays in the service (`in_past`) |
| Upcoming slots: `days` 1–60 (default 14); `from` optional RFC 3339 | `upcomingQuerySchema` |
