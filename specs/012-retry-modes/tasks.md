# Tasks: Retry a failed target now, into the next free slot, or at a picked time

**Input**: Design documents from `/specs/012-retry-modes/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/services.md, contracts/ui.md, quickstart.md

**Tests**: REQUIRED (FR-024). Integration tests run against real Postgres with run-scoped databases and the mock provider (`behaviour: "fatal"`) to make failed targets; `atTime` controls the clock. UI is tested through `renderToStaticMarkup` and pure helpers (no DOM library).

**Organization**: grouped by user story. No schema change and no migration (`pnpm db:check` must stay green). No new dependency. No change under `src/app/api/**` (FR-022).

**Headless note**: every check below is a vitest / `tsc` / lint / build command. Nothing needs a browser or dev server. The only human-owned task is marked `🛑 BLOCKED:`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- Before touching actions or pages, read the relevant guide in `node_modules/next/dist/docs/01-app/` (AGENTS.md).

---

## Phase 1: Setup

- [X] T001 Read `specs/012-retry-modes/research.md` (F1–F12, P1–P12) and the existing code to be changed: `src/server/services/posts/index.ts` (`retryTarget`, `withLockedTarget`, `lockPost`, `scheduleExplicit`, `gate`, `retryBlockedReason`), `src/server/services/queue/index.ts` (`freeCandidates`, `peekNextFree`, `allocateNextFree`), `src/server/services/failures.ts` (`previewRequeue`, `resolveAmbiguous`), `src/app/p/[projectSlug]/posts/actions.ts`, `src/components/targets/TargetResolution.tsx`, `src/app/p/[projectSlug]/compose/ScheduleDialogs.tsx`. No file changes.
- [X] T002 Record the baseline: run `pnpm vitest run tests/integration/failures/ src/server/services/queue/ < /dev/null` and `pnpm typecheck < /dev/null`; note any pre-existing failures in the task's commit message rather than fixing them.

---

## Phase 2: Foundational (blocks all user stories)

**Purpose**: the allocator option, the extracted lock helpers, `retry.ts` with the `now` mode wired end to end, and the shared UI parts. After this phase existing retry tests pass unchanged (SC-005).

- [X] T003 Add the optional `ownOccurrence?: Date | null` to `freeCandidates`, `peekNextFree` and `allocateNextFree` in `src/server/services/queue/index.ts`: remove it from the `held` set first, then apply `exclude`. Omitted option MUST give byte-identical results to today.
- [X] T004 [P] Extend the queue tests (find the existing file under `src/server/services/queue/*.test.ts` or `tests/integration/queue/`) to prove: omitted `ownOccurrence` gives the same candidates as before; when given, only that instant is freed and other held occurrences stay held.
- [X] T005 Create `src/server/services/posts/locked.ts` exporting `lockPost` and `withLockedTarget` moved from `src/server/services/posts/index.ts` (no behaviour change; avoids an import cycle with `retry.ts`). Update `posts/index.ts` and `src/server/services/failures.ts` to import them from there. Keep `gate` and `retryBlockedReason` exports where they are.
- [X] T006 Add `explicitSchedulePatch(kind, when)` (per contracts/services.md) in `src/server/services/posts/index.ts` (or `posts/schedule-patch.ts`) and make `scheduleExplicit` spread it in place of its five literal keys. Behaviour unchanged; existing schedule tests must still pass.
- [X] T007 Create `src/server/services/posts/retry.ts` with `retryInputSchema` (Zod discriminated union: `now`, `requeue` with optional `expected`, `at` with `atSchema`), the `RetryInput`, `RetryFailureReason` and `RetryResult` types, `retryLockedTarget(tx, target, now, input)` and `retryTarget(scope, targetId, input?)` per contracts/services.md. In this task implement the guards (permission before and inside the transaction, post lock → target locks → re-read, `publishing` and non-`failed` messages, `retryBlockedReason`) and the `now` body only (guarded update with `statuses: ["failed"]`, resets, one `retry_requested` with no summary, `applyDerivedStatus`). `requeue` and `at` branches throw a clear "not implemented" error until US1/US2. Absent or `null` input means `now`.
- [X] T008 Remove the old `retryTarget` from `src/server/services/posts/index.ts` and re-export the retry API (`retryTarget`, `retryLockedTarget`, `retryInputSchema`, types) from `@/server/services/posts`. `retry.ts` MUST NOT import `posts/index.ts`.
- [X] T009 Change `retryTargetAction` in `src/app/p/[projectSlug]/posts/actions.ts` to accept `{ targetId, mode?, expected?, at? }`, split `targetId` from the rest, pass `undefined` when `mode` is absent, call `posts.retryTarget`, `refresh()` when ok, and return `ActionResult<posts.RetryResult>` (FR-021). Role checks stay in the service.
- [X] T010 [P] Move `previewText` from `src/app/p/[projectSlug]/compose/ScheduleDialogs.tsx` into `src/components/schedule/explicit-time-text.ts` as `explicitTimeText(p, timeZone)`, body unchanged; import it in `ScheduleAtDialog`. Composer output MUST NOT change (`compose/schedule-preview.test.ts` passes unchanged).
- [X] T011 [P] Create `src/components/ui/Announce.tsx` (`AnnounceProvider`, `useAnnounce`: one mounted `LiveRegion`, `announce`, `restoreFocus` that focuses `#focusFallbackId` when the active element is `<body>` or disconnected). Add optional `titleId` to `src/components/ui/PageHeader.tsx` (`<h1 id tabIndex={-1}>`).
- [X] T012 [P] Create `src/components/targets/retry-ui.ts` with `RetryMode`, `canConfirm`, `retryAnnouncement`, `confirmLabel` per contracts/ui.md, and `src/components/targets/retry-ui.test.ts` covering: `canConfirm` for each mode and preview state (`now` true; `requeue` needs an ok preview, false while loading/null/not ok; `at` needs a non-`inPast` time preview); the `retryAnnouncement` strings (now; requeue with and without `changedFromPreview`; at with warnings); `confirmLabel` for each mode.
- [X] T013 Run `pnpm vitest run tests/integration/failures/ src/server/services/queue/ src/components/targets/ < /dev/null && pnpm typecheck < /dev/null`. Existing `failures/retry.test.ts`, `retry-resolve.test.ts`, `resolve.test.ts`, `concurrency.test.ts`, `requeue.test.ts` MUST pass with no edits.

**Checkpoint**: `now` works through the new service and action; allocator option exists.

---

## Phase 3: User Story 1 — Retry into the next free slot (P1) 🎯 MVP

**Goal**: `requeue` mode, its preview for failed targets, and the "Retry…" dialog with "Next free slot".

**Independent test**: fail a target on an account with slots; `previewRequeue` and `retryTarget({mode:"requeue"})` agree; the target is `scheduled`, slotted, holding exactly the new occurrence.

### Tests for User Story 1

- [X] T014 [P] [US1] Create `tests/integration/failures/retry-modes.test.ts` (shared setup helpers for later stories live here): `requeue` success stores the columns in data-model.md (`schedule_kind='slot'`, new `scheduled_at`/`next_attempt_at`/`slot_occurrence_at`/`slot_id`, resets, `status='scheduled'`), writes one `retry_requested` attempt with `{mode, scheduledAt, slotId, expected?}` and the acting member, and updates the post's derived status; refused cases: no active slots and no free occurrence leave the target `failed` with only `last_error` changed and an attempt with `error: "no_free_slot"` plus the reason, result `reason` `no_active_slots` / `no_free_occurrence` with the exact messages from contracts/services.md; validation failure (media removed) returns `status:"failed", reason:"validation"` with `issues` and writes nothing; `expected` different from the allocated instant gives `changedFromPreview: true`.
- [X] T015 [P] [US1] Create `tests/integration/failures/retry-occurrences.test.ts`: a failed target holding (a) a future free occurrence, (b) its original past occurrence, (c) none, (d) an explicit target: in each case `previewRequeue` and `retryTarget({mode:"requeue"})` give the same instant; after requeue exactly one occurrence is held and in (b) the old one is free again; `previewRequeue` of a `scheduled`/`published` target throws `ConflictError("This post is no longer failed.")`; preview of an ambiguous target is unchanged.
- [X] T016 [P] [US1] Create `tests/integration/failures/retry-concurrency.test.ts` (style of `failures/concurrency.test.ts`, `Promise.allSettled`): two failed targets on one account requeued at once get distinct occurrences; a requeue racing `runTick()` never leaves `status='failed'` with a new occurrence nor a `scheduled` slot target without one, and never publishes twice.
- [X] T017 [P] [US1] Extend `tests/integration/failures/ui.test.tsx` with static-markup checks: a retryable failed target renders a button with text `Retry…` and no `>Retry<`; `RetryDialog` rendered with `open` shows the title with the account name, three labelled radios named `retry-mode-{targetId}`, `now` checked, and the requeue radio `disabled` while the preview is loading; a live region exists with and without `AnnounceProvider`.

### Implementation for User Story 1

- [X] T018 [US1] Implement the `requeue` branch in `src/server/services/posts/retry.ts`: `gate` (return typed failure, no write), `allocateNextFree(tx, {id, accountId}, {after: now, ownOccurrence: target.slotOccurrenceAt})`, guarded status update with resets on success and the attempt summary, `changedFromPreview` computation, and the refused path (guarded `{ lastError: MSG }` only, attempt with `error: "no_free_slot"`, commit, typed failure). A missed guard throws so the hold rolls back.
- [X] T019 [US1] Update `previewRequeue` in `src/server/services/failures.ts`: throw `ConflictError("This post is no longer failed.")` for statuses other than `failed`/`ambiguous` (D6) and pass `ownOccurrence` (failed targets only) to `peekNextFree`. `resolveAmbiguous` behaviour unchanged.
- [X] T020 [US1] Create `src/components/targets/RetryDialog.tsx` (client) per contracts/ui.md: title `Retry the post to {accountName}`, `SegmentedControl layout="cards"` with the three options (`now` preselected, `requeue` disabled while loading or preview not ok with the descriptions given), `previewRequeueAction` on open with the same unavailable handling as `openNotPublished`, error line `role="alert"`, footer (Back + pending primary using `confirmLabel`/`canConfirm`), confirm via `retryTargetAction` (`now` → `{targetId}`; `requeue` → `{targetId, mode:"requeue", expected: preview.scheduledAt}`), result handling (scheduled closes + announce + `onDone`; failed or `!ok` stays open with the message, re-fetches the preview after a requeue refusal). Render the `at` option but leave its body for US2 (T027).
- [X] T021 [US1] Update `src/components/targets/TargetResolution.tsx`: add required props `accountId` and `timeZone`; replace the failed-target "Retry" button with a **"Retry…"** button that opens `RetryDialog`; use `useAnnounce()` when a provider is present (call `announce` and, after a successful retry, `restoreFocus()`), else keep the local `LiveRegion`; route the existing ambiguous-dialog announcements through `announce` with unchanged strings. Blocked-reason and reconnect-link behaviour unchanged (FR-020).
- [X] T022 [US1] Wire pages: in `src/app/p/[projectSlug]/failures/page.tsx` and `src/app/p/[projectSlug]/posts/[postId]/page.tsx` wrap content in `<AnnounceProvider focusFallbackId="page-title">`, give `PageHeader` `titleId="page-title"`, and pass `accountId` and `timeZone` to `TargetResolution`.
- [X] T023 [US1] Run `pnpm vitest run tests/integration/failures/ src/components/targets/ src/server/services/queue/ < /dev/null`, `pnpm typecheck < /dev/null` and `pnpm lint src/server/services/posts src/server/services/failures.ts src/server/services/queue src/components/targets src/components/ui/Announce.tsx 'src/app/p/[projectSlug]' < /dev/null`; fix failures.

**Checkpoint**: MVP — requeue works end to end; `now` still works; `at` option present in the UI but not yet functional.

---

## Phase 4: User Story 2 — Retry at a picked time (P2)

**Goal**: `at` mode and the "Pick a time" dialog section with DST handling.

**Independent test**: `retryTarget({mode:"at", at})` stores an explicit schedule at that instant with the hold released; DST gap/overlap instants stored equal the previewed ones.

### Tests for User Story 2

- [X] T024 [P] [US2] Extend `tests/integration/failures/retry-modes.test.ts` with `at`: success stores `schedule_kind='explicit'`, `scheduled_at = next_attempt_at = at`, `slot_occurrence_at`/`slot_id` NULL (an old hold is released and becomes free), resets, attempt `{mode:"at", scheduledAt}`; `at` in the past and `at` equal to now return `in_past` with no write and the exact message; validation failure returns the typed failure with `issues` and no write; a nearby queued post on the same account yields a warning that does not block, with the target itself excluded; malformed input (unknown mode, missing `at`, non-ISO) throws `ZodError` with nothing changed.
- [X] T025 [P] [US2] Create `tests/integration/failures/retry-dst.test.ts` with a project in `America/New_York`: spring-forward gap (`2027-03-14T02:30`): `previewExplicitTime` reports `gap` and `retryTarget({mode:"at", at: preview.instant})` stores exactly `preview.instant`; fall-back overlap (`2026-11-01T01:30`): reports `overlap` and the earlier instant is stored (SC-004).

### Implementation for User Story 2

- [X] T026 [US2] Implement the `at` branch in `src/server/services/posts/retry.ts`: `when <= now` → `in_past` (no write, message "That time has passed. Use Retry now instead."), `gate`, guarded update with `explicitSchedulePatch("explicit", when)` plus resets, attempt `{mode:"at", scheduledAt}`, `warnings` from `nearQueuedWarnings(tx, accountId, when, target.id)`.
- [X] T027 [US2] Add the "Pick a time" body to `src/components/targets/RetryDialog.tsx`: `Field` date `Date ({timeZone})` and time `Time ({timeZone})` (ids `retry-date-{targetId}`, `retry-time-{targetId}`), `previewExplicitTimeAction(slug, {local, accountIds:[accountId]})` with a `live` flag to drop stale responses, an `aria-live="polite"` container showing `explicitTimeText(...)`, the `inPast` alert "That time has passed. Pick a later time, or use Retry now.", and warnings in `text-warning`; confirm sends `{targetId, mode:"at", at: timePreview.instant}`.
- [X] T028 [US2] Run the US2 tests plus `pnpm typecheck < /dev/null`.

---

## Phase 5: User Story 3 — Retry now, as today (P3)

**Goal**: prove `now` is byte-for-byte today's behaviour and that no-mode callers still work.

**Independent test**: existing retry tests pass unchanged; new assertions show identical stored state.

- [x] T029 [P] [US3] Extend `tests/integration/failures/retry-modes.test.ts`: `now` stores exactly today's columns (`next_attempt_at = now`; old `schedule_kind`, `scheduled_at` and any held occurrence kept; counters and error reset), writes one `retry_requested` with no summary (`{}`), result `scheduled` with `slotId: null`, `changedFromPreview: false`, `warnings: []`; `retryTarget(scope, id)` with no input and with `null` behaves as `now` (FR-002).
- [x] T030 [US3] Confirm `git diff --stat` shows no edits to `tests/integration/failures/retry.test.ts`, `requeue.test.ts`, `resolve.test.ts`, `concurrency.test.ts`, `tests/integration/posts/retry-resolve.test.ts`, `compose/schedule-preview.test.ts`, `actions-authz.test.ts` and that they pass (SC-005, FR-022).

---

## Phase 6: User Story 4 — Blocked and stale retries refused (P2)

**Goal**: every mode refuses blocked, stale and unauthorised retries with the right words and no partial change.

**Independent test**: each mode against publishing, already-retried, removed, `needs_reauth`, provider-missing targets and unauthorised callers.

- [x] T031 [P] [US4] Extend `tests/integration/failures/retry-modes.test.ts`: for EVERY mode, removed, `needs_reauth` and provider-missing accounts are refused with today's `retryBlockedReason` text and the target is unchanged; a `publishing` target gets `ConflictError("Publishing in progress. Try again in a moment.")`; an already-scheduled target gets `ConflictError("This post is no longer failed.")`.
- [x] T032 [P] [US4] Extend `tests/integration/failures/retry-concurrency.test.ts`: N mixed-mode retries of one target via `Promise.allSettled` — exactly one succeeds, the rest are `ConflictError`, exactly one `retry_requested` entry exists and at most one occurrence is held.
- [x] T033 [P] [US4] Extend `tests/integration/failures/authz.test.ts`: a non-member and another project's owner get `not_found` from `retryTargetAction` in every mode; a read-only API key and a stub scope without `post:schedule` get `ForbiddenError` from `retryTarget` in every mode and from `previewRequeue` (FR-003, FR-014).
- [x] T034 [US4] Extend `tests/integration/failures/ui.test.tsx`: a blocked failed target renders the reason and the reconnect link and no `Retry…` control (FR-020).
- [x] T035 [US4] Run `pnpm vitest run tests/integration/failures/ < /dev/null`; fix any failures in the service (not by weakening tests).

---

## Phase 7: Polish & Cross-Cutting

- [x] T036 [P] Create `docs/failures.md` ("Failures and retrying"): the three modes, no-slot behaviour and the explanatory `last_error`, attempt-history entries, blocked reasons. Add a row under "Using Docket" in `docs/index.md` and one sentence plus link in `README.md`.
- [x] T037 [P] Add `## 012 — Retry modes` to `docs/decisions.md` with D1–D6 (from spec.md "Decisions made while specifying") and P1–P12 (from research.md); append any decision made during implementation.
- [x] T038 Run the full pass once: `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build < /dev/null`. `pnpm db:check` MUST report no pending migration. Verify with `git diff --stat main -- src/app/api` that nothing under the API changed.
- [ ] T039 🛑 BLOCKED: needs a real browser with a screen reader (VoiceOver/NVDA) — listen to the announcements and confirm focus lands on the page heading after a successful retry and returns to "Retry…" on Escape, per quickstart.md steps 2, 6 and 7. Automated static-markup and pure-helper tests cover the rest.

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 → stories. Within Phase 2: T003 before T007's requeue use; T005 before T007; T007 → T008 → T009; T004, T010, T011, T012 are independent ([P]).
- **US1 (P1)** depends only on Phase 2. **US2** depends on Phase 2 and on T020 (dialog file) for T027. **US3** and **US4** depend on Phase 2; US4's concurrency test also needs US1/US2 branches (T018, T026).
- Tests T014–T017 may be written before the implementation tasks and are expected to fail until T018–T022 land.
- T014, T024, T029, T031 edit the same file (`retry-modes.test.ts`): do them sequentially, not in parallel with each other.
- Polish after all stories.

## Parallel examples

- Phase 2: T004, T010, T011, T012 together after T003/T005 settle.
- US1 tests: T014, T015, T016, T017 (different files).
- US4: T032, T033 (different files).
- Docs: T036 and T037.

## Implementation Strategy

1. **MVP**: Phases 1–3 (US1) — requeue end to end plus the dialog; `now` already works from Phase 2.
2. Add US2 (`at`), then US3/US4 proof tests, then docs and the full pass.
3. Run only affected files while implementing; run the full suite once at T038.

---

## Phase 8: Review remediation

Findings are in `specs/012-retry-modes/review.md`. Do T040 first so the existing implementation lands as its own commits, then commit each fix as it is made.

- [x] T040 Commit the uncommitted 012 implementation, tests, docs and `tasks.md` as small Conventional Commits with explicit `git add <path>` paths (never `-A` or `.`), leaving the runner's `.specify/roadmaps/*.json` out — review F1 (MAJOR), src/server/services/posts/retry.ts:1
- [x] T041 Stop the requeue-preview load from driving the confirm button's `pending`: load the preview outside the confirm `useTransition` (its `"loading"` state already exists), so "Now" and "Pick a time" stay confirmable and the button never reads "Retrying…" before a retry; add a test that the confirm label is `confirmLabel(mode)` while the preview is loading — review F2 (MAJOR), src/components/targets/RetryDialog.tsx:44
- [x] T042 Make `AnnounceProvider.announce` re-announce identical text (e.g. clear then set on the next frame, or key the message on a counter) so consecutive "Retry queued for the next tick." / "Marked published." outcomes are each announced; add a test for two identical announcements — review F3 (MAJOR), src/components/ui/Announce.tsx:16
- [x] T043 Restore focus to "Retry…" when the retry dialog is dismissed with Back: keep `RetryDialog` mounted with `open={open === "retry"}` (resetting its state per open, e.g. a `key` bumped on open) or make `Dialog` close the element on unmount, so the native close/focus-return path runs; keep fresh state per open — review F4 (MAJOR), src/components/targets/TargetResolution.tsx:140
- [x] T044 Make the race tests able to fail: race `retryTarget({ mode: "now" })` against `runTick()` and assert the retry fulfilled, the target is consistently scheduled or claimed once, and there is at most one publish; assert both targets are `scheduled` with distinct instants in the two-target requeue test; assert at most one held occurrence in the mixed-mode test — review F5 (MAJOR), tests/integration/failures/retry-concurrency.test.ts:29

---

## Phase 9: Review remediation

Findings are in `specs/012-retry-modes/review.md` (round 2). Commit the fix as a Conventional Commit with explicit `git add <path>` paths.

- [ ] T045 Make focus after a successful retry land on the page heading regardless of refresh timing, while keeping "Back"/Escape returning focus to "Retry…": either let the success path skip `Dialog`'s return-to-opener (e.g. a `returnFocus` option or clearing `returnTo` before `onClose()`) and focus `#page-title` directly, or make `restoreFocus` wait until the opener is disconnected before deciding; add the success case on the Failures page (several rows) and the post page to T039's manual check — review F14 (MAJOR), src/components/targets/RetryDialog.tsx:101
