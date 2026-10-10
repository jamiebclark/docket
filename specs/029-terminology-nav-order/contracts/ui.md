# UI contract: nav, page headers and terms

What each screen must render after this entry. It's the reference for tests and review. Decisions behind each item
are in [research.md](../research.md). Code-level shapes are in [modules.md](./modules.md).

## 1. Project nav (`src/components/shell/LeftNav.tsx`)

Rendered order, desktop and phone strip alike (FR-001, SC-002):

| Position | Group heading (desktop only) | Label | href | Active rule |
|---|---|---|---|---|
| 1 | (none) | Overview | `/p/{slug}` | exact (`/p/{slug}` or `/p/{slug}/`) |
| 2 | PUBLISH | Compose | `/p/{slug}/compose` | prefix |
| 3 | | Calendar | `/p/{slug}/calendar` | prefix |
| 4 | | Posts | `/p/{slug}/posts` | prefix |
| 5 | | Review | `/p/{slug}/review` | prefix |
| 6 | | Failures | `/p/{slug}/failures` | prefix |
| 7 | CREATE | Generate | `/p/{slug}/generate` | prefix |
| 8 | | Brand voice | `/p/{slug}/voice` | prefix |
| 9 | | Media | `/p/{slug}/media` | prefix |
| 10 | | Batch jobs | `/p/{slug}/jobs` | prefix |
| 11 | PROJECT | Accounts | `/p/{slug}/accounts` | prefix |
| 12 | | Settings | `/p/{slug}/settings` | prefix |
| 13 | | Activity | `/p/{slug}/activity` | prefix |

These stay exactly as they are:

- **Counts**: Review with n > 0 has the screen-reader text "Review (n)", plus a pill. Failures with n > 0 has
  "Failures (n)"; with n = 0 it renders `>Failures<` and no "Failures (" (FR-002).
- **Icons**: every item keeps its icon key (FR-004).
- **Phone strip**: no group headings below `md` (spec "Not included").
- **Fixed list**: nothing is added, removed or reordered by role, project state or server config (FR-003).

## 2. Page headers

Every row renders `PageHeader`: exactly one `<h1>` with the title, and one `<p>` description right after it (FR-010,
SC-001). "Actions" go in `actions`. "Aside" goes in the new `aside` slot, beside the `<h1>` and outside it. "Below"
is content kept on the page, right after the header (FR-015). `{tz}` is the project time zone.

