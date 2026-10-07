# Research: bulk retry of failed targets

**Feature**: `015-bulk-retry-failed` | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

No external platform or library facts are needed. Every finding below comes from reading the code on this branch, which is `main` after PR #32 (012 retry modes). The one framework API used, `refresh()` from `next/cache` inside a server action, is documented in `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/refresh.md` (Next 16.3.8). It is already used the same way by `retryTargetAction`. Nothing is marked `NEEDS RESEARCH` or `NEEDS CLARIFICATION`.

## Findings from the code

| # | Finding | Where |
|---|---|---|
| F1 | `retryLockedTarget(tx, target, now, input)` is the single-retry body. The caller must already hold the post and target locks and must call `applyDerivedStatus`. It **throws** `ConflictError` for `publishing`, not-`failed` and blocked accounts. It **returns** `{ status: "failed", reason }` for the gate (`validation` / `account_unavailable`) and for no slot (`no_active_slots` / `no_free_occurrence`). The no-slot path writes `last_error` and one `retry_requested` entry with `error: "no_free_slot"`. A guard miss after a hold throws, which rolls the hold back. | `src/server/services/posts/retry.ts:54-134` |
| F2 | `withLockedTarget(scope, id, permission, fn)` checks the permission before and inside the transaction. It reads the target, locks the post (`lockForUpdate` skips soft-deleted posts and returns `null`, giving `NotFoundError`), locks every target row of the post, re-reads the target, runs `fn` with one `now`, then runs `applyDerivedStatus` and commits. Throwing from `fn` rolls the whole transaction back. | `src/server/services/posts/locked.ts:25-44`, `src/server/dal/posts.ts:231-239` |
| F3 | `retryBlockedReason(account, providerRegistered)` returns the user-facing sentence for a removed account (`account === null`), a non-`active` account, or a missing provider. It returns `null` otherwise. `targetActions` in `failures.ts` uses the same predicate for the row's "Retry…" availability. | `src/server/services/posts/retry.ts:43-48`, `src/server/services/failures.ts:112-122` |
| F4 | Removed accounts are soft-removed (`removed_at`). `accounts.get` / `accounts.list` do not return them, so the "removed" case is "id not in `accounts.list()`". `post_targets.social_account_id` is `ON DELETE RESTRICT`, so the id is always present on the target. | `src/server/db/schema/posts.ts:150-152`, `tests/helpers/failures.ts:34-39` |
| F5 | `listAttention` / `countAttention` share `attentionWhere(statuses, accountId?)` (project id, status, optional account) and the `livePost` join (same project, `deleted_at IS NULL`). `countAttention()` takes no account filter today. The partial index `post_targets_attention_idx (project_id, updated_at DESC, id) WHERE status IN ('ambiguous','failed')` already covers a read of all failed targets in a project. | `src/server/dal/targets.ts:86-130`, `src/server/db/schema/posts.ts:208-210` |
| F6 | `allocateNextFree` walks the account's free occurrences after `after`, nearest first. It tries each with `tryHoldOccurrence` in a savepoint and moves on after a unique violation. It holds at most one occurrence per call, and it only waits, on the unique index, for another transaction's uncommitted hold of the same `(account, instant)`. Holding rewrites the target's own `slot_occurrence_at`, so a target can never hold two occurrences. | `src/server/services/queue/index.ts:38-95`, `src/server/dal/targets.ts:223-242` |
| F7 | Occurrences already held, including holds committed earlier in the same bulk run, are excluded through `heldInstants`. The target's own hold is freed through `ownOccurrence` (012 P4). A failed target normally holds a **past** occurrence (012 F4), which is never a candidate. A failed target holds a future occurrence only in seeded or unusual states. | `src/server/services/queue/index.ts:39-55`, `specs/012-retry-modes/research.md` F3–F4 |
| F8 | `retryFailedItems` returns `{ changed, message, count }` with "1 item will be retried." / "{n} items will be retried." / "There are no failed items to retry.". | `src/server/services/jobs/manage.ts:36-47` |
| F9 | `runAction` maps `ZodError` to `validation` and known service errors to their codes. `failFromError` **rethrows** unknown errors, so the client's `await action()` rejects. Typed results pass through as `ok: true`. | `src/app/p/[projectSlug]/run-action.ts`, `src/lib/action-result.ts` |
| F10 | The Failures page reads `listFailures` once. It has `totals` (project-wide, not filtered by account) and `filtered` (status filter plus account filter, before paging). So on the "All" tab with an account filter, nothing on the page gives "failed targets of this account". | `src/server/services/failures.ts:129-184`, `src/app/p/[projectSlug]/failures/page.tsx:148-169` |
| F11 | The page is wrapped in `AnnounceProvider focusFallbackId="page-title"`, which gives one live region and `focusFallback()`. `Dialog` takes `returnFocus`. `Alert` defaults to `role="status"` for info and success and accepts `role="none"`. `SegmentedControl` has a `cards` layout with per-option descriptions and `disabled`. `Button` has `pending` / `pendingLabel` and is disabled while pending. | `src/components/ui/Announce.tsx`, `Dialog.tsx`, `Alert.tsx`, `SegmentedControl.tsx`, `Button.tsx` |
| F12 | `applyDerivedStatus` locks the post again (a no-op under the held lock), and writes and emits `post.*` webhooks only when the derived status changes. A skip that leaves the targets alone therefore writes nothing to the post either. | `src/server/services/posts/status.ts:26-37` |
| F13 | The scheduler's claim takes no post lock. It locks due `scheduled`/`publishing` targets and then their accounts, both with `SKIP LOCKED`, so it never waits on a user transaction. `lockForPost` in a user transaction waits out a claim that is in flight (milliseconds). | 012 research, `src/server/dal/targets.ts:163-170` |
| F14 | Integration tests for actions mock `@/server/auth/session`, `next/cache` and `next/navigation` through `tests/helpers/actions.ts`. Failed targets are seeded with `failedTarget()` / `outcomeTarget(env, "fatal")`, or by updating a draft target's `status` directly. Account states are seeded with `setAccountStatus` / `breakAccount`. Slots are paused with `pauseAllSlots`. The clock is set with `atTime`. | `tests/helpers/{actions,failures,retry,clock}.ts`, `tests/integration/failures/retry-concurrency.test.ts` |

