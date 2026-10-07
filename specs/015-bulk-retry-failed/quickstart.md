# Quickstart: validating "Retry all failed"

**Feature**: `015-bulk-retry-failed`

This guide shows how to prove the feature works. The contracts are in [contracts/services.md](./contracts/services.md) and [contracts/ui.md](./contracts/ui.md). The row effects, result shape and invariants are in [data-model.md](./data-model.md).

## Prerequisites

- Node 24, pnpm, and dependencies already installed. Nothing new is added.
- Postgres reachable through `DATABASE_URL`, as for every integration test. Test databases are run-scoped.
- No migration. `pnpm db:check` must stay green without one.
- Seeding uses the existing helpers:
  - `failedTarget()` and `outcomeTarget(env, "fatal")` create failed targets.
  - A direct `scope.targets.update(id, { status: "failed", scheduledAt })` on draft targets produces many failed targets with chosen intended times quickly.
  - `setAccountStatus` and `breakAccount` set account states, and `pauseAllSlots` takes slots away.
  - `atTime` sets the clock, and `parkAllDueTargets` runs in `beforeEach`.

## Automated checks

While implementing, run only the affected files:

```bash
pnpm vitest run tests/integration/failures/ src/components/targets/ src/lib/failures/ < /dev/null
pnpm typecheck < /dev/null
pnpm lint src/server/services/posts src/server/services/failures.ts src/server/dal/targets.ts src/lib/failures src/components/targets 'src/app/p/[projectSlug]/failures' < /dev/null
```

