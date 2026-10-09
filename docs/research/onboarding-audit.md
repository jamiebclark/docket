# Onboarding usability audit: first visit to a project

Audited 2026-10-08 by reading code, before the video roadmap's later entries landed. There was no browser and no 390 px
check, and nothing was edited. `[p]` means `src/app/p/[projectSlug]`. Re-check each file:line against current code
before relying on it.

**The main problem:** the first page inside a project gives no guidance. It shows the project name and "Pick a section
from the navigation to get started." (`[p]/page.tsx:16-19`), next to 11 equal-weight nav items. The only empty state
that points to the real first step (Accounts) is on Compose, the third nav item.

## 1. First visit, screen by screen

| # | Screen | What the person decides | Findings |
|---|---|---|---|
| 1 | `/` | Nothing: it redirects to `/setup`, `/login`, the last or earliest project, or `/p/new` (`src/app/root-redirect.ts:7-18`) | — |
| 2 | `/setup` (`src/app/setup/page.tsx:13-19`) | name, email, password | Clear. The password hint is not linked to the input; only the error is (`setup-form.tsx:26,29`) |
| 3 | `/p/new` (`src/app/p/new/page.tsx:16-21`) | name, URL name, time zone | The first sentence is jargon: "holds its own accounts, posting slots, voice and team" (`:19`). The time zone's purpose isn't explained (`new-project-form.tsx:69`). There's no Cancel or back link for someone who already has projects. The submit button is `self-start` (`:73`) |
| 4 | Invited instead: `/signup?token` (`src/app/signup/page.tsx:40-50`) | name, password; accept or decline | The role is shown as a raw lowercase key ("as **editor**") with no explanation (`:42`) |
| 5 | `/invitations` (`src/app/invitations/page.tsx:33-34`) | accept or decline | Raw role key again. Expiry is shown with `toUTCString()`. The empty-state link has no `ring-focus` (`:25`) |
| 6 | Lands on `/p/[slug]` (`p/new/actions.ts:31`, `signup/actions.ts:31`) | nothing on the page | Bare `h1` with no `PageHeader` (`[p]/page.tsx:17`). The tab title is the slug, not the project name (`:9`). `[p]/loading.tsx:1-7` is a "Loading…" line, not a skeleton |

So a new owner makes 6 decisions across 2 forms, then lands on a page with nothing to act on.

## 2. Project shell on first arrival

- **Choices: 15 interactive elements and 0 guidance.**
  - Header (4): logo, project switcher, Invitations, Sign out (`SignedInHeader.tsx:24-38`).
  - Nav (11): Calendar, Posts, Compose, Review, Failures / Generate, Jobs, Media, Voice / Accounts, Settings (`LeftNav.tsx:10-22`).
  - Body: 0.
- **Nav order follows daily use, not the order a new user needs.** Accounts, which is required first, is 10th (`LeftNav.tsx:20`).
- **There is no "Overview" or "Home" item.** The only way back is the logo, through `/` (`SignedInHeader.tsx:24`).
- **On a phone the nav is a strip of 11 items with no group labels** (`LeftNav.tsx:55`). At 390 px, 3–4 are visible.
- **The scheduler banner is the loudest thing on the first screen.** On a fresh install the worker hasn't run (`RUN_WORKER_IN_PROCESS` defaults to false, `src/server/env.ts:262`).
  - Every member, editors included, gets a red `role="alert"` banner containing `docker compose`, an env var and a `POST /api/internal/tick` command (`SchedulerHealth.tsx:64-87`, rendered at `layout.tsx:54`).
  - It is ops instructions, not a next step.
  - `ReauthBanner` already handles roles (`ReauthBanner.tsx:33-45`); this banner doesn't.
- **Project switcher:** fine (combobox, ⌘K). The `kbd` is part of the button's accessible name, so it reads "Acme Launch Ctrl/⌘ K" (`ProjectSwitcher.tsx:85-87`).
- **Already good:** API keys and Webhooks are under Settings, for owners and admins only (`[p]/settings/layout.tsx:15-28`).

## 3. Each destination when the project is empty (owner view)

