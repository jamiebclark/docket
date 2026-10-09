# Feature Specification: Project overview and getting started

**Feature Branch**: `027-project-overview`

**Created**: 2026-10-09

**Status**: Draft

**Input**: User description: "Entry 1 of 4 in the first-time project experience roadmap (`.specify/roadmaps/onboarding.md`): Project overview and getting started. Covers audit recommendations M1 and M2 (`docs/research/onboarding-audit.md`) and adds an Overview nav entry. Replace the bare project home with a PageHeader (project name, time zone, the viewer's role, one primary action), a self-deriving Getting started checklist (connect an account, add posting slots, write and schedule a first post; optional voice profile, media, invite a teammate; an owner-only server-setup row that links to the docs; collapses to 'Setup complete' once the required steps are done; no stored dismissal), sections Needs attention, Coming up, Accounts, Posts by status and Content tools (each with a populated view and an empty state whose action is the next dependent step), a skeleton loading state, the tab title set to the project name, and Overview as the first nav item with an exact-match active state."

## Context

A newcomer who opened a Docket project was "instantly confused — option overload". Today the project home
(`src/app/p/[projectSlug]/page.tsx:13-23`) shows the "Problems since you last looked" callout, the project name as a
bare heading, and "Pick a section from the navigation to get started.", beside 12 equal-weight nav items
(`src/components/shell/LeftNav.tsx:10-23`; Activity landed after the audit). Accounts, the required first step, is 11th.
The tab title is the slug (`page.tsx:8-11`), and the loading state is a "Loading…" line (`loading.tsx:1-7`).

This entry turns the home into the place that says what to do next and what needs attention.

### Audit citations re-checked against the current code (2026-10-09)

The audit was written on 2026-10-08, before the video roadmap finished. Each citation this entry relies on was
re-checked:

| Audit claim | Current code | Effect on this spec |
|---|---|---|
| Home is a bare `h1` and "Pick a section…" (`page.tsx:16-19`) | Still true, now at `:17-21`, and the page also renders `ProblemsCallout` (problem notifications landed) | Keep the callout at the top of the overview |
| Tab title is the slug (`:9`) | Still true (`:10`); the root title template is "%s · Docket" | Title becomes "{project name} · Docket" |
| `loading.tsx` is a text line | Still true | Settings has no `loading.tsx` of its own and uses this one (see FR-047) |
| `NAV_SECTIONS` at `LeftNav.tsx:10`, prefix match at `:58-59` | Now `:10-23` with Activity added under Publish; prefix match at `:59-60` | Overview needs a special-cased href and exact match |
| Review and Failures counts loaded in `layout.tsx:38-39` | Still true | Reuse the same counts |
| `listAccountsNeedingReauth` | `src/server/services/accounts.ts:413` | Feeds Needs attention |
| `AccountView.credentialsExpireAt` (`accounts.ts:31`) | Still `:31`; not shown anywhere in the app today | Feeds Needs attention and the Accounts section |
| `list.counts` (`posts/list.ts:31,68`) | Now `:32` (type) and `:76` (value); counts every post status plus `needs_decision` | Feeds Posts by status and the failed count |
| Not checked: sort order of `scope.posts.list` | Checked: soonest next-scheduled time first, then newest (`src/server/dal/posts.ts:111`) | `listPosts({ status: "scheduled" })` already gives Coming up in the right order |
| `getLlmStatus`, `media.mediaStatus` | `src/server/llm/index.ts:20`, `src/server/services/media.ts:104` | Gate the voice and media rows |
| Editors can't manage accounts, slots or voice (`access.ts:50-59`) | Still true; editors also can't view or create invitations | Editors don't get the invite step (FR-022) |
| Members list open to editors (`member: ["view"]`) | Still true; `MemberRow` has a `name` (display name) and an `email` | Name owners and admins by `name` only |
| No project-wide slot count; `accounts/page.tsx:85` loops `slots.listSlots` per account | Still true | Loop per account, as the audit allows for v1 |
| Server-setup docs: `docsUrl("deployment")`, `"storage"`, `"meta-setup"` | `src/lib/docs.ts` also has `generator`, `x-setup`, `tiktok-setup`; each connect group carries its own `setupDoc` | Link each missing item to its own page (FR-027) |

