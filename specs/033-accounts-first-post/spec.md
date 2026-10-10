# Feature Specification: Accounts restructure and first-post flow

**Feature Branch**: `033-accounts-first-post`

**Created**: 2026-10-09

**Status**: Draft

**Input**: User description: "Entry 4 of 4 in the first-time project experience roadmap (`.specify/roadmaps/onboarding.md`): Accounts restructure and first-post flow. Audit recommendations S3, C1, C3, C4 and C5 (`docs/research/onboarding-audit.md`). Account cards ordered status, then posting slots, then posting instructions (collapsed), then remove. After connecting, land on that account's slot editor. A SetupNotice variant for prerequisite lists. After a first schedule or publish, link to the calendar. A `docs/getting-started.md` page, linked from the entry-1 checklist. The project switcher's accessible name without the shortcut, and the setup password hint linked with aria-describedby. Follow the roadmap's rules for every entry (role-aware, display names only, existing primitives, test-pinned labels, fold in activity history, problem notifications and video). Not included: a dismissible checklist (audit C2)."

## Context

Entries 1–3 (`specs/027-project-overview`, `specs/028-empty-states-roles`, `specs/029-terminology-nav-order`) gave
the project a home with a Getting started checklist, made every empty state name its next step, and fixed the nav
and vocabulary. A newcomer can now find the first step and understand the words. What is left is the path through
the steps themselves:

- On the Accounts page, the step that matters right after connecting (posting slots) is buried. Each account card
  shows posting instructions first, an optional generation setting, and posting slots after it.
- After connecting an account, the owner lands at the top of the Accounts page and has to find the new card and its
  slot editor themselves.
- The Generate and Jobs gates show their prerequisites in a general-purpose Checklist card that looks like the
  overview's progress list, not like a "you can't do this yet" notice.
- After a first post is scheduled or published, nothing points to the calendar, where the result is visible.
- There is no single page a newcomer can read about how a project works end to end.
- Two accessibility gaps remain from the audit: the project switcher's spoken name includes "Ctrl/⌘ K", and the
  first-run setup form's password hint isn't linked to its input.

This entry closes those gaps. It is the last entry in the roadmap.

### Audit citations re-checked against the current code (2026-10-09)

The audit was written on 2026-10-08, before the video roadmap's last entries and entries 1–3 of this roadmap.
Each line this entry relies on was re-checked:

