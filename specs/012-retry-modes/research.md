# Research: Retry modes for a failed target

**Feature**: `012-retry-modes` | **Date**: 2026-10-06 | **Spec**: [spec.md](./spec.md)

This feature uses no external platform facts and no new library, so it needs nothing from `docs/research/` (constitution I). Every finding below comes from reading the code on `main` at `3a1795d`. The file paths cited are the sources. Planning decisions are numbered **P1–P12**. They sit beside the spec's D1–D6, and all of them go into `docs/decisions.md` (FR-023).

## Findings from the current code

| # | Finding | Source |
|---|---|---|
| F1 | `retryTarget(scope, targetId)` returns `void`. It runs inside `withLockedTarget`, which locks the post, then all of the post's targets (`lockForPost`, `FOR UPDATE`), then re-reads the target. It throws `ConflictError` for `publishing` / not `failed` / `retryBlockedReason`. It makes one guarded `update` (`statuses: ['failed']`) and writes one `retry_requested` attempt whose `requestSummary` is the default `{}`. | `src/server/services/posts/index.ts:602-659` |
| F2 | `allocateNextFree` walks the free candidates and calls `tryHoldOccurrence` on each one inside a savepoint. That call sets `slotOccurrenceAt`, `slotId`, `scheduleKind='slot'`, `scheduledAt` and `nextAttemptAt` together. Because the target has a single occurrence column, taking a new occurrence drops the old one in the same statement. A `23505` on `post_targets_occurrence_uq (social_account_id, slot_occurrence_at)` moves the walk on to the next candidate. | `src/server/services/queue/index.ts:75-93`, `src/server/dal/targets.ts:223-242`, `src/server/db/schema/posts.ts:182-188` |
| F3 | `freeCandidates` marks every instant from `heldInstants(account, after, to)` as taken, whatever the holder's status. That includes the occurrence the target itself holds. So for a failed target that still holds a **future** occurrence, both `peekNextFree` and `allocateNextFree` skip that occurrence today. D2 / FR-007 require it to count as free for that target. | `src/server/services/queue/index.ts:38-53` |
| F4 | Nothing releases an occurrence when a target fails: the engine's `release` path restores the pre-claim columns, and slot pause and delete leave `slot_occurrence_at` in place (`slot_id` goes `NULL` on delete). So a failed target normally still holds its original **past** occurrence. It holds nothing if it was explicit or "now", or if it was cancelled and later re-queued explicitly. Tests can seed a future hold directly. | `src/server/scheduler/publishing.ts:257-280`, `src/server/db/schema/posts.ts:155-157` |
| F5 | `scheduleExplicit` refuses `when <= now` with `in_past` ("That time has passed. Use Publish now instead."), runs `gate`, and makes one update. That update sets `scheduleKind`, `scheduledAt`, `nextAttemptAt`, clears `slotOccurrenceAt`/`slotId` and resets the counters. It then returns `nearQueuedWarnings(tx, account, when, t.id)`. | `src/server/services/posts/index.ts:505-567` |
| F6 | `previewRequeue` checks permissions, runs `gate`, then `peekNextFree(after: now)`. It does not look at the target's status and does not apply F3's own-hold rule. Both the ambiguous dialog and (from now on) the retry dialog use it. | `src/server/services/failures.ts:192-202` |
| F7 | `previewExplicitTime({ local, accountIds, postId? })` resolves a wall-clock time with `resolveLocalDateTime` (Temporal, earlier on overlap, forward on gap). It reports `kind: exact/gap/overlap`, `inPast` and near-post warnings for the listed accounts. It needs only `post: ['view']`. `nearScheduled` reads only `status='scheduled'` rows, so a `failed` target never warns about itself. The composer's `ScheduleAtDialog` and its `previewText` turn that result into words. | `src/server/services/posts/compose.ts:88-136`, `src/app/p/[projectSlug]/compose/ScheduleDialogs.tsx:158-262` |
| F8 | `publish_attempt_outcome` already has `retry_requested` and `requeued`. | `src/server/db/schema/attempts.ts:7-28` |
| F9 | `TargetResolution` holds its own `LiveRegion`. On the Failures page a successful retry turns the target `scheduled`, the action's `refresh()` drops the row from the list, and the row's live region unmounts with it, so the announcement can be lost. The dialog's focus return (`returnTo`) also points at a button that no longer exists. Today's single Retry button has the same latent problem. | `src/components/targets/TargetResolution.tsx:105-116`, `src/components/ui/Dialog.tsx:21-34`, `src/server/services/failures.ts:129-142` |
| F10 | There is no DOM test library. UI tests use `renderToStaticMarkup`, so interactive logic must live in pure, unit-testable helpers. | `tests/integration/failures/ui.test.tsx`, `package.json` |
| F11 | Every role (`owner`, `admin`, `editor`) has `post: ['schedule']`. A refusal is tested with a read-only API key, a stub scope without `schedule`, or a non-member, as the current `failures/authz.test.ts` does. | `src/server/auth/access.ts`, `tests/integration/failures/authz.test.ts` |
| F12 | No docs page describes Failures. README lines 10–11 mention retry and resolve in one sentence. `docs/index.md` "Using Docket" lists the topic pages. | `README.md`, `docs/index.md` |

