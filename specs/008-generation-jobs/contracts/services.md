# Contract: job services, item sources, and generic changes (`src/server/services/`)

The 007 rules carry over:

- every function takes a `ProjectScope` first;
- permissions are checked with `scope.can(...)` on the server, and again inside the transaction (`need(tx, …)`);
- input is `unknown` and parsed with Zod;
- errors are the existing DAL classes plus `LlmNotConfiguredError` and `PolicyNotAllowedError`.

The UI calls these today. The `public-api` entry calls the same functions with the same inputs (constitution IV).

Permissions reuse the 007 statements; no new access statement is added.

| Action | Needs |
|---|---|
| create a job, retry, cancel | `generation: ["run"]` and `post: ["edit"]` (owner, admin, editor) |
| auto-approve override | `generation: ["auto_approve"]`, through `resolvePolicies` (owner, admin) |
| view jobs and items | `post: ["view"]` |

## Module layout

```text
src/server/services/jobs/
├── index.ts          # public surface (below)
├── create.ts         # createJob, previewJob, insertItems
├── manage.ts         # retryItem, retryFailedItems, cancelJob
├── read.ts           # listJobs, getJob, listJobItems
├── status.ts         # refreshJobStatus (pure derive + locked write)
├── runner.ts         # processClaimedItem (contracts/runner.md)
└── sources/
    ├── types.ts      # ItemSource, PreparedSource, SourceItem
    ├── index.ts      # ITEM_SOURCES registry, sourceFor(kind)
    ├── media.ts      # media library source
    └── csv.ts        # parseJobCsv (pure) + CSV source
src/lib/jobs/template.ts   # placeholdersIn, unknownPlaceholders, renderTemplate (pure, client-safe)
src/lib/validation/jobs.ts # createJobSchema, mediaSelectionSchema, itemPayloadSchema, limits
```

## Item sources

```ts
// sources/types.ts
export interface SourceItem {
  /** Template fields, keyed by the declared field name exactly as declared. Values are text. */
  fields: Record<string, string>;
  /** Reserved for this item inside the creation transaction (research D15). */
  mediaAssetId: string | null;
  /** Shown in the items table: "sunset.jpg" or "Row 12: Blue mug". ≤ 200 characters. */
  label: string;
}

export interface PreparedSource {
  fields: string[];
  items: SourceItem[];
  summary: string;
  meta: Record<string, unknown>;
  excluded: { reason: "already_used" | "deleted"; count: number }[];
  /** The fixed brief sent to the generator for every item of this source. */
  brief: string;
}

export interface ItemSource<I> {
  readonly kind: string;
  readonly inputSchema: z.ZodType<I>;
  /** Validates input and resolves candidates. Runs outside any transaction. Throws ValidationIssuesError for bad input. */
  prepare(scope: ProjectScope, input: I, ctx: { file?: { name: string; bytes: Buffer } }): Promise<PreparedSource>;
}

// sources/index.ts
export const ITEM_SOURCES: Record<string, ItemSource<unknown>> = { media: mediaSource, csv: csvSource };
export function sourceFor(kind: string): ItemSource<unknown>; // NotFoundError for an unknown kind
```

Adding the API source (`public-api`) means adding `sources/api.ts` and one registry line. Nothing else changes (FR-005).

### Media source (`kind: "media"`)

The input is `mediaSelectionSchema` (data-model.md § Validation). `prepare`:

1. Resolves candidate ids:
   - `pick`: the given ids, in the given order;
   - `filter`: `scope.media.listIdsForSelection({ tag, missingAlt, q, includeUsed, limit: 501 })`, newest first, as in the library;
   - `unused`: `listIdsForSelection({ unusedOnly: true, limit: 501 })`.
2. Refuses more than 500 candidates: "This selection has {n} images; a job can hold at most 500. Narrow the filter or pick fewer."
3. Drops deleted ids (counted as `deleted`).
4. Drops used ids unless `includeUsed` (counted as `already_used`).
5. Leaves reserved images in. The creation transaction drops them under the lock and reports them as `skippedReserved` (research D15).

The output is:

- `fields`: `["alt_text", "tags", "filename"]`;
- per item: `alt_text` = the asset alt text, `tags` = tags joined with ", ", `filename` = `original_filename ?? ""`;
- `label`: the filename, or the alt text, or "Image {position + 1}";
- `brief`: "Write a post about the attached image.";
- `summary`: "{n} unused images", "{n} images tagged {tag}" or "{n} selected images".

### CSV source (`kind: "csv"`)

`prepare` requires `ctx.file`. It calls `parseJobCsv(bytes, name)`, which implements the rules of research D17. On problems it throws `ValidationIssuesError` listing every problem. The message of each starts with "Line {n}: " when it has a line.

