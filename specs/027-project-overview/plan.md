# Implementation Plan: Project overview and getting started

**Branch**: `027-project-overview` | **Date**: 2026-10-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/027-project-overview/spec.md`

## Summary

Replace the bare project home with a read-only overview. It has:

- a `PageHeader`: project name, "Times in {tz}. You're an {Role}." and one primary action;
- a Getting started `Checklist` that works out its own state, with three required steps, three optional ones and an
  owner-only server-setup row of docs links. It collapses to "Setup complete" and has no stored dismissal;
- the sections Needs attention, Coming up, Accounts, Posts by status and Content tools, each with a populated view and
  an empty state;
- an overview-shaped skeleton;
- the project name as the tab title;
- "Overview" as the first nav item, matched exactly.

The technical approach:

- One new service, `getOverview(scope)`, gathers facts through existing services only.
- A pure module, `deriveOverview(facts)`, holds every rule (step states, role variants, who is named, copy choices),
  so most of the behaviour is unit-tested without a database.
- The home moves into a route group, `(overview)/`, so its skeleton doesn't leak into Settings.
- Overview is added to `LeftNav` outside `NAV_SECTIONS`, so the pinned nav tests don't change.
- No schema, dependency or access-rule changes.

## Technical Context

**Language/Version**: TypeScript (strict), Node 24 LTS

**Primary Dependencies**: Next.js 16.3.8 (App Router: server components, route groups, `loading.tsx`,
`generateMetadata`), React, Tailwind 4, Zod, Drizzle (via the existing DAL only). `lucide-static` (already installed) is
used by `pnpm icons` for the two new icons. No new runtime or dev dependency.

**Storage**: PostgreSQL. **No changes**: no table, column, migration or stored preference.

**Testing**: Vitest on a real Postgres:

- pure unit tests (`src/lib/overview/derive.test.ts`);
- integration tests under `tests/integration/overview/` (service, page markup, nav), using the existing
  `postsEnv`, `actAs`, `setLlmForTests`, `setStorageForTests` and `writeHeartbeat` seams;
- the existing published-docs link test, which checks the new `docsUrl` anchors;
- a manual browser walk-through for 390 px and keyboard use (`quickstart.md`).

**Target Platform**: Self-hosted Linux server (Docker Compose, Unraid) and Neon. It renders on the server and needs no
JavaScript to read or use.

**Project Type**: Web application (a single Next.js app: `src/app`, `src/components`, `src/server`, `src/lib`).

**Performance Goals**: One home render makes about `9 + A` service reads, where A is the number of accounts (one
`listSlots` per account, as the Accounts page already does). Expected projects have fewer than 20 accounts, so no
cross-project or unbounded queries are added. The Coming up list reuses one `listPosts` page (25 rows, sliced to 5).

**Constraints**:

- Every read goes through `src/server/services/` and the scoped DAL (Constitution III and IV).
- No member email, env var name, command, redirect address or secret is rendered (FR-021, FR-026, SC-003).
- No action the viewer's role can't take (FR-023).
- No horizontal scroll at 390 px (SC-009).
- Existing nav, Review and Failures tests pass unedited (SC-007).

**Scale/Scope**:

- 1 route moved and rebuilt, 1 new skeleton, 1 small anchor on Accounts;
- 1 new shared UI component (`Checklist`) and 5 section components plus a skeleton;
- 1 service, 1 pure module and 2 icons;
- docs: the design system, the docket-ui skill, and decisions.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How |
|---|---|---|
| I. Verified facts over memory | PASS | Next behaviour (loading boundaries, route groups, title templates) is cited from `node_modules/next/dist/docs/` in research R2 and R3. Every service, line and heading cited was read in the current tree. There are no platform API facts in scope |
| II. Nothing is "working" unless it ran | PASS | Each requirement has a test (quickstart). The 390 px and keyboard checks are a real browser walk-through. Nothing needs real credentials |
| III. Project isolation in one place | PASS | `getOverview` calls only scoped services, and nothing imports the DB client. The owner-only server-setup row and every action check `scope.membership.role` or `scope.can` on the server. Access rules are unchanged (FR-024) |
| IV. One service layer | PASS | It reuses `listAccounts`, `listSlots`, `listPosts`, `countReviewQueue`, `countNeedsDecision`, `listVoiceProfiles`, `mediaStatus`, `listMedia`, `members.list`, `invitations.listForProject`, `getSchedulerHealth`, `listConnectGroups` and `getLlmStatus`. No logic is duplicated: counts match the nav because they're the same functions (FR-033) |
| V. Providers are plug-ins | PASS | Platform setup items come from the registered connect groups' own `setupDoc`. No provider is named in overview code |
| VI. Boring, few dependencies | PASS | No new dependency or infrastructure. The icons come from the installed `lucide-static` through the documented `pnpm icons` script |
| VII. Secrets never leak | PASS | The service output drops `email`, `settings`, `lastError`, `redirectUri` and `paste`. A test asserts that no seeded email or env var name appears in the output or the HTML |
| Engineering: accessibility, server components | PASS | Server components only. The checklist uses `<ol>`, status as text, decorative icons and a native `<details>`. Focus rings come from `buttonStyles`. The skeleton has `role="status"` and is `motion-safe` |
| Workflow: docs and decisions | PASS (planned) | The design system (§6 nav, §7 `Checklist`, home uses `PageHeader`), the docket-ui skill's nav bullet, and `docs/decisions.md` entry "027", with D1–D12 from research R8 |

**Gate result**: PASS. No violations, so Complexity Tracking is empty.

**Post-design re-check (after Phase 1)**: PASS. The design adds no table, dependency or cross-project query. The only
edit outside the new files and docs is to `accounts/page.tsx`, one anchor id and class (R5), and that doesn't
restructure Accounts, which entry 4 owns. Moving `page.tsx` into `(overview)/` changes no URL. `error.tsx` and
`not-found.tsx` still apply from the parent segment.

## Project Structure

### Documentation (this feature)

```text
specs/027-project-overview/
├── plan.md                         # This file
├── research.md                     # Phase 0: data sources, loading boundary, nav, links, decisions D1–D12
├── data-model.md                   # Phase 1: OverviewFacts → OverviewView, step and section rules
├── quickstart.md                   # Phase 1: validation commands, scenarios, browser walk-through
├── contracts/
│   ├── overview-service.md         # getOverview / deriveOverview signatures and obligations
│   ├── checklist-component.md      # Checklist props, rendering rules, design-system row
│   └── ui.md                       # Routes, page order, exact copy, nav rule, loading
└── tasks.md                        # Phase 2 (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
src/
├── app/p/[projectSlug]/
│   ├── page.tsx                    # REMOVED (moved into the group)
│   ├── loading.tsx                 # unchanged: the generic state for Settings and Members (D8)
│   ├── (overview)/
│   │   ├── page.tsx                # NEW: overview page + generateMetadata (project name)
│   │   └── loading.tsx             # NEW: overview skeleton
│   └── accounts/page.tsx           # EDIT: id="account-{id}-slots" on the Posting slots heading
├── components/
│   ├── ui/
│   │   ├── Checklist.tsx           # NEW shared component (audit M2)
│   │   └── icons.generated.ts      # REGENERATED: overview, circle
│   ├── overview/                   # NEW: NeedsAttentionCard, ComingUpCard, AccountsCard,
│   │                               #      PostsByStatusCard, ContentToolsCard, OverviewSkeleton
│   └── shell/LeftNav.tsx           # EDIT: Overview item + isNavItemActive
├── lib/overview/
│   ├── derive.ts                   # NEW: pure rules (types, deriveOverview, joinNames, …)
│   └── derive.test.ts              # NEW: unit tests
└── server/services/overview.ts     # NEW: getOverview(scope)

