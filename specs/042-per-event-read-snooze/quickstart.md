# Quickstart: validating per-event read state and snooze

This guide runs and proves the feature end to end. The shapes are in [data-model.md](./data-model.md), the
interfaces in [contracts/](./contracts/) and the reasoning in [research.md](./research.md). Nothing needs
real platform credentials: attention events are written through the real DAL (`ActivityRepo.insert`) against
real Postgres, and no live platform call happens anywhere in this feature.

## 0. Prerequisites

- Node 24 and pnpm. **No new package**: nothing to install (constitution VI; the pipeline cannot reach npm).
- Postgres 17 for the integration suites (run-scoped test databases, as for every suite).
- After the schema change:
  1. `pnpm db:generate` — generates `drizzle/0020_*.sql` with `CREATE TABLE notification_event_marks`, its
     PK, its two FKs, its two CHECKs and `notification_event_marks_floor_idx`. There is **no** custom or
     data migration: the table starts empty (N24).
  2. `pnpm db:check` — the committed SQL must match the schema.
- No icon, environment variable, `.env.example` or `docker-compose.yml` change.

## 1. Run it

```bash
pnpm dev                      # web on http://localhost:3000
pnpm seed                     # a project, a member and some activity, if you want data to look at
```

Then, signed in:

1. Make some problems. Easiest is the mock provider: schedule posts that fail, or use the seed script's
   failures. Each failed, ambiguous or needs-reauth event, plus your own failed connect attempts, is a
   problem (N1).
2. Open the bell. Each row now has **Mark read** and a **Snooze** disclosure with "1 hour",
   "Tomorrow morning" and "Next week".
3. Mark the middle one read: the count drops by one, that row loses its "New" badge and stays in the list,
   the others are untouched.
4. Snooze another until tomorrow morning: it leaves the panel, the count and the project's callout at once,
   and the confirmation names the instant in the project's zone. Open the project's Activity — it is still
   there, with its real outcome.
5. Disable JavaScript and repeat both from `/notifications`: each posts a form, lands back on the page with
   the same confirmation, and the reloaded count is right.
6. Use "Mark all as read": the count is 0, and if any snooze was cleared the confirmation says so.

## 2. Targeted test map (run per task)

```bash
pnpm vitest run <the files for the task>
```

