---

description: "Task list for Project overview and getting started"
---

# Tasks: Project overview and getting started

**Input**: Design documents from `/specs/027-project-overview/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (overview-service, checklist-component, ui), quickstart.md

**Tests**: Requested by the spec (SC-004, SC-005, SC-006). Tests sit beside the code they cover and run with `pnpm vitest run <file>` against real Postgres (`DATABASE_URL`). Markup tests use `renderToStaticMarkup`. Nothing here needs a browser, a dev server or the network.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1–US6 from spec.md

## Story map

- US1 (P1): a new owner knows what to do first
- US2 (P1): an editor sees what they can do and who to ask
- US3 (P2): a returning member sees what needs attention and what's coming up
- US4 (P2): an owner sees missing server pieces, without commands
- US5 (P3): Content tools and optional steps
- US6 (P3): Overview in the nav, tab title and loading skeleton

Commits: Conventional Commits with explicit paths (`feat(overview): …`, `test(overview): …`, `docs(…)`, `build(icons): …`).

---

## Phase 1: Setup

- [x] T001 [P] Add `overview` (Lucide `layout-dashboard`) and `circle` (Lucide `circle`) to the icon map in `scripts/generate-icons.mjs`, run `pnpm icons`, and confirm `src/components/ui/icons.generated.ts` gains exactly those two entries
- [x] T002 [P] Create the empty module `src/lib/overview/derive.ts` exporting the types `OverviewFacts`, `OverviewAccount`, `UpcomingPost`, `OverviewView`, `Action`, `ChecklistView`, `ChecklistStep`, `ServerSetupItem`, `AttentionItem`, `AccountRow` exactly as in `specs/027-project-overview/data-model.md` and `contracts/overview-service.md`, plus `export const EXPIRY_WINDOW_DAYS = 14`. No `server-only`, no I/O

---

## Phase 2: Foundational (blocks all stories)

**Purpose**: the pure rules, the service, the `Checklist` primitive and the route move that every story builds on.

- [ ] T003 Implement `joinNames(names, conjunction)` in `src/lib/overview/derive.ts` per research R7 (0–5 names, blank names dropped, "and"/"or"), with unit cases for 0, 1, 2, 3, 4, 5 names, blanks and both conjunctions in `src/lib/overview/derive.test.ts`
- [ ] T004 Implement `getOverview(scope)` in `src/server/services/overview.ts` per `contracts/overview-service.md` and the source table in `data-model.md`: require `project: view`; call only existing services (`listAccounts`, `listSlots` per account, `listPosts` for counts and the scheduled page sliced to 5, `countReviewQueue`, `countNeedsDecision`, `members.list` reduced to `{name, role}` for owners and admins, `invitations.listForProject` only when `scope.can({invitation:["create"]})`, `getLlmStatus`, `listVoiceProfiles` only when AI configured, `mediaStatus`, `listMedia({limit:1})` only when enabled, `getSchedulerHealth`, `listConnectGroups` only for owners with no accounts, `clock.now()`); read `viewer.can` from `scope.can` and `viewer.role` from `scope.membership.role`; drop email, settings, `lastError`, `redirectUri`, `paste`; let errors propagate; never import `@/server/db`; re-export the types from `derive.ts`
- [ ] T005 [P] Create the `Checklist` component in `src/components/ui/Checklist.tsx` per `contracts/checklist-component.md`: server-compatible `Card` with `<ol>`, decorative `aria-hidden` icons (`circleCheck`, `circle`, `clock`), status as text ("Done", "To do", "Waiting on {on}"), "Optional" text, one action `Link` styled with `buttonStyles({variant:"secondary",size:"sm"})` or `blocked` muted text, `children`, flex-wrap rows, and `collapsedSummary` as a closed native `<details>` whose `<summary>` has `focus-visible:ring-2 focus-visible:ring-focus`
- [ ] T006 [P] Add a `Checklist` row to the component table in `docs/design-system.md` §7 (exact row text in `contracts/checklist-component.md`) and note in the page-anatomy text that the project home now uses `PageHeader` (FR-060)
- [ ] T007 Move `src/app/p/[projectSlug]/page.tsx` to `src/app/p/[projectSlug]/(overview)/page.tsx` with `git mv`, leaving `src/app/p/[projectSlug]/loading.tsx` untouched; check that `pnpm typecheck` still passes and no URL changes (research R2)
- [ ] T008 [P] Add `id="account-{id}-slots"` and `scroll-mt-[calc(var(--sticky-top)+1rem)]` to the "Posting slots" heading in `src/app/p/[projectSlug]/accounts/page.tsx` (research R5), and confirm the `id="add-account"` anchor that the primary action links to exists on that page (add it only if missing)

**Checkpoint**: types, service, `Checklist` and the moved route exist.

---

## Phase 3: User Story 1 — A new owner knows what to do first (P1) 🎯 MVP

**Goal**: a brand-new project's home shows the header with one primary action and a Getting started checklist with the three required steps in order.

**Independent test**: `src/lib/overview/derive.test.ts` + `tests/integration/overview/service.test.ts` + `tests/integration/overview/ui.test.tsx` (owner, empty project).

- [ ] T009 [US1] In `src/lib/overview/derive.ts` implement `deriveChecklist` for the required steps 1–3 and the collapse rules (D1 account done when ≥1 account; D2 slots done when an available account has an active slot; D3 first post counts scheduled + publishing + published + partially_failed; blocked "Needs an account first"; step 2 action to `/accounts#account-{id}-slots`; `mode:"collapsed"` once all required steps done; return to full when one stops holding; `null` when nothing remains to show)
- [ ] T010 [US1] In `src/lib/overview/derive.ts` implement `deriveOverview` header fields: `title` (project name), `description` ("Times in {tz}. You're an {Owner|Admin|Editor}."), `primaryAction` ("Connect an account" → `/p/{slug}/accounts#add-account` with no accounts and `manageAccounts`, else "Write a post" → `/p/{slug}/compose` when `writePosts`, else null), and wire `checklist`
- [ ] T011 [US1] Unit tests in `src/lib/overview/derive.test.ts`: each required step moving To do → Done → To do (account removed, slots paused, scheduled post cancelled; SC-005), blocked variants, full ↔ collapsed, primary action rules, description for each role
- [ ] T012 [US1] Service tests in `tests/integration/overview/service.test.ts` using `postsEnv`/`actAs`: facts from a seeded project (account, slot, scheduled post), removal of the account re-expanding the derived checklist, conditional reads skipped when AI/storage/invites aren't available, and serialised output containing none of the seeded member emails, no `@`-addresses and no env var names (SC-003)
- [ ] T013 [US1] Build the overview page in `src/app/p/[projectSlug]/(overview)/page.tsx`: `export const dynamic = "force-dynamic"`, render `ProblemsCallout` first, then `PageHeader` (name as the only `h1`, description, exactly one primary `Link` via `buttonStyles({variant:"primary"})`, never `cta`), then the Getting started `Checklist` (collapsed → `collapsedSummary="Setup complete"`, showing unfinished optional steps only) before every other section, using `getOverview` then `deriveOverview`; map steps to `ChecklistItem`s with the exact copy in `contracts/ui.md`
- [ ] T014 [US1] Page markup tests in `tests/integration/overview/ui.test.tsx` (mock `ProblemsCallout` as `review.test.tsx:7-8` does): scenarios 1–4 from `quickstart.md` — owner of an empty project sees one primary action, an `<ol>` with steps 1–3 and status text, steps 2–3 blocked; after an account the primary action becomes "Write a post"; after slot + scheduled post it collapses to "Setup complete"; removing the account restores the full list

