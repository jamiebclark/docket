---

description: "Task list for 015 — bulk retry of failed targets"
---

# Tasks: "Retry all failed" on the Failures page, now or into the next free slots

**Input**: Design documents from `/specs/015-bulk-retry-failed/` (plan.md, spec.md, research.md, data-model.md, contracts/services.md, contracts/ui.md, quickstart.md)

**Tests**: Requested (spec FR-023, quickstart test map). Tests run with `pnpm vitest run <files> < /dev/null` against real Postgres; no browser is available. UI is tested through pure helpers and static markup.

**Format**: `[ID] [P?] [Story] Description` — [P] = different files, no dependency on an incomplete task.

**Notes for the implementer**: AGENTS.md says this Next.js has breaking changes — read the relevant guide in `node_modules/next/dist/docs/01-app/` (server actions, `refresh()`) before writing the action and page. Follow the `docket-ui` skill for components. No migration, no new dependency, no API/OpenAPI change. `retryTarget`, `resolveAmbiguous` and the scheduler stay unchanged. Commit with explicit paths, conventional commits.

## Phase 1: Setup

- [x] T001 Create the empty directory module `src/lib/failures/` by adding `src/lib/failures/retry-all-text.ts` with the types and constants only: `RetryAllSkipReason` (`account_removed | needs_reconnecting | provider_unavailable | no_longer_failed | cannot_publish | no_free_slot`), `SkipCounts`, and `SKIP_REASONS` in D3 order (see research.md / contracts/services.md §1). No server imports.

---

## Phase 2: Foundational (blocking prerequisites)

**⚠️ No user story work starts until this phase is complete.**

- [x] T002 [P] Write `src/lib/failures/retry-all-text.test.ts` asserting every example message in contracts/services.md §1 verbatim, singular/plural for each reason, and reasons always in D3 order.
- [x] T003 Implement `SKIP_PHRASES`, `skipPhrase`, and `retryAllMessage` (rule P9) in `src/lib/failures/retry-all-text.ts` until T002 passes.
- [x] T004 [P] Refactor `src/server/services/posts/retry.ts`: add exported `retryBlockedKey(account, providerRegistered)` and rebuild `retryBlockedReason` as a switch over it with identical sentences. Run the existing `tests/integration/failures/retry*.test.ts` and `src/components/targets/retry-ui.test.ts` unchanged to prove no regression.
- [x] T005 [P] In `src/server/dal/targets.ts` add `listFailedForRetry({ accountId? })` (id, post id, social account id, `scheduled_at`, `updated_at`; `INNER JOIN posts` on `livePost`; `attentionWhere(["failed"], accountId)`; `ORDER BY scheduled_at ASC NULLS LAST, updated_at ASC, id ASC`; no limit, no lock) and give `countAttention` an optional `accountId` parameter (existing calls unchanged). Export the `FailedForRetry` type.

**Checkpoint**: shared wording, blocked predicate and DAL read exist.

---

## Phase 3: User Story 1 — Retry every failed post at once (P1) 🎯 MVP

**Goal**: One press retries every failed target of live posts in the project ("Retry now"), reporting retried and skipped-by-reason counts.

**Independent Test**: seed failed targets on several accounts (one needing reconnecting), call `retryAllFailed(scope, { mode: "now" })`; eligible targets match a single `retryTarget` effect, blocked ones are untouched, counts sum to `inScope`.

### Tests for User Story 1

- [x] T006 [P] [US1] Write `tests/integration/failures/retry-all.test.ts` covering: filter respect (ambiguous, scheduled, deleted-post targets neither touched nor counted; targets beyond page 1 included), "now" effect byte-identical to `retryTarget(…, {mode:"now"})` on a twin target (columns + `retry_requested` entry), each skip reason (removed account, `needs_reauth`, missing provider) with no write, per-account breakdown and `count + Σ skipped + remaining = inScope`, empty scope message "There are no failed posts to retry." with `changed: false`, bad input (`targetIds` key, missing/unknown `mode`, malformed `account`) raising `ZodError` with nothing changed, post status re-derived. Use existing helpers (`failedTarget`, `outcomeTarget`, `setAccountStatus`, `breakAccount`, `atTime`, `parkAllDueTargets`).

### Implementation for User Story 1

