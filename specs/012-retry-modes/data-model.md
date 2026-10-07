# Data model: Retry modes for a failed target

**Feature**: `012-retry-modes` | **Date**: 2026-10-06

**No schema change and no migration.** No table, column, enum value or constraint is added or altered. `retry_requested` already exists in `publish_attempt_outcome` (research F8, P8). `pnpm db:check` is unaffected.

This document records how the existing rows change in each mode, and the two non-stored shapes (input and result) that later entries reuse.

## Post target (`post_targets`), the fields this feature touches

| Column | `now` (unchanged) | `requeue` success | `at` success | `requeue` refused (no slot) | any other refusal |
|---|---|---|---|---|---|
| `status` | `failed` → `scheduled` | `failed` → `scheduled` | `failed` → `scheduled` | stays `failed` | unchanged |
| `schedule_kind` | kept | `slot` | `explicit` | kept | unchanged |
| `scheduled_at` | kept | the new occurrence | `at` | kept | unchanged |
| `next_attempt_at` | `now` | the new occurrence | `at` | kept | unchanged |
| `slot_occurrence_at`, `slot_id` | kept (old hold, if any) | the new occurrence and slot; any old hold is released by the same statement | `NULL`, `NULL` (hold released) | kept | unchanged |
| `attempt_count` | `0` | `0` | `0` | kept | unchanged |
| `step_state`, `first_step_at`, `publish_started_at` | `NULL` | `NULL` | `NULL` | kept | unchanged |
| `last_error` | `NULL` | `NULL` | `NULL` | the explanation (research P6) | unchanged |
| `updated_at` | bumped | bumped | bumped | bumped | unchanged |

"Kept" means the value from before the retry. Columns not listed (`override_text`, `external_*`, `lease_*`, `in_flight_*`, `resolved_*`) are never written by a retry. That matches today's retry: the engine clears the lease and in-flight columns when a target fails.

### Constraints the writes must respect (all existing)

- `post_targets_occurrence_uq (social_account_id, slot_occurrence_at) WHERE slot_occurrence_at IS NOT NULL`: one holder per occurrence. `requeue` takes its occurrence only through `allocateNextFree` → `tryHoldOccurrence` (savepoint, `23505` means "try the next one").
- `post_targets_occurrence_is_slot`: a held occurrence implies `schedule_kind = 'slot'`. `tryHoldOccurrence` sets both together. `at` clears the occurrence in the same statement that sets `explicit`.
- `post_targets_live_has_schedule`: `scheduled` needs `next_attempt_at`, `scheduled_at` and `schedule_kind`. `requeue` and `at` set all three. `now` relies on the values the target already had (unchanged from today).

### State transitions

```text
failed ──retry(now)──────────────▶ scheduled (old kind / instant / hold)
failed ──retry(requeue, slot)───▶ scheduled (slot @ next free occurrence)
failed ──retry(requeue, none)───▶ failed    (last_error = explanation)
failed ──retry(at > now)────────▶ scheduled (explicit @ at, no hold)
failed ──retry(at ≤ now | invalid content | gate account_unavailable)──▶ failed (no write)
publishing ──retry(any)──▶ ConflictError "Publishing in progress. Try again in a moment."
other status ──retry(any)──▶ ConflictError "This post is no longer failed."
blocked account / provider ──retry(any)──▶ ConflictError (retryBlockedReason text)
```

The guard on the write is `statuses: ['failed']`. A guard miss throws `ConflictError("This post is no longer failed.")` and rolls the transaction back, including any occurrence just taken.

### Occurrence rule for a failed target (D2, research P4)

When looking for the next free occurrence for target *T*, the instant in *T*'s own `slot_occurrence_at`, if it has one, counts as free for *T*. The preview and the allocation both apply this, through the same `ownOccurrence` option. Candidates start strictly after `now`, so a past own-hold is never offered. After a successful requeue, *T* holds exactly one occurrence: the new one.

## Slot occurrence

Not stored on its own. It is computed from `posting_slots` (active only) by `occurrencesBetween` within `QUEUE_HORIZON_DAYS`. It is "taken" when any `post_targets` row of the account has that `slot_occurrence_at`, apart from *T*'s own as described above.

## Attempt entry (`publish_attempts`), the rows this feature writes

Each row has `step = 'user'`, `outcome = 'retry_requested'`, `actor_user_id` = the acting member, and `created_at` = the transaction's `now`.

| Case | `request_summary` | `error` |
|---|---|---|
| `now` (unchanged) | `{}` | `NULL` |
| `requeue` success | `{ "mode": "requeue", "scheduledAt": ISO, "slotId": uuid, "expected"?: ISO }` | `NULL` |
| `at` success | `{ "mode": "at", "scheduledAt": ISO }` | `NULL` |
| `requeue` refused, no slot | `{ "mode": "requeue", "reason": "no_active_slots" \| "no_free_occurrence" }` | `"no_free_slot"` |
| other refusals (in past, validation, gate account unavailable, conflict, forbidden, invalid input) | no row written | — |

There are no secrets in any summary, only instants and ids (constitution VII).

## Post (`posts`)

`status` is re-derived by `applyDerivedStatus` at the end of `withLockedTarget`, as today, for every mode, including the refused requeue.

## Non-stored shapes

### Retry request (`retryInputSchema`, exported)

```text
undefined | null                         → treated as { mode: "now" }
{ mode: "now" }
{ mode: "requeue", expected?: ISO-8601 instant with offset }
{ mode: "at", at: ISO-8601 instant with offset }        (atSchema)
```

An unknown `mode`, a missing `at` or a non-ISO value is a `ZodError`. The action layer turns it into `{ ok: false, error: "validation" }`, and nothing is changed.

### Retry result (`RetryResult`, exported)

```text
{ status: "scheduled", mode: "now" | "requeue" | "at",
  scheduledAt: ISO, localTime: "YYYY-MM-DDTHH:MM <zone>", slotId: uuid | null,
  changedFromPreview: boolean, warnings: Warning[] }
| { status: "failed",
    reason: "no_active_slots" | "no_free_occurrence" | "in_past" | "validation" | "account_unavailable",
    message: string, issues?: ValidationIssue[] }
```

- `now`: `scheduledAt` is the retry instant, `slotId: null`, `changedFromPreview: false`, `warnings: []` (D4).
- `requeue`: `changedFromPreview` is true only when `expected` was given and differs from the instant taken. `warnings: []`.
- `at`: `slotId: null`, `changedFromPreview: false`, and `warnings` from `nearQueuedWarnings`, excluding the target itself.

### Requeue preview (`RequeuePreview`, unchanged type)

```text
{ ok: true, scheduledAt, localTime, slotId }
| { ok: false, code: "no_active_slots" | "no_free_occurrence" | "account_unavailable" | "validation", message }
```

The new behaviour is that a target that is neither `failed` nor `ambiguous` throws `ConflictError("This post is no longer failed.")` (D6).
