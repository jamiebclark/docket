# Feature Specification: Per-kind and per-platform notification preferences — the project mute becomes a roll-up

**Feature Branch**: `057-notification-preferences`

**Created**: 2026-10-11

**Status**: Draft

**Input**: User description: "Before specifying, read .specify/roadmaps/notifications.md in full — its goal paragraph, the 'Behaviour on main that every entry builds on' bullet list (notification_states keyed (project_id, user_id) with muted; attention events per N1 in src/lib/activity/outcomes.ts; the DAL readers; the /notifications page and actions.ts; the notifications components) and the 'Rules for every entry' list (leave the repo working and say what it does not do; explicitly reverse shipped decisions and record the replacement in docs/decisions.md next to the original including the fate of existing data; committed SQL migration with pnpm db:check green and safe to apply to a live install with existing rows, never requiring an operator to reset notification state; project isolation; role-aware per N10 with nothing owner-only but server configuration; existing UI primitives, the docket-ui skill and docs/design-system.md, full keyboard use and labelled controls; secrets never leak; browser or visual-judgement tasks last in tasks.md). Also read specs/022-problem-notifications/ and decisions N1-N12 in docs/decisions.md in full — N1, N6 and N10 constrain this entry directly.

Scope of this entry: replace the single per-project muted boolean with preferences a person can set per attention kind (the four from N1) and per platform, with the project level becoming a roll-up — 'all off' is the old mute, and the UI must still offer that in one click. Migrate every existing muted = true row to all-kinds-off so no one's choice is lost, and say in docs/decisions.md what muted becomes (kept as a derived column, or dropped). Preferences gate the bell count, the panel, the callout and — once email-delivery lands — what is eligible to be mailed, so the shape settled here is the shape email consumes. Keep N6's fresh-start rule: turning a kind back on marks that kind read at that moment rather than delivering a backlog. Extend /notifications (src/app/notifications/page.tsx) from a list of on/off toggles into a per-project grid, keep the same control on each project's settings page for every member role, and keep both usable with no client JavaScript.

Testing the author attached to this entry: migration of muted rows; counting under each preference combination; per-platform filtering against accounts that were later removed; the fresh-start rule; defaults for a new member and a new project; and authz — a person may only edit their own preferences.

Must NOT take on: quiet hours — the author's stated reason is that quiet hours are a delivery-timing rule with no meaning for an in-app badge, and entry 3 (email-delivery) owns them; any email (entry 3, email-delivery); changing which outcomes are attention events, since N1 stands; real-time transport (entry 4, realtime-updates)."

## Context and sources

