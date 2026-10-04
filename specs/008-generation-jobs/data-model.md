# Data model: Generation jobs (008)

There is one migration, `drizzle/0005_*.sql`. It is generated with `pnpm db:generate` from the hand-written Drizzle schema (decision 001 #9) and committed.

- Both new tables carry `project_id` and are added to `src/server/db/project-owned.ts` (constitution III, FR-003).
- All times are `timestamptz` in UTC.
- New schema file: `src/server/db/schema/jobs.ts`, exported from `schema/index.ts`.
- Changed file: `schema/posts.ts`, which gains one column, one FK and one index.

## Enums (new)

| Enum | Values |
|---|---|
| `generation_job_status` | `queued \| running \| completed \| completed_with_failures \| cancelled` |
| `generation_job_item_status` | `queued \| running \| done \| failed \| cancelled` |
| `generation_job_item_error` | `timeout \| rate_limited \| unavailable \| internal \| interrupted \| invalid_output \| refused \| incomplete \| auth \| bad_request \| image_deleted \| image_unavailable \| no_targets` |

- The existing `approval_policy` and `scheduling_policy` enums are reused.
- `generation_mode` and `llm_failure_kind` are **not** changed: jobs do not write `generation_failures` (research D7, D21).
- `source_kind` is `text`, not an enum, so a new item source needs no migration (research D14).

## generation_jobs

| Column | Type | Rules |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `project_id` | uuid NOT NULL | FK `projects.id` ON DELETE CASCADE |
| `source_kind` | text NOT NULL | CHECK `char_length BETWEEN 1 AND 32`; must be registered in `ITEM_SOURCES` (Zod) |
| `source_summary` | text NOT NULL | for example "12 unused images" or "products.csv, 40 rows"; 1–200 characters |
| `source_meta` | jsonb NOT NULL default `{}` | media: `{ mode, includeUsed, excluded: {reason,count}[], skippedReserved }`; CSV: `{ filename, rowCount, columns }` |
| `voice_profile_id` | uuid NOT NULL | composite FK `(project_id, voice_profile_id)` → `voice_profiles(project_id, id)` |
| `voice_profile_version_id` | uuid NOT NULL | composite FK `(project_id, voice_profile_version_id)` → `voice_profile_versions(project_id, id)`; **pinned at creation** |
| `template` | text NOT NULL | 1–2,000 characters (`INSTRUCTIONS_MAX`), CHECK on length |
| `template_fields` | text[] NOT NULL | the fields the source declared, in source order |
| `target_account_ids` | uuid[] NOT NULL | 1–50 distinct, CHECK `cardinality BETWEEN 1 AND 50`; each checked to be a live account of the project at creation |
| `requested_approval` | approval_policy NULL | null means the project default was used |
| `requested_scheduling` | scheduling_policy NULL | |
| `approval_policy` | approval_policy NOT NULL | resolved and authorised once, at creation (FR-012) |
| `scheduling_policy` | scheduling_policy NOT NULL | |
| `status` | generation_job_status NOT NULL default `queued` | derived; written only by `refreshJobStatus` (research D10) |
| `item_count` | integer NOT NULL | CHECK `BETWEEN 1 AND 500`; updated by `insertItems` |
| `created_by_user_id` | uuid NULL | FK `user.id` ON DELETE SET NULL |
| `cancelled_by_user_id` | uuid NULL | FK `user.id` ON DELETE SET NULL |
| `created_at` | timestamptz NOT NULL | default now |
| `started_at` | timestamptz NULL | the first claim |
| `finished_at` | timestamptz NULL | set when the job becomes `completed*`; cleared when it goes back to `running` |
| `cancelled_at` | timestamptz NULL | |
| `last_claimed_at` | timestamptz NULL | used for claim rotation (research D4) |
| `updated_at` | timestamptz NOT NULL | `$onUpdate` |

Constraints and indexes:

- `UNIQUE (project_id, id)` (`generation_jobs_project_id_uq`), the target of the items' composite FK.
- CHECK `(status = 'cancelled') = (cancelled_at IS NOT NULL)`.
- CHECK `status NOT IN ('completed','completed_with_failures') OR finished_at IS NOT NULL`.
- INDEX `(project_id, created_at DESC, id DESC)`, for the Jobs list.
- INDEX `(last_claimed_at NULLS FIRST, created_at) WHERE status IN ('queued','running')`, for the claim.

## generation_job_items

| Column | Type | Rules |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid NOT NULL | FK `projects.id` ON DELETE CASCADE |
| `job_id` | uuid NOT NULL | composite FK `(project_id, job_id)` → `generation_jobs(project_id, id)` ON DELETE CASCADE |
| `position` | integer NOT NULL | ≥ 0; UNIQUE `(job_id, position)` |
| `label` | text NOT NULL | for example "Row 12: Blue mug" or "sunset.jpg"; at most 200 characters |
| `payload` | jsonb NOT NULL | `{ v: 1, fields: Record<string,string> }`, the template fields (Zod `itemPayloadSchema`) |
| `media_asset_id` | uuid NULL | FK `media_assets.id` ON DELETE RESTRICT (assets are soft-deleted) |
| `status` | generation_job_item_status NOT NULL default `queued` | |
| `attempt_count` | integer NOT NULL default 0 | counts temporary failures and interruptions; reset by a person's retry |
| `next_attempt_at` | timestamptz NOT NULL | default now; the backoff time while `queued` |
| `lease_owner` | uuid NULL | |
| `lease_until` | timestamptz NULL | |
| `pending_retry` | jsonb NULL | a deferred correction retry: `{ reason, problems: string[], previousOutput: string, attempts: Attempt[] }` (research D1); cleared on save, failure or a person's retry |
| `last_error_kind` | generation_job_item_error NULL | |
| `last_error` | text NULL | a plain sentence, never SDK or exception text; at most 500 characters |
| `started_at` | timestamptz NULL | the first claim |
| `finished_at` | timestamptz NULL | when the item became `done`, `failed` or `cancelled` |
| `created_at`, `updated_at` | timestamptz NOT NULL | |

Constraints and indexes:

- `UNIQUE (project_id, id)` (`generation_job_items_project_id_uq`), the target of the `posts` FK.
- **Reservation (FR-007)**: UNIQUE INDEX `generation_job_items_active_media_uq ON (project_id, media_asset_id) WHERE media_asset_id IS NOT NULL AND status IN ('queued','running','failed')` (research D15).
- CHECK `(lease_until IS NULL) = (lease_owner IS NULL)`.
- CHECK `(status = 'running') = (lease_owner IS NOT NULL)`: a running item is always leased, and nothing else is.
- CHECK `pending_retry IS NULL OR status IN ('queued','running')`.
- INDEX `(job_id, position) WHERE status = 'queued'`, for due items per job.
- INDEX `(lease_until) WHERE status = 'running'`, for recovery.
- INDEX `(project_id, job_id, status)`, for the counts.

## posts (changed)

| Column | Type | Rules |
|---|---|---|
| `generation_job_item_id` | uuid NULL | composite FK `(project_id, generation_job_item_id)` → `generation_job_items(project_id, id)` |

- UNIQUE INDEX `posts_generation_job_item_uq ON (generation_job_item_id) WHERE generation_job_item_id IS NOT NULL AND deleted_at IS NULL`. **The database guarantees at most one live post per item** (FR-018, research D8).
- No content columns change. Origin is `generated`. The job and item also appear in the generation record (below).

## Derived values (no columns)

- **Item output post**: `SELECT id, review_state FROM posts WHERE project_id = $p AND generation_job_item_id = $item`, where the newest live row wins. "Has a post" for recovery includes soft-deleted rows (research D6).
- **Job counts**: `count(*) FILTER (WHERE status = 'queued' | 'running' | 'done' | 'failed' | 'cancelled')` grouped by `job_id`, one query per page of jobs.
- **Image "used"**: `media_assets.first_used_at IS NOT NULL` (existing).
- **Image "reserved"**: `EXISTS (SELECT 1 FROM generation_job_items i WHERE i.project_id = $p AND i.media_asset_id = a.id AND i.status IN ('queued','running','failed'))`.
- **Image "unused"** (library filter and job selection): not used and not reserved.

## Generation metadata (`posts.generation_metadata`, JSON, changed)

These are additions to `generationRecordSchema` and `generationInputsSchema` in `src/lib/validation/generation.ts`. All are optional, so 007 records still parse.

```ts
mode: "single" | "series_post" | "regenerate" | "job_item";
job?: { id: string; itemId: string; position: number; sourceKind: string } | null;
inputs: {
  // …existing…
  instructions: string | null;        // max widened 2,000 → 10,000 (JOB_RENDERED_INSTRUCTIONS_MAX); form schemas keep 2,000
  itemFields?: Record<string, string> | null;
};
```

For a job item, the record's `inputs` hold:

- `brief`: the source's fixed brief;
- `instructions`: the rendered, marked template;
- `sourceText`: `null`;
- `itemFields`: the item's fields;
- `mediaAssetIds`: `[item image]` or `[]`;
- `targetAccountIds`: the accounts still live at run time;
- `series`: `null`.

`voiceProfile` names the **pinned** version.

## Validation rules (Zod, `src/lib/validation/jobs.ts`)

| Input | Rule |
|---|---|
| `voiceProfileId` | uuid; the profile must exist in the project and not be archived at creation; its current version is pinned |
| `template` | trimmed, 1–2,000 characters; every placeholder must name a declared field (FR-010) |
| `targetAccountIds` | 1–50 distinct uuids of live project accounts |
| `approval`, `scheduling` | optional enum, null for the default; then `resolvePolicies` (editor limit, confirmation) |
| `confirmUnreviewedQueue` | boolean, required true for resolved `auto_approve` + `add_to_queue` |
| media source | `{ kind: "media", selection: { mode: "pick", ids: uuid[1..500] } \| { mode: "filter", filter: { tag?, missingAlt?, q? } } \| { mode: "unused" }, includeUsed: boolean }` |
| CSV source | `{ kind: "csv" }` plus the `file` in the same form data (≤ 1 MB, research D17) |
| items | 1–500 after exclusions; for each item, rendered instructions ≤ 10,000 characters and item data ≤ 50,000 characters |

## State transitions

### Item

```text
          claim                     post saved (lease held, job not cancelled)
queued ─────────► running ───────────────────────────────► running+post ──policy applied / already decided──► done
  ▲                 │  │                                       │
  │ temporary,      │  │ lasting failure,                      │ job cancelled
  │ attempts < 3    │  │ or temporary at attempt 3             ▼
  │ (backoff)       │  └──────────────────────► failed        done (post kept, nothing more queued)
  ├─────────────────┘                             │
  │ retry deferred / image prep overran           │ person retries (attempts := 0)
  │ (no attempt counted)                          │
  └───────────────────────────────────────────────┘
lease expired, no post ─► attempts+1 ─► (≥ 3 → failed "interrupted") else run again
lease expired, with post ─► finishing only (no model call)
queued | failed | running(no post) ──job cancelled──► cancelled   (reservation released)
```

### Job

```text
queued ──first claim──► running ──no item queued/running──► completed | completed_with_failures
                           ▲                                        │
                           └──────── person retries a failed item ──┘
queued | running ──cancel──► cancelled (final)
```

Every transition happens in a transaction that holds the job row lock and calls `refreshJobStatus` (research D10).