| Requirement | Test file (new unless marked) | Proves |
|---|---|---|
| N17, FR-009, US2-AS4, AS5 | `src/lib/notifications/snooze.test.ts` | `resolveSnooze` for all three choices in `UTC`, `America/New_York` and `Australia/Lord_Howe` (a half-hour DST zone): "1 hour" is exactly 3 600 000 ms later; "Tomorrow morning" is 09:00 on the next local day; "Next week" is 09:00 on the next Monday **strictly** after today, including when today is a Monday and when today is a Sunday. A spring-forward day that skips 09:00 resolves to just after the gap; an autumn-back day that repeats it takes the earlier offset. Every result is strictly after `now` and truncated to whole milliseconds. `parseSnoozeChoice` rejects anything else. |
| N16.3, FR-007 | existing `src/lib/notifications/text.test.ts` (extended) | `EVENT_MARK_CAP === 2 * UNREAD_CAP`. `markedReadConfirmation` at 0, 1 and 2; `snoozedConfirmation` renders through `formatLocal` with the zone; `markAllConfirmation` with 0, 1 and 2 cleared snoozes; `markCapText`; `rowErrorText` for all four codes, with `not_found` identical for every not-found cause. |
| FR-022, US5-AS5, AS6 | existing `src/components/notifications/poll.test.ts` (extended) | With fake timers: `nextChangeAt` two minutes out fires one refresh at that instant and not before; the one-shot is re-armed from each new summary; an instant already past refreshes immediately; `null` arms nothing and the 60-second and become-visible behaviour is byte-for-byte today's; hiding the page clears the one-shot and becoming visible refreshes once. |
| FR-002 to FR-006, US1, US5-AS1 | `tests/integration/notifications/marks.test.ts` | One person, two projects. In project A seed a mix: events below the floor, individually read, snoozed, expired-snooze and untouched. The count equals exactly the untouched plus expired ones, and the bell, the refresh route, the panel summary and the callout all return that same number. Marking the newest read drops the count by one and leaves the others. Marking the oldest, with nothing unread beneath it, raises the floor and leaves **zero** marks. Marking newest-first leaves one mark each and no floor movement, then marking the oldest collapses every mark (M7). A read mark survives a page reload. A muted project contributes nothing whatever its marks say. Invariants I1 and I4 are asserted after every ordering. |
| N16, FR-007, FR-020, US4 | `tests/integration/notifications/cap.test.ts` | Fill one project to 200 marks newest-first with the oldest left unread: the 201st row action is refused with `at_cap`, nothing is written, the still-unread event is still unread, and the panel's items all report `actionsAvailable: false` while another project's report `true`. Two connections racing at 199 produce 200 rows, never 201 (the after-lock hook). "Mark all as read" prunes all 200 and the next row action works again. Opening the project's problems view does the same. |
| N17 to N20, FR-010 to FR-014, US2 | `tests/integration/notifications/snooze.test.ts` | A snoozed event is absent from the count, the panel, `/notifications` and the callout, and present in both Activity screens for everyone including the snoozer. Seeding its instant in the past brings it back, counted and "New", with no job run. Re-snoozing replaces the instant in both directions; "Mark read" over a snooze replaces it and the event never returns. A snooze whose target is then retried, published and resolved still returns unread and still links where Activity links it (N18). A snooze stored across a DST change in `America/New_York` flips the count at exactly its stored instant, neither an hour early nor late. `nextChangeAt` is the soonest live snooze over notifications-on projects, `null` with none, and ignores a muted project's and another person's snoozes. |
| N19, FR-013, FR-005, US3 | existing `tests/integration/notifications/mark-all.test.ts` (extended) | With individually-read and snoozed events above the floor, `markAllRead` raises the floor over all of them, deletes every mark for the project in the same transaction, reports `snoozesCleared`, and the cleared snoozes do not come back when their instant passes. An event committed a moment after the mark-all began counts as unread. A busy project still reports `busy` and writes nothing. |
| N4, US3-AS3 | existing `tests/integration/notifications/view-mark.test.ts` (extended) | `/p/a/activity?outcome=problems` and `/activity?outcome=problems` prune project A's marks exactly as a mark-all does for it, and touch no other project's. A prefetch, a filtered view and a later page prune nothing. |
| FR-008, US3-AS5 to AS7, Edge Cases | existing `tests/integration/notifications/mark-read.test.ts` (extended) | Two connections marking the **same** event read: one row, one no-op, the same count either way, no duplicate and no lost mark. Two marking **different** events: both marks survive and the floor never falls. A held project lock with a lowered timeout: `NotificationsBusyError`, nothing written, the count unchanged. A row action on an event the floor has since passed is `unchanged`, not an error, and does not lower the floor. A writer interleaved by the after-lock hook is never covered. |
| FR-003, N9 | existing `tests/integration/notifications/count.test.ts` (extended) | Everything it asserts today still holds, and 150 unread with marks in play still gives 100 with the work stopped at 100 (assert on the `LIMIT`s in the recorded SQL). |
| FR-021, FR-023, US7-AS4 | existing `tests/integration/notifications/routes.test.ts` (extended) | Both handlers called directly. The count route adds `nextChangeAt` (an ISO instant, and `null` with no snooze) and keeps 401 for no session, an expired session and a `Bearer` key only, ignores crafted `?userId=`, `?project=` and `?eventId=` and a body, and keeps `Cache-Control: private, no-store` and `Vary: Cookie`. The panel route excludes snoozed items, returns `actionsAvailable` per item, and still never carries `details`, `seq` or post text. |
| FR-004, FR-027, US7-AS3 | existing `tests/integration/notifications/scope.test.ts` (extended) | With the scope recorder: every new statement — the count, the panel, `markCounts`, `nextChangeAt`, `resolveAttentionEvent`, the floor-follow, the prune and the mark upsert — is pinned to one project or runs inside the project-set section over the caller's resolved set, and `checkScope` reports no violation for `notification_event_marks`. `markEvent` with a project id outside the set throws `NotFoundError` before any SQL. A member removed mid-request is excluded by the statement's own `member` join. |
| FR-027, US6 | existing `tests/integration/notifications/membership.test.ts` (extended) | Give a member a floor, a mute, several read marks and a snooze. Remove them, and leave: the floor, the mute and every mark go in the same transaction as the membership. A rolled-back removal (a throwing audit stub; the last-owner refusal) leaves all of it. Deleting the project and deleting the user each remove every mark. A rejoin starts with none. A role change keeps them. The next request after removal counts and lists nothing from that project. |
| FR-025, US7-AS1, AS2 | existing `tests/integration/notifications/mute.test.ts` (extended) | An editor uses both row actions on their own state. Another member of the same project sees an unchanged count, panel and callout. A non-member actor (API key / job scope) is refused. |
| FR-015 to FR-020, SC-009 | existing `tests/integration/notifications/ui.test.tsx` (extended) | `renderToStaticMarkup` of `NotificationList` for read, unread, snooze-expired and at-cap rows: the "New" badge only where it belongs, both controls present with accessible names naming the problem, the three snooze labels inside a `<details>`, the hidden `returnTo` present in the server-rendered (un-hydrated) markup, the at-cap sentence with its "Mark all as read" control, and no control at all when `actionsAvailable` is false. The `/notifications` page for each redirect parameter (`read`, `snoozed` + `until`, every `rowError`, `marked` + `snoozes`), including an unparsable `until` falling back to the generic text and a slug outside the set. `ProblemsCallout` hidden once everything is read or snoozed and back when a snooze expires. |
| FR-026, SC-008 | `tests/integration/notifications/marks-migration.test.ts` | Applies the migration to a database seeded with members, events and `notification_states` rows: every existing row is byte-for-byte unchanged, every count is unchanged, the new table is empty, and a row action then works. Also asserts the two Postgres facts the design leans on: `'infinity'::timestamptz > now()` and `date_trunc('milliseconds', 'infinity'::timestamptz) = 'infinity'`. |
| SC-006 | existing `tests/integration/notifications/performance.test.ts` (extended) | §4. |
| Regression (existing, unchanged) | `tests/integration/activity/*.test.ts`, `tests/helpers/scope-check.test.ts`, `src/server/db/project-owned.test.ts`, `tests/lint/date-format.test.ts` | Activity lists, summaries, filters and the public API are byte-for-byte the same. The registry covers every table exactly once. No hand-rolled date formatter. |