| Audit claim | Current code | Effect on this spec |
|---|---|---|
| One account card holds a header, notes, the posting-instructions form, the slot table, the slot editor and Remove (`accounts/page.tsx:117-228`, `:186-227`) | The card is now `accounts/page.tsx:141-255`. Order: header with `ProviderIcon`, name, platform and status `Badge` (`:149-158`); last error (`:159-161`); connected time (`:162-164`); notes (`:165-169`); mock controls (dev only, `:170-175`); reconnect controls for accounts needing reconnecting (`:176-210`); **Posting instructions** heading and form (`:211-222`); **Posting slots ({tz})** heading with id `account-{id}-slots` (`:224`), table or "No posting slots yet." (`:225-244`); then, for managers, the slot editor and Remove in one bordered block (`:245-252`). Entry 3 added the one-time posting-slot definition above all cards (`:123-127`) | FR-001–FR-009 |
| "Send the owner to `#account-{id}` with the slot editor focused" (S3) | Three ways to connect. (1) OAuth groups: the platform returns to `src/app/connect/callback/route.ts`, which redirects to the chooser on success (`:21-22`) or to the Accounts page with a `connect` code on failure (`:23-27`); the chooser's save action then redirects to the top of the Accounts page (`accounts/actions.ts:128`). The save returns every saved account (`connect.ts:220`, `saved: AccountView[]`), each candidate being new, already connected, or needing reconnecting (`ChooserForm.tsx:17`). (2) Credential providers such as Bluesky: a client form on the Accounts page (`ConnectCredentialsForm.tsx`) refreshes the page in place. (3) The mock provider (dev only): the same, through `ConnectMockForm.tsx` | FR-010–FR-018 |
| "Check whether changing the connect-callback redirect counts as a behaviour change" (S3, and "Not checked" in the audit) | The callback route's own redirects do not need to change: success already goes to the chooser, and failure redirects are pinned by `tests/integration/connect/callback-hint.test.ts:54`. Only where the browser ends up **after** a successful save changes (the chooser action and the two in-page forms). No data, permission, activity entry or notification changes | Answered: navigation only, not a behaviour change of the connect flow. Recorded as a decision (FR-019) |
| Other code already links into account cards | `#account-{id}` from the reconnect banner (`ReauthBanner.tsx:37`) and the overview Accounts card (`lib/overview/derive.ts:289`); `#account-{id}-slots` from the overview checklist (`derive.ts:205`), the calendar empty state (`lib/roles/calendar.ts:42`) and Compose's slot hint (`compose/composer-logic.ts:110`); `#add-account` from several empty states | These anchors must keep working (FR-008) |
| C1: `SetupNotice`, an `EmptyState` variant with a title and a list of prerequisites, for the Generate and Jobs gates | Entry 2 replaced the one-at-a-time gates with one list of every missing prerequisite, built by `generationPrerequisites` (`lib/roles/prerequisites.ts`, title "Before you can generate") and loaded by `generate/prerequisites.ts`. It is shown in the general `Checklist` card on Generate (`generate/page.tsx:55`), Batch jobs (`jobs/page.tsx:63`), New job from media (`jobs/new/page.tsx:75`) and New job from CSV (`jobs/new/csv/page.tsx:34`). `EmptyState` (`components/ui/EmptyState.tsx`) takes only `message`, `action` and `icon`. Design system §7 notes that `Checklist` is "also used for prerequisite lists (Generate, Jobs)" (`docs/design-system.md:248`) | FR-020–FR-027 |
| C3: after a first Schedule or Publish now, the Composer's success message links to "See it on the calendar" | The outcome is shown inside each dialog, not in a Composer message: "Added to the queue" (`ScheduleDialogs.tsx:84-110`), "Scheduled" (`:223-227`) and "Publishing" (`:297-300`). The Composer only refreshes the route when they finish (`Composer.tsx:601,613,625`). The overview's first-post step counts a post as done once it is scheduled, publishing, published or partially failed (`lib/overview/derive.ts:183`). The calendar accepts a `view` and a `date` (`calendar/page.tsx:40-47`) and shows published posts as well as scheduled ones (`server/services/calendar.ts:124`) | FR-030–FR-036 |
| C4: write `docs/getting-started.md`, add it to `DocPage` (`src/lib/docs.ts:6-16`), and link it from the checklist | `DocPage` is now `src/lib/docs.ts:6-17` (11 pages, no getting-started). The docs site is built with `strict: true` (`mkdocs.yml:11`) by `.github/workflows/docs.yml:32`; `tests/integration/docs/published-docs.test.ts` checks that every `docsUrl(...)` names a page in the site nav and an existing heading. The checklist is rendered by the overview page (`(overview)/page.tsx:88-92`) with the shared `Checklist` | FR-040–FR-047 |
| C5: the switcher's `kbd` is part of the button's accessible name (`ProjectSwitcher.tsx:85-87`) | Unchanged in substance: the button is `ProjectSwitcher.tsx:78-88`, the `kbd` "Ctrl/⌘ K" at `:87`, visible from the `sm` breakpoint. The shortcut listens for Ctrl or Meta with K (`:51`) | FR-050–FR-052 |
| C5: the setup password hint isn't linked; only the error is (`setup-form.tsx:26-29`) | Unchanged: `aria-describedby` points only at the error (`setup-form.tsx:26`), and the hint "12–128 characters" is hidden while an error shows (`:29`). The signup form already uses the shared `Field`, which links both hint and error (`signup-form.tsx:25`, `Field.tsx:21-37`) | FR-053–FR-055 |

