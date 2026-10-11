---

description: "Task list for per-event read state and snooze"
---

# Tasks: Per-event read state and snooze

**Input**: Design documents from `specs/042-per-event-read-snooze/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Requested explicitly (FR-029, quickstart.md §2) — every user story's tasks include its tests,
written before the implementation that makes them pass.

**Organization**: Tasks are grouped by user story. Stories US1-US4, US6 and US7 are P1; US5 is P2. Foundational
work (the table, the registry, the constants, the floor-follow/prune primitive and the row-action
transaction) is shared by every story and lives in Phase 2, because splitting it would mean every story
re-implements the same locked transaction.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on an incomplete task)
- **[Story]**: US1–US7 per spec.md; tasks with no story label are Setup, Foundational or Polish

## Path Conventions

Single Next.js app at the repository root: `src/`, `drizzle/`, `tests/`, `docs/`. Every path below is exact,
taken from plan.md's Project Structure and data-model.md/contracts/.

---

## Phase 1: Setup

- [X] T001 Read `node_modules/next/dist/docs/01-app/` sections on route handlers and server actions (per
      AGENTS.md) before touching `src/app/api/me/notifications/*/route.ts` or `src/app/notifications/actions.ts`
      in later phases; no file changes in this task.

**Checkpoint**: No code changes yet; ready for foundational work.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the sparse table, its registration, the constants, and the one locked transaction that every
story's row actions and prune logic reuse. No user story can be implemented until this phase is complete.

**⚠️ CRITICAL**: Phases 3–8 all call `markEvent`, the floor-follow or the prune added here.

- [X] T002 Add `notificationEventMarks` table to `src/server/db/schema/notifications.ts`: columns
      `project_id`, `user_id`, `event_id`, `event_seq` (`bigint`, `mode: "bigint"`), `counts_again_at`
      (`timestamptz`, not null), `created_at`, `updated_at` (`$onUpdate`); PK
      `(project_id, user_id, event_id)`; FK `(project_id, user_id)` → `member (organization_id, user_id)`
      `ON DELETE CASCADE`; FK `(event_id)` → `activity_events (id)` `ON DELETE CASCADE`; CHECK
      `event_seq > 0`; CHECK `counts_again_at = date_trunc('milliseconds', counts_again_at)`; index
      `notification_event_marks_floor_idx` on `(project_id, user_id, event_seq)` (data-model.md §1).
- [X] T003 [P] Add `{ table: "notification_event_marks", scopeColumn: "project_id" }` to `projectOwnedTables`
      in `src/server/db/project-owned.ts` (data-model.md §1 Registration, FR-027).
- [X] T004 [P] Add `EVENT_MARK_CAP = UNREAD_CAP * 2` to `src/lib/notifications/attention.ts`
      (contracts/services.md §2, N16.3).
- [X] T005 [P] Create `src/lib/notifications/snooze.ts`: `SNOOZE_CHOICES`, `SnoozeChoice`, `SNOOZE_LABEL`,
      `MORNING_HOUR = 9`, `parseSnoozeChoice`, `resolveSnooze(choice, now, timeZone): Date` using
      `Temporal.PlainDateTime.toZonedDateTime(timeZone, { disambiguation: "compatible" })`, truncated to
      whole milliseconds, throwing if the result is not strictly after `now` (contracts/services.md §1,
      research.md M8).
- [X] T006 [P] [US2] Write `src/lib/notifications/snooze.test.ts`: `resolveSnooze` for all three choices in
      `UTC`, `America/New_York` and `Australia/Lord_Howe`; "1 hour" is exactly 3 600 000 ms later; "Tomorrow
      morning" is 09:00 next local day; "Next week" is 09:00 next Monday strictly after today (including
      when today is Monday or Sunday); a spring-forward day resolves to just after the gap, an autumn-back
      day takes the earlier offset; every result is strictly after `now` and truncated to whole
      milliseconds; `parseSnoozeChoice` rejects anything else (quickstart.md §2 row 1).
- [X] T007 Run `pnpm db:generate` to produce `drizzle/0020_<generated>.sql` from T002 (one `CREATE TABLE`,
      its PK, its two FKs, its two CHECKs, `notification_event_marks_floor_idx`, no data migration), then
      `pnpm db:check` to confirm it matches the schema (data-model.md §5, FR-026). Depends on T002.
- [X] T008 [P] Write `tests/integration/notifications/marks-migration.test.ts`: applying the migration to a
      database seeded with members, events and `notification_states` rows leaves every existing row
      byte-for-byte unchanged and every count unchanged, the new table is empty, and a row action then
      works; assert `'infinity'::timestamptz > now()` and
      `date_trunc('milliseconds', 'infinity'::timestamptz) = 'infinity'::timestamptz` directly against
      Postgres (quickstart.md §2 row "FR-026, SC-008"). Depends on T007.
- [X] T009 Add `markEventFor(projectId, userId, eventId, until?)`, `fillMarksToCap(projectId, userId)` and
      `marksFor(projectId, userId)` to `tests/helpers/notifications.ts`, writing through the DAL where a
      product path exists and inserting directly inside `runCrossProject("test: …")` for an
      already-expired instant (quickstart.md §3). Depends on T002.
- [X] T010 In `src/server/dal/notifications.ts`, add the `MarkOutcome` union and change `write()`'s return
      type to `WriteOutcome` (`{ outcome, snoozesCleared }`), implement `firstUncoveredAttentionSeq` (the
      floor-follow, data-model.md §4.2), the prune statement inside the same transaction as the `GREATEST`
      upsert (data-model.md §4.3, counting `snoozesCleared` in SQL), and `markCount()`. Depends on T002,
      T004.
- [X] T011 In `src/server/dal/notifications.ts`, implement `NotificationsRepo.markEvent(input)`: the R3
      transaction order — `SET LOCAL lock_timeout`, project row `FOR UPDATE`, membership re-check, resolve
      the event by `(project_id, id, attention predicate)`, `seq <= seen_seq` ⇒ `unchanged`, cap check ⇒
      `at_cap`, `ON CONFLICT (project_id, user_id, event_id) DO UPDATE` upsert, then the floor-follow and
      prune from T010 when `newFloor > seen_seq` (data-model.md §4.4, contracts/services.md §3). Depends on
      T010.
- [X] T012 In `src/server/dal/notifications.ts`, add the hidden-now anti-join
      (`counts_again_at > now()`) to both branches of `unreadBranches` so `NotificationsRepo.unreadCount`
      honours marks, keeping every existing `LIMIT` (data-model.md §4.1, FR-003, FR-004, N9). Depends on
      T002.
- [X] T013 Write `tests/integration/notifications/marks.test.ts` covering FR-002–FR-006 and I1/I4 (one
      person, two projects; a mix of floor-read, individually-read, snoozed, expired-snooze and untouched
      events; the count equals untouched plus expired; marking newest leaves others; marking the oldest with
      nothing unread beneath it leaves zero marks; marking newest-first then the oldest collapses every
      mark; a read mark survives a reload; a muted project contributes nothing; invariants asserted after
      every ordering) — quickstart.md §2 row "FR-002 to FR-006". Depends on T009, T011, T012.

**Checkpoint**: the table exists, is registered, is migrated, and `markEvent`/`write`/`unreadCount` all
honour marks. User story implementation can now begin.

---

## Phase 3: User Story 1 - Dismiss one problem without dismissing the rest (Priority: P1) 🎯 MVP

**Goal**: a person can mark one problem read from the panel or `/notifications`, with no effect on any other
problem, working with and without client JavaScript, and refusing a crafted or foreign event id.

**Independent Test**: seed three unread events in one project and two in another; mark the middle one read
from the panel; the count falls by exactly one, that row loses "New", the other four are unchanged, and the
floor has not moved past anything still unread.

### Tests for User Story 1

- [X] T014 [P] [US1] Write `tests/integration/notifications/mark-read.test.ts` cases: two connections
      marking the **same** event read collapse to one row with no duplicate and no lost mark and the same
      count either way; two connections marking **different** events both survive and the floor never
      falls; a held project lock with a lowered timeout raises `NotificationsBusyError`, writes nothing,
      count unchanged; a row action on an event the floor has since passed is `unchanged`, not an error,
      and does not lower the floor (quickstart.md §2 row "FR-008, US3-AS5 to AS7"). Depends on T011.
- [X] T015 [P] [US1] Extend `tests/integration/notifications/scope.test.ts`: `resolveAttentionEvent`,
      `markEvent` and the prune/floor-follow are pinned to one project or run inside the project-set section
      over the caller's resolved set; `markEvent` with a project id outside the set throws `NotFoundError`
      before any SQL; `checkScope` reports no violation for `notification_event_marks` (quickstart.md §2 row
      "FR-004, FR-027, US7-AS3"). Depends on T003.

### Implementation for User Story 1

- [X] T016 [US1] In `src/server/dal/my-projects.ts`, add `resolveAttentionEvent(eventId)` to
      `ProjectSetScope.notifications`: one statement inside `runForProjectSet`, a `UNION ALL` of the two
      attention branches per project in the caller's set, each pinned `WHERE project_id = $p AND id = $e`
      plus the attention predicate; returns `{ projectId, seq } | null` (data-model.md §4, research.md M11,
      contracts/services.md §5). Depends on T011.
- [X] T017 [US1] In `src/server/dal/my-projects.ts`, add `markEvent(projectId, input)` to
      `ProjectSetScope.notifications`: `check(projectId)` throws `NotFoundError` before any SQL for an id
      outside the set, otherwise delegates to `NotificationsRepo.markEvent` (contracts/services.md §5).
      Depends on T011, T016.
- [X] T018 [US1] Add `NotificationMarkCapError` and `markEventRead(set, input)` to
      `src/server/services/notifications/index.ts`: Zod-validate `{ eventId }`, resolve via
      `resolveAttentionEvent`, call `markEvent` with `countsAgainAt: "never"`, recompute `unreadSummary`,
      return `RowActionResult`; throw `NotFoundError` for unknown/foreign/non-attention ids (one answer for
      all three), `NotificationMarkCapError` at the cap, `NotificationsBusyError` on a busy lock,
      `ForbiddenError` for a non-member actor (contracts/services.md §6, N23, FR-024, FR-025). Depends on
      T017.
- [X] T019 [US1] Add `markEventRead(prev, formData)` server action to `src/app/notifications/actions.ts`:
      read `eventId` (uuid, Zod) and `returnTo` (only `/notifications` accepted); no session ⇒ redirect to
      login; with `returnTo`, redirect to `/notifications?read=1` or `?rowError=<code>`; without it, return
      the `ActionResult<RowDone>` with `announcement` set only on a real change (contracts/services.md §8,
      §9, N12, FR-016, FR-017). Depends on T018.
- [X] T020 [P] [US1] Add `NotificationItem.actionsAvailable` and keep `isNew` in
      `src/lib/notifications/types.ts`; add `markCapText()` and extend `rowErrorText(code)` for `not_found`
      and `invalid` in `src/lib/notifications/text.ts`; add `markedReadConfirmation(count)`
      (data-model.md §6, contracts/ui.md §4). Depends on T004.
- [X] T021 [US1] Create `src/components/notifications/NotificationRowActions.tsx` (`"use client"`): a
      "Mark read" form with a hidden `eventId`, the hidden `returnTo` field rendered only until hydration
      (`useSyncExternalStore`), `Button pending`/`pendingLabel="Saving…"`, its own `LiveRegion` announcing
      only on a real change, dispatching `docket:notifications-changed` (contracts/ui.md §2, §5, research.md
      M18). Snooze controls land in Phase 4 (T030); this task renders only "Mark read" plus the
      `actionsAvailable === false` at-cap line with a "Mark all as read" submit. Depends on T019, T020.
- [X] T022 [US1] Wire `NotificationRowActions` into `src/components/notifications/NotificationList.tsx` for
      every item, passing `returnTo`/`onRowDone` through from the caller (contracts/ui.md §1). Depends on
      T021.
- [X] T023 [US1] Update `src/app/api/me/notifications/recent/route.ts` payload to include
      `items[].actionsAvailable` from `markCounts()` and `items[].isNew` from `hiddenByMark` (wired fully
      once Phase 2's `listAttention` change lands in T027/T028, but the route's shape change belongs with
      US1's `actionsAvailable` field) (contracts/http.md, data-model.md §6). Depends on T020.
- [X] T024 [US1] In `src/components/notifications/NotificationPanel.tsx`, handle `onRowDone`: clear a read
      row's "New" marker in place, and show `markedReadConfirmation` via the panel summary update
      (contracts/ui.md §6). Depends on T022.
- [X] T025 [US1] Update `src/app/notifications/page.tsx` to render the `?read=1` and
      `?rowError=busy|not_found|at_cap|invalid` confirmations from `rowErrorText`/`markedReadConfirmation`
      (contracts/services.md §9). Depends on T019, T020.
- [X] T026 [P] [US1] Extend `tests/integration/notifications/ui.test.tsx`: `renderToStaticMarkup` of
      `NotificationList` for read and unread rows shows the "New" badge only where it belongs, "Mark read"
      present with an accessible name naming the problem, the hidden `returnTo` present in un-hydrated
      markup, and no control when `actionsAvailable` is false (quickstart.md §2 row "FR-015 to FR-020,
      SC-009", scoped to US1's rows for this task). Depends on T022, T025.

**Checkpoint**: User Story 1 is fully functional and independently testable — "Mark read" works from the
panel and from `/notifications`, with and without JavaScript.

---

## Phase 4: User Story 2 - Put a problem off until later (Priority: P1)

**Goal**: a person can snooze a problem for "1 hour", "Tomorrow morning" or "Next week"; it leaves the count,
panel, `/notifications` list and callout at once, stays in Activity, and returns unread (and re-counted) when
the time passes, with no server-side work to expire it.

**Independent Test**: seed two unread problems; snooze one until tomorrow morning; count is 1, the row is
gone from the panel/`/notifications`/callout, the event is still in both Activity screens; move the clock
past the snooze and the count is 2 again with the row marked "New".

### Tests for User Story 2

- [X] T027 [P] [US2] Write `tests/integration/notifications/snooze.test.ts`: a snoozed event is absent from
      the count, the panel, `/notifications` and the callout, present in both Activity screens for everyone
      including the snoozer; seeding its instant in the past brings it back counted and "New" with no job
      run; re-snoozing replaces the instant in both directions; "Mark read" over a snooze replaces it and
      the event never returns; a snooze whose target is retried, published and resolved still returns
      unread and links where Activity links it; a snooze stored across a DST change in `America/New_York`
      flips the count at exactly its stored instant; `nextChangeAt` is the soonest live snooze over
      notifications-on projects, `null` with none, ignoring a muted project's and another person's snoozes
      (quickstart.md §2 row "N17 to N20, FR-010 to FR-014, US2"). Depends on T011, T012.

### Implementation for User Story 2

- [X] T028 [US2] In `src/server/dal/activity.ts`, add `AttentionRecord = ActivityRecord & { hiddenByMark:
      boolean }` and extend `listAttention` with the two anti-joins — exclude live snoozes inside each
      branch (before the `LIMIT`), and select `hiddenByMark` from the read-only anti-join
      (`counts_again_at > now()` after live snoozes are excluded) (data-model.md §4.5, contracts/services.md
      §4, M16). Depends on T002.
- [X] T029 [US2] In `src/server/dal/notifications.ts`/`my-projects.ts`, add `markCounts()` (per-project mark
      counts over the set, for `actionsAvailable`) and `nextChangeAt()` (soonest live snooze over
      notifications-on projects) to `NotificationsSetReader` and `ProjectSetScope.notifications`
      (data-model.md §4.6, §4.7, contracts/services.md §3, §5). Depends on T002, T011.
- [X] T030 [US2] In `src/server/services/notifications/index.ts`, add `snoozeEvent(set, input)`: Zod-validate
      `{ eventId, choice }`, resolve the event and its project's time zone, call `resolveSnooze`, then
      `markEvent` with that instant; same error mapping as `markEventRead`. Update `unreadSummary` to
      include `nextChangeAt` from T029 (contracts/services.md §6, FR-021). Depends on T016, T029, T005.
- [X] T031 [US2] In `src/server/services/notifications/panel.ts`, update `toNotificationItem` to compute
      `isNew = seq > seen && !record.hiddenByMark` and `actionsAvailable` from `markCounts`
      (contracts/services.md §7). Depends on T028, T029.
- [X] T032 [US2] Add `snoozeEvent(prev, formData)` server action to `src/app/notifications/actions.ts`:
      reads `eventId`, `choice`, `returnTo`; redirects to `/notifications?snoozed=<slug>&until=<iso>` or
      returns `ActionResult<RowDone>` with `snoozedUntil` (contracts/services.md §8, §9). Depends on T030.
- [X] T033 [P] [US2] Add `snoozedConfirmation(until, timeZone)` to `src/lib/notifications/text.ts`, formatted
      through `formatLocal` (contracts/ui.md §4, design system §4, `tests/lint/date-format.test.ts`).
      Depends on T020.
- [X] T034 [US2] Extend `NotificationRowActions` with the `<details>`/`<summary>` "Snooze" disclosure: three
      `<button name="choice" value="hour|tomorrow|next_week">` submits labelled from `SNOOZE_LABEL`, each
      with the sr-only problem name, posting to `snoozeEvent`; on snooze, focus moves to the panel heading
      via the existing `focusAfterMark` helper (contracts/ui.md §2). Depends on T021, T032, T033, T005.
- [X] T035 [US2] Update `src/app/api/me/notifications/route.ts` and
      `src/app/api/me/notifications/recent/route.ts` payloads to include `nextChangeAt` on `UnreadSummary`,
      and exclude currently-snoozed items from `recent`'s `items` (contracts/http.md, data-model.md §6).
      Depends on T030, T031.
- [X] T036 [US2] In `src/components/notifications/poll.ts`, change `startPolling` to take the whole
      `UnreadSummary`, arm a one-shot `setTimeout` from `nextChangeAt` (immediate if already past, none if
      `null`), re-arm after each refresh, and clear/not-arm while the page is hidden (contracts/ui.md §7).
      Depends on T035.
- [X] T037 [P] [US2] Extend `src/components/notifications/poll.test.ts`: with fake timers, a `nextChangeAt`
      two minutes out fires one refresh at that instant and not before; re-armed from each new summary; an
      instant already past refreshes immediately; `null` arms nothing and 60-second/become-visible
      behaviour is byte-for-byte today's; hiding the page clears the one-shot (quickstart.md §2 row
      "FR-022, US5-AS5, AS6"). Depends on T036.
- [X] T038 [US2] In `src/components/notifications/NotificationPanel.tsx`, re-arm the next-change timer from
      `unread.nextChangeAt` after a row action, and handle `onRowDone` dropping a snoozed row from the open
      popover (contracts/ui.md §3). Depends on T034, T036.
- [X] T039 [US2] Update `src/app/notifications/page.tsx` to render `?snoozed=<slug>&until=<iso>` via
      `snoozedConfirmation`, falling back to the generic "Snoozed." for an unparsable `until` or a slug
      outside the caller's set (contracts/services.md §9). Depends on T033, T034.
- [X] T040 [P] [US2] Extend `tests/integration/notifications/ui.test.tsx` for US2: the three snooze labels
      inside a `<details>`, the `/notifications` `snoozed`+`until` redirect rendering, an unparsable `until`
      falling back to generic text, a slug outside the set rendering generic text (quickstart.md §2 row
      "FR-015 to FR-020, SC-009", scoped to US2). Depends on T039.
- [X] T041 [P] [US2] Extend `tests/integration/notifications/routes.test.ts`: the count route adds
      `nextChangeAt` (ISO instant or `null`) and keeps every existing 401/no-cache/header behaviour; the
      panel route excludes snoozed items and returns `actionsAvailable` per item (quickstart.md §2 row
      "FR-021, FR-023, US7-AS4"). Depends on T035.

**Checkpoint**: User Stories 1 and 2 both work independently — snoozing hides a problem until its time,
with no recurring work, and Mark read from US1 still works unchanged.

---

## Phase 5: User Story 3 - "Mark all as read" still just bumps the floor (Priority: P1)

**Goal**: the three existing N4 mark-read paths keep doing exactly one forward floor move and now also prune
every sparse mark they cover, reporting cleared snoozes.

**Independent Test**: seed a mix of floor-read, individually-read, snoozed and expired-snooze events; run
"Mark all as read"; count is 0, every sparse mark for the project is gone, and a problem written a moment
later counts as unread.

### Tests for User Story 3

- [X] T042 [P] [US3] Extend `tests/integration/notifications/mark-all.test.ts`: with individually-read and
      snoozed events above the floor, `markAllRead` raises the floor over all of them, deletes every mark
      for the project in the same transaction, reports `snoozesCleared`, and cleared snoozes do not come
      back; an event committed a moment after the mark-all began counts as unread; a busy project still
      reports `busy` and writes nothing (quickstart.md §2 row "N19, FR-013, FR-005, US3"). Depends on T010.
- [X] T043 [P] [US3] Extend `tests/integration/notifications/view-mark.test.ts`: the project's Problems-only
      Activity view and All-activity-with-Problems-preset-first-page each prune that project's marks exactly
      as a mark-all does, touching no other project; a prefetch, a filtered view, and a later page prune
      nothing (quickstart.md §2 row "N4, US3-AS3"). Depends on T010.

### Implementation for User Story 3

- [X] T044 [US3] Update `markAllRead` in `src/server/services/notifications/index.ts` to sum `snoozesCleared`
      across the projects it marks and return `{ marked, busy, snoozesCleared }` (contracts/services.md
      §6, FR-013). Depends on T010, T042.
- [X] T045 [US3] Confirm `markProblemsView` in `src/server/services/notifications/index.ts` needs no
      signature change — the pruning happens inside `write` from T010 — and add a regression assertion if
      the existing call site needs updating for the new `WriteOutcome` shape (contracts/services.md §6).
      Depends on T010, T043.
- [X] T046 [P] [US3] Add `markAllConfirmation(snoozesCleared)` to `src/lib/notifications/text.ts`:
      "Marked as read." and, when `snoozesCleared > 0`, the added "N snoozed problems were cleared too."
      sentence (contracts/ui.md §4). Depends on T020.
- [X] T047 [US3] Update the "Mark all as read" UI call sites (`NotificationPanel.tsx`,
      `src/app/notifications/page.tsx`) and the `?marked=1[&busy=…][&snoozes=<n>]` redirect handling to use
      `markAllConfirmation` (contracts/services.md §9). Depends on T044, T046.
- [X] T048 [P] [US3] Extend `tests/integration/notifications/ui.test.tsx` for the `marked`+`snoozes` redirect
      parameter rendering (quickstart.md §2 row "FR-015 to FR-020, SC-009", scoped to US3). Depends on T047.

**Checkpoint**: Mark-all and the two N4 problems views still do one forward move each, and now prune the
sparse table in the same transaction.

---

## Phase 6: User Story 4 - The per-event state cannot grow without limit (Priority: P1)

**Goal**: however row actions are used, a person's marks for one project never exceed 200; at the cap, row
actions for that project are refused and the UI says why; a mark-all clears the cap.

**Independent Test**: mark oldest-first and confirm the table returns to empty each time; mark newest-first
to the cap; confirm the cap is enforced, surfaced, and cleared by "Mark all as read".

### Tests for User Story 4

- [X] T049 [P] [US4] Write `tests/integration/notifications/cap.test.ts`: filling one project to 200 marks
      newest-first with the oldest left unread makes the 201st row action refused with `at_cap`, writing
      nothing, the still-unread event still unread, and the panel's items for that project all report
      `actionsAvailable: false` while another project's report `true`; two connections racing at 199 produce
      200 rows, never 201 (the after-lock hook); "Mark all as read" prunes all 200 and row actions work
      again; opening the project's problems view does the same (quickstart.md §2 row "N16, FR-007, FR-020,
      US4"). Depends on T009, T011.

### Implementation for User Story 4

- [X] T050 [US4] Confirm the cap check added in T011 sits inside the locked transaction, after the
      membership re-check and before any write, refusing every row action for the project at 200 — including
      "Mark read" replacing an existing mark — and fix if T049 finds otherwise (data-model.md I3, research.md
      M9). Depends on T011, T049.
- [X] T051 [US4] Confirm `markCounts()` (T029) and `NotificationItem.actionsAvailable` (T020, T031) already
      expose the per-project cap state to every row, per-project and per-person, and that another project's
      rows stay available (research.md M9, US4-AS5); fix if T049 finds otherwise. Depends on T029, T031,
      T049.
- [X] T052 [US4] Confirm the at-cap row rendering in `NotificationRowActions.tsx` (T021) shows
      `markCapText()` with a "Mark all as read" submit when `actionsAvailable` is false, for both the panel
      and `/notifications`; fix if T049's UI assertions find otherwise. Depends on T021, T049.

**Checkpoint**: the 200 cap holds under concurrency, is surfaced per project, and is always escapable by
"Mark all as read".

---

## Phase 7: User Story 6 - Leaving still deletes everything (Priority: P1)

**Goal**: removing, leaving, or deleting a project or user removes the floor, the mute and every sparse mark
together, in the same transaction as the membership change; a rollback keeps all of it; a rejoin starts
clean.

**Independent Test**: give a member a floor, a mute, several marks and a snooze; remove them; check
everything is gone in the same transaction, a rolled-back removal leaves it all intact, and project/user
deletion removes it too.

### Tests for User Story 6

- [X] T053 [US6] Extend `tests/integration/notifications/membership.test.ts`: give a member a floor, a mute,
      several read marks and a snooze; removal and leaving delete the floor, the mute and every mark in the
      same transaction; a rolled-back removal (a throwing audit stub; the last-owner refusal) leaves all of
      it; deleting the project and deleting the user each remove every mark; a rejoin starts with none; a
      role change keeps them; the next request after removal counts and lists nothing from that project
      (quickstart.md §2 row "FR-027, US6"). Depends on T002.

### Implementation for User Story 6

- [X] T054 [US6] Confirm the `(project_id, user_id)` → `member` `ON DELETE CASCADE` FK on
      `notification_event_marks` (T002) is sufficient for every US6 scenario with no application-level
      cleanup needed; if T053 finds a gap (e.g. a direct-delete path that bypasses the FK), add the missing
      cleanup in the same place `notification_states`' deletion already happens. Depends on T002, T053.

**Checkpoint**: no reading state outlives a membership, with no new cleanup code beyond the FK — or with the
gap closed if testing finds one.

---

## Phase 8: User Story 7 - Every role manages their own, and only their own (Priority: P1)

**Goal**: every member role can use both row actions on their own state without affecting anyone else's; no
project-owned query escapes its project; API keys and forged requests are refused.

**Independent Test**: as an editor, use both row actions; as another member, confirm their count is
unaffected; run the scope harness over every new statement; send crafted requests naming another person's
state or another project's events.

### Tests for User Story 7

- [X] T055 [P] [US7] Extend `tests/integration/notifications/mute.test.ts` (or add alongside it, matching its
      existing pattern): an editor uses both row actions on their own state; another member of the same
      project sees an unchanged count, panel and callout; a non-member actor (API key / job scope) is
      refused (quickstart.md §2 row "FR-025, US7-AS1, AS2"). Depends on T019, T032.
- [X] T056 [P] [US7] Finish `tests/integration/notifications/scope.test.ts` begun in T015: run the project-
      scope test harness over every new statement — the count, the panel, `markCounts`, `nextChangeAt`,
      `resolveAttentionEvent`, the floor-follow, the prune and the mark upsert — confirming each is pinned to
      one project or runs inside the project-set section, `checkScope` reports no violation for
      `notification_event_marks`, and a member removed mid-request is excluded by the statement's own
      `member` join (quickstart.md §2 row "FR-004, FR-027, US7-AS3"). Depends on T015, T029, T030.

### Implementation for User Story 7

- [X] T057 [US7] Confirm `markEventRead`/`snoozeEvent` server actions (T019, T032) and services (T018, T030)
      refuse a non-session actor and that `src/proxy.ts`'s same-origin check refuses a forged POST before
      anything is written; fix if T055/T056 find a gap (contracts/http.md "Not provided", FR-024, FR-025,
      US7-AS4, AS5). Depends on T019, T032, T055, T056.

**Checkpoint**: isolation and role rules hold for every new statement and every new mutation, with the
existing harness as proof.

---

## Phase 9: User Story 5 - The callout and the count agree (Priority: P2)

**Goal**: the bell, the refresh route, the panel summary and the project callout always report the same
number, computed the same way, everywhere a count appears.

**Independent Test**: in one project, mix floor-read, individually-read, snoozed and expired-snooze events;
compare the bell, the refresh, the panel summary and the callout; open the project's home and Posts screens.

### Tests for User Story 5

- [X] T058 [P] [US5] Extend `tests/integration/notifications/count.test.ts`: everything it asserts today
      still holds, and 150 unread with marks in play still gives 100 with the work stopped at 100 (assert on
      the recorded SQL's `LIMIT`s) (quickstart.md §2 row "FR-003, N9"). Depends on T012.
- [X] T059 [P] [US5] Add a project-callout agreement case to `tests/integration/notifications/ui.test.tsx` (or
      a dedicated callout test, matching existing patterns): `ProblemsCallout` is hidden once everything is
      read or snoozed and reappears with the right number when a snooze expires; a muted project contributes
      nothing (quickstart.md §2 row "FR-015 to FR-020, SC-009", scoped to US5; spec US5-AS2–AS4).
      Depends on T012, T035.

### Implementation for User Story 5

- [X] T060 [US5] Confirm `projectUnread` (the callout, in `src/server/services/notifications/index.ts`) needs
      no change beyond calling the already-updated `unreadCount` (T012), and that it stays hidden at zero and
      for a muted project; fix if T058/T059 find otherwise (contracts/services.md §6, FR-019). Depends on
      T012, T058, T059.

**Checkpoint**: every surface that shows a count agrees, in every mix of read/snoozed/expired state.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: performance proof, docs, and the final manual pass across every story.

- [X] T061 [P] Extend the seeded `tests/integration/notifications/performance.test.ts`: 100 000 events in one
      project, 200 000 across the person's 20 projects, the full 200 marks in each project (half read, half
      snoozed, a tenth expired); median of 5 after warm-up, 100 ms budget each, for `unreadSummary`,
      `GET /api/me/notifications` and `recentPanel`; assert every count branch still carries its `LIMIT 100`
      and no statement in the hot path joins `posts`, `post_targets` or `social_accounts` (quickstart.md §4,
      SC-006, N18). Depends on T011, T012, T028, T030.
- [X] T062 [P] Update `docs/decisions.md`: add N13–N24 next to N2/N3 (stating which part of each is reversed,
      why, and what happens to data written under the old rule) and a new `## 056 — Per-event read state and
      snooze` heading recording M1–M18 (FR-028). This task transcribes the decisions already written in
      spec.md and research.md; it does not invent new ones.
- [X] T063 [P] Rewrite `docs/activity.md`'s Notifications section for the row actions, snoozing, what the
      floor still does, and what a snooze means for a target that has since been fixed (FR-028).
- [X] T064 [P] Update `docs/design-system.md` and `.claude/skills/docket-ui/SKILL.md` with the row-action
      pattern in a list (`<details>`/`<summary>` disclosure holding fixed-choice submits), noting no new UI
      primitive was needed (FR-028, research.md M18).
- [X] T065 Run `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build` once, after every
      task above (quickstart.md §5). Depends on every prior task.
- [ ] T066 Browser walk-through, keyboard only, as the last task (quickstart.md §6, roadmap rule): mark one
      problem read and hear the live-region announcement; snooze another until tomorrow morning and hear its
      announcement; confirm both events still show in the project's Activity; repeat both with JavaScript off
      from `/notifications`; check visible focus at every step and that nothing is conveyed by colour alone.
      **Needs a signed-in browser session** — no pipeline phase has one, so this is a human-owned task.
      Depends on T065.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup. BLOCKS every user story — the table, its registration, the
  constants, `markEvent`, the floor-follow/prune, and the marked-aware `unreadCount` are each read or written
  by every story's tasks.
- **User Stories (Phases 3–9)**: all depend on Foundational completion.
  - US1 (Phase 3) has no dependency on another story.
  - US2 (Phase 4) reuses US1's `NotificationRowActions` component (T021) and `resolveAttentionEvent`/
    `markEvent` plumbing (T016, T017) — add the Snooze disclosure beside "Mark read", not instead of it.
  - US3 (Phase 5) depends only on Foundational (T010's `write()` change); independent of US1/US2.
  - US4 (Phase 6) depends on Foundational (T011's cap check) and reuses US2's `markCounts`/`actionsAvailable`
    wiring (T029, T031) and US1's row-rendering (T021) to surface the cap; its own tasks are mostly
    confirmation/fix tasks over already-built plumbing.
  - US6 (Phase 7) depends only on Foundational (T002's FK); independent of US1–US4.
  - US7 (Phase 8) depends on US1 and US2's mutations existing (T019, T032) to test against; otherwise
    independent in implementation (confirmation/fix tasks).
  - US5 (Phase 9, P2) depends on Foundational (T012) and US2's route changes (T035) to have a snooze case to
    compare; lowest priority, can slip to last.
- **Polish (Phase 10)**: depends on all desired user stories being complete.

### Within Each User Story

- Tests are written before the implementation tasks that make them pass (FR-029 requested tests).
- DAL/service layer before route/action layer before UI components (matches the plan's layering).
- Story complete and checkpointed before moving to the next priority, though US1→US2→US3→US4 share enough
  plumbing that sequential delivery in that order is the realistic path (see note below).

### Parallel Opportunities

- T003, T004, T005 (Foundational) can run in parallel once T002 lands.
- T006 (snooze unit test) can run in parallel with T007–T013 once T005 lands.
- Within US1: T014, T015 (tests) in parallel; T020 in parallel with T016/T017.
- Within US2: T027 (test) in parallel with T028/T029 implementation; T033, T037, T040, T041 in parallel
  once their dependencies land.
- US3 (Phase 5) and US6 (Phase 7) can be staffed in parallel with US1/US2 once Foundational is done, since
  neither touches `NotificationRowActions.tsx` or the routes.
- Phase 10's doc tasks (T062–T064) can run in parallel with each other and with T061.

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational (the table, the registry, `markEvent`, the floor-follow/prune, the
   marked-aware count) — CRITICAL, blocks every story.
3. Complete Phase 3: User Story 1 ("Mark read").
4. **STOP and VALIDATE**: run `marks.test.ts`, `mark-read.test.ts`, `scope.test.ts`'s new cases, and the
   `ui.test.tsx` additions for US1; confirm the independent test in Phase 3's header.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. US1 ("Mark read") → independently testable (MVP).
3. US2 (Snooze) → builds directly on US1's row-action component; independently testable.
4. US3 (Mark-all still bumps the floor) → can land any time after Foundational; independently testable.
5. US4 (the 200 cap) → mostly confirms US2's `markCounts`/`actionsAvailable` plumbing holds under
   concurrency; independently testable.
6. US6 (membership cleanup) → independent of UI work; can be done any time after Foundational.
7. US7 (isolation and roles) → confirms US1/US2's mutations are properly scoped; naturally lands after them.
8. US5 (P2, cross-surface agreement) → last; confirms what the earlier stories already built.
9. Polish: performance, docs, final checks, browser walk-through (last, per roadmap rule).

### Note on "independent" stories that share files

Several stories touch the same files (`NotificationRowActions.tsx`, `src/server/dal/notifications.ts`,
`src/app/notifications/actions.ts`) because the plan's "one service layer, many callers" principle means
one row-action component and one DAL module serve every row action. "Independently testable" here means
each story's own test file and acceptance scenarios pass on their own — not that the stories never touch a
shared file. Within a shared file, land US1's piece before US2's piece (Snooze is additive beside Mark
read, never a replacement), to avoid merge conflicts on the same component.
