# Implementation Plan: Empty states that name the next step, and role awareness

**Branch**: `028-empty-states-roles` | **Date**: 2026-10-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/028-empty-states-roles/spec.md`

## Summary

This entry fixes the empty and not-ready states of 12 routes and the two app banners. Each state names the next step,
shows that step only to someone who can take it, and tells everyone else whom to ask, by display name.

| Area | Change |
|---|---|
| Accounts | connect section for managers only; unconfigured platforms in one owner-only, closed disclosure |
| Calendar | five derived states; the empty state replaces the toolbar and grid when there are no accounts; a slot-specific state |
| Compose | a pre-click slot hint; Add to queue disabled and demoted when no selected account has an active slot; Schedule… becomes the headline action |
| Posts, Failures | hide filter controls when the project has no posts |
| Review | explains what it's for, and links to Generate |
| Generate, both New job pages, Jobs | one `Checklist` of every missing prerequisite; setting names for owners only |
| Media | an empty library shows only the dropzone; "images and videos" |
| Voice | no archive tab when there's nothing to archive |
| Scheduler banner | commands for owners; plain copy naming owners for everyone else |
| Reauth banner | names the managers |

Every empty-state action uses `buttonStyles`.

The technical approach:

- **Pure modules** under `src/lib/roles/` hold every rule:
  - names: `joinNames` moves here with a fallback; `managersOf`, `askManagers`, `askOwners`;
  - `hasActiveSlot`;
  - `calendarState`;
  - `generationPrerequisites`.
  Most behaviour is unit-tested without a database.
- **Four small read-only service additions**: `listManagers`, `listSlotCounts`, `countPosts`,
  `getGenerationReadiness`. There's also a `missingLlmSettings` helper. The overview switches to the shared
  ranking and slot counts, so nothing is duplicated.
- **Prop additions** on `SchedulerHealth` (a required `viewer`), `ReauthBanner` (`askNames`) and `Composer`
  (`hasActiveSlot`, `canManageSlots`, `managersToAsk`).
- **No changes** to schema, dependencies, access rules or server actions.

## Technical Context

**Language/Version**: TypeScript (strict), Node 24 LTS

**Primary Dependencies**: Next.js 16.3.8 (App Router server components; `next/link` hash scrolling, cited in research
R10), React, Tailwind 4, Zod. Data access uses the existing services and scoped DAL only. No new runtime or dev
dependency, and no new icon.

**Storage**: PostgreSQL. **No changes**: no table, column, migration or stored preference.

**Testing**: Vitest on a real Postgres:

- pure unit tests in `src/lib/roles/*.test.ts`, plus `composer-logic` tests;
- page-markup and service tests in `tests/integration/roles/` and the existing per-route test files, using the
  existing `postsEnv`, `jobsEnv`, `sessionModule`/`actAs`, `setLlmForTests`, `setStorageForTests` and
  `writeHeartbeat` seams;
- a new `tests/helpers/role-copy.ts` assertion (`expectNoPrivilegedText`);
- the existing published-docs anchor test;
- a manual 390 px and keyboard walk-through (quickstart).

**Target Platform**: Self-hosted Linux (Docker Compose, Unraid) and Neon. Pages render on the server, and no state
needs JavaScript to read (the disclosure is native `<details>`).

**Project Type**: Web application (a single Next.js app: `src/app`, `src/components`, `src/server`, `src/lib`).

**Performance Goals**: extra reads are conditional and bounded:

| Where | Extra reads |
|---|---|
| Layout | `members.list` only when a banner needs names (research D8) |
| Calendar, Compose | `listSlotCounts`, which is `1 + A` reads, and only when there are accounts |
| Failures | one `posts.counts()`, only when the unfiltered list is empty |
| Voice | one archived-inclusive list, only when the active list is empty |
| Generate, Jobs | readiness, which reuses the reads those pages already make (accounts, voice) |

There are no cross-project or unbounded queries. Projects are expected to have fewer than 20 accounts.

**Constraints**:

- Every read goes through `src/server/services/` (Constitution III and IV).
- Non-owners never receive a setting name. The service drops them (FR-043).
- No member email leaves `managersOf`.
- No editor-facing action the role can't take (FR-072).
- No horizontal scroll at 390 px (SC-008).
- The pinned nav and Generate-policy tests pass unedited (FR-075).

**Scale/Scope**:

- 13 route files edited (12 surfaces): accounts, calendar, compose ×2, posts, failures, review, generate, jobs, jobs/new,
  jobs/new/csv, media, voice. Plus the layout.
- 3 components edited: `SchedulerHealth`, `ReauthBanner`, `Composer`.
- 4 pure modules and 4 service additions.
- 1 test helper.
- 8 existing test files updated (research R12), and new tests per route.
- Docs: the design system, the docket-ui skill and decisions.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How |
|---|---|---|
| I. Verified facts over memory | PASS | Every file and line cited in research R1–R12 was read in the current tree. The only framework fact (hash scrolling with `next/link`) is cited from `node_modules/next/dist/docs/01-app/03-api-reference/02-components/link.md:687`. There are no platform API facts in scope. Docs anchors are existing ones, checked by `published-docs.test.ts` |
| II. Nothing is "working" unless it ran | PASS | Every FR maps to a quickstart scenario with a test. 390 px and focus are a real browser walk-through, and the plan says to report it if it can't be run. Nothing needs credentials |
| III. Project isolation in one place | PASS | The new services call scoped services (`members.list`, `listSlots`, `listAccounts`, `listVoiceProfiles`, `scope.posts.counts`). Nothing imports the DB client. Every role check is a server-side `scope.can` or `membership.role`. No access rule changes (FR-073) |
| IV. One service layer | PASS | Manager ranking and slot counting move to one place each, and the overview adopts both (research D2, D3). `missingLlmSettings` is shared by `getLlm()` and readiness. No per-page copies of the rules |
| V. Providers are plug-ins | PASS | Unconfigured platforms come from the registered connect groups (`listConnectGroups`). No provider is named in the new code |
| VI. Boring, few dependencies | PASS | No new dependency, infrastructure or icon |
| VII. Secrets never leak | PASS | Setting names (not values) only for owners, dropped in the service. No member email in any output (`managersOf` key-set test, `expectNoPrivilegedText`). Banner commands only for owners |
| Engineering: accessibility, server components | PASS | Server components, except the already-client `Composer`. Native `<details>` with a focus-ring summary. Status as text in `Checklist`. A disabled Add to queue is `aria-describedby` its reason. `buttonStyles` focus rings |
| Workflow: docs and decisions | PASS (planned) | `docs/design-system.md` §7 and §8, the docket-ui "States" line, and `docs/decisions.md` "028" with D1–D20 (FR-090, FR-091) |

**Gate result**: PASS. No violations, so Complexity Tracking is empty.

**Post-design re-check (after Phase 1)**: PASS.

- The design adds no table, dependency, permission or server action.
- The edits outside the touched routes are small and behaviour-preserving:
  - `overview.ts` adopts `managersOf` and `listSlotCounts` with identical output;
  - `derive.ts` re-exports `joinNames`;
  - `llm/index.ts` extracts `missingLlmSettings`, and `getLlm`'s error message is unchanged.
- The Accounts edit only filters and reorders the connect section and changes the empty copy. The card restructure
  stays with entry 4.
- No nav label, nav order or PageHeader adoption changes, which stay with entry 3.

## Project Structure

### Documentation (this feature)

```text
specs/028-empty-states-roles/
├── plan.md                          # This file
├── research.md                      # Phase 0: R1–R12 sources, decisions D1–D20
├── data-model.md                    # Phase 1: derived values (no stored data)
├── quickstart.md                    # Phase 1: commands, scenarios, browser walk-through
├── contracts/
│   ├── services-and-modules.md      # pure modules + read-only services
│   ├── components.md                # SchedulerHealth, ReauthBanner, Composer prop changes
│   └── ui.md                        # every route's states and exact copy
├── checklists/                      # from the specify phase
└── tasks.md                         # Phase 2 (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
src/
├── lib/
│   ├── roles/                         # NEW pure modules + unit tests
│   │   ├── names.ts                   #   joinNames (moved, with fallback), managersOf, askManagers, askOwners
│   │   ├── slots.ts                   #   hasActiveSlot, firstWithoutActiveSlot
│   │   ├── calendar.ts                #   calendarState
│   │   ├── prerequisites.ts           #   generationPrerequisites, PREREQUISITES_TITLE
│   │   └── *.test.ts
│   └── overview/derive.ts             # EDIT: re-export joinNames; slotsDone uses hasActiveSlot
├── server/
│   ├── llm/index.ts                   # EDIT: export missingLlmSettings (getLlm uses it)
│   └── services/
│       ├── members.ts                 # EDIT: listManagers
│       ├── slots.ts                   # EDIT: listSlotCounts
│       ├── posts/list.ts, index.ts    # EDIT: countPosts (+ export)
│       ├── generation/readiness.ts    # NEW: getGenerationReadiness
│       └── overview.ts                # EDIT: managersOf + listSlotCounts (same output)
├── components/shell/
│   ├── SchedulerHealth.tsx            # EDIT: required viewer prop, owner docs link, ask copy
│   └── ReauthBanner.tsx               # EDIT: askNames
└── app/p/[projectSlug]/
    ├── layout.tsx                     # EDIT: viewer + askNames, managers read on demand
    ├── accounts/page.tsx              # EDIT: empty copy, manager-only section, order, owner disclosure, admin fallback
    ├── calendar/page.tsx              # EDIT: calendarState rendering
    ├── compose/page.tsx               # EDIT: hasActiveSlot, canManageSlots, managersToAsk
    ├── compose/[postId]/page.tsx      # EDIT: same
    ├── compose/Composer.tsx           # EDIT: empty-state button + copy, slot hint, button order
    ├── compose/composer-logic.ts      # EDIT: queueSlotHint
    ├── posts/page.tsx                 # EDIT: hide tabs when no posts; button-styled actions
    ├── failures/page.tsx              # EDIT: no-posts state; button-styled actions
    ├── review/page.tsx                # EDIT: explanation + button
    ├── generate/page.tsx              # EDIT: one Checklist in place of three gates
    ├── jobs/page.tsx                  # EDIT: header actions, empty copy, Checklist in place of box
    ├── jobs/new/page.tsx              # EDIT: Checklist incl. images item
    ├── jobs/new/csv/page.tsx          # EDIT: Checklist
    ├── media/page.tsx                 # EDIT: storage copy by role, empty library, info alert
    └── voice/page.tsx                 # EDIT: hide tabs with no profiles; copy; button

tests/
├── helpers/role-copy.ts               # NEW: expectNoPrivilegedText
└── integration/roles/                 # NEW: services.test.ts, routes.test.tsx (editor sweep, US1)
    # plus updates/new cases in the existing per-route test files (research R12)

docs/design-system.md                  # EDIT: §7 Checklist row, §8 States bullets
docs/decisions.md                      # EDIT: "## 028 — Empty states and role awareness (2026-10-09)"
.claude/skills/docket-ui/SKILL.md      # EDIT: one line in "States"
```

**Structure Decision**: This is the existing single Next.js app, following the layering entry 1 used:

- rules in `src/lib/<area>`;
- data in `src/server/services`;
- rendering in the route pages.

`src/lib/roles/` is the new area, because the same rules serve many routes. Tests follow the existing split: unit
tests next to the code; page and database tests under `tests/integration/`, or next to the route where that route
already keeps its tests (`generate.test.tsx`, `review.test.tsx`, `voice.test.tsx`, `Composer.test.ts`).

## Implementation notes for the tasks phase

- **Order**: each step can be tested on its own.
  1. `src/lib/roles/names.ts`, with the overview re-export and `managersOf` adoption. The overview tests must stay
     green.
  2. `slots.ts` (pure), `listSlotCounts`, and the overview adopting it.
  3. `countPosts`, `missingLlmSettings`, `getGenerationReadiness`, and `prerequisites.ts`.
  4. `calendar.ts` and `queueSlotHint`.
  5. Banners and the layout.
  6. Routes, in spec order: Accounts, Calendar, Compose, Posts, Failures, Review, Generate, the job pages, Jobs,
     Media, Voice.
  7. `role-copy.ts` and the editor sweep test.
  8. Docs and decisions.

  User stories map as follows:

  | Story | Steps |
  |---|---|
  | US1 | 1, 5, 6 (editor copy everywhere), 7 |
  | US2 | 3, plus the Generate and job routes |
  | US3 | 2, 4, plus Compose |
  | US4 | Accounts and Calendar |
  | US5 | Posts, Failures, Review |
  | US6 | Media, Voice, Jobs |
- **Pinned tests**: update only the assertions in research R12, in the same commit as the copy change (FR-084). Don't
  delete any. Every other existing test must pass unchanged. In particular:
  - `Composer.test.ts:183-189` keeps passing, because the empty-state href stays `/accounts` and the fallback name
    text is "an owner or admin";
  - `accounts-ui.test.ts:149-157` keeps passing for the owner, because the disclosure still contains the group
    section.
- **Mocks in page tests**: mock `ProblemsCallout` as `review.test.tsx:7-8` and the overview tests do. Render pages
  with the `sessionModule` swap pattern from `tests/integration/overview/ui.test.tsx:36-44`.
- **Setting names in tests**: assert on `missingLlmSettings(getLlmStatus().problems)` for whatever the test env has,
  never on a hard-coded list. Connect groups' configured state depends on test env vars: assert on whatever
  `listConnectGroups` reports as unconfigured, as entry 1 did.
- **The skill file**: earlier phases have edited `.claude/skills/docket-ui/SKILL.md`. This session's sandbox may refuse
  writes under `.claude/skills`. If it does, record it as an open item in the implement output. Don't skip FR-090
  silently.
- **Commits**: Conventional Commits, explicit paths:
  - `feat(empty-states): …` for user-visible route changes;
  - `refactor(roles): …` for moving `joinNames`, `managersOf` and slot counts;
  - `test(…)` and `docs(…)` as fitting.

## Not in this entry (owned elsewhere)

These are restated from the spec so the tasks phase doesn't pick them up:

- **Entry 3**: nav renames and ordering ("Brand voice", "Batch jobs"); PageHeader descriptions and adoption on
  Posts, Calendar, Review, Voice, Jobs, Media, Generate and Failures; the "posting slot" definitions and role
  descriptions.
- **Entry 4**: the Accounts card restructure, the SetupNotice variant, landing on the slot editor after connecting,
  the calendar link after a first post, and `docs/getting-started.md`.
- **No entry**: changing the queue's failure message or any server action; job-from-media "images" copy.
- **Entry 1**: the overview's behaviour, which stays unchanged here. Only its internals adopt the shared helpers.

## Complexity Tracking

No Constitution Check violations, so there's nothing to justify.