| Destination | Shows when empty | Says what to do next? | Depends on something not done yet | File:line |
|---|---|---|---|---|
| Calendar | Prev/Today/Next, a Month/Week toggle and an Account filter (only "All accounts"). Then an EmptyState, then a full empty month grid underneath | "No posts or posting slots in this period. Posting slots are set per account." → Go to Accounts | Accounts, then slots. "Slot" is never explained. The link is shown to editors too | `calendar/page.tsx:64-115` |
| Posts | 11 filter tabs, all at 0, then "No posts yet. Write your first post…" → an underlined "Write a post" | Partly. The link goes to Compose, which then says to connect an account | Accounts | `posts/page.tsx:39,88,96-106` |
| Compose | "No accounts are connected yet. Connect an account…" → Go to Accounts. Editors are told to ask an owner or admin | Yes. This is the best empty state in the app | — | `compose/Composer.tsx:182-199` |
| Compose with an account but no slots | 4 buttons; the magenta CTA is "Add to queue…" | No. It saves a draft first, then the dialog says "…has no active posting slots. Add or resume a slot first." with no link | Slots | `Composer.tsx:425-437`, `ScheduleDialogs.tsx:100`, `src/server/services/queue/index.ts:63` |
| Review | "Nothing to review" (no full stop) → "Generate a post" | No. It doesn't say what Review is for, or that hand-written posts never come here | LLM, voice profile, account | `review/page.tsx:36-44` |
| Failures | "0 need your decision · 0 failed", tabs, an Account filter, then "Nothing needs attention. Every post that was due went out or is still scheduled." | Misleading in a project with no posts at all | — | `failures/page.tsx:178-182,223` |
| Generate | Checks one gate at a time: LLM, then voice, then accounts. You find the next missing thing only after fixing the previous one | Partly | LLM (server), voice, accounts | `generate/page.tsx:50-91` |
| Generate without an LLM | Shows env var names to everyone, editors included | Not for editors | Server config | `generate/page.tsx:56` |
| Jobs | Header links "New job from media" (which goes to `/media`, not to a job) and "New job from CSV", repeated inside the EmptyState. A bespoke `rounded-md` "Generation is not configured" box lists env var names | Partly | LLM, voice, accounts, media or CSV | `jobs/page.tsx:42-51,59-63,65` |
| Media without storage | "Media storage is not set up. Ask an administrator to configure S3-compatible storage, then you can upload images here." | Partly. It says "images", but video is now supported too | Server config | `media/page.tsx:74` |
| Media, empty | Dropzone, search, 3 tabs and a disabled "No unused images to generate for" pill (a bespoke `rounded-md` span), then "No images yet. Upload your first image above." | Yes, but buried under 6 controls | — | `media/page.tsx:77-128,103` |
| Voice | "New voice profile" button and "Active / Include archived" tabs, then "No voice profile yet. Create one so generated posts sound like you." | Yes. Good copy for both roles | — | `voice/page.tsx:32-52` |
| Voice editor | Fields "Voice and tone", "Audience", "Topics and pillars" and "Avoid", with no hints | No examples | — | `voice/VoiceEditor.tsx:190-193` |
| Accounts | "No accounts are connected yet. Add one below to start scheduling posts." Then a grid of every connect group (Meta, Threads, X), Bluesky credentials and, in dev, the mock. Each unconfigured group shows "not configured on this server" and a redirect-URI copy box | Yes for owners, but they get a wall of server setup cards | Server-side app credentials | `accounts/page.tsx:106-112,233-277`, `ConnectGroupSection.tsx:62-78` |
| Accounts with one account | One card holding a header, notes, the posting-instructions form, the slot table ("No posting slots yet."), the slot editor and Remove | The slot step is the second sub-form in the card, and nothing explains what slots do | — | `accounts/page.tsx:186-227,200-201` |
| Settings | The project settings form. The policy options are explained well | n/a | — | `settings/settings-form.tsx:71-92` |

## 4. The order a new user actually needs (owner or admin)

0. **Server prerequisites:** the scheduler running, platform app credentials, an LLM for generation, and S3 for media. These only appear as scattered banners and cards.
1. **Connect an account.** Required for everything.
2. **Add posting slots.** Needed for "Add to queue" and for auto-queue jobs. Not needed for Schedule or Publish now.
3. **Make a post.** Write one and schedule or publish it, or create a **voice profile**, Generate, then Review.
4. *(Optional)* Upload media, which Instagram and media jobs need. Invite teammates.

The UI conveys this order poorly:
- Only Compose (`Composer.tsx:186-196`) and Generate (`generate/page.tsx:81-90`) say "do X first".
- Generate reveals its prerequisites one at a time, and in the wrong order (voice before accounts).
- Nothing mentions slots before the CTA that needs them.

