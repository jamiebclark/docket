# Feature Specification: Empty states that name the next step, and role awareness

**Feature Branch**: `028-empty-states-roles`

**Created**: 2026-10-09

**Status**: Draft

**Input**: User description: "Entry 2 of 4 in the first-time project experience roadmap (`.specify/roadmaps/onboarding.md`): Empty states that name the next step, and role awareness. Audit recommendation M3 (`docs/research/onboarding-audit.md`) across Accounts (role-aware copy; connect section for managers only; unconfigured platforms collapsed for owners), Calendar (the empty state replaces the grid; 'add posting slots' when there are accounts but no slots), Compose (explain before the click that Add to queue needs posting slots, with a link), Posts, Failures and Review (empty states that name the next step), Generate and Jobs (every prerequisite at once; env var names to owners only), Media (hide the toolbar when the library is empty; say 'images and videos'), Voice (an empty state that names the next step), and the scheduler-health banner (editors get plain copy; owners get the commands). EmptyState actions use buttonStyles, not underline links. Not included: renamed nav labels and PageHeader descriptions (entry 3), the Accounts card restructure (entry 4)."

## Context

Entry 1 (`specs/027-project-overview`) gave the project a real home that says what to do next. But every other route
still behaves as the audit found on 2026-10-08. Empty pages say what's missing without saying what to do. Editors are
sent to pages where they can do nothing. Prerequisites show up one at a time, or only after a failed action. A red
banner of server commands is the loudest thing every member sees on a fresh install.

This entry fixes the empty and "not ready yet" states of each route. Each one names the next step, and shows it only
to someone who can take it. Everyone else is told who to ask, by display name.

### Audit citations re-checked against the current code (2026-10-09)

The audit predates the video roadmap's last entries and entry 1. Each line this entry relies on was re-checked:

| Audit claim | Current code | Effect on this spec |
|---|---|---|
| Accounts empty copy "Add one below…" (`accounts/page.tsx:111`) | Now `:100`. The page already has a `PageHeader`, and its "Add an account" header action is shown to managers only (`:78-89`) | Only the empty copy and the connect section change |
| Connect section shown when `groups.length > 0` (`:233`) | Now `:222`, `canManage \|\| groups.length > 0` | Gate on `canManage` alone |
| Unconfigured groups show a redirect box to everyone (`ConnectGroupSection.tsx:62-78`) | Now `:72-88`. Unconfigured is checked before `canManage`, so editors see the redirect address and setup link | Owners only, collapsed (FR-003) |
| Calendar: EmptyState above an empty grid; "Go to Accounts" for everyone (`calendar/page.tsx:105-115`) | Unchanged (`:105-115`). The calendar already loads the project's accounts, and its empty-slot placeholders only cover the shown period from now on | Needs a project-wide "any active slot" read (FR-011) |
| Compose: the queue CTA fails only after saving a draft (`Composer.tsx:425-437`) | The `ActionBar` is now at `:536-549`. The no-accounts empty state is at `:238-255`, with an underlined link and an editor message that names no one. Compose now has a `PageHeader` (`:305`). The compose page passes accounts without slot data (`compose/page.tsx:21-33`) | A per-account "has an active slot" flag, read only (FR-020) |
| Queue failure message (`queue/index.ts:63`) | Still `:63` and `:86`: "{name} has no active posting slots. Add or resume a slot first." | Unchanged. This entry warns before the click instead |
| Posts: 11 filter tabs at 0, underlined action (`posts/page.tsx:88,96-106`) | Now `:90` (tabs) and `:96-108` (empty state). The page also renders `ProblemsCallout` (problem notifications landed) | Hide the tabs while the project has no posts; keep the callout |
| Failures: "Every post that was due went out…" in an empty project (`failures/page.tsx:178-223`) | Now `:176-240`; the copy is at `:229` | Needs a "project has any posts" read (FR-031) |
| Review: "Nothing to review" with an underlined link (`review/page.tsx:36-44`) | Unchanged | FR-033 |
| Generate checks one gate at a time: LLM, voice, accounts (`generate/page.tsx:50-91`) | Now `:49-91`, same order. The LLM gate prints env var names to everyone (`:56`) | One prerequisite list (FR-040) |
| New job from media gates (`jobs/new/page.tsx` ~`:97-101`) | Now LLM at `:59-67` (env var names to everyone), selection at `:69-90`, voice-or-account at `:92-107` (one at a time). The CSV page (`jobs/new/csv/page.tsx`) has no gate at all | Both new-job pages get the list (FR-042) |
| Jobs header and duplicate actions; bespoke not-configured box (`jobs/page.tsx:42-65`) | Now `:42-51` (header actions, underlined links), `:59-63` (bespoke `rounded-md` box with env var names), `:65` (the same actions repeated) | FR-044–FR-046 |
| Media: "upload images here" (`media/page.tsx:74`); 6 controls above "No images yet" (`:77-128`); bespoke pill (`:103`) | Now `:74` (storage), `:77-107` (dropzone, search, tabs, pill), `:103` (pill), `:128` ("No images yet. Upload your first image above.") | FR-050–FR-053 |
| Voice: "Include archived" shown with no profiles (`voice/page.tsx:38-44`) | Now `:38-44`; the empty-state link at `:52` is underlined | FR-055–FR-056 |
| SchedulerHealth shows commands to everyone (`SchedulerHealth.tsx:64-87`, `layout.tsx:54`) | Now `SchedulerHealth.tsx:53-78`, rendered at `layout.tsx:54`. It takes no role | Pass whether the viewer is an owner (FR-060) |
| `ReauthBanner` already handles roles (`ReauthBanner.tsx:33-45`) | It does, but tells editors "Ask an owner or admin…" without names (`:45`) | Folded in: it names them (FR-063) |
| Editors can't manage accounts, slots or voice (`access.ts:50-59`) | Still true (`:50-59`). Editors can view slots, edit media, and edit, schedule and delete posts, and run generation | Editors keep Write a post, Upload, Generate |
| Members list open to editors | Still true. Entry 1 added a shared way to list owners and admins by display name and join them ("A, B and C") | Every "ask" message reuses it (FR-070) |

