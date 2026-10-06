# Contract: services

Every caller goes through these functions (constitution IV):

- the UI server actions now;
- `bulk-retry-failures` and `api-retry-resolve` later.

All data access goes through the project-scoped DAL (constitution III). Nothing here is a public API endpoint (FR-022).

## Retry: `src/server/services/posts/retry.ts` (new; re-exported from `@/server/services/posts`)

```ts
export const retryInputSchema: z.ZodType<RetryInput>;
// z.discriminatedUnion("mode", [
//   z.object({ mode: z.literal("now") }),
//   z.object({ mode: z.literal("requeue"), expected: z.iso.datetime({ offset: true }).optional() }),
//   z.object({ mode: z.literal("at"), at: atSchema }),
// ])

export type RetryInput =
  | { mode: "now" }
  | { mode: "requeue"; expected?: string }
  | { mode: "at"; at: string };

export type RetryFailureReason = "no_active_slots" | "no_free_occurrence" | "in_past" | "validation" | "account_unavailable";

export type RetryResult =
  | {
      status: "scheduled";
      mode: RetryInput["mode"];
      scheduledAt: string;          // ISO instant
      localTime: string;            // plannedTime(...).localTime, project zone
      slotId: string | null;        // requeue only
      changedFromPreview: boolean;  // requeue with `expected` only
      warnings: Warning[];          // at only
    }
  | { status: "failed"; reason: RetryFailureReason; message: string; issues?: ValidationIssue[] };

export async function retryTarget(scope: ProjectScope, targetId: string, input?: unknown): Promise<RetryResult>;
```

### `retryTarget` behaviour

1. **Input**: `uuid.parse(targetId)`. `input` that is `undefined` or `null` becomes `{ mode: "now" }`, and then `retryInputSchema.parse(input)` runs. A bad value throws `ZodError` and nothing is written (FR-001, FR-002).
2. **Permission**: `need(scope, { post: ["schedule"] })` before the transaction and again on `tx` (as today).
3. **Locks**: `withLockedTarget` locks the post, then all of its targets, and re-reads the target (as today).
4. **Status**: `publishing` throws `ConflictError("Publishing in progress. Try again in a moment.")`; any status other than `failed` throws `ConflictError("This post is no longer failed.")`.
5. **Account**: `retryBlockedReason(account, providerRegistered)` returns a string → throw `ConflictError(reason)`. The reason is exactly today's text, for every mode.
6. The mode body runs, from `retryLockedTarget`:

| Mode | Steps | Returns |
|---|---|---|
| `now` | Guarded update (`statuses: ["failed"]`): `status: "scheduled"`, `nextAttemptAt: now`, `attemptCount: 0`, `stepState`/`firstStepAt`/`publishStartedAt`/`lastError: null`. Miss → `ConflictError`. Then the attempt `retry_requested` with no summary. | `scheduled`, `scheduledAt: now`, `slotId: null`, `changedFromPreview: false`, `warnings: []` |
| `requeue` | 1. `gate`; on failure return it.<br>2. `allocateNextFree(tx, { id, accountId }, { after: now, ownOccurrence: target.slotOccurrenceAt })`.<br>3. No occurrence: refused-requeue path (below).<br>4. Otherwise, guarded update: `status: "scheduled"` and the resets (kind, instant and hold are already set by the allocator). Miss → `ConflictError`.<br>5. The attempt, with `{ mode, scheduledAt, slotId, expected? }`. | `scheduled`, `slotId`, `changedFromPreview = expected !== undefined && +new Date(expected) !== +instant`, `warnings: []` |
| `requeue`, refused | Guarded update: `{ lastError: MSG }` only. Miss → `ConflictError`. Then the attempt, with `error: "no_free_slot"` and `{ mode: "requeue", reason }`. The transaction commits. | `failed`, `reason: "no_active_slots" \| "no_free_occurrence"`, `message: MSG` |
| `at` | 1. `when <= now` → return `in_past` (no write).<br>2. `gate`; on failure return it.<br>3. Guarded update: `status: "scheduled"`, `...explicitSchedulePatch("explicit", when)`, and the resets. Miss → `ConflictError`.<br>4. The attempt, with `{ mode: "at", scheduledAt }`. | `scheduled`, `slotId: null`, `changedFromPreview: false`, `warnings: nearQueuedWarnings(tx, accountId, when, target.id)` |

7. **Status**: `applyDerivedStatus(tx, post.id)` runs (in `withLockedTarget`).

**Gate failure** (`requeue` and `at`): `gate(tx, target)` gives `{ ok: false, code, message, issues? }`. That becomes `{ status: "failed", reason: code, message, issues }` with **no write** and no attempt row (FR-009, research P8). `code` is `validation` or `account_unavailable` here: `not_queueable` cannot come from `gate`, and the statuses were already checked.