Tests that assert strings or structure this entry touches were searched for. `tests/integration/roles/routes.test.tsx`,
`tests/integration/jobs/ui.test.tsx`, `generate/generate.test.tsx` and `lib/roles/prerequisites.test.ts` assert the
prerequisite title and items; their wording does not change (FR-024). No test asserts the switcher's accessible name
or the card's internal order. The pinned nav labels ("Review (3)", ">Failures<", Review directly above Failures in
`tests/integration/failures/nav.test.ts`) are not touched.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An account card that leads with what to do next (Priority: P1)

An owner opens Accounts after connecting their first account. Each account card reads top to bottom in the order
they need it: who the account is and whether it's working, then its posting slots with the form to add one, then
its posting instructions folded away, and last, set apart, Remove. The step that unlocks Add to queue is now the
first thing under the account's name.

**Why this priority**: Posting slots are the second required step for every new project, and today they are the
third block in the card, below an optional generation setting. Every owner who connects an account meets this card.

**Independent Test**: Render the Accounts page for an owner with one connected account, and for an editor with the
same account. Check the order of the card's sections, that posting instructions start collapsed, and that Remove is
last and shown only to the owner.

**Acceptance Scenarios**:

1. **Given** an owner and a connected account with no slots, **When** they open Accounts, **Then** the card shows, in
   order: the status section (platform mark, name, platform, status badge, connected time, any last error, notes and
   reconnect controls), then Posting slots ("No posting slots yet." and the add-slot form), then a collapsed
   Posting instructions section, then Remove.
2. **Given** an owner and an account with slots, **When** they open Accounts, **Then** the slot table sits directly
   under the Posting slots heading, the add-slot form directly under the table, and the posting-instructions form is
   inside the collapsed section.
3. **Given** an account whose posting instructions are set, **When** the card renders, **Then** the collapsed
   section's summary says instructions are set, without opening it.
4. **Given** an account needing reconnecting, **When** an owner follows the reconnect banner's link to the card,
   **Then** the status badge and the reconnect control are the first things in the card.
5. **Given** an editor, **When** they open Accounts, **Then** each card shows the status section, the slot table (or
   "No posting slots yet.") with no add, pause or delete controls, a collapsed read-only Posting instructions
   section, and no Remove.
6. **Given** a phone-width screen (390 px), **When** the card renders, **Then** the sections stack in the same order
   and nothing overflows horizontally.

---

### User Story 2 - After connecting, land on that account's slot editor (Priority: P1)

An owner connects an account. Instead of being dropped at the top of the Accounts page, they land on the new
account's card with the posting-slot form in view and keyboard focus in it, and a short message tells them what
happened and what's next.

**Why this priority**: This removes the "now what?" moment between the two required steps. Without it, the owner has
to scroll past the page header, the definition and other cards to find the new one.

**Independent Test**: Connect an account by each route (the platform chooser, a credentials form, and the mock in
development) and check where the page lands, where focus is, and what is announced.

**Acceptance Scenarios**:

1. **Given** an owner who picked one new account in the platform chooser, **When** they save, **Then** the Accounts
   page opens at that account's Posting slots section, focus is on the add-slot form's first control, and a status
   message says the account was connected and to add posting slots.
2. **Given** an owner who picked several new accounts in the chooser, **When** they save, **Then** the page lands on
   the first of them (in the order the chooser listed them) and the message says how many were connected and that
   each needs posting slots.
3. **Given** an owner who connects an account through a credentials form on the Accounts page, **When** the
   connection succeeds, **Then** the page moves to the new card's Posting slots section with focus in the add-slot
   form and the success is announced.
4. **Given** an owner who **reconnects** an existing account (through the chooser, a credentials Reconnect form or
   the mock), **When** it succeeds, **Then** the page lands on that account's card with focus on its name, not on
   the slot editor, and the message says it was reconnected.
5. **Given** a chooser save that only refreshed accounts already connected, **When** it succeeds, **Then** the page
   lands on the first of those accounts' cards, as in scenario 4.
6. **Given** a connect that fails or is cancelled, **When** the platform returns, **Then** the page behaves as today:
   the top of Accounts with the failure banner.

---

### User Story 3 - Prerequisite lists that look like a notice, not a progress tracker (Priority: P2)