Features that landed after the audit and are folded in here:

- **Problem notifications.** `ProblemsCallout` stays where it is on Posts. This entry doesn't change it.
- **Activity history.** The Activity page already has role-neutral empty states with button-styled actions. It's
  unchanged.
- **Video.** Media copy says "images and videos". Copy about generation jobs from media keeps saying "images", because
  jobs only generate for images.
- **Project overview (entry 1).** This entry uses the same rules: the same owner-and-admin name list, the same docs
  links for server pieces, and the existing `Checklist` component for prerequisite lists.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An editor is never sent somewhere they can't act (Priority: P1)

An editor joins a project where nothing is set up. On each route, they either see an action they can take (write a
post, upload media, generate), or they're told which owners and admins to ask, by display name. They never see a
connect form, a slot action, a voice action, a server command or an environment variable name.

**Why this priority**: The roadmap makes role-awareness a rule for every entry. Today editors are told to "Add one
below", are sent to Accounts from Calendar, and see the scheduler's ops commands.

**Independent Test**: In a project owned by "Robin" with an admin "Sam", no accounts, no voice profile, no AI provider
and a scheduler that has never run, sign in as an editor. Open Accounts, Calendar, Compose, Posts, Failures, Review,
Generate, Jobs, New job, Media and Voice. On each page, check for the names "Robin" and "Sam" where the editor is told
who to ask, and check that no page contains a member email, an environment variable name, a command, or a manage-only
action.

**Acceptance Scenarios**:

1. **Given** an editor in a project with no accounts, **When** they open Accounts, **Then** it reads "No accounts yet.
   Ask Robin or Sam to connect one.", and there's no "Add an account" section, no connect button, no setup-guide link and
   no redirect address.
2. **Given** the same editor, **When** they open Calendar, **Then** the empty state replaces the toolbar and the grid,
   and reads "No accounts yet. Ask Robin or Sam to connect one." with no action.
3. **Given** the same editor, **When** they open Compose, **Then** it reads "No accounts are connected yet. Ask Robin or
   Sam to connect one." with no action.
4. **Given** the same editor, **When** they open Voice, **Then** it reads "No voice profile yet. Ask Robin or Sam to
   create one." There's no "New voice profile" action and no "Include archived" tab.
5. **Given** the scheduler has never run, **When** the editor opens any project page, **Then** the banner reads
   "Scheduled posts are not going out. Ask Robin to start the scheduler." (naming owners only, see FR-061), and contains
   no command, environment variable name or address.

---

### User Story 2 - An owner sees every prerequisite for generation at once (Priority: P1)

An owner opens Generate on a fresh install. Instead of fixing one gate, reloading, and finding the next, they see one
list of everything generation needs: AI generation set up on the server, a connected account, and a voice profile.
Each item shows whether it's done, and has one action. Owners also see the environment variable names and a link to
the setup guide. Nobody else does.

**Why this priority**: The audit rates this High. Prerequisites appear one at a time and in the wrong order.

**Independent Test**: With no AI provider configured, no accounts and no voice profile, open Generate as an owner, an
admin and an editor. Check that all three items are listed at once, in order, with the right copy and actions per role.

**Acceptance Scenarios**:

1. **Given** no AI provider, no accounts and no voice profile, **When** an owner opens Generate, **Then** one list shows,
   in this order: "Set up AI generation" (To do, naming the missing settings and linking to the generator setup guide),
   "Connect an account" (To do, "Connect an account"), and "Create a voice profile" (To do, "Create a voice profile").
   The generate form is not shown.
2. **Given** the same project, **When** an admin opens Generate, **Then** the same three items are listed. The AI item
   reads "Waiting on Robin" with no setting names. The account and voice items have their actions.
3. **Given** the same project, **When** an editor opens Generate, **Then** the AI item reads "Waiting on Robin", and the
   account and voice items read "Waiting on Robin and Sam". There are no actions and no setting names.
4. **Given** AI generation is configured and an account exists, but there's no voice profile, **When** an owner opens
   Generate, **Then** the list shows the AI and account items as "Done" and the voice item as "To do".
5. **Given** every prerequisite is met, **When** anyone opens Generate, **Then** no list is shown, and the generate
   form appears as today.
6. **Given** no AI provider, **When** anyone opens New job from media or New job from CSV, **Then** the same list is shown
   with the same role rules. New job from media also lists "Images to generate for" when the selection has none.

---

### User Story 3 - Add to queue explains itself before the click (Priority: P1)

Someone writing a post for an account with no active posting slots can see, before they click, that Add to queue needs
posting slots. Managers get a link to add them. Editors are told who to ask. Schedule and Publish now still work.

**Why this priority**: The audit rates this High. Today Add to queue is the magenta headline action, and it fails only
after saving a draft, with no link.

**Independent Test**: Connect one account with no slots. Open Compose as an owner and as an editor, select the account,
and check the action bar's message and the state of each button, without clicking anything.

**Acceptance Scenarios**:

1. **Given** an owner composing for one account that has no active posting slots, **When** the account is selected,
   **Then** before any click, the action bar reads "Add to queue needs posting slots. Add slots in Accounts", with
   "Add slots in Accounts" as a link to that account's slot section. Add to queue is disabled and described by that
   message. Schedule… becomes the headline action.
2. **Given** an editor in the same situation, **When** the account is selected, **Then** the message reads "Add to queue
   needs posting slots. Ask Robin or Sam to add some.", with no link.
3. **Given** two selected accounts, one with active slots and one without, **When** the composer renders, **Then** Add
   to queue stays enabled and the headline action. A note names the account without slots: "Beta has no posting slots,
   so Add to queue can't place it."
4. **Given** every selected account has an active slot, **When** the composer renders, **Then** no slot message is
   shown, and the buttons behave as today.
5. **Given** an account whose slots are all paused, **When** it's the only one selected, **Then** it's treated as having
   no active slots (scenario 1 applies).

---

### User Story 4 - Accounts and Calendar for a new owner (Priority: P2)

A new owner opens Accounts and sees the platforms they can connect now at the top. Platforms not set up on this server
are folded into one collapsed "Not set up on this server (n)" section with setup-guide links, instead of a wall of
setup cards. On Calendar, an owner with no accounts sees one empty state with "Connect an account" instead of a toolbar
and an empty grid. Once there's an account but no slots, the calendar says to add posting slots.

**Why this priority**: These are the first two routes a new owner opens after the overview. Both are rated Medium in
the audit.

**Independent Test**: On a server where Bluesky and the mock are available and the OAuth platform groups aren't configured, open
Accounts and Calendar as an owner in an empty project. Then connect an account and open Calendar again.

**Acceptance Scenarios**:

1. **Given** an owner in a project with no accounts, **When** they open Accounts, **Then** it reads "You don't have any
   accounts yet. Connect one below to start scheduling posts." The connect options for configured platforms come first.
   The unconfigured platforms are inside one closed disclosure titled "Not set up on this server ({n})" ({n} is the number of unconfigured platform groups), each with its
   setup-guide link and redirect address.
2. **Given** an admin in the same project, **When** they open Accounts, **Then** they see the configured connect options,
   and no "Not set up on this server" section.
3. **Given** an owner in a project with no accounts, **When** they open Calendar, **Then** the toolbar and grid are
   replaced by "No accounts yet. Connect an account to see posts and open posting slots here." with "Connect an
   account" styled as a button.
4. **Given** a project with one account and no active slots, and no posts in the shown period, **When** an owner opens
   Calendar, **Then** the toolbar stays, the grid is replaced by "Add posting slots to see open times here.", and the
   action "Add posting slots" goes to that account's slot section.
5. **Given** the same project, **When** an editor opens Calendar, **Then** it reads "No posting slots yet. Ask Robin or
   Sam to add some." with no action.

---

### User Story 5 - Posts, Failures and Review in an empty project (Priority: P2)