| Page (file) | Title | Description | Actions | Aside | Above / below the header |
|---|---|---|---|---|---|
| Overview (`(overview)/page.tsx`) | unchanged | unchanged | unchanged | — | unchanged |
| Compose (`compose/Composer.tsx:330`) | "Compose" / "Edit post" | "Write once, tailor per account, then queue, schedule or publish." | — | — | unchanged |
| Compose, no accounts (`compose/Composer.tsx:248`) | "Compose" | same as Compose | — | — | below: the existing `EmptyState` |
| Calendar (`calendar/page.tsx:83`) | `calendar.title` (e.g. "October 2026") | "Scheduled posts and open posting slots, in {tz}." | — | — | below: toolbar and grid, or the empty state. The `· {tz}` span is removed (FR-016) |
| Posts (`posts/page.tsx:93`) | "Posts" | "Everything written or generated in this project." | "New post" (same condition as now) | — | above: `ProblemsCallout` (unchanged); below: filter tabs, list |
| Post detail (`posts/[postId]/page.tsx:64`) | "Post", `titleId="page-title"` | "Where this post goes, its status on each account, and every publish attempt." | Edit, Delete (same conditions) | `StatusBadge` of the post | above: the "Posts" back link |
| Review (`review/page.tsx:36`) | "Review" | "Generated posts waiting for someone to approve them." | — | — | below: list or the existing empty state |
| Failures (`failures/page.tsx:178`) | "Failures", `titleId="page-title"` | "Posts that didn't go out, and what you can do about them." | — | — | below: the totals line "{n} need your decision · {n} failed" (same condition), then the filters |
| Generate (`generate/page.tsx:38`) | "Generate" | "Draft one post, or a series of related posts, in your brand voice." | — | — | below: the "Generation mode" tabs, in both the prerequisites and form branches |
| Generated post (`generate/result/[postId]/page.tsx:61`) | "Generated post" | "What was generated, and what it was generated from." | — | `StatusBadge` of the post | below: the decision line |
| Series (`generate/series/[seriesId]/page.tsx:32`) | "Series" | "A run of related posts generated from one brief." | — | — | below: the brief paragraph |
| Brand voice (`voice/page.tsx:35`) | "Brand voice" | "How generated posts should sound." | "New voice profile" (managers) | — | below: filter tabs, list |
| New voice profile (`voice/new/page.tsx:16`) | "New voice profile" | "Describe how generated posts should sound." | — | — | below: editor |
| Voice profile (`voice/[profileId]/page.tsx:27`) | profile name | "One voice profile: how generated posts should sound, with examples." | — | — | below: archived banner (if any), editor |
| Voice profile history (`voice/[profileId]/history/page.tsx:44`) | "{name}: history" | "Earlier versions of this voice profile." | — | — | below: "Back to the profile" link, table |
| Media (`media/page.tsx:79`) | "Media" | "Images and videos you can attach to posts." | — | — | unchanged |
| Batch jobs (`jobs/page.tsx:62`) | "Batch jobs" | "Generate many posts at once from images or a CSV file." | "New batch job from CSV" and "Choose images in Media" (same conditions) | — | below: prerequisites, list |
| New batch job (`jobs/new/page.tsx:53`) | "New batch job" | "Generate one post for each image you chose." | — | — | below: prerequisites or form, in both branches |
| New batch job from CSV (`jobs/new/csv/page.tsx:31`) | "New batch job from CSV" | "Generate one post for each row of a CSV file." | — | — | below: prerequisites or form |
| Batch job (`jobs/[jobId]/page.tsx:64`) | `job.sourceSummary` | "One batch job: its settings, progress and the posts it made." | — | `StatusBadge` of the job; "Open: accepting items" (same condition) | below: "Created by …" block, details |
| Accounts (`accounts/page.tsx:102`) | unchanged | unchanged | unchanged | — | see §3.1 |
| Connect, expired (`accounts/connect/[attemptId]/page.tsx:34`) | "Connect accounts" | "Choose which accounts to add to this project." | — | — | below: the alert and back link |
| Connect (`…/[attemptId]/page.tsx:44`) | "Connect {groupDisplayName}" | "Choose which accounts to add to this project." | — | — | below: "This choice is available until {time}." (first sentence dropped), notices, form |
| Activity (`activity/page.tsx:55`) | unchanged | unchanged | — | — | unchanged |
| Project settings (`settings/page.tsx:39`) | "Project settings" | "The project's name, time zone, and how new posts are approved and scheduled." | — | — | below: form, cards |
| Members & invitations (`settings/members/page.tsx:52`) | "Members & invitations" | "Who works in this project, and invitations that haven't been accepted yet." | — | — | below: panels |
| API keys (`settings/api-keys/page.tsx:28`) | "API keys" | "Keys let tools like n8n use this project's API." | — | — | below: "Each key works only in this project, only for the permissions you tick.", then the two links |
| Webhooks (`settings/webhooks/page.tsx:28`) | "Webhooks" | "Docket can tell another service when posts publish or fail, when a job finishes, or when an account needs reconnecting." | — | — | below: signatures link, panel |
| Webhook (`settings/webhooks/[endpointId]/page.tsx:73`) | "Webhook: {host}" | "Where this webhook sends events, and its recent deliveries." | — | — | above: "All webhooks" back link |
| Invitations (`src/app/invitations/page.tsx:23`) | "Invitations" | "Projects you've been invited to join." | — | — | below: list or empty state |

These keep their current heading pattern (spec Edge Cases):

- **Error, not-found and loading pages.** The two voice loading screens change only their `<h1>` text to "Brand
  voice".
- **Signed-out and first-run card pages**: `/login`, `/setup`, `/signup`, `/p/new`, `/connect/invalid`.

### Browser tab titles

