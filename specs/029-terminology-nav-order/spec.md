# Feature Specification: Terminology, page descriptions and nav order

**Feature Branch**: `029-terminology-nav-order`

**Created**: 2026-10-09

**Status**: Draft

**Input**: User description: "Entry 3 of 4 in the first-time project experience roadmap (`.specify/roadmaps/onboarding.md`): Terminology, page descriptions and nav order. Audit recommendations S1 and S2 (`docs/research/onboarding-audit.md`). Nav groups Overview / Publish (Compose, Calendar, Posts, Review, Failures) / Create (Generate, Brand voice, Media, Batch jobs) / Project (Accounts, Settings, and Activity if present). 'Voice' becomes 'Brand voice' and 'Jobs' becomes 'Batch jobs'; keep 'Review' and 'Failures'; on the job page 'Targets' becomes 'Accounts'. A one-line PageHeader description on every route. Define 'posting slot' once, by the slot editor. Show target statuses as readable words. Role descriptions on the invite form, signup and invitations pages; hints on the voice editor; clearer /p/new copy and a time zone hint. Update docs/design-system.md §6 and the docket-ui skill. Keep the test-pinned labels 'Review (3)', '>Failures<' and Review directly above Failures. Fold features that landed after the audit (activity history, problem notifications, video) into the nav decisions. Not included: showing or hiding nav items based on project state."

## Context

Entries 1 and 2 (`specs/027-project-overview`, `specs/028-empty-states-roles`) gave the project a home with a
getting-started checklist, and made each route's empty state name the next step. A newcomer can now find the first
step. But the words around them are still the team's internal words. "Voice" in the nav sounds like audio. "Jobs"
could mean anything. Most pages have a bare heading that doesn't say what the page is for. A post's per-account
status reads "Acme: ambiguous". The invite form offers Editor, Admin and Owner without saying what each can do. The
nav also lists items in daily-use order (Calendar first), not the order a newcomer acts in (Compose first).

This entry fixes the vocabulary and the signposting. The nav is regrouped and two items are renamed. Every page gets
a one-line description of what it is for. A small set of terms (posting slot, roles, voice fields, target statuses)
is explained where people meet them. It changes words, headings and order only. No data, permission or behaviour
changes.

### Audit citations re-checked against the current code (2026-10-09)

The audit was written on 2026-10-08, before the video roadmap's last entries and entries 1 and 2 of this roadmap.
Each line this entry relies on was re-checked:

| Audit claim | Current code | Effect on this spec |
|---|---|---|
| Nav is 11 items: Calendar, Posts, Compose, Review, Failures / Generate, Jobs, Media, Voice / Accounts, Settings (`LeftNav.tsx:10-22`) | `NAV_GROUPS` is Publish, Create, Project (`LeftNav.tsx:8`). `NAV_SECTIONS` (`:10-23`) now has 12 items: **Activity** (activity history, landed after the audit) sits in Publish after Failures. **Overview** already exists, rendered first and ungrouped with an exact-match active check (entry 1) | Reorder Publish; move Activity to Project (FR-001–FR-004) |
| Review directly above Failures (`nav.test.ts:26`) | Still asserted, at `tests/integration/failures/nav.test.ts:26`. Line 27 **also** asserts Activity directly after Failures | Line 27 changes, because moving Activity is intended (FR-005) |
| No `PageHeader` on home, Posts, Calendar, Review, Voice, Jobs, Media, Generate, Failures or Settings | Overview, Compose (`Composer.tsx:330`), Accounts (`accounts/page.tsx:102`), Activity (`activity/page.tsx:55`), `/activity` and `/notifications` now use `PageHeader` with a description. Every other project page still has a bare `<h1>`, including all sub-pages (post detail, job detail, new job, voice profile, voice history, generated post, series, settings sub-pages, connect) and Compose's no-accounts state (`Composer.tsx:248`) | FR-010–FR-016 |
| "Posting slots" never explained (`accounts/page.tsx:91,199`) | The Accounts description mentions "weekly posting slots" (`:104`). Each card's heading is "Posting slots ({tz})" at `:219`; the "Connected accounts" section heading is at `:121`. No definition anywhere | FR-020–FR-021 |
| Raw target status "Acme: ambiguous" (`posts/page.tsx:127`) | Now `posts/page.tsx:150-153`: a hand-picked tone and `t.status.replaceAll("_", " ")`. Post detail already uses `StatusBadge` for targets (`posts/[postId]/page.tsx:114`). `StatusBadge` has a label for every target status (`draft`, `scheduled`, `publishing`, `published`, `failed`, `ambiguous` → "Needs your decision", `cancelled`) | FR-030–FR-031 |
| "Targets" (`jobs/[jobId]/page.tsx:108`) | Unchanged (`:108`) | FR-040 |
| Raw role key on the invite form, signup and invitations (`invitations-panel.tsx:106-110`, `signup/page.tsx:42`, `invitations/page.tsx:33`) | Invite form `SegmentedControl` at `invitations-panel.tsx:101-111` with label-only options; `SegmentedControl` already supports `layout="cards"` with per-option descriptions. Signup `:42` "as **editor**"; invitations `:34` "Join as **editor**" | FR-050–FR-053 |
| Voice editor has no hints (`VoiceEditor.tsx:190-193`) | Unchanged (`:190-193`). The `Area` field already accepts a `hint` (`:54`) | FR-060 |
| `/p/new` jargon (`p/new/page.tsx:19`); time zone purpose unexplained (`new-project-form.tsx:69`) | `:19` "A project holds its own accounts, posting slots, voice and team." `new-project-form.tsx:69` uses `TimeZoneField` with its default hint "Dates, slots and the calendar use this zone." (`TimeZoneField.tsx:35`), which itself says "slots" | FR-070–FR-071 |
| Nav labels "Voice" and "Jobs" (`LeftNav.tsx:17,19`) | Now `:18,20`. Section headings and tab titles also say "Voice" (`voice/page.tsx:14,35`, `voice/loading.tsx:4`, `voice/[profileId]/loading.tsx:4`) and "Jobs" (`jobs/page.tsx:20,62`); creation pages say "New job" and "New job from CSV" | FR-006–FR-008 |
| Design system §6 and docket-ui SKILL.md lines 28-30 describe the nav | §6's shell diagram and Sidebar bullet list Publish as Calendar, Posts, Compose, Review, Failures and Create as Generate, Jobs, Media, Voice, with no Activity. The skill's app-shell bullet (now `SKILL.md:31-33`) lists Activity under Publish | FR-080–FR-081 |

Tests that assert strings this entry changes were searched for. Only `nav.test.ts:27` (Activity after Failures)
asserts something this entry intentionally changes. `tests/integration/roles/routes.test.tsx:176` asserts that
editors **don't** see "New job from CSV"; `voice/voice.test.tsx:129` asserts the editor's "Voice" field-group legend.
FR-007 and FR-090 cover both.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A nav that reads in the order a newcomer acts (Priority: P1)

A new owner opens their project. The nav starts with Overview, then a **Publish** group that starts with Compose,
then Calendar, Posts, Review and Failures. Next comes **Create** (Generate, Brand voice, Media, Batch jobs), and last
**Project** (Accounts, Settings, Activity). The group names say what each group is for. "Brand voice" and "Batch
jobs" say what those pages hold, where "Voice" and "Jobs" did not.

**Why this priority**: The nav is on every project page and is the first thing a newcomer reads. Fixing its order
and two misleading labels helps every visit.

**Independent Test**: Render the project nav and read its items in order. Compare the groups, order and labels with
the list above. Check that the Review and Failures counts still read "Review (3)" and "Failures (2)", and "Failures"
with no count.

**Acceptance Scenarios**:

1. **Given** any member on any project page, **When** the nav renders, **Then** it lists, in this order: Overview;
   Publish: Compose, Calendar, Posts, Review, Failures; Create: Generate, Brand voice, Media, Batch jobs; Project:
   Accounts, Settings, Activity.
2. **Given** 3 posts await review and 2 targets need a decision, **When** the nav renders, **Then** the review entry's
   accessible name is "Review (3)" and the failures entry's is "Failures (2)". Review sits directly above Failures.
3. **Given** nothing needs a decision, **When** the nav renders, **Then** the failures entry reads "Failures" with no
   count.
4. **Given** a member clicks "Brand voice" or "Batch jobs", **When** the page opens, **Then** its URL is the same one
   the old "Voice" or "Jobs" item used, the nav item is marked as the current page, and the page heading and browser
   tab title use the new name.
5. **Given** a phone-width screen, **When** the nav renders as a horizontal strip, **Then** the items are in the same
   order as on desktop.