Someone opens Generate, Batch jobs or a New job page before the project is ready to generate. They see one notice,
styled like the app's other "nothing here yet" panels, with a title ("Before you can generate"), and the list of
every prerequisite: what each one is, whether it's done, and the one thing they can do about it (or who to ask).

**Why this priority**: The content is already correct (entry 2). This makes the gate read as "you can't do this yet,
here's why" and gives the design system one named component for prerequisite gates, separate from the overview's
progress list.

**Independent Test**: Render each of the four gated pages with missing prerequisites, as an owner and as an editor,
and check the notice's title, its items and their actions; render them with everything ready and check the notice
is absent.

**Acceptance Scenarios**:

1. **Given** a project with no AI provider, no account and no voice profile, **When** an owner opens Generate,
   **Then** one SetupNotice titled "Before you can generate" lists all three prerequisites, each with its status in
   words and its single action, and the generate form is not shown.
2. **Given** the same project, **When** an editor opens Generate, **Then** the same notice shows each missing item as
   waiting on the owners and admins by display name, with no actions, no server setting names and no setup-guide
   links.
3. **Given** a project ready to generate, **When** anyone opens Generate, **Then** no SetupNotice appears.
4. **Given** Batch jobs, New job from media and New job from CSV with a missing prerequisite, **When** they open,
   **Then** each shows the same SetupNotice in place of the bare Checklist card it shows today.
5. **Given** the overview, **When** it renders the Getting started list, **Then** it still uses the progress-list
   component, not SetupNotice.

---

### User Story 4 - After a first post, see it on the calendar (Priority: P2)

A newcomer writes their first post and schedules it (or adds it to the queue, or publishes it now). The success
dialog that lists each account's time now also offers "See it on the calendar", which opens the calendar at the
period that contains the post.

**Why this priority**: It closes the loop on the third required step: the person sees where scheduled work lives.
After the first post they know the way, so the link only appears once.

**Independent Test**: In a project with no scheduled or published posts, schedule a post and check the dialog's
link and its destination; then schedule a second post and check the link is absent.

**Acceptance Scenarios**:

1. **Given** a project with no post that is scheduled, publishing, published or partially failed, **When** someone
   schedules a post for a time and it succeeds, **Then** the "Scheduled" dialog shows a "See it on the calendar" link
   that opens the calendar at the period containing that time.
2. **Given** the same starting project, **When** someone adds a post to the queue and at least one account gets a
   time, **Then** the "Added to the queue" dialog shows the same link, opening the period containing the earliest
   assigned time.
3. **Given** the same starting project, **When** someone publishes a post now and it starts publishing, **Then** the
   "Publishing" dialog shows the link, opening the calendar at the current period.
4. **Given** a project that already has a scheduled or published post, **When** someone schedules, queues or
   publishes another, **Then** the dialog shows no calendar link.
5. **Given** a first attempt where every account fails, **When** the dialog shows the failures, **Then** no calendar
   link appears, because nothing was put on the calendar.
6. **Given** an editor, **When** they schedule the project's first post, **Then** they see the same link (editors
   can schedule and see the calendar).

---

### User Story 5 - A getting-started guide, linked from the checklist (Priority: P3)

A newcomer who wants the whole picture before clicking around follows a "Read the getting-started guide" link in the
Getting started card. It opens a short page on the docs site that walks through a project in the order they need:
connect an account, add posting slots, write and schedule or publish a first post, then the optional steps (brand
voice and generation with Review, media including videos, inviting teammates). It explains the three roles in plain
words, and says where to look afterwards (Calendar, Failures, Activity, notifications). Server setup is one sentence
pointing the person who runs the server to the deployment guide.

**Why this priority**: Helpful but not blocking. The in-app checklist and empty states already lead the way; the
guide is for people who prefer to read first.

**Independent Test**: Check the guide exists, is in the docs site nav, is a registered doc page in the app, the
docs site builds in strict mode, and the overview's Getting started card links to it for every role.

**Acceptance Scenarios**:

1. **Given** the Getting started card in full or collapsed form, **When** any member views the overview, **Then** it
   contains a link to the getting-started guide that opens the published page.
2. **Given** the docs site, **When** it is built in strict mode, **Then** the build passes with the new page in the
   nav.
