# Feature Specification: Per-event read state and snooze — dismiss one problem, or put it off until later

**Feature Branch**: `056-per-event-read-snooze`

**Created**: 2026-10-11

**Status**: Draft

**Input**: User description: "Before specifying, read .specify/roadmaps/notifications.md in full — its goal paragraph, the 'Behaviour on main that every entry builds on' bullet list (notification_states, attention events, the DAL readers, the routes, the components, the all-or-none env groups, the worker tick) and the 'Rules for every entry' list. Also read specs/022-problem-notifications/ (spec, data model, contracts, review) and decisions N1-N12 in docs/decisions.md in full, because this entry deliberately reverses shipped decisions and the spec must name which ones and why.

Scope of this entry: let a person dismiss one problem, or snooze it until later, without touching the rest. This reverses decision N3 (one forward-only watermark per project, never one row per event) and N2's rule that a problem stays unread until you mark the whole project read; say so explicitly and record the replacement decisions in docs/decisions.md next to the originals, including what happens to data already written under the old rule. Keep seen_seq as a floor — everything at or below it is read, and 'Mark all as read' still just bumps the floor — and add a sparse per-event table above the floor for individually read and snoozed events, so row growth stays bounded and the floor can absorb and prune the sparse rows. That bound is the point of the entry: N3 avoided per-event rows for cost reasons and this must not reintroduce them unbounded. A snoozed problem leaves the count and the panel until its time passes, then returns unread; snoozing is personal and never hides the event from Activity (N5's spirit). Define what a snooze means for an event whose target has since been retried or resolved, and what happens when the floor rises past a snoozed event. Update the count query, createNotificationsRepo and createNotificationsSetReader in src/server/dal/notifications.ts, both /api/me/notifications routes, the panel rows (per-row 'Mark read' and 'Snooze', keyboard reachable, announced through the LiveRegion) and ProblemsCallout.

Testing the author attached to this entry: counting with a mix of floor-read, individually-read, snoozed and expired-snooze events; pruning when the floor rises; concurrent mark-read from two tabs; snooze expiry at a DST boundary; membership removal still deleting everything; project isolation.

Must NOT take on: per-kind or per-platform preferences (owned by entry 2, notification-preferences); any email (owned by entry 3, email-delivery); replacing the 60-second poll (owned by entry 4, realtime-updates); notifications for successes or retries, which are not in this roadmap at all — N1 stands."

## Context and sources