Features that landed after the audit and are folded in here: **problem notifications** (the callout stays at the top),
**activity history** (Needs attention links to the Activity page), and **video** (media counts and copy say "images
and videos").

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A new owner knows what to do first (Priority: P1)

An owner creates a project and lands on its home. Instead of a heading and "pick a section", they see the project
name, its time zone, their role and one primary action, "Connect an account". Below it, a Getting started checklist
lists the steps in the order they need them, and which ones are done. Each step has one action that takes them where
the step is done.

**Why this priority**: This is the audit's main finding. Without it, a new project has nothing to act on.

**Independent Test**: Create a project as an owner and open its home. Check the header copy, the primary action and
the checklist. Then connect an account, add a slot and schedule a post, and check that each step turns to "Done"
without anything being stored or dismissed.

**Acceptance Scenarios**:

1. **Given** an owner of a new project with no accounts, **When** they open the project home, **Then** the page heading
   is the project name, the description reads "Times in {time zone}. You're an Owner.", and the one primary action is
   "Connect an account", linking to Accounts.
2. **Given** the same project, **When** the home loads, **Then** the Getting started checklist appears first, above
   every other section, with "Connect an account" as "To do", and "Add posting slots" and "Write and schedule your
   first post" as "To do" with no action, each saying it needs an account first.
3. **Given** the project has an account with no active posting slots, **When** the owner opens the home, **Then** step 1
   reads "Done", step 2 reads "To do" with an action linking to that account's slot section on Accounts, and step 3's
   action is "Write a post".
4. **Given** an account with at least one active slot and a post that is scheduled or published, **When** the owner opens
   the home, **Then** all three required steps read "Done" and the checklist shows as one line, "Setup complete".
5. **Given** the project has at least one account, **When** an owner opens the home, **Then** the primary action is
   "Write a post", linking to Compose.

---

### User Story 2 - An editor sees what they can do and who to ask (Priority: P1)

An editor opens a project where nothing is set up. They see the same overview, but only with actions they can
take. Steps they can't do say "Waiting on" and name the project's owners and admins by display name. They never see
an email address, a server command or an environment variable name.

**Why this priority**: The roadmap makes role-awareness a rule for every entry. Editors today are sent to pages where
they can do nothing.

**Independent Test**: Invite an editor to an empty project, sign in as them and open the home. Check each section for
the owner and admin display names, the absence of any email address, and the absence of manage-only actions.

**Acceptance Scenarios**:

1. **Given** an editor in a project with no accounts, owned by a member whose display name is "Robin" with an admin
   named "Sam", **When** they open the home, **Then** "Connect an account", "Add posting slots" and (when AI generation
   is configured) "Create a voice profile" read "Waiting on Robin and Sam", with no action link.
2. **Given** the same editor, **When** the home renders, **Then** the page contains no member email address, no
   "Connect an account" or "Add an account" action, no server-setup row, no environment variable name and no command
   text.
3. **Given** the same editor, **When** they look at the Accounts section, **Then** it reads "No accounts yet. Ask Robin
   or Sam to connect one."
4. **Given** an editor in a project with an account and active slots, **When** they open the home, **Then** the primary
   action is "Write a post", and step 3 has the "Write a post" action.
5. **Given** an editor, **When** the home renders, **Then** the "Invite a teammate" step is not shown, because editors
   cannot invite.

---

### User Story 3 - A returning member sees what needs attention and what's coming up (Priority: P2)

Someone who uses the project daily opens its home and sees, at a glance, what needs them (posts awaiting review,
posts needing a decision, failed posts, accounts to reconnect, credentials about to expire), the next few scheduled
posts, the state of each account, and how many posts are in each status. Each item links to the page where it's
handled.

**Why this priority**: This makes the overview worth returning to after setup. Without it, the page is only useful
once.

**Independent Test**: Seed a project with a post awaiting review, an ambiguous target, a failed post, an account
needing reconnecting, an account whose credentials expire in 10 days, and three scheduled posts. Open the home and
check each item, its count and its link.

**Acceptance Scenarios**:

1. **Given** the project has 2 posts awaiting review, 1 post needing a decision and 1 failed post, **When** a member opens
   the home, **Then** Needs attention lists "Awaiting review" (2) linking to Review, "Needs your decision" (1) linking to
   Failures, and "Failed" (1) linking to Failures, each with a text badge.
2. **Given** an account needs reconnecting, **When** an owner opens the home, **Then** Needs attention lists it by account
   name with a link to that account on Accounts. **When** an editor opens it, **Then** the item names the account and
   says to ask the owners and admins by display name, with no reconnect action.
3. **Given** an account's credentials expire within 14 days, **When** a member opens the home, **Then** Needs attention
   lists it with the expiry time shown in the project's time zone.
4. **Given** nothing needs attention, **When** a member opens the home, **Then** the Needs attention section is not shown.
5. **Given** 7 scheduled posts, **When** a member opens the home, **Then** Coming up shows the 5 soonest, each with its
   time in the project time zone, an excerpt and its account names, plus "Open calendar".
6. **Given** no scheduled posts and at least one account, **When** a member opens the home, **Then** Coming up reads
   "No scheduled posts yet. Write one and schedule it." with "Write a post". **Given** no accounts, **Then** it reads
   "No scheduled posts yet. Connect an account first." For managers the action is "Connect an account". Editors get no
   action and are told who to ask.
7. **Given** posts in several statuses, **When** a member opens the home, **Then** Posts by status shows counts for Drafts,
   Needs review, Approved but not scheduled, and Scheduled, each linking to the Posts list filtered to that status.
8. **Given** there are no posts, **When** a member opens the home, **Then** Posts by status reads "No posts yet." with
   "Write a post".

---

### User Story 4 - An owner sees which server pieces are missing, without commands (Priority: P2)

An owner on a fresh self-hosted install sees one checklist row saying which server pieces aren't set up yet (the
scheduler hasn't run, no AI provider, no media storage, platform apps not set up) and a link to the docs page for
each. No commands or env var names are shown on the overview.

**Why this priority**: Server setup blocks publishing and generation. Today it only appears as a red banner of
commands that everyone sees.

**Independent Test**: With the scheduler never having run and no AI provider or storage configured, open the home as an
owner, an admin and an editor. Only the owner sees the row, and each item links to the right published docs page.

**Acceptance Scenarios**:

1. **Given** the scheduler has never run, no AI provider is configured and storage is not set up, **When** an owner opens
   the home, **Then** the checklist includes a "Server setup" row listing "The scheduler isn't running", "AI generation
   isn't set up" and "Media storage isn't set up", each linking to its docs page.
2. **Given** the same server, **When** an admin or an editor opens the home, **Then** no server-setup row is shown.
3. **Given** the scheduler is running and the AI provider and storage are configured, and the project has an account,
   **When** an owner opens the home, **Then** no server-setup row is shown.
4. **Given** the owner's server-setup row is shown, **When** the page renders, **Then** it contains no command,
   environment variable name or secret value; it links only to the docs.

---

### User Story 5 - Content tools and optional steps (Priority: P3)

A member sees how many voice profiles and media items the project has, when those features are configured, and the
optional checklist steps (create a voice profile, upload images or videos, invite a teammate) with their status.

**Why this priority**: Generation and media are optional to publishing. They matter, but not before the required
steps.

**Independent Test**: With AI generation and storage configured, open the home in a project with no voice profile and
no media, then add one of each and check the counts and the optional steps.

**Acceptance Scenarios**:

1. **Given** AI generation is configured and there are no voice profiles, **When** an owner opens the home, **Then**
   Content tools reads "No voice profile yet. Generated posts need one." with "Create a voice profile". An editor sees
   the same sentence followed by who to ask, and no action.
2. **Given** storage is configured and the library has 3 images and 1 video, **When** a member opens the home, **Then**
   Content tools shows "4 images and videos" linking to Media.
3. **Given** neither AI generation nor storage is configured, **When** a member opens the home, **Then** Content tools is
   not shown, and the optional voice and media steps are not shown.
4. **Given** the project has a second member or a pending invitation, **When** an owner or admin opens the home, **Then**
   the "Invite a teammate" step reads "Done".

---

### User Story 6 - Overview in the navigation, and a fitting loading state (Priority: P3)

Every project page has "Overview" as the first nav item. It's highlighted only on the project home, not on every
page under the project. While the home loads, a skeleton in the shape of the overview is shown. The tab reads the
project name.

**Why this priority**: Today the only way back to the home is the logo, through a redirect. Without exact matching,
Overview would be highlighted on every page.

**Independent Test**: Render the nav at `/p/x`, `/p/x/calendar` and `/p/x/settings/members`, and check which item has
`aria-current="page"`. Check the home's document title.

**Acceptance Scenarios**:

1. **Given** the viewer is on `/p/acme`, **When** the nav renders, **Then** "Overview" is the first item, links to
   `/p/acme` and has `aria-current="page"`, and no other item does.
2. **Given** the viewer is on `/p/acme/calendar`, **When** the nav renders, **Then** Calendar has `aria-current="page"`
   and Overview does not.
3. **Given** the project is named "Acme Launch" with slug `acme`, **When** the home loads, **Then** the document title is
   "Acme Launch · Docket".
4. **Given** the home is loading, **When** the loading state shows, **Then** it is made of skeleton blocks in the shape
   of the header, the checklist and the section cards, with a status for assistive technology, and no "Loading…"
   line on its own.

### Edge Cases

- **A step's prerequisite is missing.** Steps 2 and 3 need an account. Without one they read "To do", keep their
  one-line explanation, and replace the action with "Needs an account first". An editor's "Waiting on" text doesn't
  change.
- **Every slot is paused.** Step 2 is done only when at least one account has an active (unpaused) slot. In the
  Accounts section, an account whose slots are all paused reads "All posting slots paused", linking to its slot
  section.
- **What counts as a first post.** Step 3 is done when any post in the project is scheduled, publishing, published or
  partially published. Drafts, posts awaiting review, approved posts and posts that failed outright don't count.
- **Accounts disappear after setup.** If the only account is removed, steps 1 and 2 go back to "To do", and the
  checklist expands again from "Setup complete" to the full list. There's no stored state to clear.
- **Only owners, no admins.** Editors see "Waiting on Robin". With two names it reads "Robin and Sam". With more than
  three it reads "Robin, Sam, Alex and 2 others". The viewer is never in the list, since an editor is never an owner
  or admin.
- **A member has no display name.** Display names are required, so this shouldn't happen. If one is blank, it's left
  out of the list, and if no names remain the copy reads "an owner or admin". An email is never used instead.
- **Account from an unregistered provider** (`providerAvailable` false). It's listed with its platform name as text
  and a neutral "Unavailable" badge. It counts as connected for step 1, but its slots don't count for step 2.
- **Large counts.** Counts show in full ("1,204"). Coming up is capped at 5 items.
- **Credentials already expired.** These are shown as "Credentials expired", not "expire in", and are listed under
  Needs attention.
- **A service read fails.** The problems callout already hides itself if its count fails. Any other failed read goes
  to the route's existing error state with a retry. The overview never shows a partial page that claims something is
  empty when it couldn't be read.
- **Narrow screens.** At 390 px, the header actions stack under the title, the cards stack in one column, and nothing
  scrolls sideways.
- **Non-members** get the same 404 as a missing project. The project layout already does this, and the overview
  doesn't change it.

## Requirements *(mandatory)*

### Functional Requirements

#### Header and title

- **FR-001**: The project home MUST use the shared page header, with the project name as the page's only top-level
  heading.
- **FR-002**: The header description MUST read "Times in {project time zone}. You're an {Role}.", where Role is
  "Owner", "Admin" or "Editor".
- **FR-003**: The header MUST have exactly one primary action. It is "Connect an account" (to Accounts) when the project
  has no accounts and the viewer can manage accounts, and "Write a post" (to Compose) otherwise. The header MUST NOT use
  the magenta headline-action style.
- **FR-004**: The home's document title MUST be the project name, inside the app's existing title template.
- **FR-005**: The existing "Problems since you last looked" callout MUST stay at the top of the home, above the header,
  with its behaviour unchanged.

#### Getting started checklist

- **FR-010**: The home MUST show a Getting started checklist. Its state comes only from current project data and
  server configuration. No stored dismissal, preference or per-user flag is added.
- **FR-011**: The checklist MUST be an ordered list. Each step MUST show its status as text ("Done", "To do", or
  "Waiting on {names}"), a decorative icon hidden from assistive technology, one line of explanation, and at most one
  action link.
- **FR-012**: Required steps, in order:
  1. **Connect an account.** Done when the project has at least one connected account. Action: "Connect an account" to
     Accounts.
  2. **Add posting slots.** Explanation: "Weekly times Docket uses when you Add to queue." Done when at least one account
     has at least one active slot. Action: to the first account without an active slot, at its slot section on
     Accounts.
  3. **Write and schedule your first post.** Done when any post is scheduled, publishing, published or partially
     published. Action: "Write a post" to Compose.
- **FR-013**: Optional steps, marked "Optional" in text:
  4. **Create a voice profile.** Shown only when AI generation is configured on the server. Done when the project has at
     least one non-archived voice profile. Action: to Voice.
  5. **Upload images or videos.** Shown only when media storage is configured. Done when the library has at least one
     item. Action: to Media.
  6. **Invite a teammate.** Shown only to viewers who can invite. Done when the project has more than one member or a
     pending invitation. Action: to the members settings page.
- **FR-014**: A step whose prerequisite isn't done (steps 2 and 3 without an account) MUST show "To do" and, instead of
  an action, "Needs an account first".
- **FR-015**: While any required step is unfinished, the checklist MUST appear before every other overview section,
  apart from the problems callout and the header.
- **FR-016**: Once all required steps are done, the checklist MUST collapse to a single line reading "Setup complete".
  It expands, without JavaScript, to show any unfinished optional steps and the owner's server-setup row. When every
  shown step is done and there's no server-setup row, the checklist MUST NOT be shown at all.
- **FR-017**: If a required step stops being done (for example, the only account is removed), the checklist MUST show
  the full list again.

#### Role awareness

- **FR-020**: For viewers who can't manage accounts (editors), steps 1 and 2 and, when shown, step 4 MUST read "Waiting
  on {names}" while unfinished, and MUST have no action.
- **FR-021**: {names} MUST be the display names of the project's owners and admins. They're joined as "A", "A and B",
  "A, B and C", or "A, B, C and n others". A blank name is left out, and "an owner or admin" is used when none remain.
  The overview MUST NOT show any member's email address, and MUST NOT derive a name from one.
- **FR-022**: The "Invite a teammate" step MUST NOT be shown to viewers who can't create invitations.
- **FR-023**: No section MUST offer an action the viewer can't take. Editors MUST NOT see connect, reconnect, slot,
  voice-profile creation or member-invite actions.
- **FR-024**: Role checks for every action shown MUST use the same permission rules the server enforces. The overview
  only reads data and changes no access rules.

#### Server-setup row (owners only)

- **FR-025**: Owners, and only owners, MUST see a "Server setup" row in the checklist while one or more of these is
  true:
  - the scheduler is stale or has never run;
  - AI generation isn't configured;
  - media storage isn't configured;
  - the project has no accounts and at least one platform's app isn't set up on the server.
- **FR-026**: The row MUST list each missing piece in plain words, and MUST NOT print commands, environment variable
  names, redirect addresses or secret values.
- **FR-027**: Each missing piece MUST link to its published docs page:
  - scheduler: the deployment guide's "Is the scheduler running?" section;
  - AI generation: the generator guide's "Configuring a provider" section;
  - storage: the media storage guide;
  - each platform that isn't set up: that platform's own setup guide (Meta, X, TikTok, and so on).
- **FR-028**: The server-setup row is never a required step. It MUST NOT stop the checklist collapsing to "Setup
  complete".

#### Needs attention

- **FR-030**: The home MUST show a Needs attention section only when at least one of these is above zero:
  - posts awaiting review;
  - posts needing a decision;
  - failed posts (failed or partially failed);
  - accounts needing reconnecting;
  - accounts whose credentials expire within 14 days or have expired.
- **FR-031**: Each item MUST show its count or account name with a text-and-colour badge, and link to where it's
  handled:
  - review: Review;
  - decision and failed: Failures;
  - reconnect and expiry: that account on Accounts, for viewers who can manage accounts.
- **FR-032**: For editors, reconnect and expiry items MUST name the account and say who to ask (FR-021), without a link
  to act.
- **FR-033**: The review and needs-decision counts MUST match the counts shown on the Review and Failures nav items.
- **FR-034**: Needs attention MUST include a link to the project's Activity page ("See all activity"), so problem
  history is one step away.
- **FR-035**: Expiry times MUST be shown in the project's time zone.

#### Coming up

- **FR-036**: When there are scheduled posts, Coming up MUST show up to the 5 soonest. Each shows its scheduled time in
  the project time zone, an excerpt and the names of the accounts it posts to. The section ends with "Open calendar".
- **FR-037**: When there are no scheduled posts:
  - with an account: "No scheduled posts yet. Write one and schedule it." with "Write a post";
  - without one: "No scheduled posts yet. Connect an account first." The action is "Connect an account" for managers;
    editors get no action and are told who to ask (FR-021).

#### Accounts

- **FR-038**: When the project has accounts, the Accounts section MUST list one row per account, with:
  - the platform mark and platform name as text;
  - the account name;
  - a status badge: "Connected", "Needs reconnecting", or "Unavailable" when its platform is no longer registered on the server;
  - "{n} posting slots a week" (active slots), "All posting slots paused", or "No posting slots — add some" (the
    action only for managers), linking to that account's slot section on Accounts;
  - the credential expiry time, when the account has one.
- **FR-039**: When there are no accounts:
  - managers see "You don't have any accounts yet." with "Add an account";
  - editors see "No accounts yet. Ask {names} to connect one." (FR-021).

#### Posts by status

- **FR-040**: When the project has posts, Posts by status MUST show counts for Drafts, Needs review, Approved but not
  scheduled, and Scheduled. Each count links to the Posts list filtered to that status.
- **FR-041**: When the project has no posts, the section MUST read "No posts yet." with "Write a post".

#### Content tools

- **FR-042**: When AI generation is configured, Content tools MUST show the number of active voice profiles, linking to
  Voice. When there are none, it reads "No voice profile yet. Generated posts need one.":
  - managers get "Create a voice profile";
  - editors are told who to ask (FR-021).
- **FR-043**: When storage is configured, Content tools MUST show the number of library items as "{n} images and
  videos", linking to Media. When there are none, it reads "No images or videos yet." with "Upload images or videos".
- **FR-044**: When neither feature is configured, Content tools MUST NOT be shown.

#### Shared rules for sections

- **FR-045**: Every empty state MUST use the shared empty-state pattern, with its action styled as a button, never an
  underlined text link. Every action MUST have a visible focus ring.
- **FR-046**: The overview MUST be built from the existing primitives (page header, card, empty state, badge, status
  badge, platform icon, local time, skeleton, alert, button styles, icon). The only new shared component allowed is a
  Checklist, as audit M2 permits. It MUST be documented in the design system's components table.

#### Loading

- **FR-047**: While the home loads, it MUST show a skeleton matching the overview's layout (header, checklist, section
  cards). It has an accessible status label and pulses only when motion is allowed. Settings, which has no loading
  state of its own today, MUST NOT show the overview-shaped skeleton. It keeps a generic loading state.