The output is:

- `fields`: the trimmed header names;
- per item: `fields[name] = value ?? ""`, `mediaAssetId: null`, `label: "Row {line}: {first non-empty value, ≤ 60 chars}"`;
- `brief`: "Write a post about the item described in the item data.";
- `meta`: `{ filename, rowCount, columns }`;
- `summary`: "{filename}, {n} rows".

```ts
export type CsvParse =
  | { ok: true; columns: string[]; rowCount: number; rows: { line: number; values: string[] }[]; preview: { line: number; values: string[] }[] }
  | { ok: false; problems: { line: number | null; message: string }[] };
export function parseJobCsv(bytes: Uint8Array, filename: string): CsvParse; // pure; no DB
export const CSV_MAX_BYTES = 1_048_576, CSV_MAX_ROWS = 500, CSV_ROW_MAX_CHARS = 50_000, CSV_PREVIEW_ROWS = 5;
```

## Template (`src/lib/jobs/template.ts`)

```ts
export const PLACEHOLDER = /\{\{\s*([^{}\n]{1,64}?)\s*\}\}/g;
export function placeholdersIn(template: string): string[];                       // distinct, as written
export function unknownPlaceholders(template: string, fields: readonly string[]): string[]; // case-insensitive, trimmed
export function renderTemplate(template: string, fields: Record<string, string>, opts?: { mark?: boolean }): string;
export const MARK_OPEN = "⟦", MARK_CLOSE = "⟧";
export const JOB_RENDERED_INSTRUCTIONS_MAX = 10_000;
```

- `renderTemplate` with `mark: true` (the server, and the form preview) wraps each non-empty value as `⟦value⟧`, after removing `⟦` and `⟧` from the value.
- An empty value renders as nothing.
- An unknown placeholder renders unchanged, though creation refuses it before any rendering is stored.

## Create

```ts
export const createJobSchema: z.ZodType<{
  source: { kind: "media"; selection: MediaSelection; includeUsed: boolean } | { kind: "csv" };
  voiceProfileId: string;
  template: string;
  targetAccountIds: string[];
  approval?: ApprovalPolicy | null;
  scheduling?: SchedulingPolicy | null;
  confirmUnreviewedQueue: boolean;
}>;

export interface CreateJobResult {
  jobId: string;
  itemCount: number;
  excluded: { reason: "already_used" | "deleted"; count: number }[];
  skippedReserved: number;
}
export async function createJob(scope: ProjectScope, input: unknown, ctx?: { file?: { name: string; bytes: Buffer } }): Promise<CreateJobResult>;
```

`createJob` runs these steps, in order. Nothing is written before step 9, and no model call is ever made (Story 1 scenario 1, SC-001).

1. `need(scope, { generation: ["run"], post: ["edit"] })`.
2. Throw `LlmNotConfiguredError` when `getLlmStatus().configured` is false.
3. `resolvePolicies(scope, …)` (existing). This can throw `PolicyNotAllowedError` with "Only owners and admins can auto-approve", or the confirmation validation error.
4. `takeVoice(scope, voiceProfileId)` (existing) pins `{ profileId, versionId }`.
5. `loadAccounts` (existing); then `assertMediaFits(providerKeys, 1)` when the source carries media.
6. `sourceFor(kind).prepare(scope, input, ctx)`.
7. Template checks:
   - unknown placeholders give `ValidationIssuesError` on field `template`: "Unknown column: {name}. Available: {list}" for CSV, or "Unknown field: {name}. Available: {list}" for media;
   - each item's marked rendering must be ≤ 10,000 characters, otherwise "{label}: the instructions would be {n} characters; the limit is 10,000".
8. Refuse when no item remains: "No unused images left to generate for" for `unused` mode, "None of the selected images can be used" for media otherwise, or "The file has no data rows" for CSV.
9. `scope.transaction(async (tx) => …)`:
   1. `need(tx, …)`;
   2. `tx.media.lockForReservation(ids)` locks the rows `FOR NO KEY UPDATE`, in id order, in its own statement;
   3. `tx.media.reservedAmong(ids)` and `tx.media.usedAmong(ids)` (the latter unless `includeUsed`) are re-read under the lock, and those ids are dropped and counted;
   4. step 8 is repeated;
   5. `tx.jobs.insert(…)` writes `status: "queued"`, the pinned version, the template, `template_fields`, the target ids, the requested and resolved policies, the summary and meta, and `created_by_user_id = tx.membership.userId`;
   6. `insertItems(tx, job, items)`;
   7. the transaction returns.