---

### User Story 2 - Every page says what it is for (Priority: P1)

A newcomer clicks through the nav. Each page opens with its title and one short sentence saying what it holds or
does. Review says it holds generated posts waiting for approval. Failures says it holds posts that didn't go out.
Batch jobs says it makes many posts at once from images or a CSV file. Sub-pages (a post, a job, a voice profile, a
webhook) say the same kind of thing for what they show.

**Why this priority**: A heading alone ("Review", "Jobs") is where the audit found people stalled. One sentence on
every page is the cheapest fix for the most confusion.

**Independent Test**: Render every project page, the `/invitations` page and Compose's no-accounts state. Check that
each has exactly one page heading and, beside it, a non-empty one-sentence description.

**Acceptance Scenarios**:

1. **Given** any page listed in FR-012, **When** it renders, **Then** it shows the page header (title and one-line
   description) defined there, and the title is the page's only level-one heading.
2. **Given** the Calendar page in a project whose time zone is Europe/London, **When** it renders, **Then** the
   description reads "Scheduled posts and open posting slots, in Europe/London." and the zone is not repeated in the
   title.
3. **Given** Failures, where focus moves to the heading after an action, **When** the page uses the shared page
   header, **Then** focus still lands on the heading as before.
4. **Given** Compose in a project with no accounts, **When** it renders its empty state, **Then** it shows the same
   page header as Compose with accounts, not a bare heading.

---

### User Story 3 - Roles explained where people choose or accept them (Priority: P2)

An owner invites a teammate. The role choice shows Editor, Admin and, for owners, Owner, each with one line saying
what that role can do. The invitee opens the signup link and reads "Sam invited you to Acme Launch as **Editor**",
followed by the same description of what an editor can do. On the Invitations page each invitation says the same.

**Why this priority**: The role decides what a person can do. Today it shows as a lowercase key with no
explanation, at the moment someone accepts it.

**Independent Test**: Render the invite form as an owner and as an admin, the signup page for an invitation, and the
Invitations page. Check that each shows the role's display name and its one-line description, worded the same in
all three places.

**Acceptance Scenarios**:

1. **Given** an owner on Members & invitations, **When** the invite form renders, **Then** the role choice shows
   Editor, Admin and Owner as cards, each with its description from FR-051, and Editor is selected by default.
2. **Given** an admin, **When** the invite form renders, **Then** it shows Editor and Admin with descriptions and no
   Owner option (unchanged permission).
3. **Given** an invitation as editor, **When** the invitee opens the signup link, **Then** the page names the role
   "Editor" (not "editor") and shows the editor description.
4. **Given** a signed-in user with a pending admin invitation, **When** they open Invitations, **Then** the invitation
   names the role "Admin" and shows the admin description.

---

### User Story 4 - Terms explained where people meet them (Priority: P2)

An owner adding their first posting slot reads, above the account cards, what a posting slot is: "Weekly times this
account posts at. Add to queue fills the next free slot." On the posts list, each account's status reads as a word,
like "Acme: Needs your decision", not "Acme: ambiguous". On a batch job's page, the accounts it posts to are listed
under "Accounts", not "Targets". In the voice editor, each field has a hint with an example.

**Why this priority**: Each of these is a single term a newcomer stumbles on. Each is cheap to fix where it appears.

**Independent Test**: Render Accounts with one account, the posts list with targets in every status, a batch job page,
and the voice editor. Check the definition, the readable status words, the "Accounts" label and the four hints.

**Acceptance Scenarios**:

1. **Given** a project with at least one account, **When** any member opens Accounts, **Then** the posting-slot
   definition appears once on the page, by the posting slots, whatever the number of accounts.
2. **Given** a post whose targets are in each status (draft, scheduled, publishing, published, failed, ambiguous,
   cancelled), **When** the posts list renders, **Then** each target reads "{account}: {label}" with the label from the
   shared status vocabulary ("Draft", "Scheduled", "Publishing", "Published", "Failed", "Needs your decision",
   "Cancelled"), and none shows a raw status key.
3. **Given** a batch job, **When** its page renders, **Then** the list of accounts it posts to is labelled "Accounts".
4. **Given** a manager editing a voice profile, **When** the editor renders, **Then** "Voice and tone", "Audience",
   "Topics and pillars" and "Avoid" each have a hint with an example (FR-060), linked to its field.