scripts/generate-icons.mjs          # EDIT: overview → layout-dashboard, circle → circle

tests/integration/overview/
├── service.test.ts                 # NEW: facts from seeded data, conditional reads, no emails
├── ui.test.tsx                     # NEW: page + sections, owner/editor × empty/populated, title, loading files,
│                                   #      Accounts anchor
└── nav.test.tsx                    # NEW: Overview first, exact match, one aria-current per path

docs/design-system.md               # EDIT: §6 shell diagram and sidebar text, §7 Checklist row, page anatomy note
docs/decisions.md                   # EDIT: "## 027 — Project overview (2026-10-09)" with D1–D12
.claude/skills/docket-ui/SKILL.md   # EDIT: App shell bullet lists Overview first
```

**Structure Decision**: This is the existing single Next.js app. New overview code follows the repo's layering:

- route in `src/app`;
- shared primitive in `src/components/ui`;
- feature components in `src/components/overview`;
- pure rules in `src/lib/overview`;
- data in `src/server/services`.

Tests follow the existing split: unit tests next to the code, page and DB tests under `tests/integration/`.

## Implementation notes for the tasks phase

- **Order**:
  1. pure module and tests;
  2. service and tests;
  3. icons and `Checklist`;
  4. section components;
  5. route move, page, metadata and skeleton;
  6. Accounts anchor;
  7. nav;
  8. docs and decisions.

  User stories map onto these steps: US1 and US2 (checklist, header, roles) are covered by steps 1–5, US3 by the
  sections, US4 by the server-setup items, US5 by Content tools and the optional steps, and US6 by the nav, title and
  skeleton.
- **Mocks in markup tests**:
  - `ProblemsCallout` is async, and `renderToStaticMarkup` can't render it. Mock it in page tests as
    `review.test.tsx:7-8` does. Its own tests already cover it.
  - The nav test needs a `usePathname` mock that can change per test (a module-level variable read by the mock).
- **Server-setup tests**:
  - Clear the publishing heartbeat, or write a fresh one, with `writeHeartbeat`.
  - Toggle AI with `setLlmForTests(fakeLlm | null)` and storage with `setStorageForTests(memory | null)`. Reset both
    in `afterEach`.
  - Connect groups count as configured or not according to the test env's provider variables. Assert on whichever
    groups `listConnectGroups` reports unconfigured, not on a fixed list.
- **The skill file**: `.claude/skills/docket-ui/SKILL.md` has been edited by earlier entries' phases. If the implement
  sandbox refuses that write, record it as an open item rather than skipping FR-053 silently.
- **Commits**: use Conventional Commits with explicit paths. `feat(overview): …` for user-visible work, `test(…)`,
  `docs(…)`, and `build(icons): …` for the regenerated icons.

## Not in this entry (owned elsewhere)

These are restated from the spec so the tasks phase doesn't pick them up:

- nav reordering or renaming (entry 3);
- other routes' empty states and the scheduler banner's commands (entry 2);
- the Accounts restructure and the getting-started docs page (entry 4);
- stored dismissal (no entry);
- a project-wide slot-count service (no entry).

## Complexity Tracking

No Constitution Check violations, so there's nothing to justify.
