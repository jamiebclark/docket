# Research: Per-event read state and snooze

Plan decisions **M1–M18**. The spec settled the product judgement calls as **N13–N24**; these are the
engineering ones. `docs/decisions.md` records N13–N24 next to N2/N3 and these M-decisions under a new
`## 056 — Per-event read state and snooze` heading (FR-028).

There was nothing to look up: no platform API, no new library, no new endpoint. The spec says so outright
("No external platform facts are involved, so nothing here needs `docs/research/`"), and the Technical Context
in [plan.md](./plan.md) carries no `NEEDS CLARIFICATION`. Everything below is a choice about this
repository's own code, checked against the code on `main`.

---

## The state

### M1 — One table, `notification_event_marks`, keyed `(project_id, user_id, event_id)`

**Decision**: a new project-owned table whose primary key is `(project_id, user_id, event_id)` and whose only
payload is `event_seq bigint` and `counts_again_at timestamptz`. Not columns on `activity_events`, and not a
JSON blob on `notification_states`.

**Rationale**: the key is exactly "one person, one project, one event" from FR-002, so "at most one mark"
is a database fact rather than application discipline, and "snoozing an event twice replaces the earlier
choice" is one `ON CONFLICT DO UPDATE`. The count's probe (`project_id = … AND user_id = … AND event_id = …`)
is the primary key's full prefix, so it is one index lookup with no extra index.

**Alternatives considered**:

- *Columns on `activity_events`*: read state is per person; the log is shared and append-only (020 P4). Dead.
- *A JSON array of marks on the `notification_states` row*: one row per person stays, but the count would
  have to unnest and compare in SQL on every request, the cap would be a length check in application code,
  and two tabs marking different events would lose one another's write under `READ COMMITTED` unless the whole
  blob were rewritten under the lock. The sparse table gets per-row upserts and a real `DELETE … WHERE
  event_seq <= floor` for the prune.
- *A row per event with a boolean plus a nullable instant*: two states to count separately, against N15.

### M2 — `counts_again_at` is `NOT NULL`, and "read" is `'infinity'::timestamptz`

**Decision**: one non-null `timestamptz`. `infinity` means read for ever; a finite value is a snooze.
"Hidden right now" is the single predicate `counts_again_at > now()`.

**Rationale**: this is N15 made literal — "every read of the state is one comparison against the current
time". A nullable column would force `coalesce` or an `OR` into the count's anti-join, and 022's SQL rules
forbid `OR`.