---

### User Story 5 - Creating a project says what comes next (Priority: P3)

A new owner reaches "Create a project". The sentence under the heading says what happens next ("Next you'll connect a
social account and choose when it posts."), not a list of internal nouns. The time zone field says what the zone is
used for: "Posting times and the calendar use this zone."

**Why this priority**: People see this once, but it is the first in-product copy a new owner reads.

**Independent Test**: Render `/p/new` and check the sentence and the time zone hint.

**Acceptance Scenarios**:

1. **Given** a signed-in user on `/p/new`, **When** the page renders, **Then** the sentence under "Create a project"
   reads "Next you'll connect a social account and choose when it posts."
2. **Given** the same page, **When** the time zone field renders, **Then** its hint reads "Posting times and the
   calendar use this zone." and is linked to the field.

---

### Edge Cases

- **Activity in Project, not Publish.** Activity is the project's history ("Everything that happened to publishing in
  this project"), not a step in publishing. It moves to the Project group, after Settings, as the roadmap entry lists it. Its URL and active
  state are unchanged.
- **Overview stays first and exact-match.** Overview remains ungrouped at the top. Reordering the groups must not
  break its exact-match active state (it must not light up on `/p/x/compose`).
- **Old names elsewhere.** "Voice" also names a field group in the voice editor (the voice-and-tone fields) and a row
  on the job page ("Voice": the profile used). Those describe the profile's content, not the nav section, and stay
  as they are. "Voice profile" stays the name for one profile. "Job" stays acceptable in running text on Batch jobs
  pages (for example "Jobs cannot run: …").
- **URLs don't change.** `/voice` and `/jobs` keep their paths, so bookmarks, links in docs and the public API are
  unaffected. The public API's "Jobs" tag is not a UI label and stays.
- **Unknown statuses.** If a target ever carries a status the shared vocabulary doesn't know, it falls back to the
  status name with underscores as spaces, as `StatusBadge` already does. It never shows nothing.
- **Pages with a dynamic title.** Job detail (titled by its source summary), voice profile (by profile name), voice
  history, webhook detail (by host) and Connect (by platform group) keep their dynamic titles and gain a fixed
  description.
- **Calendar title.** The calendar's title is the shown period (for example "October 2026"). It stays the title; the
  time zone moves from the title into the description, so it appears once.
- **Read-only voice editor.** Editors see a voice profile read-only. The hints describe what each field means, not an
  action, so they show to every role.
- **Role descriptions for removed options.** Admins can't invite owners, so the Owner card and its description don't
  appear for them. An invitation can still be *for* the owner role (sent by an owner); signup and Invitations then
  show the owner description.
- **Error, not-found and loading pages** keep their existing headings. They are states of a route, not routes with a
  purpose to describe. The exception is the two voice loading screens, whose heading text changes to "Brand voice"
  so the heading doesn't flash the old name.
- **Signed-out and first-run pages** (`/login`, `/setup`, `/signup`, `/p/new`, `/connect/invalid`) use the centred
  card pattern from design-system §6: a greeting `h1` and one muted sentence. They keep that pattern rather than
  switching to `PageHeader`. `/p/new` gets its new sentence (FR-070); the others already have one.

## Requirements *(mandatory)*

### Functional Requirements

**Nav (S1)**

- **FR-001**: The project nav MUST show, in this order: **Overview** (ungrouped, first); **Publish**: Compose,
  Calendar, Posts, Review, Failures; **Create**: Generate, Brand voice, Media, Batch jobs; **Project**: Accounts,
  Settings, Activity.
- **FR-002**: Review MUST sit directly above Failures. The review count's accessible name MUST stay "Review (n)" and
  the failures count's "Failures (n)". With no count, the failures entry MUST render the plain label "Failures".
- **FR-003**: The nav MUST be a fixed list: no item is added, removed or reordered based on project state, role or
  server configuration.
- **FR-004**: Every item MUST keep its current URL, icon and active-state rule. Overview keeps its exact-match rule;
  every other item keeps prefix matching.
- **FR-005**: The test that pins nav order MUST keep asserting Review directly above Failures and the "Failures (2)",
  ">Failures<" and no-"Failures (" checks. Its Activity-after-Failures assertion MUST change to assert Activity's new
  place (last in Project).

**Renames (S2)**

- **FR-006**: The nav label, page heading and browser tab title of the voice section MUST read "Brand voice". The
  same applies to the voice section's loading screens. The list page's heading and tab title MUST read "Batch jobs",
  and the nav label "Batch jobs".
- **FR-007**: Pages and links that name the batch-job section MUST use the new name. The creation pages' headings
  become "New batch job" and "New batch job from CSV" (headings and tab titles), and the Batch jobs page's create link
(`jobs/page.tsx:49`) says "New batch job from CSV". Any
  test that asserts an old string is *absent* (for example `roles/routes.test.tsx:176`, "New job from CSV") MUST be
  updated to the new string, so it still checks something.
- **FR-008**: "Voice profile" stays the name of one profile. The voice editor's "Voice" field group and the job page's
  "Voice" row stay unchanged (Edge Cases).

**Page descriptions (S2)**

- **FR-010**: Every page under a project (`/p/{slug}/…`) and the signed-in `/invitations` page MUST open with the
  shared page header: the title as the page's only level-one heading, and a one-sentence description beside it.
- **FR-011**: Existing page headers MUST keep their current title and description unless FR-012 changes them.
- **FR-012**: Pages MUST use these titles and descriptions. `{tz}` is the project's time zone. Wording marked
  *(audit)* is the audit's exact copy. The rest is new in this spec and may be adjusted in planning only to stay
  accurate to what the page shows; it must stay one sentence.

  | Page | Title | Description |
  |---|---|---|
  | Overview | (unchanged) | (unchanged: "Times in {tz}. You're {role}.") |
  | Compose, Edit post, and Compose with no accounts | "Compose" / "Edit post" | (unchanged) "Write once, tailor per account, then queue, schedule or publish." |
  | Calendar | the shown period | "Scheduled posts and open posting slots, in {tz}." *(audit)* |
  | Posts | "Posts" | "Everything written or generated in this project." *(audit)* |
  | Post detail | "Post" (with the existing "Posts" back link) | "Where this post goes, its status on each account, and every publish attempt." |
  | Review | "Review" | "Generated posts waiting for someone to approve them." *(audit)* |
  | Failures | "Failures" | "Posts that didn't go out, and what you can do about them." *(audit)* |
  | Generate | "Generate" | "Draft one post, or a series of related posts, in your brand voice." |
  | Generated post | "Generated post" | "What was generated, and what it was generated from." |
  | Series | "Series" | "A run of related posts generated from one brief." (the brief stays below the header) |
  | Brand voice | "Brand voice" | "How generated posts should sound." *(audit)* |
  | New voice profile | "New voice profile" | "Describe how generated posts should sound." |
  | Voice profile | the profile name | "One voice profile: how generated posts should sound, with examples." |
  | Voice profile history | "{profile name}: history" | "Earlier versions of this voice profile." |
  | Media | "Media" | "Images and videos you can attach to posts." |
  | Batch jobs | "Batch jobs" | "Generate many posts at once from images or a CSV file." *(audit)* |
  | New batch job | "New batch job" | "Generate one post for each image you chose." |
  | New batch job from CSV | "New batch job from CSV" | "Generate one post for each row of a CSV file." |
  | Batch job | the job's source summary (status badge beside it, as now) | "One batch job: its settings, progress and the posts it made." |
  | Accounts | (unchanged) | (unchanged) |
  | Connect | "Connect {platform group}" / "Connect accounts" | "Choose which accounts to add to this project." |
  | Activity | (unchanged) | (unchanged) |
  | Project settings | "Project settings" | "The project's name, time zone, and how new posts are approved and scheduled." |
  | Members & invitations | "Members & invitations" | "Who works in this project, and invitations that haven't been accepted yet." |
  | API keys | "API keys" | The existing first sentence becomes the description; the rest of the paragraph stays below. |
  | Webhooks | "Webhooks" | The existing sentence ("Docket can tell another service when …") becomes the description. |
  | Webhook | "Webhook: {host}" | "Where this webhook sends events, and its recent deliveries." |
  | Invitations (`/invitations`) | "Invitations" | "Projects you've been invited to join." |

- **FR-013**: A page's description MUST NOT contain server commands, env var names or actions the viewer can't take.
  None of the FR-012 descriptions vary by role.
- **FR-014**: Where a page moves focus to its heading (Failures and Post detail, as fallback after an action), the
  heading MUST stay focusable with the same id, so that behaviour doesn't change.
- **FR-015**: Content that sat next to an old bare heading MUST stay on the page: the failures totals line, the job's
  status badge and "Open: accepting items" marker, Generate's mode tabs, the series brief, and the API keys and
  webhooks links. It sits below or beside the header.
- **FR-016**: Calendar's time zone MUST appear once in its header, in the description, and not also in the title.

**Posting slot (S2)**

- **FR-020**: When the project has at least one account, the Accounts page MUST define "posting slot" once, in the
  connected-accounts section above the account cards, with the text "Weekly times this account posts at. Add to queue
  fills the next free slot." *(audit)*. It shows to every role and doesn't repeat per account.
- **FR-021**: No other page adds a second definition. Other mentions of posting slots stay as they are.

**Readable target statuses (S2)**

- **FR-030**: Wherever a post target's status is shown as text, it MUST use the shared status vocabulary (the same
  labels and tones as the existing status badge). The posts list's "{account}: {status}" badges are the place this
  changes. Unknown values fall back as described in Edge Cases.