3. **Given** the guide, **When** an editor reads it, **Then** it contains no server commands and no environment
   variable names.
4. **Given** the checklist is hidden entirely (every step done), **When** the overview renders, **Then** no guide
   link is shown there, as the card itself is gone.

---

### User Story 6 - Two accessibility fixes (Priority: P3)

A screen-reader user hears the project switcher as the project's name (e.g. "Acme Launch"), not "Acme Launch Ctrl/⌘
K", and is told separately that Ctrl+K or ⌘K opens it. On the first-run setup form, the password field announces its
"12–128 characters" hint, and still does when an error is shown.

**Why this priority**: Small, contained fixes from the audit's accessibility section that complete the roadmap.

**Independent Test**: Render the switcher and check its accessible name and shortcut property; render the setup
form with and without a password error and check what the password input is described by.

**Acceptance Scenarios**:

1. **Given** the switcher button, **When** its accessible name is computed, **Then** it is the current project's name
   and nothing else from the visible shortcut.
2. **Given** the switcher button, **When** assistive technology reads its shortcuts, **Then** it exposes both
   Control+K and Meta+K.
3. **Given** the setup form with no errors, **When** the password input's description is computed, **Then** it is the
   "12–128 characters" hint.
4. **Given** the setup form after a too-short password, **When** the description is computed, **Then** it includes
   both the hint and the error, and the hint is still visible.

---

### Edge Cases

- **A card link to an account that no longer exists** (removed by another owner between connect and landing, or a
  stale bookmark): the Accounts page opens normally at the top; no error.
- **The landing target is below other cards**: the page scrolls so the target is below the sticky header, as the
  existing anchor targets already do.
- **JavaScript is off or still loading**: the browser still jumps to the account's slot section by its address
  fragment; only the focus move needs the client.
- **Several accounts connected at once, some new and some reconnected**: land on the first **new** account's slot
  editor; the message counts both ("Connected 2 accounts and reconnected 1").
- **An admin rather than an owner connects**: same landing; admins can manage accounts and slots.
- **The connected account's platform is unavailable on the server** (e.g. its app credentials were removed): the
  landing still happens; the card's existing unavailable notes explain the state.
- **Posting instructions save fails** while the section is open: the section stays open with the error shown and
  focus on the field, as the form does today.
- **Instructions saved, then the page refreshes**: the section may close again; its summary says instructions are
  set, so nothing is lost from view.
- **Two members schedule the project's first post at the same moment**: both may see the calendar link. Acceptable;
  the link is a convenience, not a record.
- **A first post scheduled for a date in a later month**: the link opens that month, not the current one.
- **A first post that publishes now but immediately fails** (the dialog reports a failure for every account): no
  link. A partial failure with at least one account publishing shows the link.
- **A first post scheduled from Review, a batch job's auto-queue, a calendar drag or the public API**: no link; those
  paths have no Composer success dialog. This entry covers the Composer only.
- **Prerequisites change while the page is open** (an owner adds a voice profile in another tab): the notice updates
  on the next load, as today.
- **The switcher on a phone**: the shortcut hint is hidden below the `sm` breakpoint as today; the accessible name is
  the project name at every width.
- **The setup page in a browser with autofill**: hint and error linkage don't depend on typed input.

## Requirements *(mandatory)*

### Functional Requirements

**Account card order (S3)**

- **FR-001**: Each account card on the Accounts page MUST show its sections in this order: (1) status, (2) Posting
  slots, (3) Posting instructions, collapsed, (4) Remove.
- **FR-002**: The status section MUST hold the platform mark, account name, platform name, status badge, connected
  time, last error (if any), the account's notes, the reconnect controls for an account needing reconnecting (for
  managers), and the mock provider's test controls (development only, for managers).
- **FR-003**: The Posting slots section MUST hold its heading (with the project time zone), the slot table or "No
  posting slots yet.", and, for managers only, the add-slot form directly after the table. Pause, resume and delete
  stay on each slot row, for managers only.