**Checkpoint**: US1 works and is testable alone — this is the MVP.

---

## Phase 4: User Story 2 — An editor sees what they can do and who to ask (P1)

**Goal**: editors get no actions they can't take and are told who to ask.

**Independent test**: editor cases in `derive.test.ts` and `ui.test.tsx`.

- [ ] T015 [US2] In `src/lib/overview/derive.ts` add the editor variants: "Waiting on {names(and)}" for steps 1, 2 (and 4 when shown) with no action, step 3 still actionable, invite step omitted when `!viewer.can.invite` (D9), names from owners-then-admins `managers` (FR-020–FR-024); expose `names(and)`/`names(or)` helpers used by every section
- [ ] T016 [US2] Unit tests in `src/lib/overview/derive.test.ts` for editor/admin/owner variants, "Waiting on Robin and Sam", no invite step for editors, no managers (empty names) fallback
- [ ] T017 [US2] Page markup test in `tests/integration/overview/ui.test.tsx` for scenario 5: editor in an empty project with owner "Robin" and admin "Sam" — assert the "Waiting on Robin and Sam" text, no invite step, no connect/reconnect/slot actions, no email, no `LLM_`/`S3_`/`_CLIENT_ID` names and no `pnpm`/`docker` text anywhere in the HTML (SC-003)

**Checkpoint**: US1 and US2 both pass independently.

---

## Phase 5: User Story 3 — Needs attention and Coming up (P2)

**Goal**: returning members see problems, upcoming posts, accounts and post counts, each with an empty state.

**Independent test**: scenarios 7–8 in `ui.test.tsx` plus section unit cases.