- **FR-031**: The posts list's per-target badge colour MUST come from the same shared vocabulary, so "Needs your
  decision" looks the same in the list as on the post page. Colour is never the only signal; the label is always
  present.

**"Targets" → "Accounts" (S2)**

- **FR-040**: On a batch job's page, the row that lists the accounts the job posts to MUST be labelled "Accounts".
  The values, including "(removed)" for removed accounts, are unchanged.

**Role descriptions (S2)**

- **FR-050**: The invite form's role choice MUST show each offered role as a card with a one-line description. The
  role set (Editor and Admin for admins; also Owner for owners) and the default (Editor) are unchanged.
- **FR-051**: Role names and descriptions MUST come from one source, used by the invite form, signup and Invitations:
  - **Editor**: "Writes, schedules and generates posts, and uploads media. Can't connect accounts or change posting
    slots, brand voice or settings."
  - **Admin**: "Everything an editor can do, plus accounts, posting slots, brand voice, settings and invitations.
    Can't invite owners or change members' roles."
  - **Owner**: "Full control, including inviting owners, changing roles and transferring ownership."

  The wording MUST match the role permissions in `src/server/auth/access.ts`. If planning finds a mismatch, the
  permissions win and the wording is corrected.
- **FR-052**: The signup page's invitation summary MUST name the role by its display name (Editor, Admin, Owner), not
  its key, and show that role's description below the summary. The same applies in every signup state that shows the
  summary (sign up, log in to accept, accept).