The three Postgres behaviours this leans on were run against this project's own Postgres 17 while planning,
and are asserted again by a test rather than trusted:
`'infinity'::timestamptz > now()` is true (so one anti-join catches read marks and live snoozes alike),
`'infinity' < 'infinity'` is false (so the snooze-only anti-join leaves a read row in the panel, N20), and
`date_trunc('milliseconds', 'infinity'::timestamptz)` is `'infinity'` (so the millisecond CHECK in M4 accepts
a read mark). `node-postgres` parses an infinite `timestamptz` to the number `Infinity`, so the column is
never selected raw into TypeScript — see the driver note in
[data-model.md](./data-model.md#the-three-postgres-facts-the-design-leans-on).

**Alternatives considered**: nullable-means-read (needs `coalesce`/`OR`); a year-9999 sentinel (a magic
number that prints in payloads and can be compared wrongly); two columns (`read_at`, `snoozed_until`) —
two states again, and three predicates instead of one.

### M3 — `event_seq` is denormalised onto the mark

**Decision**: copy `activity_events.seq` onto the mark row at write time, inside the same locked transaction
that read it.

**Rationale**: the floor is a `seq`, so the two statements that enforce the bound — "prune everything at or
below the new floor" and "a mark may only exist above the floor" — become `WHERE event_seq <= $floor` with no
join to a 100 000-row log. It is safe to denormalise because the log is append-only: an event's `seq` is
assigned once and never changes (020), and `event_id` is a foreign key to it.

**Alternatives considered**: joining `activity_events` on every prune (a join to the biggest table inside the
write lock, for a value that cannot change); storing only `event_seq` and no `event_id` (then the count's
probe would need `seq` from the log, and `seq` is not the log's primary key).

### M4 — Two CHECKs, and no CHECK on the instant's value

**Decision**: `CHECK (event_seq > 0)` and
`CHECK (counts_again_at = date_trunc('milliseconds', counts_again_at))`. Nothing asserts that the instant is
in the future.

**Rationale**: the millisecond check keeps the instant exactly round-trippable through the JSON payload and
the `formatLocal` wording, the same discipline `activity_events_ms` applies to `occurred_at`. A
"must be in the future" CHECK cannot be written honestly: it is true only at the moment of writing, and an
expired snooze — a first-class state (N15) — is a row whose instant is in the past. The future-ness of the
three choices is guaranteed by the pure resolver and asserted by its unit test (M8) and by the service
before the write.

### M5 — The membership foreign key does all the deleting; the event foreign key is insurance

**Decision**: `FOREIGN KEY (project_id, user_id) REFERENCES member (organization_id, user_id) ON DELETE
CASCADE`, exactly as `notification_states_member_fk`, plus
`FOREIGN KEY (event_id) REFERENCES activity_events (id) ON DELETE CASCADE`. No composite foreign key to
`(project_id, id)` on the log.

**Rationale**: the membership key is what makes US6 true for free and in the same transaction — remove,
leave, project deletion and user deletion all travel through `member`, and a rolled-back removal leaves every
mark intact. Reusing the identical key shape means the floor, the mute and the marks cannot diverge. The
event key is cheap insurance for a log row that in practice is never deleted.

A composite key to `(project_id, id)` would additionally prove in the database that a mark's project matches
its event's project, but it needs a new unique index on `(project_id, id)` over the largest table in the
schema, paid on every activity insert, to defend against a bug the write path already excludes: the mark is
only ever written from a row resolved by `WHERE project_id = $p AND id = $e AND <attention predicate>`
(M11), so a cross-project mark cannot be formed. The consistency is stated as an invariant in
[data-model.md](./data-model.md) and asserted by a test instead.

### M6 — One extra index: `(project_id, user_id, event_seq)`. No new index on `activity_events`

**Decision**: add `notification_event_marks_floor_idx` on `(project_id, user_id, event_seq)`. Change nothing
about `activity_events`.

**Rationale**: the primary key serves the count's per-event probe; this index serves the prune
(`event_seq <= floor`), the cap count and the next-change scan, all of which read one person's ≤200 rows for
one project. R4's two partial indexes still drive every scan over the log: the count and the floor-follow
both walk `activity_events_attention_seq_idx` from the floor upwards with the marks probed by primary key, so
FR-004's "index-backed" promise holds with no change to the log. The spec expected "one possible index
change"; the design needs none, which is a strictly better outcome for the write path.

---

## The rules

### M7 — Marking read pulls the floor up to just below the oldest uncovered event

**Decision**: a row action runs, inside the lock and after writing its own mark:

1. find `firstUncovered` — the smallest attention `seq` for this person above the floor that has no
   `counts_again_at = 'infinity'` mark (an anti-join; a snoozed or expired-snooze mark does **not** cover);
2. `newFloor = firstUncovered - 1` when one exists, otherwise `newestAttentionSeq` (what "Mark all as read"
   uses);
3. when `newFloor > seen_seq`, raise the floor with the existing `GREATEST` upsert and
   `DELETE … WHERE event_seq <= newFloor` in the same transaction.

**Rationale**: FR-006 only asks that marking the oldest unread event raise the floor over it, but the same
query gives the maximal safe floor for free, and that is what makes US4 true for *any* order of work, not
just oldest-first. Mark newest-first down to the oldest and the final mark collapses every mark above it:
the sparse table returns to empty rather than keeping one row per event the person touched. It is safe
because a snoozed event is never "covered", so the floor always stops below it (which is also exactly what
makes N19's "the floor wins" a deliberate act of mark-all rather than an accident of a row action).

Running the same step after a **snooze** is deliberate and also safe: the event just snoozed is itself
uncovered, so `firstUncovered <= seq(E)` and the floor can never pass it; what it can do is absorb read marks
that sit below it, which keeps the table smaller for no extra statement.

**Alternatives considered**: raising the floor only to the marked event's own `seq` (leaves marks behind for
ever on the newest-first path, so the 200 cap would be reached by ordinary use rather than by abuse);
recomputing the floor in a background sweep (new recurring work, which this entry explicitly avoids);
scanning for a maximal run in application code (one round trip per event instead of one query).

### M8 — The snooze resolver is pure, in `src/lib/notifications/snooze.ts`

**Decision**: `resolveSnooze(choice, now, timeZone): Date` with three choices — `hour` (`now` plus exactly one
hour), `tomorrow` (09:00 on the next calendar day in the project's zone) and `next_week` (09:00 on the next
Monday strictly after today in that zone) — resolved through
`Temporal.PlainDateTime.toZonedDateTime(timeZone, { disambiguation: "compatible" })` and truncated to whole
milliseconds. `MORNING_HOUR = 9` is one exported constant.

**Rationale**: `compatible` is the rule Docket already ships for project-zone wall-clock times
(`resolveLocalDateTime` and `resolveOccurrence` in `src/server/services/queue/occurrences.ts`, from 020's
research D2): a time that does not exist because the clock sprang forward moves to just after the gap, and an
ambiguous one takes the earlier offset. Using the same rule means a snooze and a posting slot never disagree
about what "09:00" meant on a clock-change day. Resolving once and storing the instant is N17; nothing
recomputes it, so a snooze set before a clock change fires at the instant it was promised (FR-009, US2-AS5).

The function is a pure library module so the DST cases are unit-testable with no database and no server, and
so the UI can label the three choices from the same constant list.

**Alternatives considered**: moving `resolveLocalDateTime` out of the queue service into a shared `lib/time`
module so there is literally one implementation. Rejected for this entry: it would edit scheduler code to
gain nothing but a shared one-line Temporal call, and the scheduler is the riskiest thing in the repository
to touch for cosmetic reasons. The duplication is one option object; both sites name `compatible` and cite
the same research note, and `snooze.test.ts` asserts the gap and overlap outcomes directly.

### M9 — The cap refuses every row action for the project, including an in-place replacement

**Decision**: at 200 marks for a `(project, person)`, every row action for that project is refused with
`at_cap` — including "Mark read" on an event that already has a mark, which would not grow the table.

**Rationale**: FR-007 and US4-AS3/AS4 say the rows state that the per-row actions are unavailable and that a
submission anyway is refused. One rule the UI can state truthfully on every row of the project beats a rule
that is true for some rows and not others, and the way out is one click ("Mark all as read") that prunes
everything. This is recorded explicitly because the looser rule (allow replacements, refuse insertions) is
defensible and a reader will wonder: it was rejected for honesty of the message, not for cost.

**Where it is checked**: inside the locked transaction, after the membership re-check and before any write,
so two tabs cannot both slip past 200. The count is one index scan of the person's own rows for that project.

### M10 — `seen_seq` below the floor short-circuits to "unchanged", never to an error

**Decision**: a row action whose event is at or below the current floor writes nothing and returns
`unchanged`. The UI refreshes the count, announces nothing (N12), and shows no error.

**Rationale**: this is the stale-second-tab case in the spec's edge cases, and the floor must never be
lowered. Treating it as success-with-no-change keeps the person's list from sprouting error alerts for work
somebody (possibly they themselves, in another tab) already did.

### M11 — A row action names the event id alone; the server resolves the project inside the project set

**Decision**: `resolveAttentionEvent(eventId)` on `ProjectSetScope.notifications` runs one statement inside
`runForProjectSet`: a `UNION ALL` of two branches per project in the caller's set, each pinned
`WHERE project_id = $p AND id = $e` plus the attention predicate for that branch (the three member outcomes
as SQL literals; `connect_failed` with `actor_user_id = $u`). It returns `{ projectId, seq }` or `null`, and
`null` is the same `NotFoundError` the actions raise for an unknown id.

**Rationale**: N23 — no new identifier and no internal position reaches the browser, and the form cannot
carry a project slug that a caller might swap. Each branch is a primary-key lookup with an extra predicate,
so the whole statement is ≤40 index probes for a person in 20 projects. Because the attention predicate is
part of the resolution, an event that exists in the caller's project but is not an attention event for them
(a published post, or somebody else's connect failure) is indistinguishable from one that does not exist.

The service resolves twice on purpose: once outside the lock, to learn the project's time zone before
resolving a snooze choice to an instant, and once inside the lock, where the `seq` and the membership must be
re-read anyway. Both are cheap, and only the second one is trusted.

### M12 — Row actions reuse R3's transaction verbatim

**Decision**: `SET LOCAL lock_timeout`, the project row `FOR UPDATE`, the membership re-check, then the
reads and writes; `55P03` becomes `NotificationsBusyError`; a timeout writes nothing.

**Rationale**: FR-008. It is the same order as the existing mark-read path, so the deadlock argument from R3
still holds unchanged — a mark waits only on its one project row, and only before it holds any other lock —
and two tabs marking the same event collapse into one upsert while two tabs marking different events both
survive. Nothing new is lockable, so there is no new lock-order question to answer.

### M13 — `write()` returns an outcome object, so "Mark all as read" can say it cleared snoozes

**Decision**: `NotificationsRepo.write` changes from returning `"changed" | "unchanged" | "not_member"` to
returning `{ outcome, snoozesCleared }`, where `snoozesCleared` counts the pruned marks whose instant was
finite and still in the future. `markAllRead` sums it and the confirmation names it.

**Rationale**: FR-013 and US3-AS2 require the confirmation to say that snoozed problems were cleared too,
which is only knowable inside the transaction that pruned them. Five call sites change; the alternative — a
second query after the commit — would race with another tab and could under- or over-report.

The existing "skip the lock when nothing newer is visible" fast path is kept as it is. It is still correct:
if nothing is above the floor then no mark can exist (the invariant), and if anything is above the floor the
lock is taken and the prune runs, even when every event up there is already individually read.

### M14 — `now()` comes from the database, in every comparison

**Decision**: the count, the panel's snooze exclusion, the readness flag, the next-change query and the cap
check all compare against the transaction's `now()`. No clock is passed in from the application, and
`recentPanel`'s existing `now` argument stays what it is — the rendering clock for relative times.

**Rationale**: one clock means the count, the panel and the callout cannot disagree about whether a snooze
has run out (US5-AS1, SC-002), with no skew between the web process and Postgres. Tests control the clock by
seeding instants in the past or the future, which is how an expired snooze has to be seeded anyway.

---

## The surfaces

### M15 — Two anti-joins, so the SQL stays free of `OR`

**Decision**: a mark is classified by two primary-key anti-joins rather than by reading its value and
branching:

| Purpose | Join condition | Used by |
|---|---|---|
| hidden now (read **or** snoozed) | `counts_again_at > now()` | the count (`IS NULL` keeps the row), the panel's "New" flag (`IS NOT NULL` clears it) |
| snoozed now (not read) | `counts_again_at > now() AND counts_again_at < 'infinity'` | the panel, `/notifications` and the callout exclude the row |
| covers the floor | `counts_again_at = 'infinity'` | the floor-follow's `firstUncovered` |

**Rationale**: 022's deliberate SQL rules — no `OR`, no `NOT` other than an `IS NULL` / `IS NOT NULL`
anti-join — exist so the attention predicates keep matching the partial indexes and so every statement is
readable at a glance. The three-way classification would otherwise need `OR` or a `CASE` in a `WHERE`. Each
join is the mark primary key's full prefix against at most 200 rows, so the extra join costs a probe, and
the planner's choice of driving index does not change.

### M16 — `listAttention` does the snooze exclusion in SQL and reports readness

**Decision**: `createActivityReader(...).listAttention` gains the two anti-joins above and returns
`AttentionRecord[]` = `ActivityRecord & { hiddenByMark: boolean }`. `ActivityRecord`, `list` and `summary`
are untouched.

**Rationale**: FR-018 wants ten rows *after* snoozed ones are removed, so the exclusion has to be inside the
branch that applies the limit — filtering in application code would return fewer than ten, or would need to
over-fetch by the cap across every project. Reporting readness from the same statement is what lets the "New"
marker and the count agree about the same `now()` (M14). `listAttention` is only called by the panel, so
widening its return type touches one caller and leaves the generic Activity reader alone.

### M17 — `nextChangeAt` lives on `UnreadSummary`

**Decision**: `UnreadSummary` becomes `{ count, display, label, nextChangeAt: string | null }`, so the count
route, the panel's `unread` field and the server-rendered bell all carry it. It is the soonest finite
`counts_again_at` strictly after `now()` over the caller's **notifications-on** projects, or `null`.

**Rationale**: FR-021 only asks the count route for it, but putting it on the one summary type means the bell
can arm its refresh from the first server render instead of waiting up to 60 seconds for the first poll, and
it keeps one shape for `realtime-updates` to carry over its stream (N22). Muted projects are excluded because
they contribute nothing to count: a snooze there has no moment worth waking for. The query is a `UNION ALL`
of one `min()` per project over ≤200 of the person's own rows, inside the project-set section.

### M18 — Row actions are two server actions, and the row-action control is the only client leaf

**Decision**:

- Two server actions in `src/app/notifications/actions.ts`: `markEventRead` and `snoozeEvent`. Zod validates
  `eventId` (uuid) and `choice` (the three snooze keys); the only accepted `returnTo` stays `/notifications`.
- `NotificationRowActions` is a `"use client"` leaf rendered for every row by the shared `NotificationList`.
  It renders a "Mark read" submit and a `<details>` "Snooze" disclosure holding three submits
  (`name="choice"`), each named with the problem it acts on. It renders the hidden `returnTo` field only
  **until hydration** (`useSyncExternalStore`, the trick `NotificationBellClient` already uses), so a
  JavaScript-less post redirects back to `/notifications` with a confirmation and a hydrated one returns an
  `ActionResult` in place without navigating.
- It announces through a `LiveRegion` of its own, politely and only on a real change, and dispatches
  `docket:notifications-changed` so the bell re-counts.
- The panel passes an `onRowDone` callback (a client-to-client prop) so the snoozed row leaves the open
  popover and a read row loses its "New" marker without a refetch; `/notifications`, a server page, passes
  none and relies on the redirect.

**Rationale**: it satisfies FR-015 to FR-017 with the primitives already in the repository. `<details>` is
already used in `accounts/page.tsx` and `Composer.tsx`, is keyboard-reachable and focusable natively, and
needs no JavaScript — so the snooze choice is a labelled control rather than a hover affordance, and
"open the bell, open Snooze, choose when" is the three actions SC-001 allows. `Menu` was rejected because its
items are `onSelect` callbacks and would not exist without JavaScript; a permanently visible
`SegmentedControl` plus a submit per row was rejected because ten rows of four controls each is the clutter
`docs/design-system.md` warns about.

`AnnounceProvider` is page-local in this codebase (only `failures` and the post detail page mount it), so the
row action carries its own `LiveRegion` rather than assuming a provider above it. The bell's own poll
announcement cannot cover this: it fires only when the count *rises*, and a row action lowers it.

---

## Two places the plan differs from the spec's wording

Both are illustrations in the spec, not requirements, and both are resolved towards an existing project rule.

1. **The snooze confirmation's date shape.** N21 illustrates "Snoozed until Monday 9:00 AM." Docket has one
   date format, `formatLocal` (design system §4), and `tests/lint/date-format.test.ts` fails the build on a
   hand-rolled one. The confirmation therefore reads **"Snoozed until Mon, Oct 12, 9:00 AM EDT."** — the
   project's zone, as FR-016 requires, in the only shape the app uses.
2. **"Tomorrow morning" and "Next week" are 09:00.** The spec calls the hour a wording choice and allows the
   plan to name it once as a constant: `MORNING_HOUR = 9` in `src/lib/notifications/snooze.ts`, used by both
   the resolver and the choice labels.

## What was checked on `main` before deciding

- `src/server/db/schema/notifications.ts` — the floor, the mute, the composite membership key, the table
  comment that states the N3 invariant this entry reverses.
- `src/server/dal/notifications.ts` — `unreadBranches`, `newestAttentionSeq`, the R3 transaction, the lock
  timeout and after-lock test hooks, `NotificationsBusyError`.
- `src/server/dal/activity.ts` — `listBranch`, `branchConditions` (and its "plain AND-ed predicates only"
  comment), `BranchExtra`, `listAttention`'s four branches per project.
- `src/server/dal/my-projects.ts` — the one sanctioned cross-project reader, `runForProjectSet`, the
  `check(projectId)` that throws before any SQL, and the unmuted/all split.
- `src/server/db/project-owned.ts`, `src/server/db/cross-project.ts`, `tests/helpers/scope-check.ts` — how a
  new project-owned table joins the harness.
- `src/components/notifications/*` — the bell's hydration trick, the panel's `useActionState` and
  `CHANGED_EVENT`, `poll.ts`'s injectable `PollEnv`, `NotificationToggle`'s no-JavaScript form, `focus.ts`.
- `src/components/ui/*` — `LiveRegion`, `Announce` (page-local), `Menu`, `SegmentedControl`, `Button`.
- `src/lib/time/format.ts` and `tests/lint/date-format.test.ts` — the one date format.
- `src/server/services/queue/occurrences.ts` — the existing `disambiguation: "compatible"` rule.
- `src/proxy.ts` — the same-origin check that refuses a forged POST before anything is written.