#### Navigation

- **FR-050**: The project nav MUST show "Overview" as its first item, above the Publish group and without a group
  label. It links to the project home (`/p/{slug}`).
- **FR-051**: Overview MUST be marked as the current page only when the path is exactly the project home (with or
  without a trailing slash). Every other item keeps its current prefix matching.
- **FR-052**: The order and grouping of the other nav items MUST NOT change. The pinned labels and order MUST still
  pass: "Review (3)", ">Failures<", Review directly above Failures, and Activity directly after Failures.
- **FR-053**: The design system's app-shell section and the docket-ui skill's nav description MUST add Overview as the
  first item.

#### Docs

- **FR-060**: `docs/design-system.md` MUST list the Checklist component (its props and when to use it) and record that
  the home now uses the page header.
- **FR-061**: Judgement calls made here MUST be appended to `docs/decisions.md`:
  - who sees the invite step;
  - when the platform item shows in the server-setup row;
  - what counts as a first post;
  - failed versus partially failed in Needs attention;
  - the Settings loading state.

### Key Entities *(no new stored data)*

- **Overview**: a read-only summary of one project for one viewer. It's derived on each request from:
  - the project (name, slug, time zone);
  - the viewer's role;
  - accounts and their slots;
  - post counts by status;
  - the scheduled posts list;
  - the review and needs-decision counts;
  - accounts needing reconnecting;
  - voice profiles;
  - the media library total;
  - members and pending invitations;
  - the scheduler health;
  - the AI and storage configuration status.
