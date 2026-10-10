# Phase 1 — Data model: External item ID ledger

**Feature**: 041-external-id-ledger | **Date**: 2026-10-10

One new table, one new unique constraint on an existing table, one new column, one new enum value.
Everything else is read and write logic. One generated migration carries all of it.

## New table: `external_item_claims`

The ledger entry of the spec's Key Entities: "one source record has become a post".

| Column | Type | Null | Notes |
|---|---|---|---|
| `project_id` | `uuid` | no | FK → `projects.id` `ON DELETE CASCADE`. Part of the primary key. |
| `source_key` | `text` | no | The source namespace (D2). `"default"` when the caller named none. |
| `external_id` | `text` | no | The record's own id, stored trimmed, compared byte-exact (D14). |
| `post_id` | `uuid` | no | The post that consumed the id (FR-008). |
| `claimed_at` | `timestamptz` | no | `defaultNow()`. When the id was consumed (FR-008). |

Constraints and indexes:

- `primaryKey({ columns: [project_id, source_key, external_id] })` — the uniqueness FR-006 asks for;
  also the index every ingest and generate lookup uses (D1).
- `foreignKey({ name: "external_item_claims_post_fk", columns: [project_id, post_id], foreignColumns: [posts.project_id, posts.id] }).onDelete("cascade")`
  — project-composite, so a claim can never name another project's post (constitution III), and
  cascading only through a project deletion (F12).
- `index("external_item_claims_post_idx").on(project_id, post_id)` — the post → claim read behind
  `Post.source` (FR-023) and the skipped-item view.
- three `check(...)` constraints, each a Drizzle `sql` fragment:

  ```text
  external_item_claims_source_key_shape      char_length(source_key) BETWEEN 1 AND 64
                                             AND source_key ~ '^[a-z0-9][a-z0-9._:-]*$'
  external_item_claims_external_id_len       char_length(external_id) BETWEEN 1 AND 200
  external_item_claims_external_id_trimmed   btrim(external_id) = external_id            (D14)
  ```

There is no `deleted_at`, no `released_at` and no expiry column: an entry is never released, never
pruned and never expires (FR-011, D13).

Registration: one line in `src/server/db/project-owned.ts`
(`{ table: "external_item_claims", scopeColumn: "project_id" }`), which the project-owned registry test
and the global scope recorder both depend on.

## Changed table: `posts`

| Change | Why |
|---|---|
| `unique("posts_project_id_uq").on(project_id, id)` | The target of the ledger's project-composite FK (F10). No behaviour change; the same pattern `generation_jobs` and `generation_job_items` already use. |

Nothing else on `posts` changes. A post does not carry its source id as a column: the claim is the
record of it, so a deleted post keeps its claim and a post can be read back through one index lookup.

## Changed table: `generation_job_items`

| Change | Why |
|---|---|
| `external_id text` (nullable) | The item's source record id (FR-002). `null` for CSV items, media items and untagged API items. |
| a `generation_job_items_external_id_len` check | `external_id IS NULL OR (char_length(external_id) BETWEEN 1 AND 200 AND btrim(external_id) = external_id)` — the same invariant as the ledger (D14). |
| `generation_job_item_status` gains `'skipped'` | The terminal state of FR-021 (D8). Appended to the enum, so existing values keep their order. |

Deliberately unchanged, because they already do the right thing (F6):

- `generation_job_items_active_media_uq` stays partial on `('queued','running','failed')`, so becoming
  `skipped` frees the image (FR-018);
- `generation_job_items_lease_pair` / `_running_leased` / `_pending_retry_state` all key off
  `status = 'running'`, so a skipped item must be written with `leaseOwner: null`, `leaseUntil: null`,
  `pendingRetry: null` — the same patch shape `fail()` already uses.

## Changed table: `generation_jobs`

No column change. For an API-source job, `source_meta` becomes `{ open: boolean, sourceKey: string }`
(D12), parsed by a new `apiSourceMetaSchema` in `src/lib/validation/api.ts` instead of the current cast.
Jobs created before this entry parse with `sourceKey` defaulted to `"default"`, so old rows keep working
and no backfill is needed.

## Migration

One generated migration, `drizzle/0019_external_item_ledger.sql` (name assigned by `drizzle-kit
generate`; the number follows `0018`). It contains, in this order:

1. `ALTER TYPE "generation_job_item_status" ADD VALUE 'skipped';`
2. `ALTER TABLE "posts" ADD CONSTRAINT "posts_project_id_uq" UNIQUE ("project_id","id");`
3. `ALTER TABLE "generation_job_items" ADD COLUMN "external_id" text;` plus its check;
4. `CREATE TABLE "external_item_claims" (…)` plus its primary key, FK, index and checks.