At the end of the implement phase, run the full pass once:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build
```

`pnpm build` is included because a new server-action module and new client components cross the server/client boundary.

### Test map (FR-023, SC-001–SC-007)

| File (new unless noted) | Proves |
|---|---|
| `src/lib/failures/retry-all-text.test.ts` | Every example message in contracts/services.md §1, verbatim. Singular and plural for each reason, each lead and the remaining sentence. Reasons always appear in D3 order. |
| `tests/integration/failures/retry-all.test.ts` | <ul><li>**Filter respect**: an account filter, and only `failed` targets of live posts. Ambiguous, scheduled and deleted-post targets are neither touched nor counted (US1 AS3, US3 AS1/AS3: targets beyond page 1 are included).</li><li>**"Now" effect**: identical to `retryTarget(…, {mode:"now"})`. Compare columns and the `retry_requested` entry (actor, empty summary) against a single retry of a twin target (FR-005, FR-009).</li><li>**Skip reasons**: each reason with its count and no write, for removed, `needs_reauth` and provider-missing accounts. Requeue's `cannot_publish` (media removed), and the same target retried under `now` (US2 AS4).</li><li>**Per-account breakdown** sums, and `count + Σ skipped + remaining = inScope` (SC-005).</li><li>**Nothing in scope**: "There are no failed posts to retry.", `changed: false`.</li><li>**Bad input**: an unknown key `targetIds`, a missing or unknown `mode`, and a malformed `account` raise `ZodError` with nothing changed.</li><li>**Idempotent second press**: zero targets changed and no new entries; only the still-failed ones are reported (US4 AS4, SC-006).</li><li>**Post status**: re-derived after the run.</li><li>**`previewRetryAll`**: numbers match the run's pre-pass, and it writes nothing (row and entry counts unchanged).</li></ul> |
| `tests/integration/failures/retry-all-requeue.test.ts` | <ul><li>**Ordering**: account A's targets intended at 08:00, 09:00 and 10:00 take A's next three occurrences in that order, and account B's take B's next two (US2 AS1, SC-003).</li><li>**No double-booking**: no repeated `(account, slot_occurrence_at)`, and each target holds only its new occurrence.</li><li>**Own occurrence**: a target holding its own future occurrence keeps or takes it, and no other target takes it (edge case).</li><li>**Too few occurrences**: two free occurrences for three targets give the third target the D3 message and entry, counted `no_free_slot` (US2 AS2).</li><li>**D5**: account C has no active slots. Only its first target gets an entry. The others are counted `no_free_slot` with no write, and other accounts are still processed (US2 AS3, FR-007).</li><li>**Requeue entries**: identical to a single requeue (`{mode, scheduledAt, slotId}` and the actor).</li></ul> |
| `tests/integration/failures/retry-all-cap.test.ts` | <ul><li>**Cap**: 230 retriable targets give exactly 100 retried, the 100 earliest in D2 order. `remaining: 130` and the "press again" message. A second press retries the next 100 and a third the last 30 (US5 AS1).</li><li>**Blocked targets do not use the cap**: 150 blocked plus 20 retriable give all 20 retried in one press (US5 AS2).</li><li>**Preview**: `capApplies` and `willAttempt: 100` when over the cap (US5 AS3).</li><li>**Timing**: logs the wall time of a 100-attempt requeue press, which goes into `docs/decisions.md` (P6, SC-004).</li></ul> |
| `tests/integration/failures/retry-all-concurrency.test.ts` | Races forced with `Promise.allSettled` (P13):<ul><li>Two bulk runs, now plus now, and now plus requeue.</li><li>A bulk run plus `runTick()`.</li><li>A bulk run plus `retryTarget` on one of its targets. Either the single retry wins and the bulk run counts it `no_longer_failed`, or the bulk run wins and the single retry gets `ConflictError("This post is no longer failed.")`.</li><li>A bulk requeue plus `addToQueue` and a single requeue on the same account.</li></ul>Every case asserts that all promises settle (no deadlock or timeout), that each target has exactly one new `retry_requested` entry, that no occurrence is held twice, that the tick never attempts a target that was still `failed` when claimed, and that the summed counts are consistent (US4, SC-002). |
| `tests/integration/failures/authz.test.ts` (extended) | <ul><li>`retryAllFailedAction` and `previewRetryAllAction` return `not_found` for a non-member and for another project's slug.</li><li>`retryAllFailed` and `previewRetryAll` throw `ForbiddenError` for a stub scope without `post:schedule` and for a read-only API-key scope, with nothing changed.</li><li>**Project isolation**: project 1's run, with no filter and with project 2's account id, leaves every project 2 target, occurrence and entry unchanged. The foreign id gives "There are no failed posts to retry." (US6, FR-002).</li></ul> |
| `tests/integration/failures/list.test.ts` (extended) | `failedInFilter`: the project-wide failed count with no filter, and only that account's failed targets with an account filter. It is the same on the "All" and "Failed" tabs and on every page, and it ignores ambiguous targets. |
| `src/components/targets/retry-all-ui.test.ts` | `retryAllLabel` for the four FR-016 forms, `retryAllTitle`, `previewLines` (cap note, blocked lines), `canConfirmAll` (loading, zero, positive), `confirmAllLabel`, `controlRemains` (only `no_longer_failed` plus retried gives false; any other skip or remaining gives true), `summaryAccounts` (more than one account only). |
| `tests/integration/failures/ui.test.tsx` (extended) | Static markup:<ul><li>The `RetryAllFailed` button and its label with and without an account name.</li><li>No button when `failedCount` is 0.</li><li>`RetryAllDialog` open: the title names the scope, two labelled radios with "Retry now" checked, and confirm disabled while loading.</li><li>Page-level: no control on the ambiguous tab, and no control for a scope without `schedule`.</li></ul> |

## Manual walk-through (not claimed as verified until it is run)

1. `pnpm dev`, then sign in as an editor of a project that has two connected mock accounts with posting slots.
2. Make about six posts fail across both accounts (mock provider `behaviour: "fatal"`), and mark one account "needs reconnecting".
3. Open **Failures**. The control reads "Retry all 6 failed posts". On **Needs your decision**, it is absent.
4. Filter to one account. The label names the account and its count.
5. Use only the keyboard. Tab to the control and press Enter. The dialog title names the scope, "Retry now" is selected, and the counts and blocked reasons are shown. Arrow to "Requeue into next free slots", Tab to "Requeue posts", and press Enter.
6. The announcement and the visible summary match the result. The list refreshes. Focus is on the control if failed targets remain, otherwise on the "Failures" heading.
7. Press again. Only still-blocked targets are reported, and nothing else changes.
8. Sign in as a viewer without schedule rights (or use a stub role in a test). There is no control.