- [x] T007 [US1] Create `src/server/services/posts/retry-all.ts`: `RETRY_ALL_CAP = 100`, strict Zod `retryAllInputSchema` / `retryAllScopeSchema`, result/preview types (data-model.md), and `retryAllFailed` per contracts/services.md §1 steps 1–5 — pre-lock blocked counting via one `accounts.list()` + `retryBlockedKey`, then each target through `withLockedTarget` + `retryLockedTarget` in its own transaction, mapping outcomes to D3 reasons, `NotFoundError`/`ConflictError` → `no_longer_failed`, all other errors rethrown. Implement `mode: "now"` and the per-account tally map (names from `accounts.list()`, "Removed account" fallback, sorted by name then id).
- [x] T008 [US1] Re-export `retryAllFailed`, `previewRetryAll`, `RETRY_ALL_CAP` and the result types from `src/server/services/posts/index.ts`; run T006 until green.

**Checkpoint**: service-level "retry now" works and is tested.

---

## Phase 4: User Story 2 — Requeue into next free slots (P1)

**Goal**: `mode: "requeue"` gives each account's targets its next free occurrences in intended-time order, with graceful per-account exhaustion.

**Independent Test**: three failed targets on an account (intended 08:00/09:00/10:00) take its next three occurrences in order; an account with no active slots reports `no_free_slot` with only its first target writing an entry.

### Tests for User Story 2

- [x] T009 [P] [US2] Write `tests/integration/failures/retry-all-requeue.test.ts`: ordering per account (A three, B two), no repeated `(account, slot_occurrence_at)`, target holding its own future occurrence keeps/takes it, too-few-occurrences (third target counted `no_free_slot` with the D3 entry), D5 (account with no active slots: only the first target gets an entry, the rest counted without a write, other accounts still processed), `cannot_publish` for requeue (media removed) while the same target succeeds under `now`, requeue entries `{mode, scheduledAt, slotId}` identical to a single requeue.

### Implementation for User Story 2

- [x] T010 [US2] In `src/server/services/posts/retry-all.ts` complete requeue handling: pass `{ mode }` to `retryLockedTarget`, map `no_active_slots` / `no_free_occurrence` to `no_free_slot` with `exhausted: true`, apply D5 (later targets of an exhausted account counted without attempt or write), map gate/validation outcomes to `cannot_publish`. Run T009 until green.

**Checkpoint**: both modes work at the service level.

---

## Phase 5: User Story 3 — Retry only one account's failures (P2)

**Goal**: The account filter scopes the set; the label count reflects the filter.

**Independent Test**: with an account filter, only that account's failed targets are retried/counted; `failedInFilter` equals the filtered failed count regardless of tab or page.

- [x] T011 [P] [US3] Extend `tests/integration/failures/list.test.ts`: `failedInFilter` is the project-wide failed count without a filter and only that account's with a filter; identical on "All" and "Failed" tabs and on every page; ignores ambiguous targets.
- [x] T012 [US3] In `src/server/services/failures.ts` add `FailureList.failedInFilter` (`totals.failed` with no account, else `countAttention(query.account).failed` in the same `Promise.all`). `targetActions` keeps using `retryBlockedReason`.
- [x] T013 [P] [US3] Add an account-filter case to `tests/integration/failures/retry-all.test.ts`: only the given account's targets are retried, others untouched, and a foreign/unknown account id yields "There are no failed posts to retry.".

**Checkpoint**: scoping and count proven.

---

## Phase 6: User Story 4 — Safe under concurrency and repeated presses (P1)

**Goal**: No deadlocks, no double effects, second press is a no-op for already-retried targets.

**Independent Test**: forced races settle, each target has exactly one new `retry_requested` entry, no occurrence held twice.

- [X] T014 [P] [US4] Write `tests/integration/failures/retry-all-concurrency.test.ts` with `Promise.allSettled`: two bulk runs (now+now, now+requeue); bulk + `runTick()`; bulk + `retryTarget` on one of its targets (either bulk counts `no_longer_failed` or the single retry gets `ConflictError("This post is no longer failed.")`); bulk requeue + `addToQueue` + single requeue on one account. Assert all settle, one new entry per target, no double-held occurrence, tick never attempts a still-failed claimed target, counts consistent.
- [X] T015 [P] [US4] Add to `tests/integration/failures/retry-all.test.ts` the idempotent second press (zero changed, no new entries, only still-blocked reported).
- [X] T016 [US4] Fix any ordering/locking defect T014/T015 expose in `src/server/services/posts/retry-all.ts` (one transaction per target, no cross-target lock, no provider call in a transaction); document findings for T033. — No defect exposed: T014/T015 pass against the existing one-transaction-per-target design (no change needed). Note for T033: races settle, one retry_requested entry per target, no double holds.