10. A unique violation on `generation_job_items_active_media_uq` retries step 9 once. A second violation throws `ConflictError("Some images were just taken by another job. Try again.")`.

```ts
/** Appends items to a job, numbering positions from max+1. Used by createJob now and by the API source's "add items" later. */
export async function insertItems(tx: ProjectScope, job: JobRecord, items: readonly SourceItem[]): Promise<number>;
```

`insertItems` makes one multi-row insert:

- `next_attempt_at = now` and `payload = { v: 1, fields }`;
- `item_count` is updated;
- `refreshJobStatus` is called, so a finished job becomes `running` again when items are appended.

### Preview (for the form, nothing written)

```ts
export async function previewJob(scope: ProjectScope, input: unknown, ctx?: { file?: … }): Promise<{
  itemCount: number;
  excluded: { reason: "already_used" | "deleted"; count: number }[];
  reserved: number;                       // currently reserved by other active items (informational; rechecked at creation)
  fields: string[];
  first: { label: string; fields: Record<string, string>; mediaAssetId: string | null } | null;
  emptyByField: Record<string, number>;   // per declared field: how many items have an empty value (the form warns for referenced ones)
  instagramWithoutMedia: boolean;         // a target is Instagram and the source carries no media
}>;
```

`previewJob` runs steps 1 and 6, so it needs no template. It needs `post: ["view"]` and `generation: ["run"]`. The form combines `emptyByField` with `placeholdersIn(template)` client-side.

## Manage

```ts
export type ManageResult = { changed: true; message: string } | { changed: false; message: string };

export async function retryItem(scope: ProjectScope, jobId: string, itemId: string): Promise<ManageResult>;
export async function retryFailedItems(scope: ProjectScope, jobId: string): Promise<ManageResult & { count: number }>;
export async function cancelJob(scope: ProjectScope, jobId: string): Promise<ManageResult & { cancelledItems: number }>;
```

Each runs in one transaction: `need(tx, …)`, then the job is locked `FOR UPDATE` in its own statement, then the items are changed, then `refreshJobStatus(tx, jobId)`.

- **retryItem**:
  - if the job is cancelled, nothing changes: "This job was cancelled; its items cannot be retried.";
  - if the item is not `failed`, nothing changes: "Only failed items can be retried.";
  - otherwise the item becomes `status: queued, attempt_count: 0, next_attempt_at: now, pending_retry: null`, keeping `last_error*` until the next outcome. The message is "Item {position + 1} will be retried." (FR-024).
- **retryFailedItems**: the same rule applied to every failed item. The message is "{n} items will be retried." or "There are no failed items to retry."
- **cancelJob**: research D9. When nothing changes, the message is "This job was already cancelled." or "This job has finished; there is nothing to cancel." When it does, the message is "Job cancelled. {n} items will not be generated."

## Read

```ts
export const JOBS_PAGE_SIZE = 50, JOB_ITEMS_PAGE_SIZE = 100;
export interface JobCounts { queued: number; running: number; done: number; failed: number; cancelled: number }
export interface JobListItem {
  id: string; sourceKind: string; sourceSummary: string; createdBy: { id: string; name: string } | null; createdAt: Date;
  approval: ApprovalPolicy; scheduling: SchedulingPolicy; unreviewedQueue: boolean;
  status: JobStatus; counts: JobCounts; finishedAt: Date | null; cancelledAt: Date | null;
}
export async function listJobs(scope: ProjectScope, input: { page?: number }): Promise<{ items: JobListItem[]; total: number; page: number }>;
export async function getJob(scope: ProjectScope, jobId: string): Promise<JobListItem & {
  voice: { profileId: string; name: string; version: number; archived: boolean };
  template: string; templateFields: string[]; targets: { id: string; displayName: string; providerKey: string; removed: boolean }[];
  requested: { approval: ApprovalPolicy | null; scheduling: SchedulingPolicy | null };
  sourceMeta: Record<string, unknown>; generationConfigured: boolean; jobsRunnable: { ok: true } | { ok: false; message: string };
}>;
export async function listJobItems(scope: ProjectScope, jobId: string, input: { page?: number; status?: ItemStatus }): Promise<{
  items: { id: string; position: number; label: string; status: ItemStatus; attemptCount: number;
           media: { id: string; thumbnailUrl: string | null; altText: string } | null;
           post: { id: string; reviewState: ReviewState; status: PostStatus } | null;
           error: { kind: ItemErrorKind; message: string } | null; finishedAt: Date | null }[];
  total: number; page: number;
}>;
```

All three need `post: ["view"]`. Another project's job is `NotFoundError`, never revealed.

## Generic changes to existing code

Each is small, keeps existing behaviour, and is recorded in `docs/decisions.md` with how to reverse it.