## 3. Test helpers to add

`tests/helpers/notifications.ts`:

```ts
/** A mark for one event. `until` omitted means "read for ever" ('infinity'). */
markEventFor(projectId, userId, eventId, until?: Date)
/** Fills a project to EVENT_MARK_CAP marks for one person, leaving the oldest event unread. */
fillMarksToCap(projectId, userId)
/** The person's marks for a project, as { eventId, eventSeq, countsAgainAt }[] — for invariant assertions. */
marksFor(projectId, userId)
```

They write through the DAL where a DAL path exists; the expired-snooze and at-cap seeds insert directly
(inside `runCrossProject("test: …")`), because no product path can produce an instant in the past.

## 4. Performance (SC-006)

Extend the existing seeded performance test: 100 000 events in one project, 200 000 across the person's 20
projects, **and the full 200 marks in each project** (half read, half snoozed, a tenth already expired).
Median of 5 after a warm-up, budget 100 ms each, for:

- `unreadSummary` (the header bell, now including `nextChangeAt`);
- `GET /api/me/notifications`;
- `recentPanel` (the panel's 10 rows after the snooze exclusion).

Also assert the plan's shape promises from the recorded SQL: every count branch still carries its
`LIMIT 100`, the outer count still carries one, and no statement in the hot path joins `posts`,
`post_targets` or `social_accounts` (N18).

## 5. Final pass (once, at the end of implement)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build
```

`pnpm db:check` because the schema changed; `pnpm build` because route handlers, a server action and the
server/client boundary changed. Per the constitution, do not run the full set after every task — CI runs it
on every push.

## 6. Browser walk-through — the last task, after everything above

Keyboard only, in one project with at least three problems:

1. Tab to the bell, Enter to open. Tab to a row's "Mark read", Enter. The count drops by one, the row keeps
   its place without "New", and a screen reader hears "Marked as read. 2 unread problems."
2. Tab to another row's "Snooze", Enter to open the disclosure, Tab to "Tomorrow morning", Enter. The row
   leaves the panel and the reader hears "Snoozed until Mon, Oct 12, 9:00 AM EDT."
3. Open the project's Activity: both events are there with their real outcomes.
4. Turn JavaScript off and do 1 and 2 again from `/notifications`.
5. Check visible focus at every step, and that nothing is conveyed by colour alone.