**Messages** (`MSG`, research P6), with `{account}` = `account.displayName`:

- `no_free_occurrence`: `Not retried — {account} has no free posting slot. Retry now or pick a time.`
- `no_active_slots`: `Not retried — {account} has no active posting slots. Retry now or pick a time.`
- `in_past`: `That time has passed. Use Retry now instead.`

**Lock order**:

1. the post row;
2. the target rows of that post (`lockForPost`, `FOR UPDATE`);
3. occurrence index entries (one savepoint per candidate).

A caller that retries several targets in one transaction (the future bulk retry) MUST lock posts in id order first and then visit targets sorted by `(socialAccountId, id)`, as `queueTargetsInTx` does (the F20 rule).

```ts
/** The body of retryTarget for callers that already hold the post and target locks (bulk retry). */
export async function retryLockedTarget(tx: ProjectScope, target: TargetRecord, now: Date, input: RetryInput): Promise<RetryResult>;
```

It performs steps 4 to 6. The caller does the permission check, the locking and `applyDerivedStatus`.

### Compatibility

- `retryTarget(scope, id)` with no input behaves exactly as before. It now resolves to a `RetryResult` instead of `void`, and an `await` that ignores the value is unaffected (SC-005).
- The thrown errors keep their class and message: `ConflictError`, `ForbiddenError`, `NotFoundError`, `ZodError`.

## Shared helper: `explicitSchedulePatch` (in `posts/index.ts` or `posts/schedule-patch.ts`)

```ts
export function explicitSchedulePatch(kind: "explicit" | "now", when: Date): Pick<TargetPatch,
  "scheduleKind" | "scheduledAt" | "nextAttemptAt" | "slotOccurrenceAt" | "slotId">;
// { scheduleKind: kind, scheduledAt: when, nextAttemptAt: when, slotOccurrenceAt: null, slotId: null }
```

`scheduleExplicit` spreads it in place of its five literal keys. Its behaviour does not change.

## Allocator: `src/server/services/queue/index.ts` (extended)

```ts
export async function peekNextFree(tx, accountId, opts: { after: Date; exclude?: readonly Date[]; ownOccurrence?: Date | null }): Promise<Allocation>;
export async function allocateNextFree(tx, target, opts: { after: Date; exclude?: readonly Date[]; ownOccurrence?: Date | null }): Promise<Allocation>;
```

`freeCandidates` removes `ownOccurrence` (when non-null) from the `held` set, and only then adds `exclude`. When the option is omitted, the result is byte-identical to today, so every existing caller is unchanged.

## Preview: `src/server/services/failures.ts` → `previewRequeue` (changed)

```ts
export async function previewRequeue(scope: ProjectScope, targetId: string): Promise<RequeuePreview>;
```

1. `need(scope, { post: ["schedule"] })`, then `uuid.parse`; a missing target throws `NotFoundError` (unchanged).
2. **New**: if the status is neither `failed` nor `ambiguous`, throw `ConflictError("This post is no longer failed.")` (D6).
3. `gate`: on failure, return `{ ok: false, code: g.code === "validation" ? "validation" : "account_unavailable", message }` (unchanged).
4. `peekNextFree(scope, accountId, { after: now, ownOccurrence: status === "failed" ? target.slotOccurrenceAt : undefined })` (**new** option).
5. Same return shape as today.

Writes nothing.

## Explicit-time preview: `previewExplicitTime` (unchanged, reused)

The retry dialog calls it with `{ local: "YYYY-MM-DDTHH:MM", accountIds: [accountId] }`. A `failed` target is not `scheduled`, so it never shows up in its own warnings (research F7). The composer's behaviour is untouched.

## Server action: `src/app/p/[projectSlug]/posts/actions.ts` → `retryTargetAction` (changed)

```ts
type RetryActionInput =
  | { targetId: string; mode?: "now" }
  | { targetId: string; mode: "requeue"; expected?: string }
  | { targetId: string; mode: "at"; at: string };

export async function retryTargetAction(slug: string, input: RetryActionInput): Promise<ActionResult<posts.RetryResult>>;
// const { targetId, ...rest } = input ?? {}; passes `undefined` when `rest.mode` is absent, otherwise `rest`.
// runAction(slug, scope => posts.retryTarget(scope, targetId, body)); refresh() when result.ok.
```

- Role checks stay in the service. A non-member gets `not_found`, a scope without `schedule` gets `forbidden`, and bad input gets `validation`.
- A `status: "failed"` result is still `ok: true`. The dialog reads `data.status`.
- `previewRequeueAction` is unchanged. A conflict from D6 arrives as `{ ok: false, error: "conflict", message }`.
