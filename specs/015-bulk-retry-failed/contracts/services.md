# Contract: bulk retry services, DAL and server actions

**Feature**: `015-bulk-retry-failed`. The types are in [../data-model.md](../data-model.md), and the decisions (P1–P14) are in [../research.md](../research.md).

This is an internal contract. The UI uses it now, and `api-retry-resolve` uses it unchanged later. There is no route handler and no OpenAPI change in this entry.

## 1. `src/server/services/posts/retry-all.ts` (new, re-exported from `posts/index.ts`)

```ts
export const RETRY_ALL_CAP = 100;
export const retryAllInputSchema: z.ZodType<{ account?: string; mode: "now" | "requeue" }>;  // z.strictObject
export const retryAllScopeSchema: z.ZodType<{ account?: string }>;                             // z.strictObject
export type { RetryAllSkipReason, SkipCounts } from "@/lib/failures/retry-all-text";
export async function retryAllFailed(scope: ProjectScope, input: unknown): Promise<RetryAllResult>;
export async function previewRetryAll(scope: ProjectScope, input?: unknown): Promise<RetryAllPreview>;
```

### `retryAllFailed(scope, input)`

1. `need(scope, { post: ["schedule"] })`. Otherwise it throws `ForbiddenError` before any read (FR-002).
2. `retryAllInputSchema.parse(input)`. Otherwise it throws `ZodError`, with nothing read.
3. `scope.targets.listFailedForRetry({ accountId })` and `scope.accounts.list()`. There is no transaction and no lock.
4. For each row, in the returned (D2) order:
   - **Blocked key from the pre-read account** (`retryBlockedKey`): `skipped[key]++`.
   - **`mode === "requeue"` and the account is exhausted**: `skipped.no_free_slot++` (D5).
   - **`attempted === RETRY_ALL_CAP`**: `remaining++`.
   - **Otherwise**: `attempted++`, then the step:

   ```ts
   withLockedTarget(scope, row.id, { post: ["schedule"] }, async (tx, _post, target, now) => {
     if (target.status !== "failed") return { kind: "skip", reason: "no_longer_failed" };
     const account = await tx.accounts.get(target.socialAccountId);
     const key = retryBlockedKey(account, !!account && !!findProvider(account.providerKey));
     if (key) return { kind: "skip", reason: key };
     const r = await retryLockedTarget(tx, target, now, { mode });
     if (r.status === "scheduled") return { kind: "retried" };
     if (r.reason === "no_active_slots" || r.reason === "no_free_occurrence") return { kind: "skip", reason: "no_free_slot", exhausted: true };
     return { kind: "skip", reason: "cannot_publish" };       // validation | account_unavailable (gate)
   })
   ```

   - It catches `NotFoundError` and `ConflictError` and counts them as `no_longer_failed`. Any other error is rethrown, which aborts the run (FR-013).
   - `exhausted` marks the account for D5.
5. It builds the per-account rows and the totals, sets `message = retryAllMessage(…)` and `changed = count > 0`, and returns the result.

**Guarantees**:

- Each attempted target's stored state and attempt entries are byte-identical to `retryTarget(scope, id, { mode })` (FR-005, FR-009).
- Each step is one transaction, holding one post's locks and at most one occurrence of one account (D1, P13).
- Calling it twice in a row never re-retries a target (FR-012). A concurrent call never double-retries (FR-011).
- The result contains only this project's account ids and names.

### `previewRetryAll(scope, input?)`

- It runs `need(scope, { post: ["schedule"] })`, then `retryAllScopeSchema.parse(input ?? {})`.
- It reads the same two things as step 3 and classifies each row with `retryBlockedKey`.
- It returns a `RetryAllPreview`. When an account is given and is present in `accounts.list()`, `scope` is `{ accountId, accountName }`. Otherwise it is `null`.
- It writes nothing (FR-014).

### `src/lib/failures/retry-all-text.ts` (new, pure, no server imports)

```ts
export type RetryAllSkipReason = "account_removed" | "needs_reconnecting" | "provider_unavailable"
  | "no_longer_failed" | "cannot_publish" | "no_free_slot";
export type SkipCounts = Record<RetryAllSkipReason, number>;
export const SKIP_REASONS: readonly RetryAllSkipReason[];                 // D3 order
export const SKIP_PHRASES: Record<RetryAllSkipReason, { one: string; many: (n: number) => string }>;
export function skipPhrase(reason: RetryAllSkipReason, n: number): string;
export function retryAllMessage(r: { mode: "now" | "requeue"; inScope: number; count: number; skipped: SkipCounts; remaining: number }): string;
```