- Roadmap `.specify/roadmaps/notifications.md`, entry **2 of 4**, slug `notification-preferences`. The roadmap's goal is to finish the notification story `022-problem-notifications` deliberately left half-built; this entry closes the last item on 022's own Out of Scope list ("notification preferences finer than per project (per platform, per kind, quiet hours)") — minus quiet hours, which the roadmap hands to entry 3.
- It is second because the gating rule settled here is the rule `email-delivery` (entry 3) consumes to decide what may be mailed, and entry 1 (`per-event-read-state`, shipped as `specs/042-per-event-read-snooze/`, decisions **N13–N24**) had to define the read and snooze state first.
- **Behaviour on `main` that this feature builds on** (read from `specs/022-problem-notifications/`, `specs/042-per-event-read-snooze/` and decisions **N1–N24** in `docs/decisions.md`):
  - **`notification_states`** is one row per membership, keyed `(project_id, user_id)`, holding `seen_seq` — explicitly a **floor** since N13: every attention event at or below it is read, for ever, with no row of its own — and `muted`, the single per-project boolean this entry replaces. A composite foreign key to the membership cascades the row away with the membership, project or user.
  - **`notification_event_marks`** is the sparse per-event state added by entry 1: at most one row per person, project and event, only **above** the floor, carrying one instant ("hidden until") — for ever for read, a finite instant for snoozed (N15). The floor absorbs and prunes marks at or below it, and a hard cap of 200 marks per person per project keeps growth bounded (N16).
  - **Attention events** are decision **N1**, and **N1 stands**: the outcomes *failed*, *ambiguous* and *needs reauth* for every member, plus *connect failed* only for the member who attempted it. *Published*, *retrying* and *resolved* never count; a connect failure with no recorded actor counts for nobody. The vocabulary lives in `src/lib/activity/outcomes.ts`; the per-person rule in `src/lib/notifications/attention.ts`.
  - **An event records its own platforms.** Activity rows carry the platform keys they concern, denormalised at write time, so a connect failure spanning a platform group (Facebook and Instagram) carries both, and an event survives its account being removed — Activity already shows "Removed account" for that case.
  - **Reads** go through one module, `src/server/dal/notifications.ts`: the newest-attention-position helper, the per-project repository (`createNotificationsRepo`) and the project-set reader (`createNotificationsSetReader`, the one sanctioned cross-project reader). Its SQL rules are deliberate: no `OR`, no `NOT` other than `IS NOT NULL`, every reference pinned to a project, and the attention outcomes written as SQL literals so the partial indexes match. Today each counting branch joins `notification_states` for `muted = false`.
  - **Marking read is exact** (022's R3, reused verbatim by entry 1's row actions per M12): each write is its own transaction that sets a lock timeout, locks the project row, re-checks membership, reads the newest attention position and upserts. A timeout writes nothing and is reported as "busy".
  - **Routes**: `GET /api/me/notifications` (the 60-second count poll, N12) returns the unread summary including entry 1's soonest-change instant; `GET /api/me/notifications/recent` returns the panel model. Both are session-only, read no input, refuse API keys, and are never cached.
  - **Screens and components**: the personal `/notifications` page (`src/app/notifications/page.tsx`, `actions.ts`) lists every project the person belongs to with one on/off control each, plus the recent-problems list with per-row read and snooze actions; each project's settings page (`src/app/p/[projectSlug]/settings/page.tsx`) carries a "Your notifications" card with the same one on/off control, for **every** member role (N10); `src/components/notifications/` holds the bell, the panel, the shared list body, the per-project callout, the row actions, the poller and the view-mark glue. The count renders server-side and every control works with no client JavaScript.
  - **Starting points** (N7): a new member starts at the moment they joined; a rejoin starts again; the first deploy marked everything up to then as read. **Leaving deletes the state** in the same transaction as the membership (N8). **The display is capped** at "99+" and counting stops at 100 (N9). **Muting is personal and hides, it does not delete** (N5) — events stay in Activity for everyone.
  - **Platforms are plug-ins.** The set of platforms is the provider registry (`src/providers/registry.ts`), surfaced as `platformOptions()` and `platformName()` in `src/server/services/activity/index.ts`; `mock` appears only while it is enabled. Platforms can be added by a later release, so nothing may assume a fixed list.
  - **Many-of-many is checkboxes** (`docs/design-system.md` §7 "Choosing a control for one-of-many", `checkStyles` in `src/components/ui/controls.ts`); a `<details>`/`<summary>` disclosure holding real submits is the sanctioned "hidden until opened, works without JavaScript" shape (§7 "Row actions").
- No external platform facts are involved, so nothing here needs `docs/research/`. No new runtime dependency and no infrastructure is expected. One schema change (preferences, and the removal of `muted`) with a data migration is expected.
- **Not touched by this entry**: the all-or-none environment-variable groups, the worker tick, and the invitation delivery interface. This feature adds no environment variable and no recurring server-side work — a preference takes effect on the next read, and the fresh-start position is written by the same request that flips the switch.

## Decisions made while specifying

These are judgement calls. Planning records each one in `docs/decisions.md`, **next to the decision it replaces**, as the roadmap's rules require. Numbering continues from entry 1 (N13–N24).

### The reversal, and what happens to the data

- **N25 — Reverses the "one project-level boolean" half of N5.** N5 said four things. The three that **stand**: muting is personal (nobody else sees or is affected by your choice), it **hides and never deletes** (every event stays in Activity for everyone, including you), and notifications are **on by default**. The half that is **reversed**: the unit of choice is no longer the project. A person now chooses, per project, which **attention kinds** (the four from N1) and which **platforms** may notify them, and the project level becomes a roll-up of those switches rather than a stored flag of its own.
  - **Why N5's boolean existed**: it was the cheapest thing that answered "this project is someone else's job". It is too coarse for the real complaint, which is "tell me about failed posts but stop telling me an account needs reconnecting", or "I do not run our TikTok".
- **N26 — `muted` is dropped, not kept as a derived column.** The roll-up is computed from the switches, so there is exactly one source of truth and no column that can silently disagree with it. A boolean kept in step by triggers, or by every writer remembering to, is the kind of duplication that drifts.
  - **The fate of existing data**, which the roadmap requires to be stated: every `notification_states` row with `muted = true` becomes **all four kinds off** for that person and project, in the same migration that drops the column, so no one's choice is lost. Rows with `muted = false` need nothing written at all, because absent means on (N27). No row's `seen_seq`, `seen_at` or sparse marks are touched, and no operator has to reset notification state.
  - **How to reverse it**: re-add the column and set it to "no kind is on". The reversal is lossy only in the way the forward migration is generous — a person who had turned off a single kind would come back as unmuted.
- **N27 — Default on, stored as exceptions.** Absence of a stored preference means "this may notify me". So a new member, a project created today, a platform a later release adds, and a project where nobody has ever touched a switch are all on with nothing written. This makes the defaults a fact about the database rather than a rule every writer has to remember, and it is what makes the migration above a no-op for unmuted rows.