- **FR-053**: Each invitation on the Invitations page MUST name the role by its display name and show its
  description.

**Voice editor hints (S2)**

- **FR-060**: The voice editor MUST show a hint, linked to its field, under each of the four voice fields:
  - Voice and tone: "How posts sound, e.g. 'warm, plain-spoken, a little dry'."
  - Audience: "Who reads this, e.g. 'indie game developers'." *(audit)*
  - Topics and pillars: "What posts are about, e.g. 'release notes, behind the scenes, tips'."
  - Avoid: "Words, topics or styles to leave out, e.g. 'hype, exclamation marks, competitor names'."

  Hints show in edit and read-only modes. They don't replace a field's error message, which still shows when present.

**`/p/new` (S2)**

- **FR-070**: The sentence under "Create a project" MUST read "Next you'll connect a social account and choose when it
  posts." *(audit)*
- **FR-071**: The time zone field on `/p/new` MUST show the hint "Posting times and the calendar use this zone."
  *(audit)*. Project settings keeps its current hint.

**Docs**

- **FR-080**: `docs/design-system.md` §6 MUST describe the new nav: the shell diagram and the Sidebar bullet list the
  groups and items of FR-001, including Activity under Project. Page anatomy MUST state that every page in the
  project shell has a `PageHeader` with a one-line description.
- **FR-081**: The docket-ui skill's app-shell bullet MUST list the same groups and items as FR-001. Its guidance MUST
  say that every route has a one-line `PageHeader` description, and that role names and descriptions come from the
  single source in FR-051.

**Tests**

