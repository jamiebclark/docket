# Implementation Plan: Accounts restructure and first-post flow

**Branch**: `033-accounts-first-post` | **Date**: 2026-10-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/033-accounts-first-post/spec.md`

## Summary

This is the last entry of the onboarding roadmap. It covers audit recommendations S3, C1, C3, C4 and C5.

| Area | Change |
|---|---|
| Account card | Sections reordered: status (with reconnect and mock controls), Posting slots with the add-slot form, Posting instructions in a closed `<details>` ("· Set" / "· None"), then Remove, set apart. Anchors unchanged |
| Post-connect landing | Every successful connect (chooser, credentials, mock) lands on the first new account's Posting slots with focus on the weekday pill, or on the card's name for a reconnect. A visible and announced message goes with it. Failures unchanged |
| SetupNotice | A new shared, server-compatible EmptyState variant (dashed frame, icon, title, prerequisite rows). It replaces `Checklist` at Generate and the three Batch job gates. The content is unchanged |
| First-post calendar link | The Composer's Added to the queue, Scheduled and Publishing dialogs show "See it on the calendar" once: on the action that makes the project's first post |
| Getting-started guide | `docs/getting-started.md`, in the docs nav and `DocPage`, linked from the overview's Getting started card in both its full and collapsed forms |
| Accessibility | The switcher's name is the project name only, with `aria-keyshortcuts`. The setup password hint is always linked and visible |
| Docs | `docs/design-system.md` §7, `docs/accounts.md`, `docs/index.md`, `mkdocs.yml`, `docs/decisions.md`, and the docket-ui skill (an owed edit if the sandbox refuses it) |

**Technical approach** (details in [research.md](./research.md)):

- **The landing travels in the URL.** The URL is `?landed={id}&connected={n}&reconnected={m}#account-{id}[-slots]`.
  - It is built in the connect actions and validated on the Accounts page against the page's own account list, so a
    stale or forged link renders the normal page.
  - The chooser action redirects there. The in-page forms get the URL back in their result and `router.push` it.
  - A small page-local client component scrolls, focuses and announces, then strips the parameters with
    `history.replaceState`.
- **New versus reconnected** comes from the active account ids read just before the save. The DAL, schema and
  service signatures don't change. The chooser's display order and its save order share one pure `listedOrder`
  helper.
- **The first-post rule comes from one function**, `countsTowardFirstPost`, which the overview step already computes.
  - The Composer pages read it once, through a read-only `hasFirstPost(scope)`.
  - Each dialog captures the value when the user confirms, so the post-success refresh doesn't hide the link.
  - The compose action results are untouched.
- **Existing primitives throughout.** SetupNotice reuses EmptyState's frame and the Checklist rows, which are
  exported as `ChecklistRows` so the two can't drift. `Checklist` gains an additive `footer`.

## Technical Context

**Language/Version**: TypeScript (strict), Node 24 LTS

**Primary Dependencies**:

- Next.js 16.3.8, App Router:
  - `redirect()` in server actions; `router.push` to a hash URL, which scrolls to the id
    (`node_modules/next/dist/docs/01-app/03-api-reference/02-components/link.md:687-702`);
  - native `history.replaceState`, which the router integrates
    (`node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md:343-347`).
- React 19.2.8, Tailwind 4, Zod.
- No new runtime or dev dependency, and no new icon.

**Storage**: PostgreSQL. **No changes**: no table, column, migration or stored preference. There is one new read,
through existing scoped DAL methods: `scope.posts.counts()` on Composer load, and `listAccounts` before a connect save.

**Testing**: Vitest on a real Postgres (see [quickstart.md](./quickstart.md)):

- **Pure unit tests**:
  - `src/lib/accounts/connect-landing.test.ts`;
  - `src/lib/accounts/chooser-order.test.ts`;
  - `src/lib/compose/first-post.test.ts`;
  - `countsTowardFirstPost`;
  - SetupNotice and Checklist markup.
- **Page-markup tests** (`renderToStaticMarkup`, with the `sessionModule` swap, `postsEnv` and connect-group helpers):
  the Accounts card order and the landing, the four gates, and the overview footer link.