### The shape of a preference

- **N28 — Two independent axes, combined with AND.** An attention event may notify a person when **its kind is on** *and* **its platform is on**, for that person and that project.
  - **Rejected: a kind × platform matrix.** Four kinds times the platforms in a project is up to 28 switches per project — unusable in a grid, and nobody asked for "failures on Bluesky but not on Threads, while reauth is the other way round". If that need ever appears, the matrix is a strict superset of this shape and can replace it without changing what a switch means.
- **N29 — A multi-platform event counts if any of its platforms is on, and counts once.** A connect failure spanning a platform group (Facebook and Instagram) is one event; if either platform may still notify the person, they hear about it exactly once.
- **N30 — An event with no platform recorded is governed by its kind alone.** The platform axis can only ever *exclude* an event whose platform is known, so an event that records no platform is never silently swallowed by a platform switch.
- **N31 — The platform axis is keyed by platform, never by account.** Preferences are per project and per platform key. Removing an account changes no preference and changes no past event's recorded platforms, so filtering keeps working for events whose account is long gone, exactly as Activity keeps showing them as "Removed account". There is deliberately no per-account preference: accounts come and go, and "stop telling me about this account" has never been asked for.
- **N32 — Which platforms are offered to a person for a project**: the platforms that project currently has accounts for, plus any platform this person has already switched off for that project. A switch a person has set is therefore always visible and always reversible, and a project with one Bluesky account does not present six switches for platforms it does not use. A platform with no accounts and no stored preference is simply absent, and because absent means on (N27), connecting that platform later needs no migration.

### The project level, and one-click all-off

- **N33 — "Notifications for this project are off" means no kind is on.** That is the roll-up: the state the bell's panel, the project settings card and the grid all describe. It is derived, never stored (N26).
- **N34 — One click still turns a whole project off, and one click turns it back on.** Every project keeps a "Turn all off" control — the old mute, unchanged in effect — and a "Turn all on" beside it, each a single submit with a confirmation, next to the per-kind switches rather than hidden behind them. Turning all on is subject to the fresh-start rule (N35), so it cannot deliver a backlog.
- **N35 — The fresh-start rule applies to every switch, not just the project (extends N6).** N6 said turning notifications back on marks the project read at that moment. The replacement: turning **any** switch back on — a kind or a platform — records with that switch the newest attention position in that project at that moment, and only events after it may notify the person through that switch. A long spell with a kind off therefore ends quietly, not in a "99+" of problems the person chose not to hear about. They remain in Activity, for everyone.
  - Turning a switch **off** records no position and marks nothing read: switching off is not a claim to have dealt with anything.
  - Events that happened while a switch was off are never delivered later. That is the point of the rule, and it is why the control says so in words.
- **N36 — Turning a switch on prunes the marks it makes redundant.** Sparse read and snooze marks (N15) for events that the switch's new position now covers are deleted in the same transaction that records the position, so N16's bound on sparse rows survives a person who switches things on and off repeatedly.
- **N37 — The N4 floor paths are unchanged, and still cover everything.** "Mark all as read" and the two problems views raise the project floor over every attention event that exists at that moment, including events of kinds and platforms that are switched off — exactly as N4.1 already covers muted projects. So a switch turned on later can never surface something from before the floor.

### Where it is edited, and what it gates

- **N38 — N10 stands; what it contains grows.** The personal `/notifications` page becomes a **per-project grid** — one row per project, the four kinds as its columns, that project's platform switches in a per-project disclosure within the same row, and the one-click all-off/all-on beside them. Each project's settings page carries the same per-project control, for **every** member role, separate from the project form only owners and admins can change. Both work with no client JavaScript.
  - **Why the kinds are the columns and the platforms are a disclosure**: the number of kinds is fixed at four and the same for every project, so it tabulates; the platforms differ per project and would make the grid ragged. Most people will only ever touch the kinds.
- **N39 — One rule gates everything a person is told.** The bell count, the panel, the per-project callout and the project's unread number all ask the same question — "may this event notify this person?" — so they can never disagree. Activity, the public API and webhooks are untouched: preferences gate notifications, never the record.
- **N40 — That rule is the shape email consumes.** `email-delivery` (entry 3) decides *when* and *whether* to send; it does not get its own notion of what a person wants to hear about. Quiet hours are a delivery-timing rule with no meaning for an in-app badge, and are therefore not in this entry at all.
- **N41 — A preference is only ever the caller's own.** Mutations go through the caller's own resolved project set; a request naming another project or another person changes nothing and reveals nothing — an unknown project and someone else's project give the same "not found" (022's R13 shape, unchanged). There is no administrative view of, or control over, anyone else's preferences, and no public-API operation for them: API keys belong to projects, not people.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Hear about the problems I can act on, and not the others (Priority: P1)