## 5. What an editor sees in an empty project

Editors can't manage accounts, slots or voice (`src/server/auth/access.ts:50-59`).
- **Accounts:** they're told "Add one below…" (`accounts/page.tsx:111`), then shown a connect section with no buttons, because `groups.length > 0` (`:233`). Unconfigured groups show redirect URIs to editors too (`ConnectGroupSection.tsx:62-78`, no `canManage` check).
- **Calendar:** sends them to Accounts, where they can't do anything (`calendar/page.tsx:109`).
- **Compose, Voice, Generate:** these correctly say "Ask an owner or admin", but none says who that is. The members list is open to them (`member: ["view"]`).
- **Scheduler banner, Generate, Jobs:** these show server commands and env var names (`SchedulerHealth.tsx:75-86`, `generate/page.tsx:56`, `jobs/page.tsx:61`).
- **Invitations:** neither the invite form nor signup explains the roles (`settings/members/invitations-panel.tsx:106-110`, `signup/page.tsx:42`).

## 6. Terms a newcomer won't know

| Term | Where | Problem |
|---|---|---|
| Queue / "Add to queue" | `Composer.tsx:436`, `settings-form.tsx:92` | The main action, and never defined |
| Posting slots | `calendar/page.tsx:107`, `accounts/page.tsx:91,199` | Never explained ("weekly times this account posts at") |
| Voice / voice profile | nav `LeftNav.tsx:19`, `voice/page.tsx:31` | "Voice" in the nav sounds like audio |
| Jobs | `LeftNav.tsx:17`, `jobs/page.tsx:56` | Generic; it means batch generation from media or CSV |
| Review | `LeftNav.tsx:14` | Doesn't say it only holds AI-generated posts |
| Failures / "Needs your decision" / `ambiguous` | `posts/page.tsx:127` shows the raw target status ("Acme: ambiguous") | Internal term |
| Targets | `jobs/[jobId]/page.tsx:108` | Internal term; it means accounts |
| Series, Brief | `generate/page.tsx:43`, `GenerateForm.tsx:195` | Brief has a hint; Series doesn't |
| Approved vs Scheduled | `posts/page.tsx:28` | It isn't obvious that "approved" means not yet scheduled |

## 7. Accessibility and mobile

- **Focus rings:** EmptyState actions are plain `text-sm underline` links with no `ring-focus` and no `buttonStyles`. See `posts/page.tsx:99,103`, `review/page.tsx:40`, `voice/page.tsx:52`, `generate/page.tsx:74,87`, `Composer.tsx:190`, `failures/page.tsx:226` and `invitations/page.tsx:25`.
- **Bespoke status boxes** are used instead of `Alert`: `jobs/page.tsx:60`, `media/page.tsx:103`.
- **No `PageHeader`** on home, Posts, Calendar, Review, Voice, Jobs, Media, Generate, Failures or Settings (design-system backlog item 1).
- **Calendar at 390 px:** the toolbar wraps to 2–3 rows above an empty-state card and an empty grid (`calendar/page.tsx:64-115`).
- **Jobs table:** 10 columns, which stack into tall cards on phones (`jobs/page.tsx:70`).
- **Composer action row:** wraps its 4 buttons onto 2 lines on phones (`ActionBar.tsx:36`).

## Recommendations

### Must

**M1. A real project home** at `[p]/page.tsx`. It's a server component that only reads services.

- **Header:** a `PageHeader` with the project name and a description such as "Times in {tz}. You're an {Role}." The tab title becomes the project name.
  - One `primary` action: "Connect an account" when there are no accounts and the viewer can manage them; otherwise "Write a post", linking to Compose.
  - No `cta` button here.
- **Getting started:** a `Card`, shown first while unfinished (see M2).
- **Needs attention:** a `Card`, shown only when one of these is non-zero. Each item uses `Badge` or `StatusBadge` and links to where it's handled.
  - Awaiting review (`countReviewQueue`).
  - Needs your decision (`countNeedsDecision`). This and the review count are already loaded in `layout.tsx:38-39`.
  - Failed (`posts.listPosts(...).counts.failed`).
  - Accounts needing reconnecting (`listAccountsNeedingReauth`).
  - Credentials expiring within 14 days (`AccountView.credentialsExpireAt`, `src/server/services/accounts.ts:31`).