- [ ] T018 [US3] In `src/lib/overview/derive.ts` implement `needsAttention` (review, decision, failed+partially_failed per D4, reconnect, expiry within `EXPIRY_WINDOW_DAYS` per D5 excluding accounts already listed under reconnect; editor variants with no link and "Ask {names, or} to reconnect it."), and the `comingUp`, `accounts` (badge/slots text/expiry per `AccountRow`, D6) and `postsByStatus` views with their empty states
- [ ] T019 [US3] Unit tests in `src/lib/overview/derive.test.ts` for every attention kind, expiry edges (exactly 14 days, past, null), D4/D5, account row variants (Unavailable, Needs reconnecting, paused slots, none), posts-by-status counts and empties
- [ ] T020 [P] [US3] Create `src/components/overview/NeedsAttentionCard.tsx` (badges as text + colour, links, `LocalTime` in the project time zone, `Intl.NumberFormat("en-US")` counts, always ending with "See all activity" → `/activity`)
- [ ] T021 [P] [US3] Create `src/components/overview/ComingUpCard.tsx` (up to 5 soonest with `LocalTime` and account names, "Open calendar"; empty states and actions per `contracts/ui.md`)
- [ ] T022 [P] [US3] Create `src/components/overview/AccountsCard.tsx` (one row per account with `ProviderIcon`, provider name as text, badge, slots text/link, expiry; empty state per role)
- [ ] T023 [P] [US3] Create `src/components/overview/PostsByStatusCard.tsx` (Drafts, Needs review, Approved but not scheduled, Scheduled linking to `/posts?status=…`; empty "No posts yet." with "Write a post"); all empty-state actions use `EmptyState` with `buttonStyles`, never an underlined link (FR-045)
- [ ] T024 [US3] Render the sections in `src/app/p/[projectSlug]/(overview)/page.tsx` in the order of `contracts/ui.md` (Needs attention full width when non-null, then the `lg` two-column grid of Coming up, Accounts, Posts by status, Content tools)
- [ ] T025 [US3] Markup tests in `tests/integration/overview/ui.test.tsx` for scenarios 7–8, each section populated and empty for owner and editor (SC-004), counts equal to the nav's `countReviewQueue`/`countNeedsDecision` (FR-033), 7 scheduled posts showing 5 soonest, and a class check that the page's grid has no fixed widths (SC-009 as far as markup can show)

---

## Phase 6: User Story 4 — Owner server setup without commands (P2)

**Goal**: owners see which server pieces are missing with docs links, and nobody else does.

**Independent test**: scenario 6 in `ui.test.tsx` and `serverSetupItems` unit cases.

- [ ] T026 [US4] In `src/lib/overview/derive.ts` implement `serverSetupItems` per research R6 (scheduler `stale`/`never`, AI not configured, storage not configured, each unconfigured platform from `unconfiguredPlatforms` using its `setupDoc`; `[]` unless owner) and attach it as the "Server setup" row that never blocks collapse (FR-025–FR-028); build links with literal `docsUrl("page","anchor")` calls so the docs link test checks them
- [ ] T027 [US4] Unit tests in `src/lib/overview/derive.test.ts` for each of the four items, owner-only, row hidden when nothing is missing, and collapse unaffected
- [ ] T028 [US4] Render the "Server setup" row as a `Checklist` item whose `children` is a `<ul>` of docs links in `src/app/p/[projectSlug]/(overview)/page.tsx`
- [ ] T029 [US4] Markup tests in `tests/integration/overview/ui.test.tsx` for scenario 6 using `writeHeartbeat`, `setLlmForTests`, `setStorageForTests` (reset all in `afterEach`; assert on whichever groups `listConnectGroups` reports unconfigured): owner sees the row with docs links and no commands or env var names; admin and editor see none; run `pnpm vitest run tests/integration/docs/published-docs.test.ts` and confirm the new anchors resolve

---

## Phase 7: User Story 5 — Content tools and optional steps (P3)

**Goal**: voice and media status plus optional checklist steps appear only when those features are configured.

**Independent test**: scenario 9 in `ui.test.tsx`.

- [ ] T030 [US5] In `src/lib/overview/derive.ts` add optional steps 4 (voice, when AI configured; "Create a voice profile" → `/voice/new`), 5 (media, when storage configured; needs `editMedia`, D11) and 6 (invite, `can.invite`; done when `memberCount > 1` or `pendingInvitations > 0`), and the `contentTools` view (null when neither feature is configured; editor copy "Ask {names, or} to create one.")
- [ ] T031 [P] [US5] Create `src/components/overview/ContentToolsCard.tsx` per `contracts/ui.md` (voice and media lines, "{n} images and videos", actions per role)
- [ ] T032 [US5] Render `ContentToolsCard` in `src/app/p/[projectSlug]/(overview)/page.tsx` and add optional steps (marked "Optional" in text) to the checklist mapping
- [ ] T033 [US5] Unit and markup tests (`src/lib/overview/derive.test.ts`, `tests/integration/overview/ui.test.tsx`) for scenario 9 (0 voice profiles, 3 images + 1 video → "No voice profile yet. Generated posts need one." and "4 images and videos"), hidden when unconfigured, invite step done via member or pending invitation, and optional steps still shown after collapse