## Decisions

### P1 — Input: one exported Zod union; absent input means `now`

- **Decision**: `retryInputSchema = z.discriminatedUnion("mode", [{ mode: "now" }, { mode: "requeue", expected?: iso }, { mode: "at", at: atSchema }])`. It is exported from `src/server/services/posts/retry.ts`. `retryTarget(scope, targetId, input?)` maps `undefined` and `null` to `{ mode: "now" }` **before** parsing. `expected` and `at` both accept an ISO-8601 instant with an offset (`z.iso.datetime({ offset: true })`; `at` reuses `atSchema`).
- **Rationale**: FR-001/FR-002. A discriminated union reports an unknown `mode` as one clear issue on `mode`. Accepting offsets now saves `api-retry-resolve` from widening the schema later. Unknown extra keys are stripped, as in `resolveSchema`.
- **Alternatives**: a `mode` enum plus optional fields, checked by hand. Rejected because it gives worse error paths and lets `{ mode: "now", at }` through silently.

### P2 — Result: `RetryResult`, modelled on `ResolveResult`

- **Decision**: `RetryResult` is either `{ status: "scheduled", mode, scheduledAt, localTime, slotId: string|null, changedFromPreview, warnings }` or `{ status: "failed", reason: "no_active_slots"|"no_free_occurrence"|"in_past"|"validation"|"account_unavailable", message, issues? }`.
  - **Thrown, not returned**: conflicts (`publishing`, no longer failed, blocked account), `ForbiddenError`, `NotFoundError` and `ZodError` throw exactly as today (FR-012).
  - **`now`**: reports `scheduledAt = now`, `slotId: null`, `changedFromPreview: false`, `warnings: []` (D4).
- **Rationale**: a returned union lets the bulk entry collect per-target outcomes without try/catch, and lets the API entry map reasons to codes. It uses the allocator's two codes rather than `ResolveResult`'s merged `no_free_slot`, because the UI and API word the two cases differently ("add a slot" against "pick a time").
- **Alternatives**: reuse `TargetResult<…>`. Rejected because it carries `targetId`/`accountId` and `not_queueable`, which do not apply here.

### P3 — Where the code lives

- **Decision**: a new module `src/server/services/posts/retry.ts` holds `retryInputSchema`, `RetryResult`, `retryLockedTarget(tx, target, now, input)` (the in-lock body) and `retryTarget` (the `withLockedTarget` wrapper).
  - **Moves**: `withLockedTarget`, `gate` and `retryBlockedReason` keep their behaviour. `posts/index.ts` re-exports the new names so `@/server/services/posts` stays the single import.
  - **Lock helper**: `withLockedTarget` is exported from index, or moved to a small `posts/locked.ts` so that `retry.ts` can import it without an import cycle.
- **Rationale**:
  - `index.ts` is already 769 lines.
  - `bulk-retry-failures` needs the in-lock body so it can do its own locking (posts in id order, then occurrences in account order, the F20 rule in `queueTargetsInTx`).
  - Constitution IV: one implementation, many callers.