## Decisions

Spec decisions D1–D10 stand as written. The planning-level calls below fill in the rest, and all of them go into `docs/decisions.md` under "015".

### P1 — One module, `src/server/services/posts/retry-all.ts`, next to `retryTarget`

- **Decision**: the module exports:
  - `retryAllInputSchema` and `retryAllScopeSchema`;
  - `RETRY_ALL_CAP` (100);
  - the types `RetryAllResult` and `RetryAllPreview`;
  - `retryAllFailed(scope, input)` (the run) and `previewRetryAll(scope, input)` (the dialog numbers).

  `posts/index.ts` re-exports them. The wording the UI also needs lives in a pure module with no server imports, `src/lib/failures/retry-all-text.ts`. It holds `RetryAllSkipReason`, `SkipCounts`, `SKIP_REASONS`, `SKIP_PHRASES` and `retryAllMessage`. Client components may import runtime values from it without pulling the DAL into the browser bundle. The UI imports only types from `@/server/services/posts`, as `retry-ui.ts` does today. The module imports `withLockedTarget` from `./locked` and `retryLockedTarget` / `retryBlockedKey` from `./retry`. It never imports `./index`, which keeps 012's no-cycle rule.
- **Rationale**: the run and the preview must classify targets with the same rule, and the cap must be the same number in both, so they belong in one file. The file sits next to the body it reuses. The later `api-retry-resolve` entry imports the same two functions (FR-001).
- **Alternatives**: putting it in `failures.ts` (rejected: that module is the read side, and it already imports from `./posts`, so writes there would invite a cycle). Putting it in `posts/retry.ts` (rejected: that file is the single-target contract and is already 170 lines).

### P2 — Strict input; `mode` is required

- **Decision**: `retryAllInputSchema = z.strictObject({ account: z.uuid().optional(), mode: z.enum(["now", "requeue"]) })` and `retryAllScopeSchema = z.strictObject({ account: z.uuid().optional() })`.
  - Unknown keys (`targetIds`, `at`, `expected`…), a missing or unknown `mode` and a malformed `account` all raise `ZodError` before anything is read. The action maps that to `validation`.
  - An absent input is not defaulted.
- **Rationale**: FR-003 and FR-021 forbid a caller-supplied id list. A strict object turns "sent ids anyway" into a visible bad-input error instead of silently ignoring them. Unlike the single retry, an absent mode is not a safe default for a bulk write, and the API entry wants an explicit mode.
- **Alternatives**: `z.object` (rejected: it ignores extra keys silently). Defaulting to `now` (rejected: see above).

### P3 — DAL: `targets.listFailedForRetry({ accountId? })` plus an account filter on `countAttention`

