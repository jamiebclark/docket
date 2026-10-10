# Implementation Plan: Terminology, page descriptions and nav order

**Branch**: `029-terminology-nav-order` | **Date**: 2026-10-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/029-terminology-nav-order/spec.md`

## Summary

This entry changes words, headings and order only. It covers audit recommendations S1 and S2.

| Area | Change |
|---|---|
| Nav | Overview / Publish (Compose, Calendar, Posts, Review, Failures) / Create (Generate, Brand voice, Media, Batch jobs) / Project (Accounts, Settings, Activity). URLs, icons and active rules unchanged |
| Renames | "Voice" → "Brand voice" and "Jobs" → "Batch jobs" in the nav, headings, tab titles and the voice loading screens; "New batch job", "New batch job from CSV", "Batch job: …"; job page "Targets" → "Accounts" |
| Page headers | Every project page and `/invitations` uses `PageHeader` with a one-sentence description (every row of contracts/ui.md §2). Calendar's zone moves into the description |
| Posting slot | Defined once above the account cards |
| Target statuses | The posts list uses the shared status vocabulary for labels and tones |
| Roles | One source of names and descriptions. Shown as cards on the invite form, and as a description line on signup and Invitations |
| Voice editor | Four hints, linked to their fields |
| `/p/new` | New sentence and a time zone hint |
| Docs | `docs/design-system.md` §6, the docket-ui skill, `docs/generator.md` and `docs/decisions.md` |

The technical approach:

- **Data, not structure, in the nav.** Reorder `NAV_SECTIONS`, change two labels and Activity's group. The render loop
  is untouched, so the phone strip follows automatically.
- **Existing primitives.** `PageHeader` everywhere, with one small additive prop, `aside`, for status badges beside
  the title. `SegmentedControl layout="cards"` for roles. The existing `STATUSES` table read through `statusLabel`
  and a new exported `statusTone`. Field hints via the existing `hint` props, now linked with `aria-describedby` in
  the voice editor.
- **One new pure module**, `src/lib/roles/roles.ts` (`ROLE_OPTIONS`, `roleLabel`, `roleDescription`). It's
  client-safe and adopted by every screen that spells a role.
- **No changes** to the schema, services, DAL, access rules, server actions, public API, env vars, dependencies or
  `docker-compose.yml`.

## Technical Context

**Language/Version**: TypeScript (strict), Node 24 LTS

**Primary Dependencies**: Next.js 16.3.8 (App Router server components; route `metadata.title` with the root
`title.template`, documented in `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-metadata.md:205-251`),
React 19.2.8, Tailwind 4. No new runtime or dev dependency, and no new icon.

**Storage**: PostgreSQL. **No changes**: no table, column, enum, migration or stored preference.

**Testing**: Vitest 5 on a real Postgres:

- **Pure unit tests**: `src/lib/roles/roles.test.ts`, plus an extension of `src/components/ui/ui-atoms.test.ts`.
- **Page-markup tests** (`renderToStaticMarkup`): in a new `tests/integration/terminology/` folder and in the
  existing per-route files. They use the `sessionModule` swap, `postsEnv`, `jobsEnv`, factories and `createFakeLlm`
  seams.
- **A new test helper**: `tests/helpers/page-header.ts` (`expectPageHeader`).
- **A manual walk-through**: desktop and 390 px (quickstart §4).

**Target Platform**: The self-hosted web app (Docker Compose or Neon), on desktop and phone-width browsers.

**Project Type**: A single Next.js web application (`src/app`, `src/components`, `src/lib`, `src/server`).

**Performance Goals**: No new queries or round trips. Every change is static copy, or reads data the page already
loads.

**Constraints**:

- **Accessibility**: one `<h1>` per page; badges outside the heading; hints and errors linked by
  `aria-describedby`; role cards keyboard-operable (native radios); colour never the only signal.
- **Server components by default.** The only client files touched are already client components:
  `invitations-panel.tsx`, `members-panel.tsx`, `Composer.tsx`, `VoiceEditor.tsx` and `new-project-form.tsx`.
- **Pinned test strings**: "Review (3)", ">Failures<" and Review directly above Failures.

**Scale/Scope**:

- **Code**: about 30 page and component files, 1 new module, 1 additive component prop, and 4 docs files.
- **Tests**: about 6 new test files and 4 edited ones.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How |
|---|---|---|
| I. Verified facts over memory | PASS | Every file and line in research R1–R19 was read in the current tree on 2026-10-09. The one framework fact (route `metadata.title`) is cited from `node_modules/next/dist/docs/…/generate-metadata.md`. The role wording is checked line by line against `src/server/auth/access.ts` (R9). No platform API facts are in scope |
| II. Nothing is "working" unless it ran | PASS | Every FR and SC maps to a test in quickstart §2. Layout, focus and 390 px get a real browser walk-through, and the plan says to report it if it can't run. Nothing needs credentials |
| III. Project isolation in one place | PASS | No new data access. Pages keep their existing scoped service calls. The role filter on the invite form is the existing `invitation: create_owner` check, still enforced in the server action. No access rule changes |
| IV. One service layer | PASS | No service changes. Shared UI vocabularies have one home each: `roles.ts` for roles, `STATUSES` for statuses, `NAV_SECTIONS` for the nav. The posts list's local tone map is removed |
| V. Providers are plug-ins | PASS | No provider is named or touched |
| VI. Boring, few dependencies | PASS | No new dependency, infrastructure or icon. The test helper uses string checks, not an HTML parser |
| VII. Secrets never leak | PASS | No new data reaches the browser. Descriptions contain no env var names or commands (FR-013, SC-007, with a test guard). No email-derived names: inviter names come from the existing display-name fields |
| Engineering: accessibility, server components | PASS | See Constraints. `SegmentedControl` cards already link descriptions; `Area` gains hint and error linkage |
| Workflow: commits, checks, docs | PASS (planned) | Conventional commits with explicit paths. Targeted tests per task; the full lint, typecheck, test and build once at the end. Docs: `docs/design-system.md` §6, the docket-ui skill, `docs/generator.md`, and `docs/decisions.md` "029" (R18) |

**Gate result**: PASS. No violations, so Complexity Tracking is empty.

**Post-design re-check (after Phase 1)**: PASS.

- The design adds no table, dependency, permission, service or server action.
- The only shared-component API change is the optional `PageHeader.aside`. Without it the markup is identical, so
  the six existing callers and their tests are unaffected.
- `StatusBadge` gains an exported `statusTone`. Its own output is unchanged.
- Adopting `roles.ts` in the members table and the overview keeps their rendered text identical. The one visible
  change outside the spec's three screens is the pending-invitations table's role cell, which goes from "editor" to
  "Editor" (R9). No test pins the old text.
- The nav change is a data edit, and the Review-above-Failures test still holds by construction.

## Project Structure

### Documentation (this feature)

```text
specs/029-terminology-nav-order/
├── plan.md              # This file
├── research.md          # Phase 0: R1–R20, code survey and decisions
├── data-model.md        # Phase 1: in-code vocabularies (no persisted changes)
├── quickstart.md        # Phase 1: validation guide
├── contracts/
│   ├── ui.md            # nav order, every page header, terms and copy rules
│   └── modules.md       # roles.ts, statusTone, PageHeader.aside, Area, test helper
├── checklists/          # from specify
└── tasks.md             # Phase 2 (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
src/
├── components/
│   ├── shell/LeftNav.tsx                         # EDIT: NAV_SECTIONS order, 2 labels, Activity → Project
│   └── ui/
│       ├── PageHeader.tsx                        # EDIT: optional `aside` prop
│       ├── StatusBadge.tsx                       # EDIT: export statusTone
│       └── ui-atoms.test.ts                      # EDIT: target-status enum sweep
├── lib/
│   ├── roles/roles.ts                            # NEW: ROLE_OPTIONS, roleLabel, roleDescription
│   ├── roles/roles.test.ts                       # NEW
│   └── overview/derive.ts                        # EDIT: ROLE_LABEL from roleLabel (same output)
└── app/
    ├── invitations/page.tsx                      # EDIT: PageHeader; role label + description
    ├── signup/page.tsx                           # EDIT: role label + description in the summary
    ├── p/new/page.tsx                            # EDIT: sentence
    ├── p/new/new-project-form.tsx                # EDIT: time zone hint
    └── p/[projectSlug]/
        ├── accounts/page.tsx                     # EDIT: posting-slot definition
        ├── accounts/connect/[attemptId]/page.tsx # EDIT: PageHeader (both branches)
        ├── calendar/page.tsx                     # EDIT: PageHeader; zone into description
        ├── compose/Composer.tsx                  # EDIT: PageHeader in the no-accounts state
        ├── failures/page.tsx                     # EDIT: PageHeader titleId="page-title"
        ├── generate/page.tsx                     # EDIT: PageHeader + tabs below
        ├── generate/result/[postId]/page.tsx     # EDIT: PageHeader + aside badge
        ├── generate/series/[seriesId]/page.tsx   # EDIT: PageHeader
        ├── jobs/page.tsx                         # EDIT: "Batch jobs", PageHeader, link text, metadata
        ├── jobs/new/page.tsx                     # EDIT: "New batch job", PageHeader, metadata
        ├── jobs/new/csv/page.tsx                 # EDIT: "New batch job from CSV", PageHeader, metadata
        ├── jobs/[jobId]/page.tsx                 # EDIT: PageHeader + aside; "Accounts" row; tab title
        ├── media/page.tsx                        # EDIT: PageHeader
        ├── posts/page.tsx                        # EDIT: PageHeader; target badges via statusLabel/statusTone
        ├── posts/[postId]/page.tsx               # EDIT: PageHeader titleId + aside badge
        ├── review/page.tsx                       # EDIT: PageHeader
        ├── settings/page.tsx                     # EDIT: PageHeader
        ├── settings/api-keys/page.tsx            # EDIT: PageHeader (first sentence → description)
        ├── settings/webhooks/page.tsx            # EDIT: PageHeader (sentence → description)
        ├── settings/webhooks/[endpointId]/page.tsx # EDIT: PageHeader
        ├── settings/members/page.tsx             # EDIT: PageHeader
        ├── settings/members/invitations-panel.tsx # EDIT: role cards; table role label
        ├── settings/members/members-panel.tsx    # EDIT: labels from roles.ts (same text)
        ├── voice/page.tsx                        # EDIT: "Brand voice", PageHeader, metadata
        ├── voice/loading.tsx                     # EDIT: heading text "Brand voice"
        ├── voice/new/page.tsx                    # EDIT: PageHeader
        ├── voice/VoiceEditor.tsx                 # EDIT: four hints; Area hint/error linkage
        ├── voice/voice.test.tsx                  # EDIT: hint assertions (existing :129 loop unchanged)
        ├── voice/[profileId]/page.tsx            # EDIT: PageHeader
        ├── voice/[profileId]/loading.tsx         # EDIT: heading text "Brand voice"
        └── voice/[profileId]/history/page.tsx    # EDIT: PageHeader