- **Coming up:** a `Card`.
  - Populated: the next 5 scheduled posts with `LocalTime` and account badges, plus "Open calendar". Use `getCalendar(scope, { view: "week" })` or `listPosts({ status: "scheduled" })`, and check whether `scope.posts.list` sorts soonest first.
  - Empty: "No scheduled posts yet. Write one and schedule it." with "Write a post". If there are no accounts, it says "Connect an account first." instead.
- **Accounts:** a `Card`.
  - Populated: one row per account with:
    - `ProviderIcon`;
    - a status `Badge` (Connected / Needs reconnecting);
    - "{n} posting slots a week", or "No posting slots — add some" linking to `accounts#account-{id}`;
    - the credential expiry.
  - Empty, for managers: "You don't have any accounts yet." with "Add an account".
  - Empty, for editors: "No accounts yet. Ask {owner/admin display names} to connect one." Use member display names only; never derive a name from an email.
- **Posts by status:** a `Card` with counts for Drafts, Needs review, Approved but not scheduled, and Scheduled. Each count links to `posts?status=…`, using `list.counts` (`src/server/services/posts/list.ts:31,68`).
  - Empty: "No posts yet." with "Write a post".
- **Content tools:** a small `Card` with the voice profile and media counts. Each appears only when that feature is configured (`getLlmStatus`, `media.mediaStatus`).
  - Empty: "No voice profile yet. Generated posts need one." with "Create a voice profile" for managers.
- **Loading:** a `Skeleton` layout in `[p]/loading.tsx`.
- **Reuse:** `PageHeader`, `Card`, `EmptyState`, `Badge`, `StatusBadge`, `ProviderIcon`, `LocalTime`, `buttonStyles`, `Skeleton`, `Icon`.
- **Data gap:** no service counts slots across the whole project. `accounts/page.tsx:85` loops `slots.listSlots` per account, which is fine for v1.
- **Nav:** add "Overview" at the top of `NAV_SECTIONS` (`LeftNav.tsx:10`). It needs a special-cased href and an exact-match active check, because `/p/x` would otherwise prefix-match every route (`:58-59`).

**M2. A getting-started checklist that works out its own state.** Put it in a new `src/components/ui/Checklist.tsx`, or as a project component under `src/components/shell/`, and add it to the design-system §7 table.

- **Structure:** an `<ol>` of steps. Each step has its status in text ("Done", "To do", or "Waiting on an owner or admin"), an `aria-hidden` `Icon`, one line of explanation and a single action link.
- **Steps:**
  1. Connect an account (required).
  2. Add posting slots: "weekly times Docket uses when you Add to queue" (required for queueing).
  3. Write and schedule your first post. Done when any post is scheduled or published.
  4. *Optional:* create a voice profile. Shown only if an LLM is configured.
  5. *Optional:* upload media. Shown only if storage is configured.
  6. *Optional:* invite a teammate.
- **Editors:** steps 1, 2 and 4 show "Waiting on {names}" and have no action.
- **Server setup row, owners only:** shown only while the scheduler is stale or the LLM, storage or a platform is missing. It links to the docs (`docsUrl("deployment")`, `"storage"`, `"meta-setup"`) instead of printing commands.
- **When it goes away:** no stored dismiss state. Once the required steps are done it collapses to a one-line "Setup complete" link. It disappears once the optional steps are done too, or once the project has been publishing for a while.

**M3. Empty states that name the next step and respect roles.**

- **Accounts:**
  - Role-aware copy (`accounts/page.tsx:111`).
  - Hide the connect section from editors (`:233`).
  - Show unconfigured groups to owners only, collapsed into one `<details>` titled "Not set up on this server (n)", with setup-guide links (`ConnectGroupSection.tsx:62-78`). Configured groups' Connect buttons go at the top.
- **Calendar:**
  - With no accounts, show the EmptyState instead of the grid and toolbars, with role-aware copy (`calendar/page.tsx:105-115`).
  - With accounts but no slots: "Add posting slots to see open times here."
- **Compose:**
  - When none of the selected accounts has an active slot, the `ActionBar` message says "Add to queue needs posting slots. Add slots in Accounts", with a link.
  - This needs a per-account `hasActiveSlots` flag from `compose/page.tsx:21`. It's a read only; no action result changes.
  - Consider making "Schedule…" the `cta` in that case (`Composer.tsx:425-437`).