- **Decision**: a new `TargetsRepo` method, built on the same `attentionWhere(["failed"], accountId)` and `livePost` as `listAttention`. It returns `{ id, postId, socialAccountId, scheduledAt, updatedAt }[]`:
  - ordered `scheduled_at ASC NULLS LAST, updated_at ASC, id ASC` (D2);
  - unpaginated, with no lock and no text.

  `countAttention(accountId?: string)` gains the optional account filter. With no argument, today's callers are unchanged.
- **Rationale**: FR-004 asks for ids together with what ordering and pre-classification need, and nothing more. Row size is tiny (about 80 bytes), so even thousands of failed targets are one cheap indexed read. The project scope comes from the repo factory, as for every other method. That is what the scope-check test asserts.
- **Alternatives**: reusing `listAttention` with a huge `limit` (rejected: it joins text, uses the wrong order, and fakes "unpaginated"). Locking the set up front (rejected by D1).

### P4 — Per-target step: `withLockedTarget` plus pre-classification, then `retryLockedTarget` unchanged

- **Decision**: for each target the run is attempting, call `withLockedTarget(scope, id, { post: ["schedule"] }, body)`. The body:
  1. `target.status !== "failed"` → outcome `no_longer_failed`, with no write. This covers `publishing`, `scheduled`, `published`, `cancelled` and `ambiguous`.
  2. Reads the account (`tx.accounts.get`). If `retryBlockedKey(account, registered)` is not `null`, the outcome is that key (`account_removed` / `needs_reconnecting` / `provider_unavailable`), with no write.
  3. Calls `retryLockedTarget(tx, target, now, { mode })`.
     - `status: "scheduled"` → `retried`.
     - `reason: "validation" | "account_unavailable"` → `cannot_publish`. This comes from the gate, and only in requeue mode, with no write.
     - `reason: "no_active_slots" | "no_free_occurrence"` → `no_free_slot`. This writes what a single refused requeue writes, and marks the account exhausted for D5.

  Around the call:
  - `NotFoundError` (the post was deleted or the target is gone) is caught and counted as `no_longer_failed`.
  - `ConflictError` is caught and counted as `no_longer_failed`. Under the held locks it can only come from `retryLockedTarget`'s own re-checks, for example an account disconnected between step 2 and its re-read. The transaction has rolled back, so nothing was written, exactly as a refused single retry.
  - Any other error propagates and ends the run (FR-013).
- **Rationale**: FR-005 requires stored state identical to a single retry. Calling the exact single-retry body under the exact single-retry locking gives that by construction. Steps 1–2 duplicate no logic: they classify through the same predicate before the body would throw, so the run can count a reason instead of parsing an error message. `applyDerivedStatus` runs inside `withLockedTarget` after every target, and writes only on change (F12).
- **Alternatives**: catching `ConflictError` and mapping its message to a reason (rejected: brittle string matching). A new bulk-specific body (rejected: a second retry implementation, against constitution IV).

### P5 — `retryBlockedKey`: one predicate, two outputs

- **Decision**: `retry.ts` gains `retryBlockedKey(account, providerRegistered): "account_removed" | "needs_reconnecting" | "provider_unavailable" | null`. `retryBlockedReason` becomes a switch over that key and keeps its exact sentences. The run's pre-classification uses the key, with one `accounts.list()` and `findProvider` per account. So does the in-lock step 2 (P4) and the preview (P8).
- **Rationale**: the row's disabled "Retry…", the single retry, the bulk preview and the bulk run can then never disagree about what "blocked" means (FR-006).

### P6 — Pre-pass and cap accounting, in D2 order

- **Decision**: `retryAllFailed` does the following:
  1. `need(scope, { post: ["schedule"] })`, then parse the input.
  2. Read the set (P3) and `accounts.list()` once.
  3. Walk the set in order:
     - **Account blocked** (from the pre-read): count under its key. No lock.
     - **Requeue mode, account already exhausted in this run** (D5): count `no_free_slot`. No lock, no write.
     - **Attempted count has reached `RETRY_ALL_CAP`**: count `remaining`.
     - **Otherwise**: attempt (P4) and add one to the attempted count, whatever the outcome.

  The result's `inScope` is the size of the set read in step 2. So `retried + Σ skipped + remaining = inScope` always holds (SC-005).
- **Rationale**: this matches D5–D6 literally. Blocked targets and D5 skips never use up the cap. Only the cap limits work under the locks.
- **Cap value**: **100**, fixed. One attempt is one short transaction: about four indexed reads, the gate's content load in requeue mode, at most one occurrence walk, and two or three writes. Each is measured in tens of milliseconds locally, so 100 fits well under SC-004's 10 s. The implement phase runs the cap test (100 requeue attempts) and records its measured wall time in `docs/decisions.md`. If that time is over 5 s, the cap is lowered to 50 and the decision says why. No configuration knob is added: the spec asks for a fixed, tested number.
- **Alternatives**: a time budget instead of a count (rejected: not deterministic to test, and "press again" would cover a varying number of posts). Making the cap an env var (rejected: one more knob, and still needs a tested default).