- **FR-004**: The Posting instructions section MUST start collapsed for everyone, using a native disclosure with a
  visible focus ring. Its summary MUST say whether instructions are set (for example "Posting instructions · Set" /
  "Posting instructions · None"). Managers get the existing form inside; editors get the read-only text or "No
  posting instructions."
- **FR-005**: The section MUST stay open after a failed save, keeping the existing error and focus behaviour.
- **FR-006**: Remove MUST be the last element of the card, visually separated from the slot and instruction
  sections, and shown to managers only. Its confirmation dialog is unchanged.
- **FR-007**: The page-level posting-slot definition added by entry 3 MUST stay where it is and remain the only
  definition on the page.
- **FR-008**: The anchors `#account-{id}`, `#account-{id}-slots` and `#add-account` MUST keep working, and every
  existing link to them (reconnect banner, overview, calendar empty state, Compose slot hint, empty states) MUST
  still land on the right place.
- **FR-009**: Editors MUST NOT see any control they can't use in the card: no add-slot form, slot row actions,
  instruction form, reconnect controls, mock controls or Remove.

**Landing after connecting (S3)**

- **FR-010**: After a successful connect that adds at least one **new** account, the Accounts page MUST open at the
  first new account's Posting slots section, with keyboard focus on the add-slot form's first control.
- **FR-011**: "First" MUST mean the first saved account in the order the chooser listed it; for a credentials or mock
  connect there is only one account.
- **FR-012**: After a successful connect that only reconnects or refreshes existing accounts, the page MUST open at
  the first such account's card, with focus on the card's account name, not on the slot editor.
- **FR-013**: The landing MUST be accompanied by a polite status announcement that is also visible, naming the
  outcome: "Connected {account name}. Add posting slots so Add to queue can schedule it." for one new account;
  "Connected {n} accounts. Add posting slots for each." for several; "Reconnected {account name}." for a reconnect;
  combined counts when a save does both. Account names are the platform's display names, never derived from an
  email.
- **FR-014**: The landing MUST apply to all three connect routes: the platform chooser (OAuth groups and pasted
  tokens), the credentials forms (new and reconnect), and the mock (development only).
- **FR-015**: Failed, cancelled and not-allowed connects MUST behave exactly as today: the top of the Accounts page
  with the existing failure banner.
- **FR-016**: The connect callback's own redirect targets MUST NOT change (chooser on success, Accounts with a code on
  failure).
- **FR-017**: The landing MUST NOT change what is saved, who may connect, the activity entries written, or any
  notification sent.
- **FR-018**: If the landing target no longer exists when the page loads, the page MUST open normally with no error.
- **FR-019**: `docs/decisions.md` MUST record that the post-connect destination change is a navigation change, not a
  behaviour change of the connect flow, with the reasoning from the Context table.

**SetupNotice (C1)**

- **FR-020**: A shared SetupNotice component MUST be added as a variant of the empty-state panel: the same dashed
  panel and decorative icon, plus a visible title (a heading at the level that fits the page outline), an optional
  one-sentence lead, and an ordered list of prerequisites.
- **FR-021**: Each prerequisite MUST show its title, a one-line explanation, its status in words ("Done", "To do" or
  "Waiting on {names}"), and at most one action or a short blocked reason. The status icon is decorative; the status
  is never conveyed by icon or colour alone.
- **FR-022**: SetupNotice MUST replace the Checklist card at the four generation gates: Generate, Batch jobs (when
  not ready), New job from media, and New job from CSV.
- **FR-023**: The overview's Getting started list MUST keep using the Checklist component.
- **FR-024**: The prerequisite content (titles, descriptions, statuses, actions, the "Before you can generate" title,
  and the rule that only owners see server setting names and setup-guide links) MUST NOT change; SetupNotice only
  changes how it is presented.
- **FR-025**: SetupNotice MUST be usable from server-rendered pages and work without client scripting.
- **FR-026**: `docs/design-system.md` §7 MUST gain a SetupNotice row (props, when to use it, that it is an
  EmptyState variant for prerequisite gates) and the Checklist row MUST stop saying it is used for prerequisite
  lists.