- **Action tests**: the landing URLs from all four connect actions. The existing `actions-authz` and
  `compose/actions` assertions stay unchanged.
- **A guide content guard**: no command fences and no env var tokens.
- **A manual browser walk-through** at desktop width and 390 px.

**Target Platform**: The self-hosted web app (Docker Compose or Neon), on desktop and phone-width browsers.

**Project Type**: A single Next.js web application (`src/app`, `src/components`, `src/lib`, `src/server`).

**Performance Goals**:

- **Accounts page**: no extra queries; the landing is validated against the list the page already loads.
- **Composer page**: one aggregate count query (`posts.counts()`, already used by the overview).
- **Connect actions**: one extra account-list read each.

**Constraints**:

- Role checks stay on the server (the landing only for `account:manage`; Composer reads only for `post:schedule`).
- No URL-supplied text is rendered.
- The landing works without JavaScript, apart from the focus move.
- SetupNotice is server-compatible.
- The strict docs build keeps passing.
- Every changed screen works at 390 px with keyboard use and visible focus.

**Scale/Scope**:

- About 20 source files changed: 4 new (`connect-landing.ts`, `chooser-order.ts`, `first-post.ts`, `SetupNotice.tsx`)
  plus the page-local `ConnectLanding.tsx`.
- 6 docs files, and about 8 test files new or extended.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Verified facts over memory | PASS | Next behaviour cited from `node_modules/next/dist/docs`. `aria-keyshortcuts` from the installed `@types/react@19.3.0`. Media-required facts for the guide from `docs/limits.md:72,193`. No platform API is touched |
| II. Nothing is "working" unless it ran | PASS | Every scenario maps to a test (quickstart §2). The mkdocs strict build can't run in the sandbox and will be reported as "verified by CI on the PR", not as run. The browser walk-through is reported only if it ran |
| III. Project isolation in one place | PASS | New reads go through `ProjectScope` (`scope.posts.counts()`, `accounts.listAccounts`). No raw DB import. Role checks on the server: the landing renders only for `account:manage`, and the Composer read only for `post:schedule` |
| IV. One service layer | PASS | `hasFirstPost` lives in the services and reuses the overview's rule. Connect saves still go through `saveConnectedAccount(Tx)`. The landing is navigation, so it lives in the actions and the page |
| V. Providers are plug-ins | PASS | No provider changes. `listedOrder` works for any provider's candidate tree |
| VI. Boring, few dependencies | PASS | No new dependency. `Intl` for instant→date, not Temporal, recorded as a decision (research R10) |
| VII. Secrets never leak | PASS | The landing URL holds ids and counts only. Credentials results still never echo fields (existing authz test). Secrets are still cleared before navigation |
| Accessibility constraint | PASS | Native `<details>`, focus management after landing, a polite LiveRegion, `aria-keyshortcuts`, linked hints, visible focus rings |
| Workflow: docs, decisions, commits | PASS | design-system §7, accounts.md, index/mkdocs and decisions.md are planned. The skill edit goes the owed-edit route if refused (FR-027) |

No violations, so Complexity Tracking is empty.

**Post-design re-check**: PASS. The design adds no table, dependency, provider change or client-side role check. The
one judgement call against the letter of a constraint (Intl rather than Temporal, for instant→date in the calendar
link) is justified in research R10 and goes into `docs/decisions.md`.

## Project Structure

### Documentation (this feature)