- **Checklist step**: has a key, a title, a one-line explanation, whether it's optional, its status (done, to do, or
  waiting on named people), and an optional action (label and destination). It isn't stored.
- **Server-setup item**: a missing server piece (scheduler, AI generation, storage, or a platform), with its plain-words
  label and docs link. Shown to owners only, and not stored.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An owner opening a brand-new project can reach the page where the next required step is done in 1 click
  from the home, for each of the three required steps.
- **SC-002**: The home of a brand-new project shows exactly one primary action and a checklist in which all three
  required steps are visible. Today it shows 0 actions in the page body.
- **SC-003**: Across the home rendered for an editor in an empty project and in a fully populated one, 0 member email
  addresses, 0 environment variable names, 0 commands, and 0 actions the editor's role can't perform appear.
- **SC-004**: Every overview section has a tested empty state and a tested populated state, for both an owner and an
  editor (at least 5 sections × 2 states × 2 roles).
- **SC-005**: Each checklist step's status is tested against data. Each step moves from "To do" to "Done" when its data
  changes, and back when it's removed, with nothing stored.
- **SC-006**: On every project route, exactly one nav item is marked current, and Overview is marked only on the project
  home.
- **SC-007**: The existing nav, Review and Failures tests pass unchanged.
- **SC-008**: The home's tab title is the project name for 100% of projects, including ones whose name differs from
  the slug.