`retryAllMessage` is exactly P9. Examples that tests must assert verbatim:

| Input | Message |
|---|---|
| `inScope: 0` | There are no failed posts to retry. |
| now, count 1 | 1 post will be retried. |
| now, count 10, 2 `needs_reconnecting` | 10 posts will be retried. Skipped 2: 2 need reconnecting. |
| requeue, count 1 | 1 post was queued into the next free slot. |
| requeue, count 4, 1 `no_free_slot`, 1 `cannot_publish` | 4 posts were queued into the next free slots. Skipped 2: 1 can't be published as is, 1 no free slot. |
| now, count 0, 2 `needs_reconnecting`, 1 `no_free_slot` | No posts were retried. Skipped 3: 2 need reconnecting, 1 no free slot. |
| now, count 100, `remaining` 130 | 100 posts will be retried. 130 more failed posts were not retried yet. Press Retry all failed again to continue. |
| now, count 100, `remaining` 1 | 100 posts will be retried. 1 more failed post was not retried yet. Press Retry all failed again to continue. |

## 2. `src/server/services/posts/retry.ts` (small change)

```ts
export function retryBlockedKey(account: AccountRecord | null, providerRegistered: boolean):
  "account_removed" | "needs_reconnecting" | "provider_unavailable" | null;
export function retryBlockedReason(account, providerRegistered): string | null;  // now a switch over retryBlockedKey; sentences unchanged
```

`retryLockedTarget`, `retryTarget`, `retryInputSchema` and `RetryResult` are unchanged (spec out-of-scope).

## 3. DAL: `src/server/dal/targets.ts`

```ts
listFailedForRetry(opts: { accountId?: string }): Promise<FailedForRetry[]>;
countAttention(accountId?: string): Promise<{ ambiguous: number; failed: number }>;
```

- `listFailedForRetry` is `SELECT id, post_id, social_account_id, scheduled_at, updated_at` from `post_targets` with an `INNER JOIN posts ON livePost`, `WHERE attentionWhere(["failed"], accountId)` and `ORDER BY scheduled_at ASC NULLS LAST, updated_at ASC, id ASC`. It has no limit and no lock.
- Both methods are project-scoped through the repo factory's `projectId`, as every repo method is, and are covered by the existing scope-check test.

## 4. `src/server/services/failures.ts` (small change)

- `FailureList` gains `failedInFilter: number`.
  - With no `query.account` it is `totals.failed`.
  - Otherwise it is `(await scope.targets.countAttention(query.account)).failed`, read in the same `Promise.all`.
  - It is independent of `query.status` and `query.page`.
- `targetActions` keeps using `retryBlockedReason` (now built on the key), so the per-row result is unchanged.

## 5. Server actions: `src/app/p/[projectSlug]/failures/actions.ts` (new, `"use server"`)

```ts
export async function retryAllFailedAction(
  slug: string,
  input: { account?: string; mode: "now" | "requeue" },
): Promise<ActionResult<RetryAllResult>>;
//   runAction(slug, (scope) => posts.retryAllFailed(scope, { account: input?.account, mode: input?.mode }))
//   — `account` is omitted from the object when undefined or ""; refresh() on ok.

export async function previewRetryAllAction(
  slug: string,
  input: { account?: string },
): Promise<ActionResult<RetryAllPreview>>;
//   runAction(slug, (scope) => posts.previewRetryAll(scope, { account: input?.account })) — reads only, no refresh.
```

| Situation | Action result |
|---|---|
| no session / not a member / another project's slug | `{ ok: false, error: "not_found" }` |
| no `post:schedule` | `{ ok: false, error: "forbidden" }` |
| bad `mode` / malformed `account` | `{ ok: false, error: "validation" }` |
| run completed (including "nothing to retry" and all-skipped) | `{ ok: true, data: RetryAllResult }` |
| unexpected error | the promise rejects (`failFromError` rethrows, F9). The dialog shows the FR-013 sentence. |

Only `{ account, mode }` ever reaches the service (FR-021). The action builds that object from scratch.