- **FR-027**: The docket-ui skill MUST say prerequisite gates use SetupNotice. If the phase cannot write the skill
  file, the exact owed edit MUST be recorded in `docs/decisions.md`, as entries 2 and 3 did.

**Calendar link after a first post (C3)**

- **FR-030**: When a Schedule, Add to queue or Publish now action from the Composer succeeds for at least one account,
  and the project had no post that counts toward the overview's first-post step before that action (scheduled,
  publishing, published or partially failed), the success dialog MUST show a "See it on the calendar" link.
- **FR-031**: The first-post rule MUST be the same rule the overview's "Write and schedule your first post" step
  uses, so the link appears exactly when that step turns done.
- **FR-032**: The link MUST open the calendar at the period containing the post's earliest assigned time on the
  calendar, in the project's time zone (today's period for Publish now).
- **FR-033**: The link MUST NOT appear when every account in the attempt failed, or when the project already had such
  a post.
- **FR-034**: The link MUST be shown to every role that can schedule or publish (owners, admins and editors).
- **FR-035**: The link MUST use the existing button or link styles with a visible focus ring and be reachable by
  keyboard from the dialog; the dialog's existing outcome rows, live-region behaviour and Close action stay as they
  are.
- **FR-036**: Working out whether this is the first post MUST be read-only and MUST NOT change any action's result,
  error or side effect.

**Getting-started page (C4)**

- **FR-040**: A `docs/getting-started.md` page MUST be added to the docs site, in the site nav (near the top of
  "Using Docket" or as its own top-level item), and to the app's registry of doc pages.