A person who belongs to several projects turns off *Needs reconnecting* for a project whose accounts someone else owns, while leaving *Failed* and *Needs your decision* on. From then on the bell, the panel and that project's callout tell them about failed and ambiguous posts in that project and say nothing about accounts needing reconnection — and every one of those events is still in Activity for everyone.

**Why this priority**: This is the request. The per-project mute forces an all-or-nothing choice, so people mute a project and then miss the failures they did care about.

**Independent Test**: Seed a person in one project with one event of each attention kind above their floor. Turn *Needs reconnecting* off. Check the count drops by exactly that event, the panel no longer lists it, the callout's number matches, and both Activity screens still show it unchanged.

**Acceptance Scenarios**:

1. **Given** one unread event of each of the four attention kinds, **When** the person turns one kind off for that project, **Then** the count drops by exactly the events of that kind, the panel omits them, and the project's callout number matches the new count.
2. **Given** a kind is off, **When** a new event of that kind is written, **Then** nothing is added to the count, the panel or the callout, and the event appears in Activity for every member including this person.
3. **Given** a kind is off for one member, **When** another member of the same project looks, **Then** their own notifications for that kind are unaffected.
4. **Given** all four kinds are off for a project, **When** the person looks at that project's settings or the grid, **Then** it says notifications for the project are off, in words, and the project contributes nothing to the count, the panel or the callout.
5. **Given** every project a person belongs to has all kinds off, **When** they open the bell, **Then** there is no count and the panel says notifications are off for all of their projects, with a link to the Notifications page.
6. **Given** a person who has never set a preference, **When** anything is counted, **Then** every kind and every platform is on and the behaviour is identical to today's unmuted project.

---

### User Story 2 - Stop hearing about a platform I do not run (Priority: P1)

A person in a project that posts to several platforms turns off one platform. Problems concerning that platform's accounts stop reaching them; problems on the other platforms keep coming. When one of that platform's accounts is removed months later, their choice is still there, still named, and still reversible.

**Why this priority**: Per-platform is the second half of the request, and it is the one that has to survive account churn — which is why the preference is keyed by platform and not by account.

**Independent Test**: Seed a project with accounts on two platforms and failed events on both. Turn one platform off and check only the other platform's events count. Remove that platform's accounts and check the switch is still listed, still off, and the historical events are still excluded.

**Acceptance Scenarios**:

1. **Given** failed events on two platforms, **When** one platform is turned off, **Then** only the other platform's events count, in the bell, the panel and the callout.
2. **Given** a platform is off and all of its accounts are later removed, **When** the person opens the grid or that project's settings, **Then** the platform's switch is still listed and still off, and its past events are still excluded from the count.
3. **Given** a platform with accounts in the project and no stored preference, **When** the controls are shown, **Then** it is listed and on.
4. **Given** a platform the project has no accounts for and no stored preference, **When** the controls are shown, **Then** it is not listed, and an account connected on it later is on without any further action.
5. **Given** a connect failure that spans a platform group (Facebook and Instagram) and only one of the two platforms is on, **When** the count is computed, **Then** the event counts exactly once; **given** both are off, **Then** it does not count.
6. **Given** an attention event that records no platform at all, **When** the count is computed, **Then** it is governed by its kind alone and no platform switch excludes it.

---

### User Story 3 - Turning something back on does not dump a backlog (Priority: P1)

A person who turned *Failed* off for a busy project three weeks ago turns it back on. They are not greeted by "99+". Problems from the next failure onwards reach them; the three weeks they chose not to hear about stay where they always were — in Activity.

**Why this priority**: It is N6's rule, and the reason it exists: a mute that ends in a flood teaches people to mute permanently. Extending the rule to each switch is the only way the finer-grained choice stays usable.

**Independent Test**: With a kind off, write 150 events of that kind. Turn the kind back on and check the count is zero. Write one more and check the count is one. Repeat for a platform switch, and for "Turn all on".

**Acceptance Scenarios**:

1. **Given** a kind has been off while many events of that kind were written, **When** the kind is turned back on, **Then** the count attributable to it is 0, and the next event of that kind makes it 1.
2. **Given** a platform has been off while events concerning it were written, **When** the platform is turned back on, **Then** those events do not count and later ones do.
3. **Given** a project with every kind off, **When** "Turn all on" is used, **Then** the project's unread count is 0 and later problems count.
4. **Given** a kind is turned off, **When** that happens, **Then** nothing is marked read: events of the other kinds above the floor still count exactly as before.
5. **Given** an event was individually read or snoozed (entry 1) and its kind is then turned off and back on, **When** the count is computed, **Then** the event does not count and no stale sparse mark for it remains.
6. **Given** a person at the sparse-mark cap for a project, **When** they turn a switch back on, **Then** the marks the new position makes redundant are gone and row actions are available again.
7. **Given** "Mark all as read" or a problems view raised the floor while a kind was off, **When** that kind is turned on later, **Then** nothing from before the floor appears.