- **Posts:** hide `FilterTabs` while the total is 0 (`posts/page.tsx:88`), and use `buttonStyles` for the action (`:103`).
- **Failures:** with no posts at all, say "Posts that fail to publish will show up here." and hide the tabs and filter (`failures/page.tsx:178-223`).
- **Review:** "Generated posts wait here for approval before they're scheduled. Posts you write yourself don't come here." with "Generate a post". If a prerequisite is missing, link to Voice or Accounts instead (`review/page.tsx:36-44`).
- **Generate and Jobs:**
  - Check every prerequisite at once (LLM, voice profile, account, media or CSV) and show one checklist (`generate/page.tsx:50-91`, `jobs/new/page.tsx` ~`:97-101`).
  - Env var names go to owners only. Editors see "Ask an owner or admin to turn on AI generation."
- **Jobs page:**
  - The header gets one primary action, "New job from CSV". "New job from media" becomes a secondary "Choose images in Media".
  - Remove the duplicate EmptyState actions (`jobs/page.tsx:42-65`).
  - Use `Alert` for the not-configured note (`:60`).
- **Media:**
  - When the library is empty and no filter is set, hide the search, tabs and disabled pill (`media/page.tsx:78-107`).
  - Say "images and videos" (`:74,128`).
  - Use `Alert` instead of the span (`:103`).
- **Voice:** hide "Include archived" when there are no profiles (`voice/page.tsx:38-44`).
- **SchedulerHealth:** pass `canManage` to it (`SchedulerHealth.tsx:75-86`, `layout.tsx:54`). Owners keep the commands; editors get "Scheduled posts are not going out. An owner or admin needs to start the scheduler."
- **All EmptyState actions:** use `buttonStyles({ variant: "secondary" | "primary" })`, not underline links.

### Should

**S1. Nav order and grouping** (`LeftNav.tsx:8-22`). Update design-system §6 and the docket-ui SKILL.md (lines 28-30) to match.

- **Groups:**
  - Overview.
  - Publish: Compose, Calendar, Posts, Review, Failures. Review stays directly above Failures (`tests/integration/failures/nav.test.ts:26`).
  - Create: Generate, Voice, Media, Jobs.
  - Project: Accounts, Settings.
- **Fixed list:** don't add or remove items based on project state.
- **Could:** hide Generate, Jobs and Voice when the server has no LLM configured.
- **Settings:** stays the home for API keys and webhooks.

**S2. Terminology and help text.** Check the tests for each string first.

- **Nav labels:** "Voice" becomes "Brand voice", "Jobs" becomes "Batch jobs". Keep "Review" and "Failures"; tests assert "Review (3)" and ">Failures<".
- **One-line `PageHeader` descriptions on every route:**
  - Posts: "Everything written or generated in this project."
  - Calendar: "Scheduled posts and open posting slots, in {tz}."
  - Review: "Generated posts waiting for someone to approve them."
  - Failures: "Posts that didn't go out, and what you can do about them."
  - Batch jobs: "Generate many posts at once from images or a CSV file."
  - Brand voice: "How generated posts should sound."
- **Define "posting slot" once,** by the slot editor: "Weekly times this account posts at. Add to queue fills the next free slot." (`accounts/page.tsx:199`)
- **Readable statuses:** show target statuses as words, e.g. "needs your decision", not "ambiguous" (`posts/page.tsx:127`). Reuse the `StatusBadge` map.
- **"Targets" becomes "Accounts"** (`jobs/[jobId]/page.tsx:108`).
- **Role descriptions:** on the invite form's role `SegmentedControl`, use `layout="cards"` with descriptions (`invitations-panel.tsx:101-111`). For example, Editor: "writes, schedules and generates posts; can't connect accounts". Use the same wording on `signup/page.tsx:42` and `invitations/page.tsx:33`.
- **Voice editor hints:** e.g. Audience: "Who reads this, e.g. 'indie game developers'" (`VoiceEditor.tsx:190-193`).
- **`/p/new`:** "Next you'll connect a social account and choose when it posts." (`p/new/page.tsx:19`). Time zone hint: "Posting times and the calendar use this zone."

**S3. Restructure the Accounts page** (`accounts/page.tsx:117-228`).

