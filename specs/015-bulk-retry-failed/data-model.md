# Data model: bulk retry of failed targets

**Feature**: `015-bulk-retry-failed`. **No schema change and no migration.** `pnpm db:check` must stay green.

This feature reads `post_targets`, `posts`, `social_accounts` and `posting_slots`. It writes only what a single retry writes, to `post_targets`, `publish_attempts` and `posts.status`. Nothing new is stored: there is no bulk-run record and no new attempt outcome (D4, spec assumptions).

## Entities as used here

### Failed target (existing `post_targets` row)

| Field | Column | Used for |
|---|---|---|
| id | `id` | identity; final D2 tiebreak |
| post | `post_id` | the lock order (post first) |
| account | `social_account_id` | the scope filter (D8), pre-classification (P5), D5 exhaustion, per-account breakdown |
| intended time | `scheduled_at` (nullable) | D2 order: earliest first, `NULL` last |
| entered failed | `updated_at` | D2 second key |
| status | `status` | must be `failed` when read, and again under the lock |
| held occurrence | `slot_occurrence_at`, `slot_id` | requeue's `ownOccurrence` (012 D2); replaced by the new hold |
| last error | `last_error` | rewritten only on a `no_free_slot` skip (012 D3) |

**In scope** (FR-003, FR-004): `project_id` = the caller's project, `status = 'failed'`, the post is in the same project and has `deleted_at IS NULL`, and, when given, `social_account_id = account`. This uses the same `attentionWhere` and `livePost` as the Failures list. Ambiguous, scheduled and deleted-post targets are never in scope.

### DAL read: `FailedForRetry` (new, P3)

```ts
interface FailedForRetry {
  id: string;
  postId: string;
  socialAccountId: string;
  scheduledAt: Date | null;
  updatedAt: Date;
}
// targets.listFailedForRetry({ accountId?: string }): Promise<FailedForRetry[]>
// ORDER BY scheduled_at ASC NULLS LAST, updated_at ASC, id ASC — unpaginated, no lock
```

`targets.countAttention(accountId?: string)` gains the optional account filter. Calling it with no argument behaves exactly as today.

### Bulk retry request (P2)

```ts
retryAllInputSchema = z.strictObject({ account: z.uuid().optional(), mode: z.enum(["now", "requeue"]) })
retryAllScopeSchema = z.strictObject({ account: z.uuid().optional() })   // preview
```

- An unknown key (for example `targetIds`), a missing or unknown `mode`, or a malformed `account` raises `ZodError`. Nothing is read.
- An `account` that is not in the project matches nothing, so the result is `inScope: 0` (D8).

### Skip reasons (D3)

`type RetryAllSkipReason = "account_removed" | "needs_reconnecting" | "provider_unavailable" | "no_longer_failed" | "cannot_publish" | "no_free_slot"`, in this order everywhere: the message, the summary and the tests.

| Reason | Decided | Lock taken | Writes |
|---|---|---|---|
| `account_removed` / `needs_reconnecting` / `provider_unavailable` | pre-pass, from `accounts.list()` + `findProvider` (no attempt); **or** under the lock if the account changed mid-run (counts as an attempt) | no / yes | nothing |
| `no_longer_failed` | under the lock: status ≠ `failed` (incl. `publishing`), post deleted (`NotFoundError`), or a `ConflictError` from the single-retry body | yes | nothing (transaction rolled back or no-op) |
| `cannot_publish` | under the lock: requeue gate refused (`validation` / `account_unavailable`) | yes | nothing |
| `no_free_slot` | under the lock (first time per account: an attempt), then pre-pass for that account's later targets (D5, no attempt) | first only | first only: `last_error` = "Not retried — {account} has no free posting slot. Retry now or pick a time." (or "…has no active posting slots…"), plus one `retry_requested` with `{ mode: "requeue", reason }`, `error: "no_free_slot"` and the actor |

### Per-target effect of a retry (identical to a single retry, FR-005)

| Mode | `post_targets` after | `publish_attempts` |
|---|---|---|
| `now` | `status` = `scheduled`, `next_attempt_at` = now, `attempt_count` = 0, and `step_state`, `first_step_at`, `publish_started_at`, `last_error` = `NULL`. Schedule kind, intended time and any held occurrence are kept. | one `retry_requested`, `step: "user"`, empty summary, `actor_user_id` = the member |
| `requeue` | holds the new occurrence (`slot_occurrence_at`, `slot_id`, `schedule_kind = 'slot'`, `scheduled_at` = `next_attempt_at` = the instant). The old occurrence is released by the overwrite. `status` = `scheduled`, with the same resets as `now`. | one `retry_requested` with `{ mode: "requeue", scheduledAt, slotId }` and the member (no `expected` in bulk) |

`posts.status` is re-derived after every target. It is written and its webhook emitted only when it changes (F12).

### Bulk retry result (`RetryAllResult`, D10 / P7)

```ts
type SkipCounts = Record<RetryAllSkipReason, number>;      // all six keys, zero when unused

interface RetryAllResult {
  changed: boolean;          // count > 0
  message: string;           // retryAllMessage(result), P9
  count: number;             // targets retried
  mode: "now" | "requeue";
  inScope: number;           // size of the set read at the start of the run
  skipped: SkipCounts;
  remaining: number;         // eligible but beyond RETRY_ALL_CAP attempts
  accounts: {
    accountId: string;
    name: string;            // display name, or "Removed account"
    retried: number;
    skipped: SkipCounts;
    remaining: number;
  }[];                       // accounts with ≥ 1 in-scope target, by name then id
}
```

**Invariants**:

- `count + Σ skipped + remaining === inScope` (SC-005).
- The per-account rows sum to the totals.
- `changed === (count > 0)`.
- The number of attempts under a lock is at most `RETRY_ALL_CAP`.
- Nothing outside the caller's project appears.

### Bulk retry preview (`RetryAllPreview`, FR-014 / P8)

```ts
interface RetryAllPreview {
  scope: { accountId: string; accountName: string } | null;   // null = every account
  inScope: number;
  blocked: Pick<SkipCounts, "account_removed" | "needs_reconnecting" | "provider_unavailable">;
  eligible: number;          // inScope − Σ blocked
  willAttempt: number;       // min(eligible, cap)
  cap: number;               // RETRY_ALL_CAP (100)
  capApplies: boolean;       // eligible > cap
}
```

The preview reads only. When the account filter names an account that is not in the project, it returns `scope: null` and `inScope: 0`, so no name leaks.

## State transitions

```text
failed ──(bulk now, under lock)──────────────▶ scheduled (next_attempt_at = now)
failed ──(bulk requeue, gate ok, slot held)──▶ scheduled (slot occurrence)
failed ──(bulk requeue, no slot)─────────────▶ failed   (last_error rewritten, retry_requested entry)
failed ──(blocked / gate refused / D5)───────▶ failed   (unchanged)
other  ──(any)───────────────────────────────▶ other    (counted no_longer_failed)
```

The bulk run never touches an `ambiguous` target. Its explicit resolution path is unchanged (constitution V).