- **Alternatives**: grow `retryTarget` in place. Rejected because the next entry would have to split it anyway.

### P4 — Own-hold rule (D2): an `ownOccurrence` option on the allocator

- **Decision**:
  - **The option**: `freeCandidates`, `peekNextFree` and `allocateNextFree` take an optional `ownOccurrence?: Date | null`. That one instant is removed from the `held` set before filtering. Callers pass `target.slotOccurrenceAt`, read under the lock (the preview reads it without one).
  - **Why it is exact**: `post_targets_occurrence_uq` means at most one row holds a given (account, instant), so removing that instant frees it for exactly this target. `tryHoldOccurrence` on the target's own instant rewrites the same values on the same row, so it raises no unique violation.
  - **Who passes it**: only the retry `requeue` mode and `previewRequeue` for a `failed` target. `resolveAmbiguous`, `queueTargetsInTx`, `moveToNextFreeSlot` and `pullQueueForward` pass nothing, so their behaviour is unchanged (FR-022).
- **Rationale**: preview and allocation use the same function with the same input, so they agree (FR-007). A past own-hold is never a candidate, because candidates start after `now`. After a successful requeue the single column holds only the new instant, which releases the old one (F2).
- **Alternatives**:
  - Release the own occurrence before allocating. Rejected because it writes in the preview path, or makes the preview and the allocation differ.
  - Switch to `heldOccurrences` and filter by target id. Equivalent, but it returns more data than needed.

### P5 — `requeue`: order of operations, so nothing is ever half-scheduled

- **Decision**: inside `withLockedTarget` (post lock → target locks → re-read):
  1. Status checks (F1), with unchanged messages.
  2. `retryBlockedReason` → `ConflictError` with today's words (FR-003).
  3. `gate(tx, target)` → on failure, return `{ status: "failed", reason: g.code, message: g.message, issues }` with no writes (FR-009).
  4. `allocateNextFree(tx, target, { after: now, ownOccurrence })`:
     - **No occurrence**: go to P6.
     - **Got one**: it is now held by this target, inside this transaction.
  5. Guarded `update(..., { statuses: ["failed"] })` that sets `status: "scheduled"` and the FR-004 resets. Step 4 has already set the kind, the instant and `nextAttemptAt`, and this update leaves them alone. A guard miss **throws** `ConflictError("This post is no longer failed.")`, which rolls back the hold.
  6. The attempt entry (P8). `withLockedTarget` then runs `applyDerivedStatus`.
- **Rationale**:
  - The hold and the status change commit together or not at all (FR-006, SC-002).
  - The scheduler's claim needs `status IN ('scheduled','publishing')` and uses `SKIP LOCKED` on target rows that this transaction has locked. So it sees either `failed` (not claimable) or the committed scheduled row.
  - **Two failed targets on one account**: they lock different posts and meet only on the unique index. The second one waits for the first to commit, gets `23505` in its savepoint, and moves on.
  - **Two retries of the same target**: they are serialised by the post lock. The second re-reads `scheduled` and is refused.
- **Alternatives**: update the status before allocating, as `queueTargetsInTx` does for drafts. Rejected because a failure after the update would need a compensating write.

### P6 — Refused `requeue` (D3): message, guard and history

- **Decision**: when the allocator returns `no_active_slots` or `no_free_occurrence`, the code makes a guarded `update(target.id, { lastError: MSG }, { statuses: ["failed"] })`. A miss throws `ConflictError`. It then inserts an attempt `{ step: "user", outcome: "retry_requested", error: "no_free_slot", requestSummary: { mode: "requeue", reason: code }, actorUserId }` and **returns** `{ status: "failed", reason: code, message: MSG }`, so the transaction commits. `MSG`, using the account's display name:
  - `no_free_occurrence`: `Not retried — {account} has no free posting slot. Retry now or pick a time.`
  - `no_active_slots`: `Not retried — {account} has no active posting slots. Retry now or pick a time.`