- **FR-041**: The page MUST describe a project in the order a newcomer needs: connect an account; add posting slots
  (what they are, and that Add to queue needs them while Schedule and Publish now don't); write a post and schedule,
  queue or publish it, then see it on the calendar.
- **FR-042**: It MUST then cover the optional steps: a brand voice profile, generating posts and approving them in
  Review; uploading images and videos to Media (and which platforms need media); and inviting teammates.
- **FR-043**: It MUST explain the three roles in the same words the app uses since entry 3 (owner, admin, editor),
  including that editors can't connect accounts or manage posting slots or the brand voice.
- **FR-044**: It MUST say where to look afterwards: Calendar, Posts, Review, Failures, Activity, and the notifications
  bell for problems.
- **FR-045**: It MUST NOT contain server commands or environment variable names; server setup is a short pointer to
  the deployment guide for whoever runs the server.
- **FR-046**: The overview's Getting started card MUST link to the page ("Read the getting-started guide") for every
  role, in both its full and collapsed forms. The link opens the published docs page and is styled like the card's
  other doc links.
- **FR-047**: The docs site MUST still build in strict mode, and the published-docs check (every doc link names a
  page in the nav and an existing heading) MUST pass.

**Accessibility (C5)**

- **FR-050**: The project switcher button's accessible name MUST be the current project's name only; the visible
  "Ctrl/⌘ K" hint MUST be hidden from assistive technology.
- **FR-051**: The switcher button MUST expose its keyboard shortcuts as Control+K and Meta+K through the standard
  shortcut property.
- **FR-052**: The switcher's look, its visible shortcut hint (from the `sm` breakpoint), the dialog and the shortcut
  itself MUST NOT change.
- **FR-053**: On the first-run setup form, the password input MUST be described by its "12–128 characters" hint at
  all times, and by its error as well when one is shown.
- **FR-054**: The hint MUST stay visible while an error is shown.
- **FR-055**: The setup form's other fields, labels, autocomplete values and submit behaviour MUST NOT change. Using
  the shared field component (as signup already does) is acceptable if it keeps them.

**Repo health and scope**

- **FR-060**: The pinned nav labels and order in `tests/integration/failures/nav.test.ts` ("Review (3)",
  ">Failures<", Review directly above Failures) MUST still pass unchanged.
- **FR-061**: No new shared component other than SetupNotice MUST be added; everything else uses the existing
  primitives (PageHeader, Card, EmptyState, Badge, StatusBadge, ProviderIcon, LocalTime, Skeleton, Alert,
  buttonStyles, Checklist).
- **FR-062**: The entry MUST state, in `docs/decisions.md`, what it does not do (see "Not included") and that no later
  roadmap entry owns those items.
- **FR-063**: Any screen this entry changes MUST still work at 390 px width with full keyboard use and visible focus.

### Key Entities

- **Account card section**: one of status, posting slots, posting instructions, remove; fixed order; visibility per
  role.
- **Connect outcome**: the accounts saved by a successful connect, each new or reconnected/refreshed, in the order
  listed; decides where the page lands and what is announced. Not stored.
- **Prerequisite item**: the existing per-viewer item from entry 2 (title, explanation, status, optional action or
  blocked reason). Unchanged; SetupNotice renders a list of them.
- **First-post fact**: whether the project had any post counting toward the first-post step before an action. Read,
  never stored.
- **Doc page**: a published docs page the app can link to; gains "getting-started".

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On every account card, for owners and editors, the posting-slot section is the first section after the
  account's status, in 100% of rendered cards.
- **SC-002**: After connecting a new account by any of the three routes, an owner can add the first posting slot
  with zero scrolling and zero clicks to reach the form (focus is already in it).
- **SC-003**: All four generation gates show every missing prerequisite in one SetupNotice on a single load, for both
  owners and editors, with no server setting names shown to editors.
- **SC-004**: The calendar link appears on exactly one success: the action that makes the project's first post
  scheduled or published; on 0 later successes.
- **SC-005**: Following the calendar link shows the newly scheduled or published post without further navigation.
- **SC-006**: The getting-started guide is reachable from the overview in one click for every role, the docs site
  builds in strict mode with it, and it contains 0 server commands and 0 environment variable names.
- **SC-007**: A newcomer can read the guide in under 5 minutes.
- **SC-008**: The switcher's accessible name contains no shortcut text, and the setup password input is described by
  its hint in 100% of form states (with and without an error).
- **SC-009**: The existing test suite, including the pinned nav tests and the connect callback tests, passes with no
  changes to their assertions except where a requirement above changes the asserted behaviour on purpose.

## Assumptions

- "First schedule or publish" includes Add to queue, since it schedules the post; the roadmap and audit name Schedule
  and Publish now, and the overview's first-post step counts a queued post as done. Only the Composer's dialogs show
  the link (also when it edits an existing draft at `/compose/{postId}`); Review, batch jobs, calendar drags and the
  public API don't.
- "The first control of the add-slot form" is the weekday choice; focusing it lets the owner pick a day and tab to
  the time and Add slot.
- Reconnects land on the card, not the slot editor, because a reconnected account usually already has slots and the
  person came to fix its status; the audit's "slot editor focused" is about the newly connected account.
- The confirmation message after connecting is visible as well as announced, so sighted keyboard users see why focus
  moved.
- The getting-started guide is for project members, so it is safe to link for editors; server operators already have
  the deployment, storage and platform setup guides.
- `mkdocs` is not installed in the pipeline sandbox and phases can't reach the package registry. The strict docs build
  is verified by the docs workflow on the pull request; locally, the published-docs test covers the app's links.
- Activity history and problem notifications need no new screens here: their existing links to `#account-{id}` land
  on a card that now shows status and reconnect first, and the guide points to Activity and the notifications bell.
  Video is covered by the guide's media step and by the calendar link applying to video posts too.
- The role-awareness rule needs no new owner/admin name lookups beyond what entry 2 already loads; the editor copy in
  SetupNotice comes from the existing prerequisite items.

## Not included

- **A dismissible checklist (audit C2).** It needs a stored per-user preference and its own decision. This is the
  last entry in the roadmap, so no later entry owns it; it stays a candidate for a future roadmap.
- Deep links from activity entries about accounts to the specific account card (they still go to the Accounts page).
- Moving focus into the slot editor for links other than the post-connect landing (the checklist, calendar and
  Compose slot links keep scrolling to the slot section as today).
- A calendar link after scheduling from Review, batch jobs, the calendar itself or the public API.
- Any change to the connect flow's data, permissions, activity entries or notifications, or to the callback's
  redirect targets.
- Any change to the overview checklist's steps, the Accounts page's connect section, or the prerequisite wording.