tests/
├── helpers/page-header.ts                        # NEW: expectPageHeader
└── integration/
    ├── terminology/nav.test.tsx                  # NEW
    ├── terminology/page-headers.test.tsx         # NEW (incl. Calendar, Accounts definition, posts statuses, /p/new, copy guard)
    ├── terminology/roles.test.tsx                # NEW
    ├── failures/nav.test.ts                      # EDIT: line 27 only (R2)
    ├── roles/routes.test.tsx                     # EDIT: lines 176, 187 (string rename)
    ├── jobs/ui.test.tsx                          # EDIT: lines 66, 76, 107 (string rename); + header/"Accounts" checks
    ├── connect/chooser-ui.test.ts                # EDIT: + expectPageHeader
    ├── api-keys/ui.test.tsx                      # EDIT: + expectPageHeader
    ├── notifications/ui.test.tsx                 # EDIT: + expectPageHeader for Project settings
    └── accounts-ui.test.ts                       # EDIT: + expectPageHeader for Members

docs/
├── design-system.md                              # EDIT: §6 diagram, Sidebar bullet, Page anatomy
├── generator.md                                  # EDIT: lines 55, 61 wording
└── decisions.md                                  # EDIT: "029" section, D1–D12

.claude/skills/docket-ui/SKILL.md                 # EDIT: app-shell bullet + PageHeader/roles lines (sandbox may refuse; R18)
```

**Structure Decision**: This is the existing single Next.js app. Everything sits in the files the routes already
own. The only new source file is `src/lib/roles/roles.ts`, next to the other pure role helpers from entry 2. New
tests go in a `tests/integration/terminology/` folder named after the entry's theme, as earlier entries did
(`roles/`, `overview/`).

## Implementation notes for the tasks phase

- **Order of work**: shared pieces first, then pages, then tests and docs.
  1. Shared pieces: `roles.ts`, `statusTone`, `PageHeader.aside`, `expectPageHeader`.
  2. Nav, with its test edit.
  3. Page headers, grouped by area: Publish pages; Create pages and renames; Project and settings pages;
     `/invitations`.
  4. Terms: slot definition, posts statuses, roles screens, voice hints, `/p/new`.
  5. Docs.

  Pages are independent of each other once the shared pieces exist, so tasks per area can be `[P]`.
- **Pinned tests**: change only the assertions listed in research R19, in the same commit as the string change they
  pin. Don't delete any. Everything else must pass unchanged. In particular:
  - `review.test.tsx:142-146` (Review count);
  - `overview/nav.test.tsx` (Overview first and exact-match);
  - `voice.test.tsx:129` (the "Voice" legend);
  - `calendar.test.ts:42` (`calendar.title`);
  - the overview "You're an Owner" text.
- **Mocks in page tests**: mock `ProblemsCallout` as `roles/routes.test.tsx:11-12` does. Render pages with the
  `sessionModule` swap from `tests/integration/overview/ui.test.tsx:36-44`. Mock `next/navigation` and `next/link`
  for `LeftNav` as `failures/nav.test.ts:6-9` does.
- **Tab titles in tests**: import `metadata` (or call `generateMetadata`) from the page module and assert `.title`.
  The template "%s · Docket" is applied by Next at runtime, not in the module.
- **Target statuses in tests**: set the seven statuses through a test-only scoped update of `post_targets.status` (as
  the failures helpers do for outcomes). Don't add a service.
- **The skill file**: `.claude/skills/docket-ui/SKILL.md` is under a sandbox write-deny in pipeline sessions
  (entries 027 and 028 both hit it, `docs/decisions.md:1294,1321`). Attempt the edit. If it's refused, add the exact
  text to an "Open item" in the 029 decisions section and say so in the implement output. Don't skip FR-081
  silently. Fold in the still-owed 027 line ("Overview first") and 028 line ("States"), since they touch the same
  bullets.
- **Compose change notice**: none. No `docker-compose.yml` or env change, and the decisions entry says so.
- **Commits** (Conventional Commits, explicit paths):
  - `feat(nav): …` for the nav order and renames;
  - `feat(ui): …` for page headers and terms;
  - `refactor(roles): …` for adopting the shared role labels with no visible change;
  - `test(…)` and `docs(…)` as fitting.

## Not in this entry (owned elsewhere)

These are restated from the spec so the tasks phase doesn't pick them up:

- **No entry**:
  - showing or hiding nav items by state or config;
  - group labels on the phone strip;
  - "approved" vs "scheduled" wording on the posts tabs;
  - a Series hint on the Generate form;
  - readable publish-attempt outcomes;
  - `/p/new` Cancel or back link and its `self-start` button;
  - the Invitations expiry format and its empty-state focus ring;
  - URL or public API renames.
- **Entry 4**:
  - the Accounts card restructure;
  - landing on the slot editor after connecting;
  - the `SetupNotice` variant;
  - the calendar link after a first post;
  - `docs/getting-started.md`;
  - the project switcher's accessible name;
  - the setup password hint.
- **Entry 2, done**: empty states. This entry only adds headers above them.

## Complexity Tracking

No Constitution Check violations, so there's nothing to justify.