- **Card order:** status and header, then **Posting slots** first, then Posting instructions in a `<details>`, then Remove.
- **After connecting:** send the owner to `#account-{id}` with the slot editor focused. Check whether changing the connect-callback redirect counts as a behaviour change.

### Could

- **C1. `SetupNotice`:** an `EmptyState` variant with a `title` and a list of prerequisites, for the Generate and Jobs gate checklist. Add it to design-system §7.
- **C2. A dismissible checklist.** This needs a stored per-user preference, so record the decision in `docs/decisions.md`.
- **C3. Link to the calendar after a first post.** After a first Schedule or Publish now, the Composer's success message links to "See it on the calendar".
- **C4. A getting-started page.** Write `docs/getting-started.md`, add it to `DocPage` (`src/lib/docs.ts:6-16`), and link it from the checklist.
- **C5. Two accessibility fixes:**
  - Remove the `kbd` from the switcher's accessible name: put `aria-hidden` on the `kbd` and `aria-keyshortcuts="Control+K Meta+K"` on the button (`ProjectSwitcher.tsx:87`).
  - Link the setup password hint with `aria-describedby`, or use `Field` (`setup-form.tsx:26-29`).

## Findings table

| Severity | file:line | Finding | Fix |
|---|---|---|---|
| High | `[p]/page.tsx:16-19` | The project home has no guidance and no actions | M1 + M2 |
| High | `LeftNav.tsx:10-22` | 11 equal-weight items; the required first step is 10th | Overview item, checklist, S1 |
| High | `Composer.tsx:435` + `queue/index.ts:63` | The magenta "Add to queue" fails without slots, only after saving, and with no link | Slot hint in the ActionBar message, with a link |
| High | `generate/page.tsx:50-91` | Prerequisites appear one at a time, voice before accounts | Show every gate at once |
| High | `SchedulerHealth.tsx:64-87` | On first run, a red banner of ops commands that editors see too | Role-aware copy; owners get a docs link |
| Medium | `accounts/page.tsx:111,233` | Editors are told to "Add one below" and shown a connect section | Role-aware copy; gate on `canManage` |
| Medium | `ConnectGroupSection.tsx:62-78` | Every unconfigured platform shows a redirect-URI box, editors included | Owners only, collapsed |
| Medium | `calendar/page.tsx:105-115` | An EmptyState above an empty grid; "Go to Accounts" for editors | Replace the grid; role-aware |
| Medium | `failures/page.tsx:223` | "Every post that was due went out" in a project with no posts | Copy for a new project |
| Medium | `posts/page.tsx:88` | 11 filter tabs, all at 0 | Hide while the total is 0 |
| Medium | `jobs/page.tsx:42-65` | Duplicate actions; "from media" goes to Media; env vars shown to everyone | One primary action; `Alert`; role-aware |
| Medium | `media/page.tsx:77-107` | 6 controls above "No images yet"; says "images" only | Hide the toolbar when empty; "images and videos" |
| Medium | `review/page.tsx:38` | "Nothing to review" doesn't say what Review is | Explain it and link the prerequisite |
| Medium | `signup/page.tsx:42`, `invitations-panel.tsx:106-110` | Roles shown as raw keys | Role descriptions |
| Medium | `[p]/loading.tsx:1-7` | A text "Loading…" line | `Skeleton` |
| Low | `[p]/page.tsx:9` | The tab title is the slug | Use the project name |
| Low | `posts/page.tsx:127` | Raw target status | Readable labels |
| Low | `jobs/[jobId]/page.tsx:108` | "Targets" | "Accounts" |
| Low | `voice/VoiceEditor.tsx:190-193` | No hints | Hints with examples |
| Low | `p/new/page.tsx:19`, `new-project-form.tsx:69` | Jargon; the time zone's purpose isn't explained | Copy and a hint |
| Low | `jobs/page.tsx:60`, `media/page.tsx:103` | Bespoke boxes | `Alert` |
| Low | various EmptyState actions | Underline links with no focus ring | `buttonStyles` |
| Low | `setup-form.tsx:26-29` | The password hint isn't linked | `aria-describedby` |
| Low | `ProjectSwitcher.tsx:87` | The `kbd` is part of the accessible name | `aria-hidden` + `aria-keyshortcuts` |
| Low | `invitations/page.tsx:34` | Expiry shown as a UTC string | `LocalTime` |

**Not checked:** the sort order of `scope.posts.list`, and whether changing the post-connect redirect target counts as a behaviour change.