---

## Phase 8: User Story 6 — Nav, tab title and skeleton (P3)

**Goal**: Overview is the first nav item with an exact-match active state; the tab title is the project name; the home has its own skeleton and Settings keeps the generic one.

**Independent test**: `nav.test.tsx` and the title/loading cases in `ui.test.tsx`.

- [ ] T034 [P] [US6] Add Overview as the first item in `src/components/shell/LeftNav.tsx` (above the Publish group, no group label, `overview` icon, outside `NAV_SECTIONS`) and export `isNavItemActive(pathname, href, exact)` matching Overview only at exactly `/p/{slug}` (with or without trailing slash) while other items keep prefix matching (FR-050–FR-052)
- [ ] T035 [P] [US6] Create `src/components/overview/OverviewSkeleton.tsx` and `src/app/p/[projectSlug]/(overview)/loading.tsx`: header, checklist and section-card placeholders, `role="status"` with an accessible label, `motion-safe:animate-pulse` only (FR-047)
- [ ] T036 [US6] Add `generateMetadata({ params })` to `src/app/p/[projectSlug]/(overview)/page.tsx` returning `{ title: scope.project.name }`, and `{}` with no session or on `NotFoundError`, never the slug (FR-004)
- [ ] T037 [US6] Nav tests in `tests/integration/overview/nav.test.tsx` with a per-test changeable `usePathname` mock: Overview first, exactly one `aria-current="page"` for `/p/acme`, `/p/acme/`, `/p/acme/calendar` and `/p/acme/settings/members` (scenario 10, SC-006)
- [ ] T038 [US6] Tests in `tests/integration/overview/ui.test.tsx`: `generateMetadata` returns the project name when it differs from the slug (SC-008) and `{}` for not-found; `(overview)/loading.tsx` exists and `src/app/p/[projectSlug]/loading.tsx` is unchanged; Accounts markup carries `id="account-{id}-slots"`
- [ ] T039 [US6] Run `pnpm vitest run tests/integration/overview/nav.test.tsx tests/integration/failures/nav.test.ts "src/app/p/[projectSlug]/review/review.test.tsx"` and confirm the two pinned nav tests pass without being edited (SC-007)

---

## Phase 9: Polish and cross-cutting

- [ ] T040 [P] Update the app-shell section (§6 diagram and sidebar text) of `docs/design-system.md` to show Overview first (FR-053)
- [ ] T041 [P] Update the App shell bullet in `.claude/skills/docket-ui/SKILL.md` to list Overview first (FR-053); if the sandbox refuses the write, record it as an open item in `docs/decisions.md` instead of skipping silently
- [ ] T042 [P] Append "## 027 — Project overview (2026-10-09)" to `docs/decisions.md` with D1–D12 from `research.md` R8, including who sees the invite step, when the platform item shows, what counts as a first post, failed vs partially failed, and the Settings loading state (FR-061)
- [ ] T043 Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` synchronously and fix every failure (the build is needed because the route moved into a group and loading boundaries changed)
- [ ] T044 🛑 BLOCKED: needs a real browser and no Playwright/Puppeteer in this repo — at 390 px width confirm `document.documentElement.scrollWidth <= innerWidth` on the home (SC-009), Tab through the page seeing a focus ring on every action and the "Setup complete" summary (opens with Enter/Space with JavaScript off), and see the skeleton on throttled load but the generic state on Settings (`quickstart.md` browser walk-through)

---

## Dependencies and execution order

- Phase 1 → Phase 2 → stories → Polish. T003 and T004 need T002; T007 before any page work (T013, T024, T028, T032, T035, T036).
- US1 (T009–T014) is the MVP and should land first. US2 extends `derive.ts` after US1 (T015 after T009/T010). US3, US4 and US5 each extend `derive.ts` and the page, so run them in order; the component tasks (T020–T023, T031) are parallel with each other. US6 (T034, T035) is independent of the others and can run in parallel with US3–US5, but T036 edits the same page file as T013.
- T043 comes after everything; T044 is a human check and doesn't block anything.

## Parallel examples

- Setup: T001 ∥ T002.
- Foundational: T005 ∥ T006 ∥ T008, while T003 → T004 proceed.
- US3 components: T020 ∥ T021 ∥ T022 ∥ T023.
- US6: T034 ∥ T035.
- Polish: T040 ∥ T041 ∥ T042.

## Implementation strategy

MVP first: Phases 1–3 deliver a home with a header, one primary action and a self-deriving checklist (US1). Then add editor variants (US2), the sections (US3), the owner server-setup row (US4), Content tools and optional steps (US5), and the nav/title/skeleton (US6). Validate each story with its own tests before moving on; finish with the full lint, typecheck, test and build pass.