```text
specs/033-accounts-first-post/
├── plan.md              # This file
├── research.md          # Phase 0: decisions R1–R14, spec corrections
├── data-model.md        # Phase 1: views and URL values (no persistent change)
├── quickstart.md        # Phase 1: tests, final pass, walk-through
├── contracts/
│   ├── modules.md       # Signatures of new and changed modules
│   └── ui.md            # Screen-by-screen copy, order, roles
└── tasks.md             # Phase 2 (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
src/
├── lib/
│   ├── accounts/
│   │   ├── connect-landing.ts          # NEW  classify / href / parse / message
│   │   └── chooser-order.ts            # NEW  listedOrder
│   ├── compose/
│   │   └── first-post.ts               # NEW  firstPostCalendarHref, zonedDate
│   ├── overview/derive.ts              # + countsTowardFirstPost (used by deriveChecklist)
│   └── docs.ts                         # + "getting-started"
├── server/services/
│   ├── overview.ts                     # + hasFirstPost(scope)
│   └── connect.ts                      # chooseConnectCandidates sorts `chosen` with listedOrder
├── components/
│   ├── ui/
│   │   ├── Checklist.tsx               # export ChecklistRows, checklistStatusText; + footer
│   │   └── SetupNotice.tsx             # NEW  shared EmptyState variant
│   └── shell/ProjectSwitcher.tsx       # aria-keyshortcuts, kbd aria-hidden
└── app/
    ├── setup/setup-form.tsx            # SetupField; hint always linked
    └── p/[projectSlug]/
        ├── (overview)/page.tsx         # Checklist footer: getting-started link
        ├── accounts/
        │   ├── page.tsx                # card order; parse landing; message; tabIndex
        │   ├── ConnectLanding.tsx      # NEW  page-local client: scroll, focus, announce, strip params
        │   ├── actions.ts              # pre-read ids; landing in results; chooser redirect
        │   ├── ConnectCredentialsForm.tsx  # router.push(landing)
        │   ├── ConnectMockForm.tsx     # router.push(landing)
        │   ├── SlotEditor.tsx          # ReconnectMockButton → router.push(landing)
        │   └── connect/[attemptId]/ChooserForm.tsx  # uses listedOrder
        ├── compose/
        │   ├── page.tsx, [postId]/page.tsx  # pass firstPostDone
        │   ├── Composer.tsx            # forward firstPostDone
        │   └── ScheduleDialogs.tsx     # capture wasFirst; calendar link
        ├── generate/page.tsx           # SetupNotice
        └── jobs/page.tsx, jobs/new/page.tsx, jobs/new/csv/page.tsx  # SetupNotice

tests/integration/
├── accounts-ui.test.ts                 # order assertions updated on purpose (:233, :240)
├── accounts-landing.test.ts            # NEW  page landing markup, forged/stale params
├── actions-authz.test.ts               # + landing cases (existing assertions kept)
├── overview/ui.test.tsx                # + guide link, full and collapsed
└── docs/getting-started.test.ts        # NEW  content guard (or inside published-docs.test.ts)

docs/
├── getting-started.md                  # NEW
├── index.md, accounts.md, design-system.md, decisions.md
mkdocs.yml                              # nav entry
```

**Structure Decision**: The existing single Next.js app layout. The new pure modules go under `src/lib/<area>/`, next
to their peers, and are client-safe (no `@/server` imports). The only new shared UI component is `SetupNotice` in
`src/components/ui/`. `ConnectLanding` is page-local, beside the other Accounts client components.

## Implementation order (for /speckit-tasks)

1. **Pure modules and their tests**: `connect-landing`, `chooser-order`, `first-post`, `countsTowardFirstPost`. They
   have no UI dependency.
2. **US1, card order**: change `accounts/page.tsx` and update the `accounts-ui.test.ts` assertions.
3. **US2, landing**:
   1. the actions (pre-read, landing result, chooser redirect);
   2. `listedOrder` in the chooser and the service;
   3. `ConnectLanding`;
   4. the page parse and message;
   5. the three client forms.
4. **US3, SetupNotice**: export `ChecklistRows`, write `SetupNotice`, swap it in at the four gates, and update
   design-system §7.
5. **US4, calendar link**: `hasFirstPost`, then the Composer pages, `Composer` and the dialogs.
6. **US5, guide**: `docs/getting-started.md`, `mkdocs.yml`, `index.md`, `DocPage`, the Checklist `footer` and the
   overview link.
7. **US6, accessibility**: the switcher, then `SetupField`.
8. **Docs and decisions**: `accounts.md`, `decisions.md` (the 033 section and the skill open item), then the final pass
   and the walk-through.

US1–US6 are independent after step 1, except that US2's message placement sits in the card structure US1 produces.

## Complexity Tracking

No Constitution Check violations.