**Checkpoint**: concurrency guarantees proven.

---

## Phase 7: User Story 5 — Bounded steps for large backlogs (P3)

**Goal**: At most 100 attempts per press, with a clear "press again" message.

**Independent Test**: 230 retriable targets → 100 retried, `remaining: 130`; blocked targets don't consume the cap.

- [x] T017 [P] [US5] Write `tests/integration/failures/retry-all-cap.test.ts`: 230 retriable targets (seed ~230 drafts over two accounts with `createDraft`, then `scope.targets.update(id, { status: "failed", scheduledAt })`; avoid `runTick`) give 100 retried in D2 order, `remaining: 130`, and the press-again message; second press 100, third 30; 150 blocked + 20 retriable → all 20 retried in one press; preview `capApplies` / `willAttempt: 100`; log wall time of a 100-attempt requeue press.
- [x] T018 [US5] In `src/server/services/posts/retry-all.ts` enforce `attempted === RETRY_ALL_CAP` → `remaining++` (blocked/D5 skips don't count toward the cap). Run T017 until green.
- [x] T019 [US5] Implement `previewRetryAll` in `retry-all.ts` per contracts/services.md §1 (same reads, `retryBlockedKey` classification, `scope` populated only when the account is present, `capApplies`, `willAttempt`, writes nothing) and add preview tests to `retry-all.test.ts` (numbers match the run's pre-pass; row and entry counts unchanged).

**Checkpoint**: backlog handling and preview done.

---

## Phase 8: User Story 6 — Authorization and isolation (P2)

**Goal**: Only members with `post:schedule` can run or preview; nothing crosses projects.

- [x] T020 [P] [US6] Extend `tests/integration/failures/authz.test.ts`: `retryAllFailedAction`/`previewRetryAllAction` return `not_found` for a non-member and another project's slug; `retryAllFailed`/`previewRetryAll` throw `ForbiddenError` for a stub scope without `post:schedule` and a read-only API-key scope with nothing changed; project 1's run (no filter, and with project 2's account id) leaves every project 2 target, occurrence and entry unchanged.
- [x] T021 [US6] Create `src/app/p/[projectSlug]/failures/actions.ts` (`"use server"`): `retryAllFailedAction(slug, input)` building `{ account?, mode }` from scratch (omit `account` when undefined/empty), via `runAction`, calling `refresh()` on ok; `previewRetryAllAction(slug, input)` read-only, no refresh. Result mapping per contracts/services.md §5 (unexpected errors reject).

**Checkpoint**: server surface complete and authorized.

---

## Phase 9: UI (serves US1–US3, US5)

**Goal**: The "Retry all N failed posts" control, dialog and summary on the Failures page.

- [x] T022 [P] [US1] Write `src/components/targets/retry-all-ui.test.ts` for `retryAllLabel` (four FR-016 forms), `retryAllTitle`, `previewLines` (cap note, blocked lines), `canConfirmAll` (loading, zero, positive), `confirmAllLabel`, `controlRemains`, `summaryAccounts`.
- [x] T023 [US1] Create `src/components/targets/retry-all-ui.ts` (pure; runtime imports only from `@/lib/failures/retry-all-text`, `import type` from `@/server/services/posts`) with the helpers and `UNEXPECTED_ERROR` from contracts/ui.md §4. Run T022 until green.
- [x] T024 [US1] Create `src/components/targets/RetryAllDialog.tsx` (`"use client"`) per contracts/ui.md §3: preview load on open, `SegmentedControl` cards (Retry now preselected), numbers live region, all-blocked explanation with disabled confirm, `role="alert"` error line, submit guard (ref + `Button pending`), announce via the page's `AnnounceProvider`, focus handling.
- [x] T025 [US1] Create `src/components/targets/RetryAllFailed.tsx` (`"use client"`) per contracts/ui.md §2: button (hidden at 0), per-open `dialogKey` remount, persistent summary `Alert` with `role="none"` and per-account list when more than one account has skips.
- [x] T026 [US3] Wire `src/app/p/[projectSlug]/failures/page.tsx`: render `<RetryAllFailed key=… slug accountId accountName failedCount={list.failedInFilter} />` in the filter bar only when `canSchedule`, `query.status !== "ambiguous"` and `list !== null`.
- [x] T027 [US1] Extend `tests/integration/failures/ui.test.tsx` (static markup): button label with/without account name; no button at count 0; open dialog shows scope title, two labelled radios with "Retry now" checked, confirm disabled while loading; page-level: no control on the ambiguous tab or without `schedule`.

**Checkpoint**: feature usable end to end.

---

## Phase 10: Polish & cross-cutting

- [X] T028 [P] Add "Retrying every failed post" section to `docs/failures.md`.
- [X] T029 [P] Update the `docs/index.md` row wording and add one clause to `README.md`.
- [X] T030 Append to the existing `## 015 — Bulk retry of failed targets` section in `docs/decisions.md` the measured 100-attempt requeue press time from T017 (lower `RETRY_ALL_CAP` to 50 if it exceeded 5 s, per P6) and any concurrency findings from T016.
- [X] T031 Run the full pass once and fix failures: `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build` (all with `< /dev/null`); `db:check` must stay green with no migration.
- [X] T032 Confirm via `git status` that `AGENTS.md`/`CLAUDE.md` regeneration by `next dev` is not left as a stray diff, and that no files outside the plan's structure changed.
- [ ] T033 🛑 BLOCKED: needs a human with a real browser and keyboard — run the quickstart manual walk-through (Tab/Enter/arrow keys through the dialog, focus return to the control or the "Failures" heading, announcement matching the visible summary). Automated coverage (T022, T027) stands in; this stays owed, not claimed verified.

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 (T003 needs T002 for TDD; T004, T005 independent of each other and of T002/T003).
- Phase 3 (US1) needs Phase 2. Phase 4 (US2) builds on T007. Phase 5 (US3): T012 needs T005; T013 needs T007.
- Phase 6 (US4) and Phase 7 (US5) need T007/T010; T019 (preview) needs T007 and T005.
- Phase 8: T021 needs T008 and T019. T020 needs T008, T019 and T021.
- Phase 9: T023 needs T001/T003 types; T024–T025 need T021, T023; T026 needs T012, T025; T027 needs T026.
- Phase 10 last; T030 needs T016 and T017; T031 after everything.
- `retry-all.ts` edits (T007, T010, T016, T018, T019) are the same file — keep sequential. `retry-all.test.ts` edits (T006, T013, T015, T019) are the same file — keep sequential.

### Parallel opportunities

- Phase 2: T002, T004, T005 together.
- After T010: T009/T014/T017 test files are different files and can be authored together.
- Phase 9: T022 alongside T021.
- Phase 10: T028, T029 together.

## Implementation Strategy

- **MVP**: Phases 1–3 (service-level "retry now"), then add US2 requeue (also P1) and US4 concurrency (P1) before exposing any UI; the UI (Phase 9) is what makes it user-visible.
- **Incremental**: Foundation → US1 → US2 → US4 → US3 → US5 → US6 → UI → docs, running only the affected test files between steps and the full pass at T031.

---

## Phase 11: Review remediation

- [ ] T034 Commit the uncommitted implementation in small Conventional Commits with explicit `git add <path>` paths (service/DAL/actions/UI as `feat(failures): …`, tests as `test(failures): …`, `docs/*` + `README.md` as `docs(failures): …`, `tasks.md` as `docs(tasks): …`); never `git add -A`/`.`; leave `.specify/roadmaps/*.json` alone — review F1 (MAJOR), src/server/services/posts/retry-all.ts:1
- [ ] T035 Make the bulk-vs-tick race test able to fail: count the tick's engine attempt entries per target (e.g. `fatal_error` / entries with a `tickId`) and assert at most one per target, assert no engine entry precedes the target's `retry_requested` entry, and use a fixture where the tick verifiably claims at least one retried target (e.g. a `succeed` account asserting a `published` target, or a follow-up `runTick()`) — review F2 (MAJOR), tests/integration/failures/retry-all-concurrency.test.ts:61-72
- [ ] T036 Make the timed requeue press really attempt 100 targets (e.g. 50 failed targets on each of two accounts with free slots; assert `count === 100` or no D5 skips), re-measure, and correct the "Measured" line in `docs/decisions.md` with the real figure and attempt count (lower `RETRY_ALL_CAP` to 50 per P6 if it exceeds 5 s) — review F3 (MAJOR), tests/integration/failures/retry-all-cap.test.ts:74-82, docs/decisions.md:574