### P7 — Result shape and per-account breakdown

- **Decision**: the result is JSON-serialisable, with no `Date`. Its fields:
  - `changed`, `message`, `count`, `mode`, `inScope`, `remaining`;
  - `skipped`: all six D3 keys, always present, zero when unused;
  - `accounts`: one entry per account with at least one in-scope target, ordered by name then id. Each entry has `{ accountId, name, retried, skipped (six keys), remaining }`. `name` is the display name, or "Removed account" for a removed one, as the list shows it.

  The full shape is in [data-model.md](./data-model.md).
- **Rationale**: D10 and FR-010 require it. Fixed keys make the result easy for a client and the later API to read, and easy for tests to assert. It carries only project-scoped account ids and names: no tokens and no other project's data.

### P8 — The preview, `previewRetryAll(scope, { account? })`, reads only

- **Decision**: the preview does the following:
  - checks the same permission (`post: ["schedule"]`) and reads the same set as P6 step 2;
  - classifies blocked accounts with the same key (P5);
  - returns `{ inScope, blocked: { account_removed, needs_reconnecting, provider_unavailable }, eligible, willAttempt: min(eligible, RETRY_ALL_CAP), cap: RETRY_ALL_CAP, capApplies: eligible > RETRY_ALL_CAP, scope }`, where `scope` is `{ accountId, accountName }` or `null` for every account.

  The preview does not depend on the mode and does not predict D5 or gate outcomes. Those depend on locks and on time, and the result reports them (spec edge case "snapshot"). It writes nothing.
- **Rationale**: FR-014 requires "known blocked by account-level reasons" and nothing more. A per-target gate or slot preview for up to 100 targets would cost as much as the run itself.

### P9 — Messages: pure `retryAllMessage(result)` in `src/lib/failures/retry-all-text.ts`, with fixed phrases

- **Decision**: the message is built from the following parts, joined by single spaces:
  - **Lead**:
    - `inScope === 0` → "There are no failed posts to retry." (and nothing else);
    - `count === 0` → "No posts were retried.";
    - now → "1 post will be retried." / "{n} posts will be retried.";
    - requeue → "1 post was queued into the next free slot." / "{n} posts were queued into the next free slots.".
  - **Skips**: when the total is above zero, "Skipped {k}: " plus the non-zero reasons, in D3 table order, joined by ", " and ended with ".". Each reason has a singular and a plural phrase:

    | Key | 1 | n |
    |---|---|---|
    | `account_removed` | 1 on a removed account | {n} on removed accounts |
    | `needs_reconnecting` | 1 needs reconnecting | {n} need reconnecting |
    | `provider_unavailable` | 1 with an unavailable provider | {n} with an unavailable provider |
    | `no_longer_failed` | 1 no longer failed | {n} no longer failed |
    | `cannot_publish` | 1 can't be published as is | {n} can't be published as is |
    | `no_free_slot` | 1 no free slot | {n} no free slot |

  - **Remaining**: "1 more failed post was not retried yet." / "{n} more failed posts were not retried yet.", then "Press Retry all failed again to continue."

  Examples: "10 posts will be retried. Skipped 2: 2 need reconnecting." and "No posts were retried. Skipped 3: 2 need reconnecting, 1 no free slot.".
- **Rationale**: these match D10's examples word for word. Reasons are phrased so that "{n} {phrase}" reads as a sentence. The phrases also feed the per-account lines in the UI summary, so the wording is defined once, as `SKIP_PHRASES` in `src/lib/failures/retry-all-text.ts` (P1).
- **Alternatives**: the bare D3 labels with a number ("2 account removed"; rejected because it reads as if accounts, not posts, were counted).

### P10 — Server actions in `src/app/p/[projectSlug]/failures/actions.ts`

- **Decision**: the file has `"use server"` and two actions:
  - `retryAllFailedAction(slug, input)` builds `{ account, mode }` from `input?.account` and `input?.mode` only, and passes it to `posts.retryAllFailed` through `runAction`. It calls `refresh()` when `ok`.
  - `previewRetryAllAction(slug, input)` builds `{ account }` the same way and calls `posts.previewRetryAll`.

  No permission logic sits in the action (FR-021).