- **Rationale**: D3 and FR-008. No other column changes: the old occurrence, the kind and the instant all stay. Failed `tryHoldOccurrence` savepoints leave nothing behind. The error string `no_free_slot` matches the code `resolveAmbiguous` writes, so history filters and readers treat the two alike.
- **Alternatives**: throw a `ConflictError`, which leaves no trace. Rejected by D3.

### P7 — `at`: shared with `scheduleExplicit`

- **Decision**:
  1. Status checks, then `retryBlockedReason`.
  2. If `at <= now` (server clock, under the lock), return `{ status: "failed", reason: "in_past", message: "That time has passed. Use Retry now instead." }`.
  3. `gate`. A failure is returned (P5 step 3).
  4. One guarded update (`statuses: ["failed"]`): `status: "scheduled"`, then `explicitSchedulePatch("explicit", when)` (`scheduleKind`, `scheduledAt`, `nextAttemptAt`, `slotOccurrenceAt: null`, `slotId: null`), then the FR-004 resets. A guard miss throws `ConflictError`.
  5. `warnings = nearQueuedWarnings(tx, account, when, target.id)`.

  `explicitSchedulePatch(kind, when)` is a tiny helper that `scheduleExplicit` adopts too, so the two cannot drift apart.
- **Rationale**: FR-010 and FR-011. The wording follows the composer's message but points to the retry dialog's own alternative, as US2 AS3 asks ("can use 'Retry now' instead"). Clearing the occurrence in the same statement that sets `scheduleKind='explicit'` satisfies `post_targets_occurrence_is_slot`.
- **Alternatives**: call `scheduleExplicit` directly. Rejected because it locks the post itself, filters by draft/cancelled/scheduled status and guards on those statuses, not on `failed`.

### P8 — Attempt history: one `retry_requested` entry per retry; no migration

- **Decision**: every retry that goes ahead, or is refused for want of a slot (P6), writes exactly one `retry_requested` entry with `actorUserId`:
  - **`now`**: unchanged, with `requestSummary` left at its default `{}`, so SC-005's "identical history" holds.
  - **`requeue` success**: `requestSummary: { mode: "requeue", scheduledAt, slotId, expected? }`.
  - **`at` success**: `requestSummary: { mode: "at", scheduledAt }`.
  - **`requeue` with no slot**: as in P6.
  - **Written nowhere**: refusals that change nothing (`in_past`, `validation`, `account_unavailable` from the gate, conflicts, permission). This matches today, where a refused retry writes no entry, and SC-003's "exactly as it was".
- **Rationale**:
  - FR-013 allows "the entry (or a companion entry)". One entry keeps the history readable: the Failures attempt log renders `request` pairs as they are.
  - `bulk-retry-failures` can then count retries by one outcome.
  - No new enum value is needed (F8), so there is no migration and `pnpm db:check` is untouched.
- **Alternatives**: `retry_requested` plus a companion `requeued` at `now + 1ms`, as `resolveAmbiguous` does. Rejected because it gives two entries for one user action and puts `requeued` against a target that was never ambiguous.

### P9 — Preview for a failed target (FR-014, D6)

- **Decision**: `previewRequeue` re-reads the target:
  - **Neither `failed` nor `ambiguous`**: throws `ConflictError("This post is no longer failed.")`.
  - **`failed`**: passes `ownOccurrence: target.slotOccurrenceAt` to `peekNextFree`.
  - **`ambiguous`**: unchanged.
  - **Everything else is kept**: the permission, `gate` and the return type. A `failed` target on a removed, disconnected or provider-less account gives `account_unavailable` through `gate`. The UI never opens the dialog for those, because `canRetry` is false (FR-020).
- **Rationale**: one preview implementation (FR-021) that agrees with allocation (P4). The conflict wording comes from D6. In the ambiguous dialog a stale target now shows the same conflict text instead of a slot. That is the only visible change there, and it is logged.
- **Alternatives**: a separate `previewRetry`. Rejected by FR-021.

### P10 — UI: a `RetryDialog`, pure helpers, and existing controls only