A newcomer opening Posts, Failures or Review in a new project learns what each page is for and what to do next,
without a row of zero-count tabs.

**Why this priority**: The audit rates these Medium. Failures' copy is misleading in a project with no posts, and Review
doesn't say what it's for.

**Independent Test**: In a project with no posts, open Posts, Failures and Review as an owner and as an editor. Then add
one draft and check that Posts shows its tabs again.

**Acceptance Scenarios**:

1. **Given** a project with no posts at all, **When** anyone who can write posts opens Posts, **Then** no filter tabs are
   shown, and the empty state reads "No posts yet. Write your first post to see it here." with "Write a post" styled as
   a button.
2. **Given** the project has one draft, **When** anyone opens Posts with a status filter that matches nothing, **Then**
   the tabs are shown and the empty state reads "No posts match this filter." with "Show all posts" styled as a button.
3. **Given** a project with no posts at all, **When** anyone opens Failures, **Then** the counts line, tabs, account
   filter and Retry all are hidden, and it reads "Posts that fail to publish will show up here." with "Write a post".
4. **Given** a project with published posts and nothing failed, **When** anyone opens Failures, **Then** it keeps today's
   "Nothing needs attention. Every post that was due went out or is still scheduled." with "View posts" as a button.
5. **Given** AI generation, an account and a voice profile all exist and the review queue is empty, **When** anyone opens
   Review, **Then** it reads "Generated posts wait here for approval before they're scheduled. Posts you write yourself
   don't come here." with "Generate a post".
6. **Given** the review queue is empty and generation isn't ready, **When** anyone opens Review, **Then** it reads the
   same explanation, and the action goes to Generate, where the full prerequisite list is shown (FR-033).

---

### User Story 6 - Media, Voice and Jobs show one clear next step (Priority: P3)

An empty media library shows the dropzone and one sentence, not six controls. Voice shows no archive tab when there's
nothing to archive. Jobs has one primary action in its header, and no duplicate links in its empty state.

**Why this priority**: These pages are optional to publishing. The fixes are small, but they remove clutter that hides
the next step.

**Independent Test**: With storage and AI configured, open Media, Voice and Jobs in an empty project as an owner and as
an editor.

**Acceptance Scenarios**:

1. **Given** storage is configured and the library is empty with no filter set, **When** an editor opens Media, **Then**
   only the upload dropzone and "No images or videos yet. Upload your first one above." are shown. There's no search,
   no filter tabs, and no "No unused images" note.
2. **Given** storage is not configured, **When** an owner opens Media, **Then** it reads "Media storage is not set up, so
   images and videos can't be uploaded yet." with "Set up storage" linking to the storage guide. An editor or admin sees
   the same first sentence, then "Ask Robin to set it up.", with no link.
3. **Given** the library has items but none is unused, **When** someone who can generate opens Media, **Then** "No
   unused images to generate for" is shown as an info alert instead of a bespoke pill.
4. **Given** a project with no voice profiles, archived or not, **When** an owner opens Voice, **Then** there's no
   "Active / Include archived" tab row, and the empty state reads "No voice profile yet. Create one so generated posts
   sound like you." with "Create a voice profile" styled as a button.
5. **Given** a project with only archived voice profiles, **When** an owner opens Voice, **Then** the tab row is shown,
   so the archived profiles stay reachable.
6. **Given** generation is ready and there are no jobs, **When** an owner opens Jobs, **Then** the header has one primary
   action, "New job from CSV", and a secondary "Choose images in Media". The empty state reads "No generation jobs yet.
   Start one from a CSV file, or choose images in Media." with no actions of its own.
7. **Given** AI generation isn't configured, **When** anyone opens Jobs, **Then** the bespoke box is replaced by the
   prerequisite list (FR-040), and the header's new-job actions are hidden.

### Edge Cases

- **No owners or admins have a display name.** Display names are required, so this shouldn't happen. If none remain,
  the copy reads "an owner or admin" (or "an owner"), using the overview's name rule. An email is never used instead.
- **Many managers.** Names join as "A", "A or B", "A, B or C", then "A, B, C or n others", the same as the overview.
- **The viewer is the only owner.** Owners never see an "ask" message, because they can act on everything this entry
  covers.
- **An admin and a server-level gap.** Admins can manage accounts, slots and voice, so they get those actions. For server
  pieces (scheduler, AI generation, storage, platform apps), they're told which owners to ask, like editors (FR-061).
- **Account from an unregistered provider** (`providerAvailable` false). It counts as an account for "no accounts"
  states. Its slots don't count as active for Compose's slot hint or Calendar's slot state.