---

### User Story 4 - Set it all from one place, or from the project (Priority: P2)

From the personal Notifications page a person sees every project they belong to as a row: which kinds may notify them, which platforms, and one control to turn the whole project off or on. The same control for one project is on that project's settings page, where an editor who cannot change the project's name can still change their own notifications. Both work with the keyboard alone and with client JavaScript unavailable.

**Why this priority**: Without one place to see it, finer-grained preferences become something people set once by accident and cannot find again.

**Independent Test**: With a person in three projects, open the Notifications page, change a kind in one project and a platform in another with the keyboard only, and check each change is saved with a confirmation naming the project. Repeat with JavaScript disabled. As an editor, change the same switches from the project's settings page.

**Acceptance Scenarios**:

1. **Given** a person in several projects, **When** the Notifications page loads, **Then** each project is one row showing its kind switches, its platform switches (reachable without JavaScript) and the project-level control, every switch labelled with the project and the thing it governs.
2. **Given** the grid, **When** a switch is changed, **Then** the change is saved, a confirmation names the project and what changed, and the page shows the new state.
3. **Given** client JavaScript is unavailable, **When** any switch, "Turn all off" or "Turn all on" is used, **Then** it works and confirms, and the platform switches are still reachable.
4. **Given** a keyboard-only user, **When** they move through a project's row, **Then** every switch and button is reachable in a sensible order with visible focus, and each has an accessible name identifying both the project and what it governs.
5. **Given** an editor who cannot change project settings, **When** they open that project's settings page, **Then** they can change every one of their own notification switches for it, in a card separate from the project form.
6. **Given** a person who belongs to no project, **When** they open the Notifications page, **Then** it says so and offers a way back, rather than erroring.
7. **Given** a project whose name changes, **When** the grid is reloaded, **Then** rows and labels follow the new name with no stale preference.

---

### User Story 5 - Nobody else's switches, and nothing leaked (Priority: P1)

Preferences are personal. There is no way to read or change another person's, and a crafted request naming a project the person does not belong to tells them nothing about whether it exists.

**Why this priority**: These controls are new write paths that name a project, and the count crosses projects, so a mistake here leaks one project's existence or one person's choices.

**Independent Test**: Call every preference mutation with: no session; an expired session; a valid session naming another member's user; a valid session naming a project the caller does not belong to; a valid session naming a project that does not exist; a public-API key. Check the responses and that nothing was written.

**Acceptance Scenarios**:

1. **Given** no session or an expired one, **When** a preference change is attempted, **Then** it is refused and nothing is written.
2. **Given** a valid session and a request naming another person, **When** it is processed, **Then** the other person's preferences are unchanged, and only the caller's own state can ever be the thing that changed.
3. **Given** a valid session naming a project the caller does not belong to, and one naming a project that does not exist, **When** each is processed, **Then** both give the same "not found", write nothing, and reveal nothing about whether the project exists.
4. **Given** a public-API key instead of a session, **When** a preference change is attempted, **Then** it is refused.
5. **Given** a person removed from a project, **When** their next page load, panel, callout or refresh happens, **Then** that project's rows and switches are gone and nothing from it is counted.
6. **Given** a member removed from a project, **When** the membership is deleted, **Then** their preferences for it are deleted in the same transaction; **given** the removal is rolled back (for example "last owner"), **Then** they are intact.
7. **Given** a project or a user is deleted, **When** that happens, **Then** the preferences go with it.

---

### User Story 6 - An existing install upgrades without losing anyone's choice (Priority: P1)

An install that has been running with the per-project mute is upgraded. Everyone who had muted a project still hears nothing from it; everyone who had not is unaffected; nobody's reading position moves, and no operator has to reset anything.

**Why this priority**: The roadmap forbids an entry that requires an operator to reset notification state, and a silent un-mute would be the worst possible outcome of this change — it turns a deliberately quiet project back into noise.

**Independent Test**: Seed `notification_states` rows with `muted = true` and `muted = false`, non-zero positions, `seen_at` values and sparse marks. Apply the migration. Check every muted row now has all four kinds off and reads as "off", every unmuted row has no stored preference and reads as fully on, and every position, `seen_at` and sparse mark is unchanged.

**Acceptance Scenarios**:

1. **Given** a row with `muted = true`, **When** the migration has run, **Then** all four kinds are off for that person and project, the project reads as off, and it contributes nothing to their count.
2. **Given** a row with `muted = false`, **When** the migration has run, **Then** every kind and platform is on for them and the count is exactly what it was.
3. **Given** rows with positions, `seen_at` values and sparse read and snooze marks, **When** the migration has run, **Then** none of them changed and no mark was pruned.
4. **Given** the migration has run, **When** a person who had muted a project turns one kind back on, **Then** the fresh-start rule applies from that moment, not from when they muted.
5. **Given** a live install with existing rows, **When** the migration is applied, **Then** it succeeds without an operator step and without resetting notification state.
6. **Given** the migration has run, **When** the schema is checked against the committed migrations, **Then** they match.

---

### Edge Cases

- A kind is turned off and on again twice in a minute: the position recorded is the one from the last "on", and the count reflects only events after it.
- Two tabs change the same switch in opposite directions: the later write wins, and no write can lower an already-recorded fresh-start position, so no backlog can appear by racing.
- A switch change arrives while the project row is locked by another write: the change is reported as busy, nothing is written, and retrying works — the behaviour today's mute change already has.
- A project has every kind on but every platform it has accounts for off: the roll-up still reads as "on" in words, and the count is zero, because no event can pass the platform axis. The controls say which switches are off rather than implying nothing is set.
- An event whose kind is on but whose platform is off, and which was individually read before the platform went off: it does not count, and its sparse mark is pruned no later than the next time the floor rises or that platform is turned back on.
- An event is written a moment after a switch is turned on: the recorded position is the newest event at the moment of the write, so an event committing afterwards counts — the same bound 022's R3 already states and tests.
- A platform is added by a new release of Docket: it is on for everyone, with no preference row and no migration, and appears in a project's controls as soon as that project has an account on it.
- `mock` is a registered platform only while it is enabled: it follows the same rule as Activity's platform filter, so a switch for it never appears on an install that has it off.
- A platform that was switched off is disabled in configuration and later enabled again: the stored switch is still there and still applies.
- A person at the 200 sparse-mark cap turns a kind off: switching off prunes nothing, so the cap is unchanged and the truthful "use Mark all as read" message still stands.
- A snooze runs out in a project whose kind has since been switched off: the event does not return to the count, and the soonest-change instant the bell uses skips it.
- A person changes role in a project: their preferences are kept; role has never affected who may be notified.
- A crafted request naming a kind or a platform that does not exist: it is refused as invalid, writes nothing, and does not reveal the registry.

## Requirements *(mandatory)*

### Functional Requirements

**The preference model**

- **FR-001**: The system MUST keep, per person and per project they belong to, which of the four attention kinds (N1) and which platforms may notify them. It MUST NOT keep a per-project on/off flag as a separate stored fact (N26), and MUST NOT keep per-account preferences.
- **FR-002**: Absence of a stored preference MUST mean "may notify me" (N27). A new membership, a newly created project, a newly registered platform and a project where no switch has ever been touched MUST therefore have everything on with nothing written.
- **FR-003**: An attention event MUST be eligible to notify a person for a project exactly when: its kind is on for them in that project; **and** either the event records no platform, or at least one of the platforms it records is on for them in that project (N28, N29, N30). Which events are attention events MUST NOT change — N1 stands.
- **FR-004**: Preferences MUST be keyed by platform, never by account (N31). Removing, re-adding or renaming an account MUST change no preference, and MUST NOT change whether a past event concerning it is eligible.
- **FR-005**: "Notifications for this project are off" MUST be derived as "no kind is on" (N33), used consistently wherever that state is described, and MUST have exactly the effect the old mute had: the project contributes nothing to the count, the panel or the callout, and hides nothing in Activity (N5).

**Fresh start**

- **FR-006**: Turning any switch on — a kind, a platform, or the project-level "Turn all on" — MUST record, with that switch, the newest attention position in that project at that moment, so that only events after it are eligible through that switch (N35). Events that occurred while it was off MUST NOT become eligible later, and MUST remain in Activity.
- **FR-007**: Turning a switch off MUST mark nothing read and MUST NOT change the eligibility of any other kind or platform.
- **FR-008**: Recording a fresh-start position MUST delete, in the same transaction, the sparse per-event read and snooze marks that the position makes redundant, so entry 1's bound on sparse rows is unaffected (N36). It MUST NOT delete any mark that is still meaningful.
- **FR-009**: The three paths that mark read (N4) MUST be unchanged and MUST continue to cover every attention event that exists at that moment, including events of switched-off kinds and platforms (N37). A switch turned on later MUST NOT surface anything at or below the project's floor.

**What preferences gate**