- Roadmap `.specify/roadmaps/notifications.md` / `.specify/roadmaps/notifications.json`, entry 1 of 4, slug `per-event-read-state`. Its stated goal: finish the notification story that `022-problem-notifications` deliberately left half-built. This entry closes the third item on 022's own Out of Scope list ("per-event read state, marking a single problem read, or snoozing").
- It is first in the roadmap because the read/snooze state and the count-route payload shape that the three later entries consume are defined here.
- **Behaviour on `main` that this feature builds on** (read from `specs/022-problem-notifications/` and decisions **N1–N12** in `docs/decisions.md`):
  - **`notification_states`** is one row per membership, keyed `(project_id, user_id)`, holding `seen_seq` (a monotonic watermark: every attention event with `seq <= seen_seq` is read) and `muted`. A composite foreign key to the membership cascades the row away when the membership, project or user goes. The table's own comment states the N3 invariant outright: "never one row per event".
  - **Attention events** are decision N1: the outcomes *failed*, *ambiguous* and *needs reauth* for every member, plus *connect failed* only for the member who attempted it. *Published*, *retrying* and *resolved* never count. A connect failure with no recorded actor counts for nobody.
  - **Reads** go through one module: a newest-attention-position helper, a per-project repository (`createNotificationsRepo`) and a project-set reader (`createNotificationsSetReader`, the one sanctioned cross-project reader). Its SQL rules are deliberate: no `OR`, no `NOT` other than `IS NOT NULL`, every reference pinned to a project, and the attention outcomes written as SQL literals so the partial indexes match.
  - **Marking read is exact** (022's R3): each mark is its own transaction that sets a lock timeout, locks the project row, re-checks membership, reads the newest attention position and does a `GREATEST` upsert. There are no deadlocks because a mark waits only on its one project row, before it holds any other lock. A timeout marks nothing and is reported as "busy".
  - **Routes**: `GET /api/me/notifications` (the 60-second count poll, N12) returns `{ count, display, label }`; `GET /api/me/notifications/recent` returns the panel model (state, up to 10 items, the unread summary). Both are session-only, read no input, and are never cached.
  - **Components** in `src/components/notifications/`: the bell (server part plus client leaf), the panel, the shared list body, the "notifications changed" leaf, the per-project callout, the poller and the request-scoped view-mark glue. The personal `/notifications` page renders the same list body server-side and works with no client JavaScript.
  - **Three things mark read** (N4): "Mark all as read"; a project's Activity with the *Problems* preset and no other filter, first page; All activity under the same conditions. Opening the panel, other views, paging and prefetching mark nothing.
  - **Muting is personal and hides, it does not delete** (N5). Events stay in Activity for everyone, including the person who muted the project.
  - **The display is capped** at "99+" and counting stops at 100 (N9).
- No external platform facts are involved, so nothing here needs `docs/research/`. No new runtime dependency and no infrastructure is expected. One schema change (a sparse per-event mark table) and one possible index change are expected.
- **Not touched by this entry**: the all-or-none environment-variable groups and the worker tick. This feature adds no environment variable and no recurring server-side work: a snooze expires by the passage of time, which every read already compares against, so nothing has to run to expire it.

## Decisions made while specifying

These are judgement calls. Planning records each one in `docs/decisions.md`, **next to the decision it replaces**, as the roadmap's rules require.

### The two reversals

- **N13 — Reverses N3.** N3 said "one position per person per project, and it only moves forward. There is no per-event read state." That is now too coarse: it is what makes 022 unable to dismiss one item. The replacement keeps the cheap part and adds the sparse part:
  - `seen_seq` stays, and becomes explicitly a **floor**: every attention event at or below it is read, for ever, with no row of its own. "Mark all as read" and the three N4 paths still do nothing but bump the floor.
  - **Above the floor only**, a sparse per-event mark may exist for one person, one project and one event: "I have read this one", or "hide this one until a time".
  - The floor is still forward-only. A mark from a stale second tab never lowers it.
  - **Why N3 existed**: cost. N3 avoided one row per event because an installation writes an activity event for every target of every post, and read state must not grow with it. N16 is how that bound survives the reversal.
- **N14 — Reverses half of N2.** N2 said two things. The half that **stands**: unread means "newer than where you last looked", not "still broken" — a problem a person has not dealt with still counts after the target has been retried and published, and Docket does not second-guess that. The half that is **reversed**: "a problem stays unread until *the whole project* is marked read". A person may now mark one problem read, or snooze one problem, without touching the rest and without moving the floor past anything else.

### What the state means

- **N15 — One meaning, "hidden until".** A sparse mark carries an instant from which the event counts again. "Mark read" is that instant set to the end of time; "Snooze" is that instant set to when the snooze runs out. So read and snoozed are not two states to be counted separately: every read of the state is one comparison against the current time, which is what keeps the count as cheap as it is today. A mark whose instant has passed is an expired snooze and is simply ignored.
- **N16 — Bounded growth is the point of the entry.** Three rules together, and tests for each:
  1. **A mark can only exist above the floor.** Nothing at or below the floor ever gets a row.
  2. **The floor absorbs and prunes.** Whenever the floor rises — by "Mark all as read", by an N4 problems view, or by an individual mark that leaves nothing unread beneath it — every sparse mark at or below the new floor is deleted in the same transaction. In the ordinary case of a person who clears their problems oldest-first, the floor follows them up and the sparse table returns to empty.
  3. **A hard cap of 200 sparse marks per person per project**, twice the unread cap of 100, as a backstop against a person who marks hundreds read out of order while deliberately leaving the oldest one unread. At the cap, the per-row actions for that project are unavailable and the row says so, pointing at "Mark all as read", which clears the whole project and prunes every mark. Nothing is silently dropped and no unread event is silently turned read.
- **N17 — Snooze offers three fixed choices, in the project's time zone.** "1 hour", "Tomorrow morning" (09:00 the next day) and "Next week" (09:00 the next Monday). Docket stores no per-person time zone, and the panel already shows each row's time in its project's zone, so the project's zone is the only one available and the only one that will not surprise. "1 hour" is an exact duration; the two wall-clock choices are resolved once, when the snooze is set, with explicit DST disambiguation, and stored as an absolute instant. A snooze set before a clock change therefore fires at the instant it was promised; nothing recomputes it later.
- **N18 — A snooze is on the event, not on the target.** If the target is retried, published or resolved while the event is snoozed, the snooze still runs out and the event comes back unread — exactly as an unread problem that has since been fixed still counts today (the half of N2 that stands). Two reasons: the count stays a comparison of positions and times with no join to targets or accounts, which is what keeps it cheap; and a person who asked to be reminded is reminded. The row links where Activity links it, so a fixed target shows as the post rather than a Failures entry, and one "Mark read" clears it.
- **N19 — The floor wins over a snooze.** "Mark all as read", and the N4 problems views, raise the floor over everything that exists at that moment, including snoozed events, and prune their marks: a snoozed event at or below the new floor is read and does not come back. "All of this is read" is a stronger and later statement than "remind me later", and the alternative — snoozes surviving above a floor that claims to cover them — would break the invariant that makes the count cheap. When a mark-all clears snoozes, its confirmation says so.
- **N20 — A snoozed problem leaves the panel; a read one stays, without "New".** Snoozing is the action for "not now, and out of my way", so a snoozed event is excluded from the count, the panel, the `/notifications` list and the project callout until its time passes. An individually-read event keeps 022's panel behaviour: the panel lists the 10 newest attention events, read and unread alike, and it simply loses its "New" marker, so a person does not lose their place as they work down the list. Neither action hides anything from Activity, for anybody (N5's spirit).
- **N21 — The row actions are reachable, named and announced.** Each row in the panel, in `/notifications` and anywhere else the shared list is used, offers "Mark read" and "Snooze", each a real control whose accessible name identifies the problem it acts on, reachable in the normal Tab order, and working with no client JavaScript through a form post. The outcome is announced politely through the existing live region ("Marked as read. 2 unread problems.", "Snoozed until Monday 9:00 AM."), never as an alert, and only on a real change (N12's rule).
- **N22 — The count payload gains the next change.** The count route answers with the existing count, display and label plus the soonest moment at which one of the caller's snoozes runs out, or nothing when there is none. The bell refreshes then, instead of up to 60 seconds late, and the shape is the one the later `realtime-updates` entry carries over its stream.
- **N23 — A row action names the activity event by its existing id.** No new identifier, and no internal position, is exposed to the browser. The server resolves the id inside the caller's own project scope; an id in another project, an id that is not an attention event for that person, and an id that does not exist are the same "not found", change nothing and reveal nothing.
- **N24 — Nothing written under the old rule changes.** No per-event rows exist today, so there is nothing to migrate: the new table starts empty, and an empty table means the behaviour an existing installation has now, to the row. Every existing `notification_states` row keeps its `seen_seq` and `muted` exactly as they are, and is still the floor. No operator has to reset notification state, and the migration is safe to apply to a live installation with existing rows.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Dismiss one problem without dismissing the rest (Priority: P1)

A person opens the bell, sees three problems, recognises one as something they have already dealt with, and clears just that one. The count drops by one. The other two are still unread, still counted, and still waiting.

**Why this priority**: This is the entry. Today the only way to clear anything is to clear everything, so people either lose track of real problems or stop using the count.

**Independent Test**: Seed three unread attention events in one project and two in another. Mark the middle one read from the panel. Check the count fell by exactly one, that row is no longer marked "New", the other four still are, and the project's floor has not moved past anything still unread.

**Acceptance Scenarios**:

1. **Given** three unread problems in a project, **When** the person marks the newest one read, **Then** the count falls by one, that row loses its "New" marker and stays in the list, and the other two are unchanged.
2. **Given** a problem has been marked read, **When** any later page load, panel open or refresh happens, **Then** it is still read.
3. **Given** the oldest unread problem is marked read and nothing unread remains beneath it, **When** the mark is saved, **Then** the floor rises to cover it and no per-event mark is left behind.
4. **Given** problems are marked read out of order so that an older one is still unread, **When** the marks are saved, **Then** the floor has not moved and a sparse mark exists for each one marked.
5. **Given** a person marks a problem read, **When** a screen reader is in use, **Then** it hears politely that the problem was marked as read and what the count is now, and the control that was used names the problem it acted on.
6. **Given** client JavaScript is unavailable, **When** the person uses "Mark read" on the `/notifications` list, **Then** the mark is saved, the page confirms it, and the count on the reloaded page is right.
7. **Given** a crafted request naming an event in a project the person does not belong to, or an event that is not an attention event for them, **When** it is sent, **Then** nothing changes, the answer is the same "not found" as for an event that does not exist, and nothing about that project is revealed.

---

### User Story 2 - Put a problem off until later (Priority: P1)

A person sees a problem they cannot deal with right now. They snooze it for an hour, until tomorrow morning, or until next week. It leaves the count and the panel at once. When the time comes it is back, unread, as if it had just arrived.

**Why this priority**: Without snooze, "not now" has only two outcomes: leave it counted and learn to ignore the count, or mark it read and forget it. Snooze is what makes the count trustworthy.

**Independent Test**: Seed two unread problems. Snooze one until tomorrow morning. Check the count is 1, the snoozed row is gone from the panel, the `/notifications` list and the project callout, and the event is still in both Activity screens. Move the clock past the snooze and check the count is 2 again and the row is back, marked "New".

**Acceptance Scenarios**:

1. **Given** two unread problems, **When** one is snoozed, **Then** the count falls to 1 and the snoozed row is no longer listed in the panel, in `/notifications` or in the project's callout count.
2. **Given** a snoozed problem, **When** its time passes, **Then** it counts again, is listed again, and is marked "New".
3. **Given** a snoozed problem, **When** anyone opens that project's Activity or All activity, **Then** the event is listed there for everyone, including the person who snoozed it, with its real outcome.
4. **Given** a snooze is set to "Tomorrow morning" or "Next week", **When** it is saved, **Then** it is stored as the absolute instant of 09:00 in the project's time zone on that day, resolved once with an explicit rule for a clock change that skips or repeats that hour.
5. **Given** a snooze whose stored instant falls on the other side of a daylight-saving change, **When** the clock changes, **Then** the snooze still runs out at exactly the instant it was set to, neither an hour early nor an hour late.
6. **Given** a snoozed problem whose target has since been retried and published, **When** the snooze runs out, **Then** the problem comes back unread, its row links to the post rather than to a Failures entry, and one "Mark read" clears it.
7. **Given** a snoozed problem, **When** the person chooses "Mark read" on it before the snooze runs out, **Then** it becomes read and never comes back.
8. **Given** a snooze is set, **When** a screen reader is in use, **Then** it hears politely when the problem will return, in the project's time zone.
9. **Given** client JavaScript is unavailable, **When** the person snoozes from the `/notifications` list, **Then** the snooze is saved and confirmed with the time it will return.

---

### User Story 3 - "Mark all as read" still just bumps the floor (Priority: P1)

The things that already cleared a whole project still do exactly that, in one cheap write, and they tidy up after the per-event marks.

**Why this priority**: It is the cost bound and the compatibility promise in one. If "Mark all as read" stopped being a single forward move, or stopped pruning, the sparse table would grow without limit and this entry would have reintroduced what N3 avoided.

**Independent Test**: Seed a project with a mix of floor-read, individually-read, snoozed and expired-snooze events. Use "Mark all as read". Check the count is 0, the floor covers every event that existed, every sparse mark for that project is gone, and a problem written a moment later counts as unread.

**Acceptance Scenarios**:

1. **Given** individually-read and snoozed events above the floor, **When** "Mark all as read" runs, **Then** the floor rises over all of them, every sparse mark at or below it is deleted, and the count is 0.
2. **Given** snoozed events were cleared by "Mark all as read", **When** the confirmation shows, **Then** it says the snoozed problems were cleared too, and they do not come back when their time passes.
3. **Given** a project's Activity is opened with the *Problems* preset and no other filter, first page, **When** it loads, **Then** that project's floor rises and its sparse marks are pruned, exactly as "Mark all as read" does for it, and no other project is touched.
4. **Given** a problem committed a moment after a mark-all began, **When** the count next refreshes, **Then** it counts as unread.
5. **Given** two tabs mark the same problem read at the same time, **When** both complete, **Then** one is recorded, the other is a no-op, the count is the same either way, and neither leaves a duplicate or a lost mark.
6. **Given** two tabs mark different problems read at the same time, **When** both complete, **Then** both marks survive and the floor is never lowered by either.
7. **Given** the project is locked by a concurrent write for longer than the lock wait allows, **When** a row action is used, **Then** nothing is written, the person is told it could not be saved just now and to try again, and the count is unchanged.

---

### User Story 4 - The per-event state cannot grow without limit (Priority: P1)

However a person uses the row actions, the amount of read state Docket keeps for them stays small, and no operator ever has to clean it up.

**Why this priority**: N3 refused per-event rows for exactly this reason, and the roadmap says the bound "is the point of the entry". A design that is correct but unbounded would be worse than not shipping it.

**Independent Test**: Mark problems read oldest-first and check the sparse table returns to empty each time. Then mark problems read newest-first, deliberately leaving the oldest unread, until the cap is reached; check the cap is enforced, the person is told, the count is still right, and "Mark all as read" clears everything.

**Acceptance Scenarios**:

1. **Given** a person clears their problems oldest-first, **When** each mark is saved, **Then** the floor follows and the number of sparse marks for that project returns to zero.
2. **Given** the floor rises for any reason, **When** it is saved, **Then** no sparse mark at or below it remains.
3. **Given** a person has reached the cap of sparse marks for a project, **When** the panel or `/notifications` lists that project's rows, **Then** those rows say the per-row actions are unavailable until the project is marked read, and offer "Mark all as read".
4. **Given** a person at the cap, **When** a row action for that project is nonetheless submitted, **Then** it is refused with that same explanation, nothing is written, and no unread problem is silently turned read.
5. **Given** a person at the cap in one project, **When** they use a row action in another project, **Then** it works: the cap is per person and per project.
6. **Given** a person at the cap, **When** they use "Mark all as read" or open the project's problems view, **Then** every mark for that project is pruned and the row actions work again.

---

### User Story 5 - The callout and the count agree (Priority: P2)

Every place that shows a number shows the same number: the bell, the project callout, the panel's summary and the refresh.

**Why this priority**: 022 made one rule drive the count, the panel and the callout so they could never disagree. Adding two more ways to clear a problem is exactly where they would start to.

**Independent Test**: In one project, floor-read some events, individually read others, snooze one and let one snooze expire. Compare the bell, the refresh, the panel summary and the project's callout. Open the project's home and Posts screens.

**Acceptance Scenarios**:

1. **Given** a project with floor-read, individually-read, snoozed and expired-snooze events, **When** each of the bell, the refresh, the panel summary and the callout is computed, **Then** they are equal, and equal to the number of attention events above the floor that are neither read nor currently snoozed.
2. **Given** every problem in a project is read or snoozed, **When** its home or Posts screen opens, **Then** no callout shows.
3. **Given** a snooze runs out, **When** the project's home opens, **Then** the callout is back with the right number.
4. **Given** a muted project, **When** anything is counted, **Then** it still contributes nothing, whatever its per-event marks say.
5. **Given** the caller has a snooze that runs out in two minutes, **When** the refresh answers, **Then** it reports that moment, and the bell refreshes then rather than up to 60 seconds later.
6. **Given** the caller has no snooze at all, **When** the refresh answers, **Then** it reports no next change and the 60-second behaviour is exactly what it is today.

---

### User Story 6 - Leaving still deletes everything (Priority: P1)

A removed member's reading state for a project — the floor, the mute and every per-event mark — is gone with the membership, in the same transaction.

**Why this priority**: The count crosses projects, and this entry adds a second place where per-person, per-project state lives. A cleanup that covered only the old table would leave one person's reading history behind after they were removed.

**Independent Test**: Give a member a floor, a mute, several individual marks and a snooze in a project. Remove them. Check every one of those is gone in the same transaction as the membership, that a rolled-back removal leaves all of them intact, and that deleting the project or the user removes them too.

**Acceptance Scenarios**:

1. **Given** a member with a floor, a mute, individual marks and a snooze in a project, **When** they are removed or leave, **Then** all of it is deleted in the same transaction as the membership.
2. **Given** a removal that is rolled back (for example the last owner), **When** it fails, **Then** every one of those is intact.
3. **Given** a project or a user is deleted, **When** that happens, **Then** every per-event mark goes with it.
4. **Given** a removed member is invited back, **When** they accept, **Then** they start fresh from the rejoin, with no per-event mark from before.
5. **Given** a member removed from a project, **When** their next page load, panel open or refresh happens, **Then** nothing from that project is counted or listed, whatever marks existed.

---

### User Story 7 - Every role manages their own, and only their own (Priority: P1)

Reading and snoozing are personal. Every member role does it for themselves; nobody does it for anybody else; no project-owned query escapes its project.

**Why this priority**: It is the constitution's isolation rule and N10's role rule applied to a new table that is keyed by person *and* project and read across projects.

**Independent Test**: As an editor, use both row actions. As another member of the same project, check their count is unaffected. Run the project-scope test harness over every new statement, including the cross-project count. Send crafted requests naming another person's state and another project's events.

**Acceptance Scenarios**:

1. **Given** an editor (who cannot change project settings), **When** they use "Mark read" and "Snooze", **Then** both work for their own state.
2. **Given** one member marks a problem read or snoozes it, **When** another member of the same project looks, **Then** their own count, panel and callout are unaffected.
3. **Given** every new statement, **When** the project-scope test harness runs, **Then** each is pinned to one project or runs inside the one sanctioned project-set section over the caller's own resolved set, and an id outside that set is refused before any query runs.
4. **Given** a public-API key instead of a session, **When** a row action or a count is attempted, **Then** it is refused: keys belong to projects, not people.
5. **Given** a request forged from another site, **When** it arrives, **Then** it is refused before anything is written.

---

### Edge Cases

- **An expired snooze and an individual mark on the same event.** Marking read overwrites the snooze; the event never comes back. There is only ever one mark per person, project and event.
- **Snoozing an event twice.** The later choice replaces the earlier one, in either direction: a shorter snooze shortens it.
- **A snooze set for a time that has already passed** cannot be chosen: all three choices are in the future when they are resolved. A mark whose instant has passed is simply an expired snooze and counts.
- **A clock change that skips 09:00** (spring forward) or **repeats it** (autumn back) on the day a "Tomorrow morning" or "Next week" snooze points at: the instant is resolved once, with an explicit documented rule, and stored. It never shifts afterwards.
- **A snooze on an event at or below the floor** cannot happen: a row offered for snoozing is above the floor by construction, and if the floor rises in the meantime the mark is pruned (N19).
- **A problem written a moment after a row action** counts as unread. A row action never covers an event that did not exist when it ran.
- **An event whose account was removed or whose post was deleted** still has working row actions: they act on the event, not on the target.
- **A connect failure attempted by another member** has no row action for this person, because it is not in their list at all (N1).
- **A person whose only memberships are muted**, or who belongs to no project, sees no row actions and the existing empty states, unchanged.
- **The count reaches 100 or more** with per-event marks in play: the display is still "99+" and the counting work still stops at 100.
- **Two tabs where one has a stale list**: a row action on an event that has since been covered by a risen floor is a no-op, not an error, and does not lower the floor.
- **The row action fails** (the project is busy, or the network drops): the count and the list keep their last value, the person is told it was not saved, and nothing is half-written.
- **A project with hundreds of thousands of events** does not slow page loads: the count still looks only above the floor, stops at 100, and the per-event marks it has to consider are capped.

## Requirements *(mandatory)*

### Functional Requirements

**The state**

- **FR-001**: The system MUST keep `seen_seq` as a floor per person per project: every attention event at or below it is read, with no per-event record. "Mark all as read" and the three N4 paths MUST still do nothing but move that floor forward (N13).
- **FR-002**: The system MUST keep, above the floor only, at most one sparse mark per person, project and attention event, carrying the instant from which that event counts again: the end of time for "read", and the end of the snooze for "snoozed" (N15).
- **FR-003**: A person's unread count MUST be the number of attention events, across the projects they currently belong to with notifications on, that are above their floor for that project and have no sparse mark whose instant is still in the future. It MUST still be computed from current memberships on every request, MUST still not need to count past 100, and MUST NOT depend on the current state of the event's target or account (N18).
- **FR-004**: Each project's unread lookup MUST remain index-backed, and the cross-project lookup MUST remain limited to the caller's own resolved project set and MUST pass the project-scope test harness. The per-project repository, the project-set reader and the newest-position helper MUST all honour the sparse marks, so no caller can see a different answer.
- **FR-005**: A sparse mark MUST NOT exist at or below the floor. Whenever the floor rises, every sparse mark at or below the new floor MUST be deleted in the same transaction (N16.1, N16.2).
- **FR-006**: Marking one event read MUST raise the floor to cover it, and prune, when no attention event at or below it is left unread or snoozed for that person; otherwise it MUST leave the floor where it is and record a sparse mark (N16.2).
- **FR-007**: The number of sparse marks per person per project MUST be capped at 200. At the cap, row actions for that project MUST be refused with an explanation that names "Mark all as read" as the way out; nothing MUST be written and no unread event MUST be turned read. The cap MUST be per person and per project (N16.3).
- **FR-008**: Per-event marks MUST be written with the same locking, ordering, lock wait and busy reporting as the existing mark-read path, so no new deadlock or lost update is possible. Two marks of the same event MUST be idempotent; a mark MUST never lower the floor; a mark MUST never cover an event committed after it ran.

**Snoozing**

- **FR-009**: A person MUST be able to snooze one attention event for "1 hour", until "Tomorrow morning" or until "Next week", resolved once at the moment of snoozing to an absolute instant — 09:00 in the project's time zone for the two wall-clock choices, with an explicit, documented disambiguation rule for a clock change that skips or repeats that hour — and stored as that instant (N17).
- **FR-010**: While snoozed, an event MUST NOT appear in the count, the panel, the `/notifications` list or the project callout, and MUST still appear in both Activity screens for everyone, including the person who snoozed it (N20, N5's spirit).
- **FR-011**: When a snooze runs out, the event MUST count again and be listed again, marked as new, with no server-side work needed to expire it.
- **FR-012**: A snooze MUST be on the event, not on its target. A retry, a publish or a resolution of the target MUST NOT cancel the snooze and MUST NOT mark the event read; when the snooze runs out the event MUST come back unread, with its row linking wherever Activity links it (N18).
- **FR-013**: A risen floor MUST win over a snooze: a snoozed event at or below a new floor MUST be read, MUST NOT come back, and its mark MUST be pruned. When "Mark all as read" clears one or more snoozes, its confirmation MUST say so (N19).
- **FR-014**: Marking a snoozed event read MUST replace the snooze; snoozing an already-snoozed event MUST replace the earlier choice, in either direction.

**The panel, the list and the callout**

- **FR-015**: Each row of the shared problems list — in the bell's panel, on `/notifications`, and anywhere else it is used — MUST offer "Mark read" and "Snooze" for that one problem. Each control's accessible name MUST identify the problem it acts on, every control MUST be reachable in the normal Tab order with visible focus, and the snooze choice MUST be a labelled control, not a hover-only or pointer-only affordance (N21).
- **FR-016**: Both row actions MUST work with no client JavaScript, through a form post that returns to the page with a confirmation naming what happened — including, for a snooze, when the problem will return, in the project's time zone (N21).
- **FR-017**: With client JavaScript, the outcome of a row action MUST be announced politely through the existing live region, only on a real change, and MUST update the bell's count, its accessible name and the row's own state without navigating away from the page the person was on.
- **FR-018**: The panel MUST keep listing the 10 newest attention events from the caller's notifications-on projects, read and unread alike, with currently snoozed events excluded; an individually-read event MUST lose its "New" marker and stay in the list (N20).
- **FR-019**: The project callout MUST use the same count as the bell, so individually-read and snoozed problems leave it, and it MUST still be hidden at zero and for a muted project.
- **FR-020**: Rows in a project that has reached the sparse-mark cap MUST say that the per-row actions are unavailable until the project is marked read, and MUST offer "Mark all as read" (N16.3).

**The routes and actions**

- **FR-021**: The count route MUST keep returning the caller's count, its capped display and its accessible label, and MUST add the soonest instant at which one of the caller's snoozes runs out, or nothing when there is none. It MUST remain session-only, read no input, refuse public-API keys, and never be cached (N22).
- **FR-022**: The browser MUST refresh the bell at that reported instant in addition to the existing 60-second and become-visible refreshes, and MUST behave exactly as it does today when there is no snooze.
- **FR-023**: The panel route MUST exclude currently snoozed events from its items and MUST tell the caller, per row, whether the row actions are available, so the cap can be shown. It MUST remain session-only, read no input, refuse public-API keys, and never be cached.
- **FR-024**: Row actions MUST be server-side mutations that name the activity event by its existing id and nothing else. An id in another project, an id that is not an attention event for that person, and an id that does not exist MUST all change nothing and give the same "not found", revealing nothing about whether it exists (N23). A request without a valid session, or forged from another site, MUST be refused before anything is written.
- **FR-025**: Every member role MUST be able to use both row actions for their own state, and MUST NOT be able to change anyone else's. Calls through a job-runner or API-key scope MUST be refused.

**Data and migration**

- **FR-026**: The schema change MUST ship as a committed SQL migration with the migration check green, MUST be safe to apply to a live installation with existing rows, and MUST NOT require an operator to reset notification state. No existing `notification_states` row MUST be altered by it, and an empty sparse table MUST reproduce today's behaviour exactly (N24).
- **FR-027**: The sparse table MUST be project-owned and registered as such, so the project-scope harness covers it, and its rows MUST be deleted with the membership, the project or the user, in the same transaction as the membership change, exactly as the floor and the mute are today.

**Docs and tests**

- **FR-028**: `docs/decisions.md` MUST record N13–N24 **next to** the decisions they replace, stating for N3 and N2 which part is reversed, why, and what happens to data written under the old rule. `docs/activity.md`'s Notifications section MUST be updated for the row actions, snoozing, what the floor still does, and what a snooze means for a target that has since been fixed. `docs/design-system.md` and the `docket-ui` skill MUST list any new UI primitive the row actions need; existing primitives MUST be preferred.
- **FR-029**: Tests MUST cover:
  - counting with a mix of floor-read, individually-read, snoozed and expired-snooze events in the same project and across projects, including under the 100 cap and with a muted project;
  - pruning when the floor rises, by each of the N4 paths and by an individual mark that lets the floor follow;
  - the sparse-mark cap: enforced, per project, surfaced in the list, refused on submission, and cleared by a mark-all;
  - concurrent mark-read from two tabs, on the same event and on different events, plus a busy lock writing nothing;
  - snooze expiry at a daylight-saving boundary, for both wall-clock choices, in a zone that observes it;
  - a snooze whose target was retried, published or resolved while snoozed;
  - the floor rising past a snoozed event, and the confirmation that says so;
  - membership removal, leave, rollback, and project and user deletion still deleting the floor, the mute and every sparse mark;
  - project isolation through the test harness, for every new statement including the cross-project count, and an id outside the caller's set refused before any query;
  - the two routes' authentication, key refusal, no-input behaviour, no-cache headers and new payload fields;
  - the row actions with and without client JavaScript, their accessible names, their announcements, and the rendered list for read, unread, snoozed, expired-snooze and at-cap rows.

### Key Entities

- **Reading floor** (existing, meaning sharpened): one per person per project. Every attention event at or below it is read, with no per-event record. It only moves forward, and when it moves it absorbs and deletes the sparse marks it has covered.
- **Per-event mark** (new, sparse): at most one per person, project and attention event, and only above that person's floor. It says when the event counts again: never, for "read"; at a chosen instant, for "snoozed". Capped at 200 per person per project. Deleted when the floor covers it, and with the membership, project or user.
- **Unread count** (existing, redefined): attention events above the floor with no mark still in the future, over the person's current notifications-on projects, capped at 100.
- **Next change** (new, derived, not stored): the soonest instant at which one of the caller's snoozes runs out, used to refresh the bell on time.
- Existing entities referenced, unchanged in meaning: activity event, attention event, mute, project, member, user, session.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From any signed-in page, a person can clear one problem and leave the others in two actions with the keyboard alone (open the bell, choose "Mark read"), and can put one off until later in three (open the bell, choose when, confirm).
- **SC-002**: Clearing or snoozing one problem changes the count by exactly one and leaves every other problem's state untouched, in 100% of tested combinations of floor-read, individually-read, snoozed and expired-snooze events.
- **SC-003**: A snoozed problem is absent from the count, the panel, the personal list and the project callout for the whole of its snooze, and present in both Activity screens throughout, in 100% of tested cases.
- **SC-004**: A snoozed problem returns within one refresh interval of the instant it was set to, including across a daylight-saving change in the project's zone, with no server-side work scheduled to expire it.
- **SC-005**: A person who clears problems oldest-first leaves zero per-event records behind, and no person can ever hold more than 200 per project, however they use the row actions — demonstrated by a test that tries to exceed it.
- **SC-006**: With 100,000 events in a project, a person in 20 projects holding 200,000 events in total, and the maximum 200 per-event marks in each, computing the unread count adds under 100 ms to a page load and the refresh answers in under 100 ms, in a seeded test — the same budget 022 met without per-event state.
- **SC-007**: Zero problems from projects a person does not belong to, has muted, has read or has currently snoozed appear in their count, panel, callout or refresh, in tests; and removal still takes effect on the very next request, with no per-event mark left behind.
- **SC-008**: Applying the migration to a copy of a populated installation changes no existing notification row and no count, and requires no operator action.
- **SC-009**: The row actions, the panel, the personal list and the callout pass the `docket-ui` accessibility rules (full keyboard use, visible focus, controls labelled with the problem they act on, status conveyed as text as well as colour, polite announcements only on real change) and work with no client JavaScript.

## Assumptions

- Every member role can view posts, so every member of a project can receive its notifications and manage their own read and snooze state (N10).
- The project's time zone is the only zone available for a snooze, because Docket stores no per-person time zone; the panel already shows each row's time in its project's zone, so this is what a person already sees.
- Three fixed snooze choices are enough. A date-and-time picker would need a new primitive and a per-person zone, and no one has asked for one.
- 200 sparse marks per person per project is a generous backstop, not an expected working figure: it is twice the unread cap, and the ordinary oldest-first path never reaches 2.
- "Tomorrow morning" and "Next week" mean 09:00 because that is the start of a working day; the exact hour is a wording choice, not a requirement, and the plan may name it once as a constant.
- The activity log is append-only, so an event behind a per-event mark is never deleted while the mark exists; project and user deletion remove both together.
- No new environment variable, dependency, infrastructure, public-API operation or `docker-compose.yml` change is expected. Webhooks remain the way to deliver problems outside Docket.
- The existing reauth banner, Failures count and Review count are unchanged and continue to show *current* problems; the bell shows *new* ones.

## Dependencies

- `022-problem-notifications` on `main`: the floor, the mute, the attention rule (N1), the three mark-read paths (N4), the two session routes, the bell, the panel, the shared list, the personal `/notifications` page, the callout, the poller, the live region and the exact-marking locking order.
- `020-activity-history` on `main`: the activity log, its outcomes, its ordering position, its *Problems* preset and its row links.
- The project-scope test harness, which must cover the new table.

## Out of Scope

Each of these is named with the entry that owns it, as the roadmap's rules require.

- **Per-kind and per-platform preferences**, and anything finer than the existing per-project mute — owned by roadmap entry 2, `notification-preferences`.
- **Any email**, immediate or digest, and quiet hours — owned by roadmap entry 3, `email-delivery`. This entry's state is what that entry will consume to avoid mailing a problem already read, dismissed or snoozed.
- **Replacing the 60-second poll** with a server push — owned by roadmap entry 4, `realtime-updates`. This entry only adds the next-change instant to the count payload, which that entry will carry over its stream.
- **Notifications for successes, retries or resolutions.** N1 stands and is not revisited here.
- **Un-snoozing, and a list of what you have snoozed.** A snoozed problem is still in Activity for everyone, "Mark read" still works on it, and "Mark all as read" clears every snooze. A dedicated snoozed view would be a screen of its own with nobody asking for it.
- **Undoing "Mark read"** on one problem. The problem remains in Activity.
- **A custom snooze date and time**, a per-person time zone, or snoozing a whole project (that is what the mute is).
- **Changing the activity log** beyond what this read state needs (an index, if the plan shows one is needed for FR-004), its event kinds, its messages, its filters or its public API.
- **Changing what counts as an attention event**, who is notified, the 100 cap, the "99+" display, the three N4 mark-read paths, or where the callout appears.
