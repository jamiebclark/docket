# Feature Specification: Problem notifications — an unread-problems bell, a recent-problems panel and a per-project callout

**Feature Branch**: `022-problem-notifications`

**Created**: 2026-10-08

**Status**: Draft

**Input**: User description: "Tell people about problems without them having to go looking, building on the activity events from the activity-history entry. Before specifying, read specs/ for the activity-history entry (its spec, data model and decisions; the event kinds and the /activity and /p/[projectSlug]/activity screens), src/components/shell/SignedInHeader.tsx and src/components/shell/InvitationBadge.tsx (the existing header badge pattern), src/components/shell/UserMenu.tsx, src/server/dal/ (membership scoping), the docket-ui skill, docs/design-system.md, .specify/memory/constitution.md and docs/decisions.md. Must deliver: Per-user read state: a per-user, per-project 'seen up to' marker (no per-event rows), so the unread count is a single indexed count of attention events newer than the marker. Attention events are problems only: post target failed, ambiguous, account needs reauth, and account connect failed (only for the user who attempted it). Successes and retries never count. A per-user, per-project setting to mute a project's notifications (still visible in Activity), editable from the user menu or project settings; default on for every project the user belongs to. Header bell with the unread count across the user's projects (accessible name such as '3 unread problems', hidden when zero, capped display like '99+'), opening a panel with the latest 10 attention events (project, platform mark, account, message, relative time, link to the post or Failures entry) plus 'View all' (the all-projects Activity filtered to problems) and 'Mark all as read'. Opening Activity filtered to problems for a project marks that project read. Keyboard and screen-reader accessible per the docket-ui skill; works without client JavaScript for the count and links, with a light client refresh (a small authenticated route handler polled every 60 s while the tab is visible) so the count updates without a reload. A per-project 'Problems since you last looked' callout at the top of /p/[projectSlug] or the posts screen when unread problems exist, linking to Activity. Membership changes: a removed member's markers and mutes are deleted with the membership and nothing leaks; a new member starts with everything before joining marked read. Tests: unread counting (only attention kinds, respects markers, mutes and membership), mark-read paths, the poll route's auth and scoping, removal cleanup, the new-member starting point, and rendering incl. zero, one and 99+. Docs: a 'Notifications' note next to the activity docs, stating that delivery outside Docket uses webhooks (docs/n8n.md). Does NOT: email, push or chat delivery (webhooks cover it); notifications for successes; per-event read state; changes to the activity log itself beyond what read state needs."

## Context and sources