- **Decision**:
  - **Control**: `TargetResolution` swaps the "Retry" button for a **"Retry…"** button that opens a new client component, `src/components/targets/RetryDialog.tsx`.
  - **Mode choice**: `SegmentedControl` in its `cards` layout, with native radios, so arrow keys and Tab work. "Now" is preselected (D1). Each option has a description:
    - "Now": retries on the next scheduler pass.
    - "Next free slot": shows the preview state.
    - "Pick a time": shows the date and time fields.
  - **"Next free slot" availability**: the option is `disabled` while the preview is loading or failed, and the reason is shown in its description.
  - **Preview**: opening the dialog calls `previewRequeueAction`. A thrown action failure maps to `account_unavailable`, as `openNotPublished` does.
  - **"Pick a time"**: `Field` date and time inputs labelled with the zone, with `previewExplicitTimeAction` from `compose/actions.ts` (reused, no new action) called with `accountIds: [accountId]`. `previewText` moves from `ScheduleDialogs.tsx` into `src/components/schedule/explicit-time-text.ts` and both dialogs import it.
  - **Confirm**: sends the resolved `instant` (SC-004) or the previewed `scheduledAt` as `expected`. The Confirm button is disabled until the chosen mode can be confirmed.
  - **Pure helpers**: the wording and enablement rules live in `src/components/targets/retry-ui.ts`. `canConfirm(mode, preview, timePreview)`, `retryAnnouncement(result)` and `retryFailureText(result)` are unit-tested.
  - **New props**: `TargetResolution` takes `accountId` and `timeZone`. Both render sites have them (the Failures page through `row.account.id` and `tz`; the post page through `t.accountId` and `tz`).
- **Rationale**: FR-015 to FR-019, with the existing design-system parts only (docket-ui skill, `docs/design-system.md`). Since there is no DOM test library (F10), the logic must be pure to be tested.
- **Alternatives**: a menu with three items. Rejected because "Pick a time" needs a field in any case, and D1 chose a dialog.

### P11 — Announcements and focus survive the row disappearing

- **Decision**:
  - **Announcer**: a small client `AnnounceProvider` / `useAnnounce()` in `src/components/ui/Announce.tsx` renders one page-level `LiveRegion` and exposes `announce(message)` and `focusFallback()`. The Failures page and the post page wrap their content in it.
  - **Fallback**: `TargetResolution` uses the context when it exists and otherwise keeps its own `LiveRegion`. That way the existing static-markup test, which looks for `role="status"`, still holds and unwrapped uses keep working.
  - **On success**: the dialog closes. After the refresh, if focus is on `body` or on a detached node, `focusFallback()` focuses the page heading (`tabIndex={-1}`, given an id).
  - **On failure**: the dialog stays open, shows the message in its `role="alert"` line and announces it too (FR-018).
- **Rationale**: F9. Without this, FR-018 and SC-006 fail on the Failures page for every successful retry. The fix is in the shared component, so the ambiguous dialogs gain it too without any change in behaviour.
- **Alternatives**: delay `refresh()` until after the announcement. Rejected because it is timing-dependent and still loses focus.

### P12 — Server action and docs

- **Decision**:
  - **Action**: `retryTargetAction(slug, { targetId, mode?, expected?, at? })` builds the service input (`mode` absent means none is passed, so it is `now`) and returns `ActionResult<RetryResult>`. It calls `refresh()` whenever the call returns without throwing, because a refused requeue changed `lastError`. Role checks stay in the service (`post: ['schedule']`).
  - **Docs**:
    - a new `docs/failures.md` ("Failures and retrying"): ambiguous vs failed, the three retry modes, the no-slot behaviour, and history entries;
    - a row in `docs/index.md` "Using Docket";
    - a README sentence pointing to it;
    - D1–D6 and P1–P12 under a new `## 012 — Retry modes` section in `docs/decisions.md`.
- **Rationale**: FR-021 and FR-023. No docs page described failures (F12).
- **Alternatives**: a section in `docs/accounts.md`. Rejected as the wrong topic.

## Open items

None. No `NEEDS CLARIFICATION`, `NEEDS RESEARCH` or `NEEDS DEPENDENCY` remains.