### Generation core step API

This lives in `services/generation/core.ts`.

```ts
export interface PendingRetry {
  reason: "invalid_output" | "invalid_platform" | "refused" | "incomplete" | "timeout";
  problems: string[];
  previousOutput: string;          // capped at PREVIOUS_OUTPUT_MAX (existing, 20,000)
  attempts: GenerationRecord["attempts"];
}
export type CoreStep = CoreOutcome | { ok: "retry"; pending: PendingRetry };

export interface CoreRequest { /* existing */ timeoutMs?: number; itemData?: { fields: [string, string][] } | null }

export async function runGenerationStep(
  scope: ProjectScope,
  req: CoreRequest,
  llm: LlmProvider,
  opts: {
    /** Present: run only the retry call with this context. */
    pending?: PendingRetry | null;
    /** Called before the retry; returns the timeout for it, or null to defer it. */
    retryWindowMs?: () => Promise<number | null>;
  },
): Promise<CoreStep>;

export async function runGeneration(scope, req, llm?): Promise<CoreOutcome>; // unchanged behaviour
```

- `runGeneration` runs the first step and, on `retry`, a second step with that `pending`. It never defers. `core.test.ts` passes unchanged.
- `req.timeoutMs` is passed to `llm.generate({ …, timeoutMs })` on the first call. The retry uses the window that `retryWindowMs` returns.

### Prompt builder

In `services/generation/prompt.ts`, `PromptInput` gains `itemData: { fields: [string, string][] } | null` (research D20). When it is `null` the output is byte-for-byte unchanged, and the existing snapshot passes. A new snapshot covers the item-data form.

### Save helper

`services/generation/save.ts` is a new file.

```ts
export async function saveGeneratedPost(tx: ProjectScope, args: {
  accounts: AccountRecord[];               // first one decides base_text (007 D10)
  variants: Record<string, string>;
  assets: MediaRow[];
  imageAltTexts: string[] | null;
  record: GenerationRecord;
  schedulingPolicy: SchedulingPolicy;
  createdByUserId: string | null;
  link: { generationRequestId: string } | { seriesId: string; seriesPosition: number } | { generationJobItemId: string };
}): Promise<string>; // postId
```

It is the body that `generateSingle` and `writeSeriesPost` repeat today, moved unchanged:

1. `lockShared` media, and throw `NotFoundError` on a mismatch;
2. insert the post with `origin: "generated"`, `review_state: "needs_review"` and the link column;
3. `setMedia`, then `markUsed`;
4. insert the targets with `override_text` set to each target's variant;
5. `fillEmptyAltTexts`;
6. `applyDerivedStatus`.

Single and series pass `createdByUserId: tx.membership.userId`. The job runner passes `job.createdByUserId`.

### Policy guard

```ts
export async function applyApprovalPolicy(
  scope: ProjectScope, postId: string, resolved: ResolvedPolicies,
  opts?: { guard?: (tx: ProjectScope) => Promise<void> },
): Promise<…>; // unchanged return
```

`guard` runs inside the policy transaction right after `lockPost`. If it throws, the transaction rolls back and the error propagates. Existing callers pass nothing.

### DAL additions

- `dal/jobs.ts` adds the `JobsRepo` and `JobItemsRepo` used by the services above:
  - `JobsRepo`: `insert`, `get`, `lockForUpdate`, `lockShared`, `list`, `countsFor(jobIds)`, `update`;
  - `JobItemsRepo`: `insertMany`, `get`, `listForJob`, `countByStatus`, `updateWithLease(id, token, patch)`, `retryFailed`, `cancelForJob`.

  They are wired into `buildScope` as `scope.jobs` and `scope.jobItems`.
- `dal/media.ts`:
  - `list()` returns `reservedByJobId`, and `unused` also excludes reserved images (research D16);
  - new methods: `listIdsForSelection`, `lockForReservation`, `reservedAmong`, `usedAmong`.
- `dal/posts.ts`: `insert` accepts `generationJobItemId`; new `findByJobItemId(itemId, { includeDeleted })`.
- `dal/job-claims.ts`: `claimDueJobItems` and `forJobRunner` (contracts/runner.md).
- `db/project-owned.ts`: adds `generation_jobs` and `generation_job_items`.

### Other

- `regeneratePost` passes `previous.inputs.itemFields` as `itemData` (research D21).
- No change to `lib/action-result.ts`. CSV problems are thrown as `ValidationIssuesError([{ code: "csv", field: "file", message: "Line 4: …" }, …], "The CSV file has problems.")`, and `failFromError` already returns `issues` unchanged. Template problems use `{ code: "template", field: "template" }`.