- Roadmap `.specify/roadmaps/docket.json`, entry `activity-notifications`. This is the second half of the owner's 2026-10-07 request ("a notification queue for errors"). It was split from `activity-history` so the log could land and be reviewed before anything counted it.
- Behaviour on `main` that this feature builds on (read from `specs/020-activity-history/` and `docs/decisions.md` 020, D1–D10 and P1–P17):
  - **Activity events** are append-only, one per project, written in the same transaction as the target or account change they describe. Each has a time and a stable tie-breaker for ordering. Seven kinds map one-to-one onto outcomes: published, failed, ambiguous ("Needs your decision"), retrying, resolved, needs reauth ("Needs reconnecting") and connect failed.
  - **Problems are already defined**: the *Problems* preset is exactly failed, ambiguous, needs reauth and connect failed (D3). Retrying and resolved count as neither success nor problem.
  - **The actor is recorded.** A connect-failed event names the member who tried; an API key cannot connect accounts, so every connect-failed event has a member actor (or none, if that member's user was deleted).
  - **Lookups by project, outcome and time are index-backed** (P6). Ordering is time, then tie-breaker (P5). Known bound from P5: a transaction that commits after a reader has passed its position can be missed by that reader.
  - **Screens.** `/p/[projectSlug]/activity` (every member role can view it) and `/activity` (all the caller's projects, membership resolved on every request through the one sanctioned cross-project reader). Both accept the shareable filter `preset=problems`; `/activity` also accepts a repeatable `project` filter. Rows link to the target's Failures entry while it still needs a person, to the post once it has moved on, and to Accounts for account events (P15).
  - **The header** (`SignedInHeader`) is shared by the project shell and the pages outside it (`/activity`, `/invitations`). It shows the Docket mark, an Invitations link whose pending-count badge is hidden at zero and carries screen-reader text, and the user menu. The user menu today is a row of links and a button (avatar and name, "Activity", "Sign out"), not a dropdown.
  - **Project settings** (`/p/[projectSlug]/settings`) is visible to every member; only owners and admins can change the project's own fields.
  - **Membership** is added when a project is created (owner) and when an invitation is accepted, and removed by "remove member" and "leave project", each in a project-locked transaction that also writes an audit entry. Deleting a project or a user cascades to their memberships.
  - **Isolation.** Every project-owned query is pinned to one project, or to the caller's own resolved project set through the named cross-project section; a test harness fails any other query on a project-owned table.
- No external platform facts are involved, so nothing here needs `docs/research/`. No new runtime dependency or infrastructure is expected: the refresh is a plain periodic request from the browser while the tab is visible. One schema change (per-person, per-project notification state) is expected.

## Decisions made while specifying

These are judgement calls. Planning records each one in `docs/decisions.md`.

- **N1 Attention events are the *Problems* preset, minus other people's connect attempts.** An event needs attention when its outcome is failed, ambiguous or needs reauth, or when it is connect failed *and* the person is the member who attempted the connect. Published, retrying and resolved events never count. A connect-failed event with no recorded actor counts for nobody. The same rule drives the count, the panel and the callout, so they never disagree.
- **N2 Unread means "newer than where you last looked", not "still broken".** A problem stays unread until the person marks it read, even if the target has since been retried and published. The panel and Activity show the later outcome; the bell does not try to second-guess it. This keeps the count a single cheap comparison against one marker, as requested.
- **N3 One marker per person per project; it only moves forward.** Marking read sets the marker to the newest event that existed at that moment for that project (or to that moment). A later, older mark (for example from a stale second tab) never moves it back. There are no per-event read rows.
- **N4 What marks a project read.** Exactly three things:
  1. "Mark all as read" in the panel: every project the person currently belongs to, muted or not.
  2. Opening the project's Activity with the *Problems* preset (`/p/{slug}/activity?preset=problems`) when the view shows every problem: no platform, account or date filter, and the first page.
  3. Opening All activity with the *Problems* preset under the same conditions: the projects that view covers (all of the person's projects, or those named in its project filter).

  Opening the panel, opening Activity unfiltered or with other filters, paging, and the callout itself mark nothing. A link being prefetched or preloaded by the browser MUST NOT count as opening.
- **N5 Muting is personal and hides, it does not delete.** A muted project contributes nothing to the bell's count, the panel or the callout. Its events stay in Activity for everyone, including the person who muted it. Notifications are on for every project by default.
- **N6 Unmuting starts fresh.** Turning notifications back on marks the project read at that moment, so a long mute does not end in a "99+" of problems the person chose not to hear about. They remain in Activity.
- **N7 Starting points.** A new member's marker starts at the moment they joined, so earlier history is read; it is still visible in Activity. A member who leaves and later rejoins starts again from the rejoin. When this feature first ships, every existing membership starts with everything up to that moment marked read, so the backfilled history from 020 does not arrive as a flood. Problems that are open at that moment are still shown by the existing reauth banner and the Failures count.
- **N8 Leaving deletes the state.** The marker and mute for a project are deleted in the same transaction that removes the membership (remove member, leave project), and with the project or the user. Nothing about a former member's reading is kept.
- **N9 The bell stays; the count hides.** The bell is always in the header so the recent problems and the mute settings are always one step away. Its count badge is hidden when there is nothing unread. The visible count is capped at "99+"; counting may stop at 100.
- **N10 Where muting is edited.** A personal "Notifications" page outside any project, linked from the user menu and from the panel, lists every project the person belongs to with an on/off control. Each project's settings page has the same control for that project, usable by every member role, separate from the project form that only owners and admins can change.
- **N11 Where the callout appears.** On the project's home (`/p/{slug}`, where `/` and the switcher land) and at the top of the Posts screen, the two places a person arrives in a project.
- **N12 The refresh is quiet.** While the tab is visible, the browser asks for the person's current count every 60 seconds and once when the tab becomes visible again; it stops while the tab is hidden. It updates the badge and the bell's accessible name. It announces to screen readers only when the count goes up, never on every poll.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Know there is a problem without looking (Priority: P1)

A person who belongs to several projects sees a bell in the header on every signed-in page. When a post fails, becomes ambiguous, or an account needs reconnecting in any of their projects (and they have not muted it), the bell shows how many unread problems there are. When nothing needs their attention, the bell shows no count. The count updates on its own within a minute while the tab is open, without a reload.

**Why this priority**: This is the request: problems should find the person, rather than the person checking Failures or Activity in each project.

**Independent Test**: Seed a user in two projects with a mix of published, retrying, resolved, failed, ambiguous, needs-reauth and connect-failed events (some by the user, some by another member), some before and some after the user's marker. Load any signed-in page and check the count equals the attention events newer than each project's marker. Add a failed event and check the count changes on the next refresh without a reload.

**Acceptance Scenarios**:

1. **Given** no unread attention events, **When** any signed-in page loads, **Then** the bell shows no count and its accessible name says there are no unread problems.
2. **Given** exactly one unread failed event, **When** the page loads, **Then** the bell shows "1" and its accessible name is "1 unread problem".
3. **Given** 3 unread problems across two projects, **When** the page loads, **Then** the bell shows "3" and its accessible name is "3 unread problems".
4. **Given** 150 unread problems, **When** the page loads, **Then** the bell shows "99+" and its accessible name says more than 99 unread problems.
5. **Given** published, retrying and resolved events newer than the marker, **When** the count is computed, **Then** none of them count.
6. **Given** a connect-failed event attempted by another member, **When** the count is computed for this person, **Then** it does not count; for the member who attempted it, it does.
7. **Given** the tab is visible and a new problem is written, **When** up to 60 seconds pass, **Then** the count shows the new value without a reload, and a screen reader hears that it went up.
8. **Given** the tab is hidden, **When** time passes, **Then** no refresh requests are made; **When** the tab becomes visible again, **Then** the count refreshes at once.
9. **Given** client JavaScript is unavailable, **When** a page loads, **Then** the count is correct as of that load and every link in the bell's panel still works.

---

### User Story 2 - See the recent problems and act on them (Priority: P1)

The person opens the bell. A panel lists the latest 10 attention events across their unmuted projects, newest first. Each shows its project, the platform mark and account, the message, and when it happened (relative, with the absolute time and zone available), and links to the post or to its Failures entry. Unread ones are marked as new. "View all" opens All activity filtered to problems, and "Mark all as read" clears the count.

**Why this priority**: A number alone is not enough to act on. The panel turns the count into "which post, which account, where do I fix it".

**Independent Test**: Seed 12 attention events across two projects, some read and some unread, plus non-attention events. Open the panel with the keyboard and check its 10 rows, their order, contents, "new" markers and links. Use "Mark all as read" and check the count is gone and the rows are no longer marked new. Repeat with JavaScript disabled.

**Acceptance Scenarios**:

1. **Given** 12 attention events, **When** the panel opens, **Then** it lists the newest 10, each with the project name, platform mark with the platform name as text, account name (or "Removed account"), the message, and a relative time whose full date, time and project zone are available to every user.
2. **Given** a failed event whose target is still failed, **When** its row is chosen, **Then** it opens that target's entry on the Failures screen; **given** its target has since moved on, **Then** it opens the post; **given** a needs-reauth or connect-failed event, **Then** it opens the project's Accounts screen.
3. **Given** unread and read events in the list, **When** the panel shows, **Then** unread rows are marked "New" in text as well as styling.
4. **Given** the panel is open, **When** "View all" is chosen, **Then** All activity opens with the *Problems* preset.
5. **Given** unread problems in several projects, **When** "Mark all as read" is chosen, **Then** the count is gone, no row is marked new, and the person stays on the page they were on.
6. **Given** no attention events at all, **When** the panel opens, **Then** it says there are no problems and still offers "View all" and the notification settings link.
7. **Given** a keyboard user, **When** they open the panel, **Then** focus moves into it, Tab moves through its links and buttons in order, Escape closes it and returns focus to the bell, and the bell exposes whether the panel is open.
8. **Given** the panel is opened, **When** it is closed again without using "Mark all as read", **Then** the count is unchanged.

---

### User Story 3 - Looking at a project's problems clears them (Priority: P1)

The person follows the callout, the panel's "View all", or their own bookmark to Activity filtered to problems. Having seen them, they are no longer counted as unread for the projects that view covered.

**Why this priority**: Without an automatic "seen", the count only grows and people learn to ignore it.

**Independent Test**: With unread problems in projects A and B, open A's Activity with the *Problems* preset and check A's unread count drops to zero while B's is unchanged. Open it with a date filter instead and check nothing changes.

**Acceptance Scenarios**:

1. **Given** unread problems in A and B, **When** the person opens A's Activity with the *Problems* preset and no other filters, **Then** A is marked read and B is not.
2. **Given** unread problems in A and B, **When** they open All activity with the *Problems* preset, **Then** both are marked read; **given** its project filter names only A, **Then** only A is marked read.
3. **Given** the *Problems* preset plus a platform, account or date filter, or an older page, **When** opened, **Then** nothing is marked read.
4. **Given** Activity opened without the *Problems* preset, **When** it loads, **Then** nothing is marked read.
5. **Given** a problem is written just after the person opened the view, **When** the count next refreshes, **Then** that problem counts as unread.
6. **Given** a link to the problems view is merely prefetched, **When** the person has not opened it, **Then** nothing is marked read.

---

### User Story 4 - Hear about only the projects that matter to me (Priority: P2)

A person in many projects turns notifications off for some of them, from a Notifications page linked from the user menu or from that project's settings. Muted projects no longer add to the count, the panel or the callout, but their events remain in Activity.

**Why this priority**: The owner runs several projects; some are low-stakes or someone else's job. Without muting, those make the bell noise.

**Independent Test**: Mute project B for one user. Add problems to A and B. Check the count, panel and B's callout include only A for that user, a second member of B still sees B's problems, and B's events remain in both Activity screens for the first user.

**Acceptance Scenarios**:

1. **Given** a new membership, **When** the Notifications page opens, **Then** that project's notifications are on.
2. **Given** B is muted, **When** problems are written in B, **Then** they are not in this person's count, panel or B's callout, and they still appear in B's Activity and All activity.
3. **Given** B is muted by one member, **When** another member of B looks, **Then** their notifications for B are unaffected.
4. **Given** B was muted while problems happened, **When** notifications for B are turned back on, **Then** B starts with nothing unread, and later problems count.
5. **Given** an editor (who cannot change project settings), **When** they open B's settings, **Then** they can still turn their own notifications for B on and off.
6. **Given** the Notifications page, **When** a person changes a project's setting, **Then** it is saved with a confirmation, works without client JavaScript, and every control has a visible label naming the project.
7. **Given** a person who belongs to no projects, **When** they open the Notifications page, **Then** it says so and offers a way back, rather than erroring.

---

### User Story 5 - A nudge inside the project (Priority: P2)

When a person arrives in a project (its home or the Posts screen) and that project has unread problems for them, a callout at the top says "Problems since you last looked", with how many, and links to the project's Activity filtered to problems.

**Why this priority**: People who never glance at the header still arrive in a project. It reuses the same count, so it is cheap.

**Independent Test**: With 2 unread problems in A, open A's home and Posts screens and check the callout and its count and link. Mark A read and check the callout is gone. Mute A and check it does not show.

**Acceptance Scenarios**:

1. **Given** 2 unread problems in A, **When** A's home or Posts screen opens, **Then** a callout titled "Problems since you last looked" says 2 problems and links to A's Activity with the *Problems* preset.
2. **Given** no unread problems in A, or A muted, **When** those screens open, **Then** no callout shows.
3. **Given** the callout's link is followed, **When** Activity loads, **Then** A is marked read and the callout is gone on the next visit.
4. **Given** a screen reader user, **When** the screen loads with the callout, **Then** it is announced politely (not as an urgent alert), and the count and link are text.

---

### User Story 6 - Joining and leaving never leaks (Priority: P1)

A new member is not greeted with a project's whole history as unread. A removed member's reading state for that project is gone, and that project's problems disappear from their bell, panel and refresh at once.

**Why this priority**: The count crosses projects, so membership mistakes here would leak one project's problems to someone outside it.

**Independent Test**: Seed problems in a project, invite and accept a new member, and check their count is zero until a new problem. Remove a member and check their state for that project is deleted in the same transaction, and their count, panel and refresh exclude it on the very next request.

**Acceptance Scenarios**:

1. **Given** 20 problems in A before a person joins, **When** they accept the invitation, **Then** their unread count for A is 0, and a problem after joining makes it 1.
2. **Given** a member who muted A and has a marker in A, **When** they are removed or leave, **Then** their marker and mute for A no longer exist, and the removal's rollback (for example "last owner") leaves both intact.
3. **Given** a member removed from A, **When** their next page load, panel or refresh happens, **Then** nothing from A appears or is counted.
4. **Given** a removed member is invited back, **When** they accept, **Then** they start fresh from the rejoin, with notifications on.
5. **Given** a project or a user is deleted, **When** that happens, **Then** their notification state goes with it.
6. **Given** this feature is first deployed onto existing data, **When** existing members next load a page, **Then** their counts start at zero and only problems after the deploy count.

---

### User Story 7 - The refresh is safe (Priority: P1)

The background refresh only ever tells a signed-in person about their own projects, and only the count.

**Why this priority**: It is a new endpoint that browsers call every minute, so it must not become a way to read other people's or other projects' state.

**Independent Test**: Call the refresh with no session, an expired session, a session for a user in no projects, and a session for a user in some projects with crafted parameters naming other projects or users, and with an API key. Check the responses.

**Acceptance Scenarios**:

1. **Given** no session or an expired one, **When** the refresh is called, **Then** it is refused as unauthenticated with no count.
2. **Given** a valid session, **When** called, **Then** it returns only that person's unread count (and its capped display), computed exactly as the header does, and responses are never cached or shared.
3. **Given** query parameters or a body naming another user or project, **When** called, **Then** they are ignored and the result is still only the caller's own count.
4. **Given** a public-API key instead of a session, **When** called, **Then** it is refused; API keys belong to projects, not people.

---

### Edge Cases

- A problem that has already been fixed (retried and published) still counts until it is marked read (N2). The panel row links to the post, because the target has moved on.
- A problem committed a moment after the person marked read or opened the problems view counts as unread; it is never silently swallowed by a mark that ran before it existed. The plan states how the marker handles a transaction that commits after the mark has passed its position (the P5 bound) and records it.
- Two tabs mark read at different times: the marker ends at the later position (N3).
- An event whose account was removed or whose post was deleted shows "Removed account" or "Post deleted" in the panel, matching Activity.
- A connect-failed event for a platform group that spans several platforms (Facebook and Instagram) shows the group's mark or each mark, as Activity does, and counts once.
- A connect-failed event whose attempting user was deleted counts for nobody (N1).
- A person whose only memberships are muted sees the bell with no count, and the panel says notifications are off for their projects with a link to the Notifications page.
- A person in no projects sees the bell with no count; the panel and the Notifications page say they are not in any project.
- The count reaches 100 or more: the display is "99+" and counting work stops at 100.
- A crafted "mark all as read" or mute change naming a project the person does not belong to changes nothing and reveals nothing.
- A mark-read or mute request without a valid session, or forged from another site, is refused.
- The refresh fails (network or server error): the last shown count stays, no error is shown, and the next interval tries again.
- Being on Activity with the *Problems* preset while new problems arrive: the view does not re-mark read on its own; the count rises on the next refresh until the view is opened again.
- The person changes roles in a project: their marker and mute are kept.
- A project with a very large history (hundreds of thousands of events) does not slow page loads, because the count only looks at attention events newer than the marker and stops at 100.

## Requirements *(mandatory)*

### Functional Requirements

**Read state and attention**

- **FR-001**: The system MUST keep, per person and per project they belong to, a "seen up to" position and a notifications on/off setting. It MUST NOT keep per-event read state.
- **FR-002**: An event MUST count as an attention event for a person exactly as N1 describes: failed, ambiguous or needs reauth for any member; connect failed only for the member who attempted it. Published, retrying and resolved events MUST never count.
- **FR-003**: A person's unread count MUST be the number of attention events, across the projects they currently belong to with notifications on, that are newer than their position for that project. It MUST be computed from the person's current memberships on every request, and MUST NOT need to count past 100.
- **FR-004**: Each project's unread lookup MUST be one index-backed count over that project's attention events newer than the position. The cross-project lookup MUST be limited to the person's own resolved project set and MUST pass the project-scope test harness.
- **FR-005**: The position MUST only move forward (N3). Marking read MUST cover every event that existed when it was done and MUST NOT cover events committed afterwards (see Edge Cases).
- **FR-006**: Projects MUST be marked read only by the three paths in N4. Opening the panel, unfiltered or otherwise-filtered Activity, later pages, and prefetching or preloading MUST NOT mark anything read.

**Muting**

- **FR-007**: Notifications MUST be on by default for every membership. Turning them off for a project MUST remove that project from the person's count, panel and callout, and MUST NOT hide anything in Activity (N5). Turning them back on MUST mark the project read at that moment (N6).
- **FR-008**: A personal Notifications page, outside any project and linked from the user menu and from the panel, MUST list every project the person belongs to with a labelled on/off control. Each project's settings page MUST show the same control for that project to every member role, separate from the owner/admin project form (N10). Both MUST work without client JavaScript and confirm the change.
- **FR-009**: Changing a mute or marking read MUST only ever affect the caller's own state for projects they currently belong to. A request naming another project or person MUST change nothing and MUST NOT reveal whether that project exists.

**Header bell and panel**

- **FR-010**: Every signed-in page that shows the shared header MUST show a bell next to Invitations. Its count badge MUST be hidden at zero and MUST show the number up to 99 and "99+" from 100. Its accessible name MUST state the count in words: "No unread problems", "1 unread problem", "N unread problems", "More than 99 unread problems".
- **FR-011**: The bell MUST open a panel listing the 10 newest attention events across the person's projects with notifications on, newest first. Each row MUST show:
  - the project name;
  - the platform mark (decorative) with the platform name as text;
  - the account name, or "Removed account";
  - the message;
  - a relative time, with the absolute time and the project's time zone available as text;
  - a "New" marker in text when it is newer than the person's position;

  and MUST link to the same place Activity links that event (Failures entry while the target still needs a person, otherwise the post; Accounts for account events).
- **FR-012**: The panel MUST offer "View all" (All activity with the *Problems* preset), "Mark all as read" (N4.1, returning the person to the page they were on) and a link to the Notifications page. Its empty states MUST say there are no problems, or that notifications are off for all of the person's projects, or that they belong to no project.
- **FR-013**: The bell and panel MUST be fully keyboard and screen-reader accessible per the docket-ui skill: a labelled control that exposes its open state, focus moved into the panel on open, logical Tab order, Escape closes and returns focus to the bell, visible focus, and text plus colour for every status.
- **FR-014**: Without client JavaScript, the count MUST be correct as of the page load, the panel's rows and links MUST be reachable from the bell, and "Mark all as read" MUST work.

**Refresh**

- **FR-015**: A small, session-authenticated endpoint MUST return the caller's unread count and its capped display, computed exactly as FR-003. It MUST refuse callers without a valid session (and public-API keys), ignore any parameter naming a person or project, and mark its responses as not cacheable.
- **FR-016**: While the tab is visible, the page MUST refresh the bell from that endpoint every 60 seconds and once when the tab becomes visible again; it MUST NOT poll while the tab is hidden. A refresh MUST update the badge and the accessible name, MUST announce politely only when the count increases, and on failure MUST keep the last value silently.

**Project callout**

- **FR-017**: A project's home and its Posts screen MUST show, at the top, a "Problems since you last looked" callout when the person has unread problems in that project with notifications on. It MUST state the number (with the same "99+" cap) and link to that project's Activity with the *Problems* preset. It MUST be announced politely, not as an urgent alert, and MUST NOT show when the count is zero or the project is muted.

**Membership changes**

- **FR-018**: A new membership (project creation or accepted invitation) MUST start with its position at the moment of joining and notifications on (N7). A rejoin MUST start fresh.
- **FR-019**: Removing a member and leaving a project MUST delete that person's position and mute for the project in the same transaction as the membership; a rolled-back removal MUST leave them intact. Deleting the project or the user MUST delete them too (N8). The next request after removal MUST NOT count, list or refresh anything from that project for that person.
- **FR-020**: When this feature is first deployed, every existing membership MUST start with everything up to that moment marked read (N7).

**Scope of change**

- **FR-021**: The activity log MUST NOT change apart from what read state needs (for example an index, if the plan shows one is needed for FR-004). No event kinds, messages, screens' filters or API responses change, other than Activity's problems view marking read (N4).

**Docs and tests**

- **FR-022**: `docs/activity.md` MUST gain a "Notifications" section covering: what counts (N1, N2), what marks read (N4), muting (N5, N6), starting points (N7), the 60-second refresh, and that delivery outside Docket (email, chat, phones) is done with webhooks, linking to `docs/n8n.md`. The judgement calls N1–N12 MUST be appended to `docs/decisions.md`, and the docket-ui skill's structure list and `docs/design-system.md` MUST list the bell and any new UI atom.
- **FR-023**: Tests MUST cover:
  - unread counting: only attention kinds; connect failed only for its attempter; positions respected; mutes respected; only current memberships; the 100 cap;
  - every mark-read path in N4, including the filter and page conditions that do not mark read, forward-only positions, and an event committed after the mark still counting;
  - unmute starting fresh;
  - the refresh endpoint's authentication (none, expired, API key), scoping (crafted parameters, a user in no projects) and no-cache response;
  - cross-project scoping through the project-scope harness;
  - removal and leave cleanup in the same transaction, rollback leaving state intact, and project and user deletion;
  - the new-member and rejoin starting points, and the first-deploy starting point;
  - rendering of the bell (zero, one, many, 99+, accessible names), the panel (rows, "New", empty variants, links) and the callout (shown, hidden, muted).

### Key Entities

- **Notification state**: One per person per project membership. Holds the "seen up to" position in that project's activity and whether notifications are on. Created at joining (or first use, behaving as if created at joining), moved forward by marking read, deleted with the membership, project or user. Never per event.
- **Attention event**: Not stored separately. An activity event that counts for a given person under N1.
- **Unread count**: For a person, the attention events newer than their position, summed over their current, unmuted projects, capped at 100.
- Existing entities referenced, unchanged in meaning: activity event, project, member, user, session.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new problem in any unmuted project a person belongs to appears in their bell within 60 seconds while their tab is visible, and on the next page load otherwise.
- **SC-002**: From any signed-in page, a person can reach the post or Failures entry behind a recent problem in two actions (open the bell, choose the row), with the keyboard alone.
- **SC-003**: With 100,000 events in a project and a person in 20 projects holding 200,000 events in total, computing the unread count adds under 100 ms to a page load and the refresh answers in under 100 ms, in a seeded test.
- **SC-004**: In tests, zero problems from projects the person does not currently belong to, or has muted, appear in their count, panel, callout or refresh; removal takes effect on the very next request.
- **SC-005**: In tests, 100% of non-attention events (published, retrying, resolved, other members' connect failures) are excluded from every count, and 100% of the N4 paths mark read exactly the projects they cover, while every other view marks nothing.
- **SC-006**: A new member's count is 0 on their first page load, and every existing member's count is 0 right after the first deploy.
- **SC-007**: The bell, panel, callout and Notifications page pass the docket-ui accessibility rules (keyboard only, visible focus, labelled controls, text plus colour) and work without client JavaScript for counts, links, marking read and muting.

## Assumptions

- All member roles can view posts, so every member of a project can receive its notifications.
- A connect attempt is always made by a signed-in member; API keys cannot connect accounts.
- The panel's "latest 10" covers read and unread attention events, so it stays useful after "Mark all as read"; unread ones are marked "New".
- Relative times in the panel follow the existing convention: absolute time and project zone as a tooltip and as screen-reader text.
- The Notifications page is reached at a route outside any project (for example `/notifications`); the plan fixes the path.
- The existing reauth banner, Failures count and Review count are unchanged and continue to show *current* problems; the bell shows *new* ones.
- Webhooks, the public API and the activity events themselves are unchanged; there is no public-API operation for notifications, because API keys belong to projects, not people.
- No new environment variables, dependencies or `docker-compose.yml` changes are expected.

## Out of Scope

- Email, push, chat or any other delivery outside Docket. Webhooks already cover it (`docs/n8n.md`).
- Notifications for successes, retries or resolutions.
- Per-event read state, marking a single problem read, or snoozing.
- Changes to the activity log, its event kinds, its filters or its API beyond what read state needs.
- Real-time push from the server to the browser (only the 60-second refresh).
- Notification preferences finer than per project (per platform, per kind, quiet hours).