- **All slots paused.** These count as "no active slots" everywhere in this entry. The copy still says "posting slots".
  The slot section on Accounts shows them as Paused, so the owner can resume one there.
- **Slot data can't be read on Compose.** The hint is left out, and Add to queue behaves as today. The server's own
  check still catches the case after the click. A failed read never disables the action.
- **Filtered views.** Posts, Failures and Media keep their filter controls whenever a filter is set, even when nothing
  matches, so the filter can be cleared. Only the unfiltered, truly empty state hides them.
- **Calendar with slots but nothing in the shown period** (for example, a past week). The toolbar stays, and the empty
  state reads "No posts or open posting slots in this period." with "Today" styled as a button. There's no Accounts link.
- **Calendar with no active slots but posts in the period.** The grid is shown with its posts. One line above it reads
  "Add posting slots to see open times here." (managers get the link; editors get who to ask).
- **Review for a viewer who can't generate.** Every role can run generation today. If that changes, the action is left
  out, and the explanation stays.
- **Narrow screens.** At 390 px nothing scrolls sideways, and the collapsed "Not set up on this server" section and
  prerequisite lists stack in one column.
- **The scheduler recovers.** The banner disappears for everyone, as today. Nothing is stored.

## Requirements *(mandatory)*

### Functional Requirements

#### Accounts

- **FR-001**: With no accounts, Accounts MUST read "You don't have any accounts yet. Connect one below to start
  scheduling posts." for viewers who can manage accounts. For everyone else, it MUST read "No accounts yet. Ask {names}
  to connect one." (FR-070), with no action.
- **FR-002**: The "Add an account" section (connect options, credential forms, mock form) MUST be shown only to viewers
  who can manage accounts. Editors MUST NOT see a connect button, a token field, a setup-guide link or a redirect
  address anywhere on the page.
- **FR-003**: Platforms that aren't configured on this server MUST be shown to owners only. They're grouped into one
  native disclosure, closed by default, titled "Not set up on this server ({n})". Each platform inside keeps its
  setup-guide link and redirect address. Admins MUST NOT see this disclosure.
- **FR-004**: Configured platforms' connect options MUST come before the disclosure, and before credential and mock
  forms.
- **FR-005**: A configured platform whose callback address doesn't qualify ("unavailable") keeps today's behaviour for
  managers. Editors don't see it, since they don't see the section (FR-002).