- **SC-009**: No overview element scrolls sideways at a 390 px viewport.

## Not included in this entry

- **Nav reordering and grouping**: entry 3 (S1) owns this. Overview is added on top, and nothing else moves.
- **Other routes' empty states and role-aware copy** (Accounts, Calendar, Compose, Posts, Failures, Review, Generate,
  Jobs, Media, Voice, and the scheduler-health banner): entry 2 (M3) owns these. In particular, the red scheduler banner
  still shows commands to every member until entry 2 lands.
- **Terminology and page descriptions** ("Brand voice", "Batch jobs", readable target statuses, the definition of
  "posting slot" by the slot editor): entry 3 (S2) owns these. The overview uses today's labels ("Voice", "Approved but
  not scheduled").
- **The Accounts card restructure, landing on the slot editor after connecting, linking to the calendar after a first
  post, and a getting-started docs page linked from the checklist**: entry 4 (S3, C3, C4) owns these.
- **Stored dismissal of the checklist**: no entry in this roadmap owns it. Entry 4 also excludes it, because it needs a
  stored per-user preference and its own decision (audit C2).
- **A project-wide slot-count service**: no later entry owns it. The overview loops slots per account, which the audit
  says is fine for v1.
- **Hiding the checklist "once the project has been publishing for a while"** (audit M2): the timing is vague, so this
  entry uses FR-016 instead (the checklist disappears once every shown step is done).