- **FR-090**: Tests MUST cover: the nav groups and order (FR-001, FR-002); the renamed labels in the nav, headings and
  tab titles (FR-006, FR-007); a page header with a non-empty description on every page in FR-012; readable target
  statuses on the posts list for every target status (FR-030); and role descriptions on the invite form (owner and
  admin), signup and Invitations (FR-050–FR-053). A test is updated only where it asserts a string this entry
  intentionally changes (FR-005, FR-007). The voice editor's "Voice" field-group assertion stays as it is.

### Key Entities

- **Nav item**: a label, group, icon and URL in the project nav. This entry changes labels and order only.
- **Role description**: a display name and a one-line summary per role (owner, admin, editor), shared by every
  screen that shows a role.
- **Status label**: the shared mapping from a post, target, account or job status to a readable word and tone. It
  already exists; this entry makes the posts list use it for targets.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of the pages listed in FR-012 render a page header with exactly one level-one heading and a
  non-empty one-sentence description (checked by test).
- **SC-002**: The nav renders 13 items in the FR-001 order, with Review directly above Failures, on every project
  page and at phone width.
- **SC-003**: No raw status key (a lowercase status word or anything with an underscore) appears in a post target's
  status on the posts list, for every one of the 7 target statuses.
- **SC-004**: All three places that show a role (invite form, signup, Invitations) show the same display name and
  description for it, for all 3 roles.
- **SC-005**: The words "Voice" and "Jobs" no longer appear as a nav label, page heading or browser tab title. They
  are replaced by "Brand voice" and "Batch jobs".
- **SC-006**: The whole test suite passes. The only changed assertions are those that pin a string this entry
  intentionally changes.
- **SC-007**: No page description, role description or hint added here contains an env var name, a server command or
  a person's name taken from an email address.

## Not included, and who owns it

- **Showing or hiding nav items by project state or server config** (including the audit's S1 "Could": hiding
  Generate, Batch jobs and Brand voice without an LLM). The nav is a fixed list. No later entry in this roadmap owns
  this.
- **Group labels on the phone nav strip.** Below `md` the strip still has no group headings; only the order changes.
  No later entry owns it.
- **Accounts card restructure** (status → posting slots → instructions → remove), landing on the slot editor after
  connecting, the `SetupNotice` variant, the post-first-schedule calendar link, `docs/getting-started.md`, the project
  switcher's accessible name and the setup password hint. Entry 4 owns these.
- **Other terms from the audit's §6** that S2 doesn't list: what "approved" means next to "scheduled" on the posts
  tabs, and a hint for "Series" on the Generate form beyond the Generate page description. Readable wording for
  publish-attempt *outcomes* in the attempt logs (Failures and post detail) is also out: these are attempt outcomes,
  not target statuses. No later entry owns these.
- **Other `/p/new` and Invitations fixes** from the audit's §1: a Cancel or back link on `/p/new`, its `self-start`
  submit button, the invitation expiry shown as a UTC string, and the Invitations empty-state link's focus ring. No
  later entry owns these.
- **Renaming URLs or public API names.** `/voice`, `/jobs` and the API's "Jobs" tag stay as they are.
- **Empty states.** Entry 2 handled them; this entry only adds headers above them.

## Assumptions

- Activity goes last in Project (Accounts, Settings, Activity), in the order the roadmap entry and the request list
  it. Activity is history across the project, not a publishing step. Problem notifications have no project nav item
  (they live in the header bell and `/notifications`), so they don't affect the nav. Video added no route.
- "Every route" means every page in the project shell plus `/invitations`, the one signed-in page outside a project
  without a page header (`/activity` and `/notifications` already have one). Signed-out and first-run card pages,
  error pages, not-found pages and loading screens keep their existing pattern (Edge Cases).
- The posting-slot definition goes in the connected-accounts section, directly above the account cards and their slot
  editors. That way it shows once, to every role (editors see slots read-only and meet the term on Calendar and
  Compose), and it survives entry 4's card restructure. Placing it inside each card would repeat it per account.
- The new time zone hint applies only on `/p/new`, where the request asks for it. Changing the shared default hint
  would also change Project settings, which this entry doesn't need to touch.
- The role descriptions are worded from the permission table in `src/server/auth/access.ts`: editors can view
  accounts, slots and voice but not manage them, and can't update the project. Admins manage everything except
  inviting owners and changing roles.
- No data, permission, service or API changes are needed. Every change is copy, order or the use of existing
  primitives (`PageHeader`, `SegmentedControl` cards, `StatusBadge`'s vocabulary, field hints). No new shared
  component is added.