- **FR-006**: The existing "Add an account" header action and the connected account cards MUST NOT change (the card
  restructure is entry 4's).

#### Calendar

- **FR-010**: With no accounts, Calendar MUST replace its toolbar (Previous, Today, Next, Month/Week, Account) and its
  grid with one empty state. The project title and time zone stay. Managers see "No accounts yet. Connect an account to
  see posts and open posting slots here." with "Connect an account". Others see "No accounts yet. Ask {names} to
  connect one."
- **FR-011**: With accounts but no active slot on any of them, and nothing in the shown period, Calendar MUST keep its
  toolbar and replace the grid with an empty state. Managers see "Add posting slots to see open times here." with "Add
  posting slots", linking to the slot section of the first account without an active slot. Others see "No posting
  slots yet. Ask {names} to add some."
- **FR-012**: With accounts but no active slot, and posts in the shown period, the grid MUST show as today, with the
  FR-011 sentence above it as a single line (its link for managers, or who to ask for others).
- **FR-013**: With at least one active slot and nothing in the shown period, Calendar MUST keep its toolbar and replace
  the grid with "No posts or open posting slots in this period." and a "Today" action. It MUST NOT link to Accounts.
- **FR-014**: Whether any active slot exists MUST be read through existing services, under the project's scoped access.
  A per-account loop is acceptable, as on Accounts and the overview.

#### Compose

- **FR-020**: The compose page MUST tell the composer, for each account, whether it has at least one active slot. This
  is a read only. No server action, queue rule or result shape changes.
- **FR-021**: When at least one account is selected and none of the selected accounts has an active slot, the action
  bar MUST show, before any click:
  - for viewers who can manage slots: "Add to queue needs posting slots. Add slots in Accounts", where "Add slots in
    Accounts" links to the slot section of the first selected account without an active slot;
  - for others: "Add to queue needs posting slots. Ask {names} to add some."
- **FR-022**: In the FR-021 case, Add to queue MUST be disabled and described by that message. Schedule… MUST become the
  one headline action, and Add to queue drops to a secondary button. Publish now and Save draft are unchanged.
- **FR-023**: When some, but not all, selected accounts lack an active slot, Add to queue MUST stay enabled and remain
  the headline action. A note in the action bar names the accounts without slots ("{names} has/have no posting slots,
  so Add to queue can't place it/them.").
- **FR-024**: An existing blocking reason (no account selected, checking, errors, waiting for review, published, or no
  permission to schedule) MUST still take priority, and disable every scheduling button as today. The slot message
  doesn't replace it.
- **FR-025**: The no-accounts empty state MUST keep its manager copy and use a button-styled "Connect an account"
  action. The editor copy MUST become "No accounts are connected yet. Ask {names} to connect one."
- **FR-026**: The same rules apply when editing an existing post (`compose/{postId}`).

#### Posts

- **FR-030**: When the project has no posts at all and no status filter is set, Posts MUST hide its filter tabs. The empty
  state MUST read "No posts yet. Write your first post to see it here." with a button-styled "Write a post" for viewers
  who can write posts. The "New post" header action and the problems callout are unchanged.
- **FR-031**: With a status filter set, or once any post exists, the tabs MUST show as today. A filter that matches nothing
  reads "No posts match this filter." with a button-styled "Show all posts".

#### Failures

- **FR-032**: When the project has no posts at all, Failures MUST hide its counts line, tabs, account filter and Retry all,
  and read "Posts that fail to publish will show up here." with a button-styled "Write a post" for viewers who can write
  posts. When posts exist and nothing needs attention, it keeps today's copy, with "View posts" button-styled. A
  filtered empty view keeps "No posts match this filter." with a button-styled "Clear filters".

#### Review

- **FR-033**: When the review queue is empty, Review MUST read "Generated posts wait here for approval before they're
  scheduled. Posts you write yourself don't come here." The action, button-styled, is "Generate a post", linking to
  Generate. When a generation prerequisite is missing (FR-040), the action is still "Generate a post": Generate then
  shows every missing piece at once with role-aware actions. This means Review never sends an editor to Voice or
  Accounts.

#### Generate and Jobs: prerequisites

- **FR-040**: Generate MUST check every prerequisite at once, and when any is missing, show one ordered list in place of
  the form:
  1. **Set up AI generation** (server);
  2. **Connect an account**;
  3. **Create a voice profile** (at least one non-archived profile).
  Each item shows its status as text ("Done", "To do", or "Waiting on {names}") and at most one action. The list uses
  the existing `Checklist` component. The generation mode tabs stay above it.
- **FR-041**: Role rules for the list:
  - **AI generation**: owners see the missing setting names (from the server's own configuration check), and a link to
    the generator guide's "Configuring a provider" section. Admins and editors see "Waiting on {owner names}", with no
    setting names and no link.
  - **Account**: managers get "Connect an account" (to Accounts). Editors get "Waiting on {names}".
  - **Voice profile**: viewers who can manage voice get "Create a voice profile" (to the new-profile page). Editors get
    "Waiting on {names}".
- **FR-042**: New job from media and New job from CSV MUST show the same list, with the same role rules, whenever a
  prerequisite is missing. New job from media adds a fourth item, "Images to generate for", when the selection has no
  usable images. It's never "Waiting on": every role that can run jobs can upload. Its action is "Back to Media". The
  existing messages for an unusable selection are kept.
- **FR-043**: The prerequisite list MUST NOT print environment variable names, commands or setting values for anyone
  except owners. No secret values are ever shown.

#### Jobs list

- **FR-044**: The Jobs header MUST have one primary action, "New job from CSV", and a secondary "Choose images in Media"
  (linking to Media), shown when storage is configured. Both are shown only to viewers who can run generation, and only
  when the FR-040 prerequisites are met.
- **FR-045**: The Jobs empty state MUST read "No generation jobs yet. Start one from a CSV file, or choose images in
  Media." with no actions of its own (the header already has them). Without storage, "or choose images in Media" is
  left out.
- **FR-046**: When a prerequisite is missing, the bespoke not-configured box MUST be replaced by the FR-040 list, built
  from existing primitives, with the same role rules. Existing jobs stay listed below it.

#### Media

- **FR-050**: When storage is configured, the library is empty, and no filter or search is set, Media MUST show only the
  upload dropzone (for viewers who can edit media) and the empty state "No images or videos yet. Upload your first one
  above.". The search form, filter tabs and generate controls are hidden. A viewer who can't edit media gets "No images
  or videos yet." with no reference to the dropzone.
- **FR-051**: When storage isn't configured, Media MUST read "Media storage is not set up, so images and videos can't be
  uploaded yet." Owners also get a button-styled "Set up storage" linking to the storage guide. Everyone else gets "Ask
  {owner names} to set it up.", with no link.
- **FR-052**: The "No unused images to generate for" note MUST use the shared info alert instead of the bespoke pill. Its
  text is unchanged.
- **FR-053**: A filtered view with no matches MUST keep its controls, and read "No images or videos match these
  filters."

#### Voice

- **FR-055**: Voice MUST hide its "Active / Include archived" tabs when the project has no voice profiles at all,
  archived ones included. It shows them as soon as any profile exists.
- **FR-056**: The Voice empty state MUST keep its manager copy, with a button-styled "Create a voice profile". The editor
  copy MUST become "No voice profile yet. Ask {names} to create one."

#### Scheduler-health and reauth banners

- **FR-060**: The project layout MUST tell the scheduler-health banner whether the viewer is an owner. The stale and
  never-run states keep their headline sentence for everyone, in the same danger banner. Owners keep today's three
  remedies (with their commands and setting names) and get a link to the deployment guide's "Is the scheduler running?"
  section.
- **FR-061**: Admins and editors MUST see "Scheduled posts are not going out. Ask {owner names} to start the scheduler."
  in place of the remedies, with no command, setting name, address or link. Server pieces are named as the owners'
  job, because only owners are shown how to fix them (see Assumptions).
- **FR-062**: The quiet header indicator is unchanged.
- **FR-063**: The reauth banner's editor line MUST name the managers: "Ask {names} to reconnect it/them." Owners' and
  admins' reconnect links are unchanged.

#### Shared rules

- **FR-070**: Every "ask" message in this entry MUST use the display names of the people who can act, joined with "or"
  (the overview's rule: "A", "A or B", "A, B or C", "A, B, C or n others"). Project-level items (accounts, slots, voice)
  name owners and admins. Server-level items (scheduler, AI generation, storage, platform apps) name owners only.
  "Waiting on {names}" statuses in prerequisite lists join with "and", as the overview's checklist does. A blank name is
  left out. When none remain, the copy says "an owner or admin" (or "an owner"). No email is ever shown or
  used to make a name.
- **FR-071**: Every empty-state action on the routes this entry touches MUST be styled with the shared button styles
  (secondary, or primary when it's the page's only next step), with a visible focus ring. None is an underlined text
  link. This covers Accounts, Calendar, Compose, Posts, Failures, Review, Generate, Jobs, both New job pages, Media and
  Voice.
- **FR-072**: No page in this entry MUST show an editor an action they can't take: connecting, reconnecting, slot
  management, voice-profile creation, or server setup.
- **FR-073**: Every role check MUST use the same permission rules the server enforces. This entry changes no access rule,
  server action or stored data.
- **FR-074**: The UI MUST be built from existing primitives (PageHeader, Card, EmptyState, Badge, StatusBadge,
  ProviderIcon, LocalTime, Skeleton, Alert, buttonStyles, Icon, and entry 1's Checklist). No new shared component is
  added. The SetupNotice variant is entry 4's (audit C1).
- **FR-075**: The pinned nav labels and order MUST be unchanged: "Review (3)", ">Failures<", Review directly above
  Failures, and Activity directly after Failures. The Generate policy test's ordering assertion (the policy note before
  "Brief") MUST still pass.

#### Tests

- **FR-080**: For every route touched, there MUST be a test of its empty or not-ready state as an owner and as an
  editor. Each asserts the next-step action (owner) or the named owners and admins (editor), and asserts the editor's
  page contains no environment variable name, no command and no member email.
- **FR-081**: Compose MUST have a test showing the slot hint and the disabled Add to queue before any click, for both
  roles. It also covers the mixed-accounts note and the case with no hint.
- **FR-082**: Generate, New job from media, New job from CSV and Jobs MUST each have a test that lists every missing
  prerequisite at once (all three missing), and one that shows a partial set as Done and To do.
- **FR-083**: The scheduler-health banner MUST have tests by role: owner (remedies and docs link), admin and editor
  (plain copy naming owners, and no command or setting name). This covers both the stale and the never-run states.
- **FR-084**: Existing tests that pin copy this entry replaces MUST be updated to the new copy in the same change, not
  deleted. The affected tests are the scheduler-health remedies for editors, Failures' empty copy, Review's "Nothing to
  review", the Generate LLM gate, "Ask an owner or admin" in Generate, Voice and the reauth banner, the Accounts
  "not configured on this server" assertion, and the Jobs empty-state links. Every other existing test MUST pass
  unchanged.

#### Docs

- **FR-090**: `docs/design-system.md` MUST record:
  - in §7 or §8: empty-state actions are always button-styled; and an unfiltered empty list hides its filter controls;
  - that prerequisite lists reuse `Checklist`;
  - that "ask" copy names people by display name, following FR-070.
  The docket-ui skill's "States" section MUST say the same in one line.
- **FR-091**: Judgement calls MUST be appended to `docs/decisions.md`:
  - server pieces name owners only, and admins don't see commands;
  - Add to queue disabled versus hidden, and Schedule… as the headline action when no slots;
  - the mixed-accounts note;
  - Review linking to Generate rather than to Voice or Accounts;
  - which tests' pinned copy was updated.

### Key Entities *(no new stored data)*

- **Viewer capability**: the viewer's role and what it can do (manage accounts, slots, voice; run generation; edit
  media; write and schedule posts), and whether they're an owner. It's derived from the existing permission rules.
- **People to ask**: the display names of the project's owners and admins (or owners only, for server pieces),
  ordered owners first. They're read from the members list and never stored.
- **Account slot state**: for each account, whether it has at least one active (unpaused) posting slot. It's read on
  each request.
- **Generation prerequisite**: AI generation configured, an account, a voice profile, and (for media jobs) usable
  images. Each has a status (done, to do, or waiting on named people) and at most one action. It isn't stored.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On every route this entry touches, an owner in an empty project can reach the page where the next
  required step is done in 1 click from that route's empty state.
- **SC-002**: Across all 12 touched surfaces rendered for an editor in an empty project (Accounts, Calendar, Compose,
  Posts, Failures, Review, Generate, Jobs, New job from media, New job from CSV, Media, Voice) plus the scheduler
  banner, there are 0 environment variable names, 0 commands, 0 member emails, and 0 actions the editor's role can't
  perform.
- **SC-003**: Generate and the job pages show every missing prerequisite on the first load. 1 page view instead of up to
  3 reload cycles.
- **SC-004**: With an account that has no active slots, the reason Add to queue can't be used is visible before any
  click, and no draft is saved by trying it.
- **SC-005**: An empty Posts page shows 0 filter tabs (down from 11). An empty Media library shows 1 control (the
  dropzone) above its empty state (down from 6).
- **SC-006**: 100% of empty-state actions on the touched routes are button-styled with a visible focus ring.
- **SC-007**: Every touched route has a tested empty state for both an owner and an editor. The pinned nav tests and the
  Generate policy ordering test pass unchanged.
- **SC-008**: No touched page scrolls sideways at a 390 px viewport.

## Not included in this entry

- **Renamed nav labels** ("Brand voice", "Batch jobs"), nav grouping and order: entry 3 (S1, S2). This entry uses
  today's labels ("Voice", "Jobs").
- **PageHeader descriptions on every route, and adopting PageHeader where it's missing** (Posts, Calendar, Review,
  Voice, Jobs, Media, Generate, Failures): entry 3 (S2). Existing headings are left as they are.
- **Defining "posting slot" by the slot editor, readable target statuses, "Targets" → "Accounts", role descriptions and
  voice-editor hints**: entry 3 (S2).
- **The Accounts card restructure** (status → slots → instructions → remove), landing on the slot editor after
  connecting, the SetupNotice variant, linking to the calendar after a first post, and `docs/getting-started.md`: entry 4
  (S3, C1, C3, C4, C5).
- **Changing the queue's own failure message or any server action**: no entry owns this. This entry only warns before
  the click.
- **Copy about generation jobs from media** ("images" in New job and the Media generate buttons): no entry owns this.
  Jobs only generate for images today.
- **The overview** is entry 1's and is unchanged.

## Assumptions

- **Server pieces name owners only.** The request says env var names go "to owners only", and the banner's commands
  go to owners. Entry 1 also kept the server-setup row for owners. Admins therefore don't get commands or setting
  names, so pointing an editor to an admin for server setup would send them to someone who isn't shown how to fix it.
  Project-level items (accounts, slots, voice) still name owners and admins, as the roadmap's rule says.
- **Disabling Add to queue is acceptable.** The audit asks for a message before the click, and to "consider" making
  Schedule… the headline action. Disabling it when no selected account can be queued stops a draft from being saved
  only to show an error. This is a UI read, not an action change.
- **Review links to Generate.** The audit says to link to Voice or Accounts when a prerequisite is missing. Because
  Generate now shows every prerequisite at once with role-aware actions, linking there gives one consistent next step,
  and never sends an editor to a page where they can't act.
- **Calendar's slot read.** The calendar's existing empty-slot placeholders only cover the shown period from now on, so
  "no slots" needs its own project-wide read. A per-account loop through the existing slot service is fine for v1, as
  the audit allows.
- **Failures and Posts' "no posts at all" read** uses the existing post counts, which Posts already loads.
- **Copy.** Strings quoted here are the target copy. Where the audit gives copy, it's used as is or lightly normalised
  (full stops, sentence case, "or" for "ask" lists).
- **Docs links** use the existing published-docs helper and pages (deployment, generator, storage, and each platform's
  setup guide). No new docs page is written.
- **No JavaScript needed** to read any empty state, and the "Not set up on this server" disclosure is native. The
  composer's slot hint is part of the existing client composer.