- **FR-010**: The unread count, the panel's rows, the per-project callout and the project's unread number MUST all apply FR-003, so they cannot disagree. The 100-count cap and the "99+" display (N9) MUST be unchanged, applied to eligible events.
- **FR-011**: The count route and the panel route MUST keep their current response shapes, including entry 1's soonest-change instant, which MUST now consider only eligible events. Neither route MUST gain an input.
- **FR-012**: The panel's "notifications are off for all of your projects" state MUST now mean "no project of yours has any kind on", and MUST still offer a link to the Notifications page and "View all".
- **FR-013**: Activity (both screens, their filters and their links), the public API, webhooks, the activity log itself and the event vocabulary MUST NOT change. Preferences MUST gate notifications only (N39).
- **FR-014**: The eligibility rule MUST be expressed in one place that a later entry can reuse unchanged, because `email-delivery` consumes it to decide what may be mailed (N40). This entry MUST NOT add any notion of when something is delivered.

**Where it is edited**

- **FR-015**: The personal Notifications page MUST present every project the person belongs to as a per-project grid row: the four kinds, that project's platform switches, and a project-level "Turn all off" / "Turn all on" (N34, N38). Every control MUST have an accessible name identifying both the project and what it governs.
- **FR-016**: Each project's settings page MUST offer the same per-project control for that project to **every** member role, separate from the project form that only owners and admins may change (N10, unchanged).
- **FR-017**: Both MUST work with no client JavaScript — including reaching and changing the platform switches — and MUST confirm each change with text naming the project and what changed. Both MUST be fully keyboard operable with visible focus, use the existing primitives, and follow `docs/design-system.md` and the docket-ui skill.
- **FR-018**: The controls MUST state in words that turning something off hides notifications only, that problems stay in Activity, and that turning something back on starts from that moment.
- **FR-019**: Which platforms are offered for a project MUST be: the platforms that project has accounts for, plus any platform the person has already switched off for it (N32). A platform that is not registered, or is registered but disabled by configuration, MUST NOT be offered; a preference already stored for it MUST still apply.

**Isolation and authorization**

- **FR-020**: A person MUST only be able to read and change their own preferences. Every mutation MUST resolve the project through the caller's own memberships; a request naming another project, a project that does not exist, or another person MUST write nothing and MUST give the same "not found" (N41). An unknown kind or platform MUST be refused as invalid.
- **FR-021**: Public-API keys MUST be refused on every preference path, and no public-API operation for preferences MUST exist.
- **FR-022**: Every read MUST stay pinned to one project or go through the one sanctioned cross-project reader, and MUST pass the project-scope test harness. Removing a membership MUST delete that person's preferences for the project in the same transaction; a rolled-back removal MUST leave them intact; deleting the project or the user MUST delete them too (N8, unchanged).

**Migration**

- **FR-023**: The schema change MUST ship as a committed SQL migration, MUST leave the committed migrations and the schema in agreement, and MUST be safe to apply to a live install with existing rows without any operator step and without resetting notification state.
- **FR-024**: The migration MUST turn every existing `muted = true` row into all four kinds off for that person and project, MUST leave `muted = false` rows with no stored preference, and MUST NOT alter any reading position, its timestamp, or any sparse per-event mark (N26).

**Docs and tests**

