# Roadmap: first-time project experience

Goal: make the first visit to a Docket project self-explanatory. A newcomer opening a project was "instantly confused
— option overload". Today the project home (`src/app/p/[projectSlug]/page.tsx:16-19`) is a bare heading and "Pick a
section from the navigation to get started", beside 11 equal-weight nav items (`src/components/shell/LeftNav.tsx:10-22`)
where the required first step, Accounts, is 10th. Prerequisites (account → posting slots → post; LLM + voice for
generation) surface one at a time or only after a failed action.

Source: a usability audit of the first-visit path, recorded in `docs/research/onboarding-audit.md` (findings with
file:line citations, recommendations M1–M3, S1–S3, C1–C5). Read it in full before specifying any entry. The audit was
written against the code of 2026-10-08, before the video roadmap's entries landed; re-check every cited line against the
current code, since some pages (Media, Compose, Accounts) changed. Follow `docs/design-system.md` and the docket-ui
skill for all UI.

Rules for every entry:
- Must leave the repo working and say what it does not do, and which later entry owns it.
- Never derive a person's name from their email: show member display names only.
- Role-aware: editors cannot manage accounts, slots or voice; never show them actions they can't take, server
  commands or env var names. Point them to the owners and admins by display name.
- Prefer existing primitives (PageHeader, Card, EmptyState, Badge, StatusBadge, ProviderIcon, LocalTime, Skeleton,
  Alert, buttonStyles). Add a new shared component only when the audit says so, and document it in the design system.
- Tests pin some labels ("Review (3)", ">Failures<", Review above Failures in `tests/integration/failures/nav.test.ts`).
  Keep them unless the entry says otherwise.
- Other features landed since the audit (activity history, problem notifications, video). Fold their screens into the
  overview and nav decisions rather than ignoring them.

## Entries, in order

1. **Project overview and getting started.** Audit M1 + M2 and the Overview nav entry. A real project home with
   PageHeader (project name, time zone, the viewer's role, one primary action), a self-deriving Getting started
   checklist (connect an account, add posting slots, write and schedule a first post; optional voice profile, media,
   invite a teammate; an owner-only server-setup row that links to docs instead of printing commands; collapses to a
   one-line "Setup complete" once required steps are done, no stored dismissal), and sections Needs attention,
   Coming up, Accounts, Posts by status and Content tools, each with a populated view and an empty state whose action
   is the dependent next step ("You don't have any accounts yet — add one", "No scheduled posts yet — write one").
   Skeleton loading, tab title = project name, Overview first in the nav with an exact-match active state.
   Not included: nav reordering, other routes' empty states, terminology, stored dismissal, a slot-count service.

2. **Empty states that name the next step, and role awareness.** Audit M3 across Accounts (role-aware copy, connect
   section for managers only, unconfigured platforms collapsed for owners), Calendar (empty state replaces the grid;
   "add posting slots" when there are accounts but no slots), Compose (explain before the click that Add to queue
   needs posting slots, with a link), Posts, Failures, Review, Generate and Jobs (all prerequisites at once, env var
   names to owners only), Media (hide the toolbar when empty; "images and videos"), Voice, and the scheduler-health
   banner (editors get plain copy, owners the commands). EmptyState actions use buttonStyles. Not included: renamed
   nav labels, PageHeader descriptions, the Accounts card restructure.

3. **Terminology, page descriptions and nav order.** Audit S1 + S2: nav groups Overview / Publish (Compose, Calendar,
   Posts, Review, Failures) / Create (Generate, Brand voice, Media, Batch jobs) / Project (Accounts, Settings, and
   Activity if present); "Voice" → "Brand voice", "Jobs" → "Batch jobs" (keep Review and Failures); a one-line
   PageHeader description on every route; define "posting slot" once by the slot editor; human-readable target
   statuses; "Targets" → "Accounts"; role descriptions on invite, signup and invitations; hints on the voice editor;
   clearer `/p/new` copy and time zone hint. Update `docs/design-system.md` §6 and the docket-ui skill. Not included:
   showing or hiding nav items by project state.

4. **Accounts restructure and first-post flow.** Audit S3 + C1, C3, C4, C5: each account card ordered status →
   posting slots → posting instructions (collapsed) → remove; after connecting, land on that account's slot editor;
   a SetupNotice variant for prerequisite lists; after a first schedule or publish, link to the calendar; a
   `docs/getting-started.md` page linked from the checklist; the project switcher's accessible name without the
   shortcut, and the setup password hint linked with aria-describedby. Not included: a dismissible checklist (needs a
   stored per-user preference and its own decision).
