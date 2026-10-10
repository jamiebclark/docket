# Contract — DAL and services: the external item claim ledger

**Feature**: 041-external-id-ledger | **Date**: 2026-10-10

Every rule in this feature lives in `src/server/dal/` (one new repository) and `src/server/services/`
(one new shared helper plus edits to the generation and job services). Route handlers, server actions,
the job runner and the public API all reach it through `ProjectScope` (constitution III and IV).

## New DAL repository: `ExternalClaimsRepo`

`src/server/dal/external-claims.ts`, created by `createExternalClaimsRepo(exec, projectId)` and exposed
as `scope.externalClaims`. Every query filters `project_id = projectId`; nothing here is cross-project.

```ts
export interface ExternalClaim {
  sourceKey: string;
  externalId: string;
  postId: string;
  claimedAt: Date;
}

export interface ExternalClaimsRepo {
  /** The claim on one id, or null. Used by the generate pre-check and the runner's pre-check. */
  find(sourceKey: string, externalId: string): Promise<ExternalClaim | null>;
  /** The claims among `externalIds` in one namespace, keyed by external id. One indexed query. */
  findMany(sourceKey: string, externalIds: readonly string[]): Promise<Map<string, ExternalClaim>>;
  /** The claim a post consumed, or null. Behind `Post.source`. */
  findByPostId(postId: string): Promise<ExternalClaim | null>;
  /**
   * Inserts the claim. Throws a unique violation when the id is already claimed — callers recover by
   * re-reading (D7). Call only inside the transaction that inserts the post (FR-007).
   */
  insert(input: { sourceKey: string; externalId: string; postId: string; claimedAt: Date }): Promise<void>;
}
```

Wiring:

- `createSchedulingRepos` gains `externalClaims`, so the job runner's `forJobRunner` scope and webhook
  emission both have it (F9);
- `ProjectScope` gains `readonly externalClaims: ExternalClaimsRepo`;
- `EmitRepos` in `webhooks/emit.ts` gains `"externalClaims"`;
- `src/server/db/project-owned.ts` gains the table (data-model.md).

`findMany` with an empty list returns an empty map without querying (the convention the media repo
already follows).

## `generation/save.ts` — the one place a claim is written (D3)

```ts
export async function saveGeneratedPost(tx, args: {
  …unchanged…,
  /** Claims this source record for the new post, in this transaction. Omit for untagged saves. */
  external?: { sourceKey: string; externalId: string };
}): Promise<string>
```

After the post, its media, its targets and its derived status are written, and before returning:

```text
if (args.external) await tx.externalClaims.insert({ ...args.external, postId: post.id, claimedAt: now });
```

Properties this gives for free:

- FR-007: the claim and the post are in the caller's single transaction — both or neither;
- FR-009: a failed generation never reaches `saveGeneratedPost`, so nothing is claimed;
- series and the app composer pass no `external`, so neither claims anything (FR-005, scope).

## `generation/single.ts`

**Schema.** `generateSingleSchema` gains:

```ts
externalId: externalIdSchema.optional(),
sourceKey: sourceKeySchema.default(DEFAULT_SOURCE_KEY),
```

with a `.refine` (or `.check`) that refuses a `sourceKey` sent without an `externalId`, and
`planSeriesSchema` extends its `omit` to `{ requestId: true, externalId: true, sourceKey: true }` (F14).

**`GenerateResult`.** The `ok: true` branch gains nothing: `existing: boolean` already carries what the
API needs for `alreadyPosted` (F1). `existingResult(post)` is reused unchanged.

**New flow** (additions marked `+`):

```text
  parse, need(), resolvePolicies
  existing = posts.findByRequestId(requestId)        → existingResult (idempotency replay)
+ if (externalId) {
+   claim = externalClaims.find(sourceKey, externalId)
+   if (claim) {
+     post = posts.get(claim.postId)
+     if (!post) throw ConflictError(…, { reason: "already_posted_post_deleted" })   // FR-010, D5
+     return existingResult(post)                                                   // FR-013, FR-014
+   }
+ }
  takeVoice, loadAccounts, loadAssets, groups, limits
  runGeneration(...)                                  ← first model call
  scope.transaction(saveGeneratedPost({ …, external }))
  catch unique violation →
+   claim = externalClaims.find(sourceKey, externalId)   // D7: ask the ledger first
+   if (claim) { post = posts.get(claim.postId); if (post) return existingResult(post) }
    winner = posts.findByRequestId(requestId); if (winner) return existingResult(winner)
    rethrow
```