- **FR-025**: The decisions N25–N41 MUST be appended to `docs/decisions.md`, each **next to the decision it replaces or extends** (N5, N6, N10 and 022's plan decisions R1, R5 and R14), stating the reversal, the replacement and the fate of the data written under the old rule, as the roadmap requires. `docs/activity.md`'s "Notifications" section MUST describe the preferences, the roll-up, the fresh-start rule and the fact that delivery outside Docket is still webhooks; the docket-ui skill's structure list and `docs/design-system.md` MUST cover the grid and any new atom.
- **FR-026**: The spec, the plan and the docs MUST state what this entry does not do and which later entry owns it: quiet hours and any email (`email-delivery`), real-time transport (`realtime-updates`), and changes to which outcomes are attention events (owned by nothing in this roadmap — N1 stands).
- **FR-027**: Tests MUST cover:
  - **migration**: `muted = true` rows become all-kinds-off, `muted = false` rows get nothing, positions, timestamps and sparse marks untouched, and the schema matching the committed migrations;
  - **counting under each preference combination**: each kind on and off; each platform on and off; both axes together; a multi-platform event with one, both and neither platform on; an event with no platform; all kinds off; interaction with the floor and with individually-read, snoozed and expired-snooze events from entry 1; the 100 cap;
  - **per-platform filtering against accounts that were later removed**, including a platform whose every account is gone, and a platform re-connected afterwards;
  - **the fresh-start rule**: per kind, per platform and via "Turn all on"; no backlog; nothing marked read by switching off; the redundant-mark pruning; the position never moving backwards under two concurrent writes; an event committed just after the switch still counting;
  - **defaults**: a new member, a rejoin, a project created today, a platform registered later, and a person with no preference row at all;
  - **authz**: only one's own preferences; another project, a non-existent project and another person all refused identically with nothing written; API keys refused; the project-scope harness; membership removal and rollback; project and user deletion;
  - **the screens**: the grid (several projects, mixed states, all-off, no projects), the project settings card for every member role, the confirmations, keyboard operation, accessible names, and both pages working with no client JavaScript.

### Key Entities

- **Notification preference**: For one person, one project and one switch — an attention kind or a platform — that the switch is off, or that it was turned on at a given position. Absent means on (FR-002). Deleted with the membership, project or user. Never per account, never per event.
- **Notification state** (existing, changed): still one row per membership holding the reading floor and its timestamp; it no longer holds a project-level mute (FR-001).
- **Notification event mark** (existing, unchanged in meaning): entry 1's sparse per-event read or snooze state above the floor. This entry only prunes the ones a fresh start makes redundant (FR-008).
- **Eligible attention event**: not stored. An attention event (N1) that may notify a given person for a given project under FR-003.
- Existing entities referenced, unchanged in meaning: activity event, project, member, user, session, social account, platform (a registered provider).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A person can stop being notified about one attention kind, or one platform, in one project without affecting any other kind, platform, project or person — in at most two actions from the Notifications page, with the keyboard alone.
- **SC-002**: Turning a whole project's notifications off, and on again, is still one action each, and has exactly the effect the per-project mute had.
- **SC-003**: After an upgrade of an install with existing rows, 100% of people who had muted a project are still notified of nothing from it, 100% of people who had not see an unchanged count, and 0 reading positions, timestamps or sparse marks have changed.
- **SC-004**: Turning a switch back on after any number of events happened while it was off yields 0 unread for that switch, and the next event through it yields 1.
- **SC-005**: In tests, 0 events that a person's preferences exclude appear in their count, panel, callout or refresh, and 0 events are removed from Activity, the public API or webhooks by any preference.
- **SC-006**: In tests, 0 preference reads or writes touch another person's preferences or a project the caller does not belong to, and a project the caller does not belong to is indistinguishable from one that does not exist.
- **SC-007**: With 100,000 events in a project and a person in 20 projects holding 200,000 events in total, computing the unread count still adds under 100 ms to a page load and the refresh still answers in under 100 ms, in a seeded test.
- **SC-008**: The grid and the project settings card pass the docket-ui accessibility rules (keyboard only, visible focus, labelled controls, text as well as colour for every state), and every switch, including the platform switches, can be changed with client JavaScript unavailable.

## Assumptions

- The four attention kinds are the four outcomes of N1, named to people as Activity already names them (*Failed*, *Needs your decision*, *Needs reconnecting*, *Connect failed*); *Connect failed* is offered as a switch even though it only ever concerns the person's own connect attempts.
- "Platform" means a registered provider — the same vocabulary and display names Activity's platform filter uses.
- Every attention event records the platforms it concerns at write time, so platform filtering does not depend on the account still existing. An event that records none is possible and is handled by FR-003.
- Preferences are per project; there is no account-wide "never tell me about reauth anywhere" switch. The grid makes the per-project choice quick enough that the global one is not needed yet, and adding it later would not change what the per-project switches mean.
- Every member role can be notified, so every member role can set their own preferences; nothing here is owner-only.
- Turning a switch on uses the same locked, membership-re-checking write the existing mute change uses, so its failure mode ("busy, nothing written, try again") and its exactness bound are the ones already specified and tested in 022's R3.
- No new environment variable, dependency, infrastructure or `docker-compose.yml` change is expected.
- No credential, token or recipient address is involved anywhere in this entry — a preference is a switch and a position — so the secret-scanning test is unaffected and stays green.
- The personal page stays at `/notifications` and the project control stays on the project's settings page; the plan fixes any new route or parameter.

## Out of Scope

- **Quiet hours.** They are a delivery-timing rule with no meaning for an in-app badge, and `email-delivery` (entry 3) owns them.
- **Any email**, any mailer, any digest, any unsubscribe and any delivery cadence — all `email-delivery` (entry 3). This entry only settles the preference shape that entry will consume.
- **Real-time transport.** The 60-second refresh stays exactly as it is; replacing it is `realtime-updates` (entry 4).
- **Changing which outcomes are attention events**, or notifying anyone about successes, retries or resolutions. N1 stands, and nothing in this roadmap changes it.
- **A kind × platform matrix**, per-account preferences, and an account-wide preference spanning every project (N28, N31, Assumptions).
- **Anyone else's preferences**: no administrative view, no project-wide default imposed by an owner, no public-API operation.
- **Changes to the activity log, its kinds, its filters, its screens or its API**, beyond what the preference reads need.