All four steps are additive: no existing row is rewritten and no existing column changes type or
nullability, so the migration is safe to run against a populated database and needs no data migration.
`pnpm db:check` must pass afterwards (schema and migrations in step).

> Postgres will not let `ALTER TYPE … ADD VALUE` run in the same transaction block as a statement that
> *uses* the new value. Nothing in this migration uses `'skipped'`, so a single transactional migration
> is fine; this is called out because the implement phase must not "helpfully" add a backfill `UPDATE`
> to the same file.

## Entity relationships

```text
projects ──┬─< posts ──────────< post_targets
           │     ^
           │     │ post_id (project-composite, cascade)
           ├─< external_item_claims   PK (project_id, source_key, external_id)
           │
           └─< generation_jobs ──< generation_job_items
                  source_meta.sourceKey      external_id
                            └──── together identify the claim an item will try to make ────┘
```

An item's `(job.source_meta.sourceKey, item.external_id)` is the key the runner claims when it saves a
post. The claim row does **not** point back at the item: a claim outlives items and jobs, and pointing
only at the post keeps FR-008 to one meaning ("which post consumed the id").

## Validation rules (one place each)

In `src/lib/validation/api.ts`, used by the API, the services and the tests:

| Constant / schema | Value | Requirement |
|---|---|---|
| `EXTERNAL_ID_MAX` | `200` | FR-004 |
| `SOURCE_KEY_MAX` | `64` | D2 |
| `DEFAULT_SOURCE_KEY` | `"default"` | FR-003 |
| `externalIdSchema` | `z.string().trim().min(1, …).max(EXTERNAL_ID_MAX, …)` | FR-004: present, non-blank after trimming, length-capped |
| `sourceKeySchema` | `z.string().trim().min(1).max(SOURCE_KEY_MAX).regex(/^[a-z0-9][a-z0-9._:-]*$/, …)` | D2 |

Boundary behaviour:

- `externalId: ""`, `"   "` or 201 characters → `400 validation_failed`, details naming the field
  (`externalId`, or `source.items.3.externalId` / `items.3.externalId` in a batch) (FR-004).
- `sourceKey` without `externalId` → `400 validation_failed` naming `sourceKey`: a namespace with
  nothing to put in it is a caller mistake, not a silent no-op.
- No `externalId` → nothing is claimed and nothing is checked (FR-005).

## State transitions

**Claim.** None. A claim is inserted once, with its post, and never updated or deleted (FR-011).

**Job item.** The existing machine gains one terminal state:

```text
queued ──claim──> running ──save+claim ok──> done
                     │
                     ├──ledger hit before the model ──> skipped   (terminal)
                     ├──claim lost at save ───────────> skipped   (terminal)
                     ├──temporary error ─────────────> queued (backoff)
                     ├──permanent error ─────────────> failed
                     └──job cancelled ───────────────> cancelled
```

`skipped` is terminal: no tick claims it (the claim query only looks at `queued` and expired-lease
`running`), `retryFailed` ignores it (FR-022), `cancelForJob` ignores it, and it holds no image or lease.

**Job status.** `deriveJobStatus(current, counts, started, open)` with `counts.skipped` added:

| Items | Status |
|---|---|
| any `queued` or `running` | `queued` until work started, then `running` |
| none left, `open` | `queued` / `running` (an open job never finishes) |
| none left, any `failed` | `completed_with_failures` |
| none left, no `failed`, some `skipped` | `completed` (FR-021, AS 2.7) |

`worked` becomes `started || counts.running > 0 || counts.done + counts.failed + counts.skipped > 0`.

## Volumes and cost

- Up to ~100,000 claims per project (spec Assumptions). At `project_id` + a short `source_key` + a
  ~20-character `external_id` the primary-key index stays a few megabytes; every read in this feature is
  an index lookup or an `IN` list against it, so SC-008 holds without a cache.
- Per generate request: one extra `SELECT` (pre-check) and one extra `INSERT` (on success).
- Per ingest call: one extra `SELECT … WHERE project_id = $1 AND source_key = $2 AND external_id = ANY($3)`
  for the whole call, whatever the item count.
- Per job item run: one extra `SELECT` before the model, one extra `INSERT` in the save transaction.
- Per post read through the API or a webhook: one extra `SELECT` on `external_item_claims_post_idx`.