- **Rationale**: these are the page's own actions, and the shape follows `posts/actions.ts`. The action deliberately builds a fresh object, so even a client that sends `targetIds` cannot reach the service with them. A direct service call that includes them is refused by P2.

### P11 — Failures page: `failedInFilter`, and a client island that outlives the button

- **Decision**:
  - **Service**: `listFailures` adds `failedInFilter: number`. That is `totals.failed` with no account filter, otherwise `countAttention(query.account).failed`. It ignores the tab and the page (FR-016, US3 AS3).
  - **Page**: when `canSchedule && query.status !== "ambiguous" && list`, the page renders a new client component `<RetryAllFailed key={`${query.status}:${query.account ?? ""}`} … />` inside the filter bar. The component renders the button only when `failedInFilter > 0`. It always renders the last result summary it holds, so the summary survives the `refresh()` that may remove the button (US1 AS4). The `key` resets the summary when the filter changes, which is the "cleared on the next navigation" assumption.
- **Rationale**: a server component cannot hold "the last result". A leaf client component keyed by the filter is the smallest client surface (docket-ui: server by default, client leaf for interactivity).
- **Focus**: the pure helper `controlRemains(result)` is true when `remaining + Σ skipped − skipped.no_longer_failed > 0`. Those targets are still `failed`, so the button is still rendered after the refresh. If it is true, the dialog returns focus to the button (`returnFocus`). If not, focus goes to `focusFallback()`, the page heading (FR-019).

### P12 — Dialog `RetryAllDialog` and pure `retry-all-ui.ts`

- **Decision**: the dialog uses only existing parts: `Dialog`, `SegmentedControl` (`cards`), `Alert`, `Button` and `useAnnounce`.
  - **On open**: it loads `previewRetryAllAction` in its own transition, as `RetryDialog` does. "Retry now" is preselected (D9).
  - **Pending**: the confirm `Button` uses `pending` (which disables it) and a ref guard against a second submit during the transition (FR-018). Escape and Back still close the dialog, and the run carries on on the server (spec edge case).
  - **Errors**: an `ok: false` result shows its message in a `role="alert"` line. A rejected promise (an unexpected error, F9) shows "Some posts may have been retried. Reload the page to see where things stand.".

  All wording, enablement and summary lines live in `retry-all-ui.ts` and are unit-tested, because there is no DOM test library (012 P10).
- **Rationale**: this is the same pattern as 012, so behaviour and keyboard handling match the single-retry dialog.

### P13 — Concurrency argument (D1, FR-011) and what the tests force

- **Lock order of one bulk step**: post row → that post's target rows → (requeue) at most one held occurrence of one account. That is the single-retry order. Within the run, steps are sequential and each commits before the next starts, so the run never holds two posts at once.
- **Against the scheduler**: the claim never waits (`SKIP LOCKED`, F13). The bulk step waits at most for a claim's short transaction. No cycle is possible.
- **Against a single retry or another bulk run**: both take post → targets on one post. Whichever gets the post lock first wins. The other re-reads the target under the lock, sees it is not `failed`, and reports `no_longer_failed` (bulk) or "This post is no longer failed." (single).
- **Against queueing (F20 order) and allocator moves**: an allocating bulk step holds no occurrence while it waits on the unique index, because a successful hold ends the walk (F6). It never waits on a post lock after it holds an occurrence. So it cannot be the holder in a wait cycle with a transaction that holds occurrences in (account, target id) order and waits on posts.
- **No double effects**: the `statuses: ["failed"]` write guard plus the under-lock re-check mean one retry per target per failed spell, and one `retry_requested` entry per retry. The occurrence unique index means one holder per instant.
- **Tests**: these force the races with `Promise.allSettled` (the style of `failures/retry-concurrency.test.ts`). They run two bulk runs (now + requeue), bulk + `runTick()`, bulk + `retryTarget` on one of its targets, and bulk requeue + `addToQueue` / single requeue on the same account. They assert that every promise settles (no deadlock or timeout), that each target has exactly one new `retry_requested` entry, that no `(account, slot_occurrence_at)` repeats, and that the counts add up.

### P14 — Docs

- **Decision**:
  - `docs/failures.md` gains a "Retrying every failed post" section covering scope, the two modes, order, skip reasons, the 100 cap and "press again", and safety under repeated presses.
  - `docs/decisions.md` gains "## 015 — Bulk retry of failed targets", holding D1–D10 and P1–P14. That section is written now, by this phase.
  - The README's Failures sentence (line 11) adds that every failed post can be retried at once. The `docs/index.md` row becomes "Retrying failed posts, one at a time or all at once".
  - No `docs/research/` entry is needed.