`metadata.title`, rendered through the root template "%s · Docket" (FR-006, FR-007, SC-005):

| Route | Title |
|---|---|
| `voice` | "Brand voice" |
| `jobs` | "Batch jobs" |
| `jobs/new` | "New batch job" |
| `jobs/new/csv` | "New batch job from CSV" |
| `jobs/[jobId]` | "Batch job: {sourceSummary}" |

Every other title is unchanged, including "Voice profile" and "Voice profile history".

### Other renamed strings

- **Job page**: `<dt>Targets</dt>` becomes `<dt>Accounts</dt>` (FR-040). The values, including "(removed)", are
  unchanged.
- **Kept**: the job page's `<dt>Voice</dt>` and the voice editor's "Voice" legend (FR-008).

## 3. Terms

### 3.1 Posting slot (Accounts)

When the project has 1 or more accounts, the connected-accounts section renders, right after its `<h2>` and before
the first card, exactly once:

> **Posting slots:** Weekly times this account posts at. Add to queue fills the next free slot.

- It renders for every role.
- It doesn't render with 0 accounts.
- No other page gets a definition (FR-020, FR-021).

### 3.2 Target statuses (Posts list)

Each target badge reads `{accountName}: {label}`, with an optional ` · {note}`. The tone comes from the shared
vocabulary (FR-030, FR-031, SC-003):

| status | label | tone |
|---|---|---|
| draft | Draft | neutral |
| scheduled | Scheduled | brand |
| publishing | Publishing | info |
| published | Published | success |
| failed | Failed | danger |
| ambiguous | Needs your decision | warning |
| cancelled | Cancelled | neutral |
| anything else | the key with `_` → space | neutral |

### 3.3 Roles

Display names and descriptions, the same on every screen (FR-051, SC-004):

| key | label | description |
|---|---|---|
| editor | Editor | Writes, schedules and generates posts, and uploads media. Can't connect accounts or change posting slots, brand voice or settings. |
| admin | Admin | Everything an editor can do, plus accounts, posting slots, brand voice, settings and invitations. Can't invite owners or change members' roles. |
| owner | Owner | Full control, including inviting owners, changing roles and transferring ownership. |

Where they show:

- **Invite form** (`settings/members/invitations-panel.tsx`): a "Role" radio group in `cards` layout, with each
  card's description linked to its radio by `aria-describedby`. Order: Editor, Admin, then Owner, only when
  `canInviteOwner`. Editor is checked by default. Below it sits the Invite button (FR-050).
- **Pending invitations table**: the role cell shows the label ("Editor"), not the key.
- **Members table**: role labels as today (same text, from the shared source).
- **Signup** (`src/app/signup/page.tsx`), in the `signup`, `login_required` and `accept` states:
  "{inviter} invited you to **{project}** as **{label}**.", then the description as a muted line (FR-052).
- **Invitations** (`src/app/invitations/page.tsx`), per item: "Join as **{label}**. Invited by {inviter}. Expires
  {UTC}.", then the description as a muted line (FR-053).

### 3.4 Voice editor hints

Each hint sits under its label, linked to the textarea by `aria-describedby`. It shows in edit and read-only modes,
and the error (when present) is linked too (FR-060):

| Field | Hint |
|---|---|
| Voice and tone | How posts sound, e.g. 'warm, plain-spoken, a little dry'. |
| Audience | Who reads this, e.g. 'indie game developers'. |
| Topics and pillars | What posts are about, e.g. 'release notes, behind the scenes, tips'. |
| Avoid | Words, topics or styles to leave out, e.g. 'hype, exclamation marks, competitor names'. |

### 3.5 `/p/new`

- **Under "Create a project"**: "Next you'll connect a social account and choose when it posts." (FR-070)
- **Time zone hint**: "Posting times and the calendar use this zone.", linked to the combobox (FR-071).
- **Project settings**: keeps "Dates, slots and the calendar use this zone."

## 4. Copy rules

These hold for everything in §2 and §3 (FR-013, SC-007):

- no env var name;
- no server command;
- no person's name taken from an email address;
- no action the viewer can't take;
- every description is one sentence and doesn't vary by role.