## Assumptions

- **Admins don't get the server-setup row.** The roadmap and the request both say owners only, even though admins can
  manage accounts. Admins still see the account, slot and voice actions.
- **Who sees the invite step.** Audit M2 names steps 1, 2 and 4 for editors' "Waiting on" text and is silent on step 6.
  Since editors can't invite, the invite step is hidden from them rather than shown as waiting, following the rule
  "never show them actions they can't take".
- **When the platform item shows.** It appears only while the project has no accounts. A server will usually leave some
  platforms unconfigured on purpose (for example, an owner who doesn't use X). Once an account exists, nagging about
  the others would be permanent noise.
- **What counts as failed.** Needs attention's "Failed" count includes partially failed posts as well as failed ones,
  since both have targets to deal with on Failures. The audit cited only `counts.failed`.
- **Read cost.** Slot counts loop per account (audit data gap). All reads go through existing services, under the
  project's scoped data access. No new queries touch project-owned data outside that layer.
- **Copy.** Strings quoted in this spec are the target copy. Where the audit gives copy, it's used as is or lightly
  normalised (full stops, sentence case).
- **Docs links.** These use the existing published-docs helper and pages. No new docs pages are needed (the
  getting-started page is entry 4's).
- **Server-side rendering.** The overview is rendered on the server and needs no JavaScript to read or use. The "Setup
  complete" expansion uses a native disclosure.