`ConflictError`'s message names the id and says the post was deleted; it must not include the post id of
a deleted post in the message (the `details.reason` is the machine-readable part).

## `jobs/sources/types.ts` and `jobs/sources/api.ts`

- `SourceItem` gains `externalId: string | null`. `csv.ts` and `media.ts` set `null`.
- `apiItemSchema` gains `externalId: externalIdSchema.optional()`; `prepareApiItems` carries it through
  and reports invalid ids as `items.<i>.externalId` (append) / `source.items.<i>.externalId` (create).
- `apiSourceSchema` gains `sourceKey: sourceKeySchema.default(DEFAULT_SOURCE_KEY)`, and `apiSource.prepare`
  returns `meta: { open, sourceKey }`.
- New `apiSourceMetaSchema = z.object({ open: z.boolean().default(false), sourceKey: sourceKeySchema.default(DEFAULT_SOURCE_KEY) })`
  replaces the `(prepared.meta as { open?: boolean })` cast in `create.ts` and gives `append.ts` the
  job's namespace from the row it already locked (D12).

## New shared helper: `jobs/claims.ts`

One function, used by both ingest paths so the rule exists once (constitution IV):

```ts
/**
 * Drops items whose external id is already claimed, and later duplicates of an id inside this call.
 * Call inside the write transaction. Items with no external id are always kept.
 */
export async function dropAlreadyPosted(
  tx: ProjectScope,
  sourceKey: string,
  items: readonly SourceItem[],
): Promise<{ kept: SourceItem[]; skipped: number }>;
```

Implementation: one `findMany` for the distinct ids in the call, then a single pass keeping the first
occurrence of each unseen id (FR-016, FR-017). It takes no lock: a claim appearing after this point is
handled by the runner's late skip (FR-021), and locking a not-yet-existing row is not possible anyway.

## `jobs/create.ts`

- `CreateJobResult` gains `skippedAlreadyPosted: number`.
- Inside `write()`, after the media filter and **before** the `items.length === 0 && !open` check:
  `const { kept, skipped } = await dropAlreadyPosted(tx, sourceKey, items)`.
- The empty check becomes: if `kept.length === 0 && !open` then
  - if `skipped > 0` → a `ValidationIssuesError` with one issue, code `already_posted`, field
    `source.items`, message `"All <skipped> items were already posted."` (FR-020)
  - else → today's `emptyMessage` issue, unchanged.
- `insertItems` is called with `kept`; `sourceSummary`'s count correction already handles a shorter list.
- `insertItems` writes `externalId: item.externalId` on each row.

## `jobs/append.ts`

- `AppendResult` gains `skippedAlreadyPosted: number`.
- Order inside `write()`: lock the job → read `sourceKey` from `source_meta` → `prepareApiItems` →
  `assertRenderedFits` → `dropAlreadyPosted` → **then** the `JOB_ITEMS_MAX` check on
  `job.itemCount + kept.length` (FR-018) → media checks on `kept` only (FR-018: a skipped item reserves
  nothing) → `insertItems(kept)`.
- `added` is `kept.length`; `items` lists only the rows actually inserted.

## `jobs/status.ts`

- `JobCounts` (in `dal/jobs.ts`) gains `skipped`, and `emptyCounts()` initialises it.
- `deriveJobStatus`: `worked` gains `+ counts.skipped`; the `completed_with_failures` test stays
  `counts.failed > 0` (FR-021, D10).
- `insertItems`' `base` sum gains `counts.skipped` (F4).

## `jobs/runner.ts`

Two additions, both inside `processClaimedItem`:

1. **Pre-check (D9).** After the accounts and assets are resolved and before the `runGenerationStep`
   budget window, when `item.externalId` is set: `claim = externalClaims.find(sourceKey, item.externalId)`.
   A hit calls a new local `skip()`:

   ```text
   commit({ status: "skipped", leaseOwner: null, leaseUntil: null, pendingRetry: null,
            finishedAt: now, lastErrorKind: null, lastError: null })
   counts.skipped++ ; outcome = "skipped"
   ```

   `skip()` goes through the same lease-checked `commit()` every other terminal write uses, so a lost
   lease is still counted as stale and nothing is written.

2. **Save recovery (D7).** The existing `catch (isUniqueViolation)` around `saveGeneratedPost` first asks
   `externalClaims.find(sourceKey, item.externalId)`: a claim whose `postId` is not this item's post means
   another submission won, so the item is `skip()`ed; otherwise it falls through to today's
   `posts.findByJobItemId` recovery.

`sourceKey` comes from `apiSourceMetaSchema.parse(job.sourceMeta)`. A job whose `sourceKind` is not
`"api"` has no external ids on its items, so the whole block is skipped.

`GenerationCounts` gains `skipped: number` (and `emptyGenerationCounts()` initialises it) so the tick
heartbeat and the log line report skips separately from failures. The `generation_job_item` log line
reports `outcome=skipped`, and carries no external id (it is caller data, not a secret, but the log line
stays a fixed vocabulary).

## `jobs/read.ts` and the views

- `listJobItems`'s status filter enum gains `skipped`; so does `api/operations/jobs.ts`'s `itemsQuery`.
- `JobItemView` gains `externalId: string | null` and
  `skipped: { externalId: string; reason: string; postId: string | null } | null`.
- `toItemView` fills `skipped` only when `row.status === "skipped"`, from
  `externalClaims.find(sourceKey, row.externalId)`. `postId` is that claim's post, or `null` when
  `posts.get(claim.postId)` finds nothing because the post was deleted — so a caller never gets a post id
  it cannot read. `reason` comes from one pure helper so the API and the app word it identically:

  ```ts
  // src/lib/jobs/skipped.ts
  export function alreadyPostedReason(externalId: string): string;  // "Already posted: … became a post earlier."
  ```

- `toApiJobItem` maps the three new fields.

## `views/post.ts`, `views/load.ts`, `webhooks/emit.ts`

- `PostViewInput` gains `source: { key: string; externalId: string } | null`; `toApiPost` passes it
  through to `ApiPost.source` (FR-023, D11).
- `loadApiPost` and `webhooks/emit.ts`'s `postData` each resolve it with
  `externalClaims.findByPostId(post.id)`, added to the existing `Promise.all`, so no new round trip in
  series.

## App (UI)

- `StatusBadge`'s table gains `skipped: { label: "Skipped", tone: "neutral" }` — a plain, non-alarming
  state, never colour alone (FR-025).
- `JobItemsTable`: the last-but-one column changes from `Error` to `Detail` and renders the error message
  for a failed item or the skip reason (linking to `skipped.postId` when there is one) for a skipped
  item. The retry action stays limited to `failed`.
- The job page's counts row gains `Skipped`, and its `FilterTabs` gain a `Skipped` tab.
- Nothing else in the app changes: the composer, the generate form and the CSV/media job forms never
  send an external id (FR-005).

## Invariants the implement phase must not break

1. A post with a claim and a claim with no post cannot exist: one transaction, one insert each (FR-007).
2. Only `saveGeneratedPost` inserts a claim; only `dropAlreadyPosted`, the generate pre-check, the
   runner pre-check and `findByPostId` read one.
3. No code outside `src/server/dal/` touches `external_item_claims` directly, and no query against it
   omits `project_id` (the global scope recorder fails the suite otherwise).
4. A claim is never updated or deleted by application code.
5. `deriveJobStatus` stays the only writer of `generation_jobs.status`.
6. The ledger check never runs inside a held transaction that also makes a model call (there is no such
   transaction; the pre-check is outside the save).
