---

description: "Task list for 028 — Empty states that name the next step, and role awareness"
---

# Tasks: Empty states that name the next step, and role awareness

**Input**: `specs/028-empty-states-roles/` — plan.md, spec.md, research.md (R1–R12, D1–D20), data-model.md, contracts/{services-and-modules,components,ui}.md, quickstart.md

**Tests**: Required by the spec (FR-080–FR-084). Every route gets an owner and an editor test. Existing pinned-copy tests are updated in the same task as the copy change (FR-084), never deleted.

**Execution notes** (headless implement phase: no browser, no network, no dev server):
- Run tests with `pnpm vitest run <paths> < /dev/null`. Everything here is verifiable with Vitest, `pnpm typecheck`, `pnpm lint`, `pnpm build`.
- Copy strings are exact in `contracts/ui.md`. Prop shapes are exact in `contracts/components.md` and `contracts/services-and-modules.md`.
- Read `node_modules/next/dist/docs/` before touching Next APIs (AGENTS.md).
- Commits: Conventional Commits, explicit paths. `refactor(roles)` for moves, `feat(empty-states)` for route changes.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US6, per spec.md

---

## Phase 1: Setup

**Purpose**: Test helper and baseline.

- [x] T001 Run the baseline `pnpm vitest run src/lib/overview tests/integration/overview tests/integration/scheduler-health.test.ts < /dev/null` and record that it passes before any edit (these must stay green through the refactor steps).
- [x] T002 [P] Create `tests/helpers/role-copy.ts` exporting `expectNoPrivilegedText(html, { emails })` per quickstart.md "Helper": fails on env-var-name pattern `/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/`, `docker`, `/api/internal`, `<code`, any member email, and `accounts#add-account`, `#account-…-slots`, `/voice/new` links.

---

## Phase 2: Foundational (blocks all stories)

**Purpose**: Pure modules, read-only services, banners/layout plumbing. No schema, dependency, access-rule or server-action changes.

- [x] T003 Create `src/lib/roles/names.ts` (`joinNames` with fallback param defaulting to "an owner or admin", `managersOf`, `askManagers`, `askOwners`, `Manager` type) per contracts/services-and-modules.md; change `src/lib/overview/derive.ts` to `export { joinNames } from "@/lib/roles/names"`. Add `src/lib/roles/names.test.ts` (fallbacks, owners-first ordering, `Object.keys` has no email/userId); `src/lib/overview/derive.test.ts` must pass unchanged.
- [x] T004 [P] Create `src/lib/roles/slots.ts` (`hasActiveSlot`, `firstWithoutActiveSlot`) with `src/lib/roles/slots.test.ts` (paused and unavailable accounts count as not active).
- [x] T005 [P] Add `missingLlmSettings(problems)` to `src/server/llm/index.ts` (lone LLM_PROVIDER problem expands to provider, model, key) and make `getLlm()` use it with its error message unchanged; add a case in `src/server/llm/index.test.ts` and keep the existing pinned message test green.
- [x] T006 Add `listManagers(scope)` to `src/server/services/members.ts` (`managersOf(await list(scope))`) and make `getOverview` in `src/server/services/overview.ts` use `managersOf` instead of its inline ranking (depends on T003).
- [x] T007 Add `listSlotCounts(scope)` and `AccountSlotCount` to `src/server/services/slots.ts` (`1 + A` reads via `listAccounts` + `listSlots`) and make `getOverview` build `OverviewAccount.slots` from it; make `derive.ts` `slotsDone` use `hasActiveSlot` (depends on T004, T006 — same file as T006's overview edit). Overview tests unchanged.
- [x] T008 [P] Add `countPosts(scope)` to `src/server/services/posts/list.ts` (sum of `scope.posts.counts()` excluding `needs_decision`) and export it from `src/server/services/posts/index.ts`.
- [x] T009 Create `src/server/services/generation/readiness.ts` with `getGenerationReadiness(scope)` per data-model.md §4 (`missingSettings` only for an owner and only when LLM unconfigured; uses T005). Depends on T005.
- [x] T010 Create `src/lib/roles/prerequisites.ts` (`generationPrerequisites`, `PREREQUISITES_TITLE = "Before you can generate"`) per data-model.md §4 and contracts/ui.md "Generate" table, with `src/lib/roles/prerequisites.test.ts` (all missing for owner/admin/editor, partial, all done → `null`, images item, no non-owner output matches the env-name regex, no "Waiting on" for owner, ≤1 action per item). Depends on T003, T009.
- [x] T011 [P] Create `src/lib/roles/calendar.ts` (`calendarState`, all five kinds per data-model.md §5 and contracts/ui.md "Calendar") with `src/lib/roles/calendar.test.ts` (each kind for a manager and for an editor). Depends on T003, T004.
- [x] T012 Add `queueSlotHint` to `src/app/p/[projectSlug]/compose/composer-logic.ts` per data-model.md §6, with cases in the existing composer-logic test file for `none`, `all` (manager and editor), `some` (one and two names), and unknown (`null`). Depends on T003.
- [x] T013 Create `tests/integration/roles/services.test.ts`: `listManagers` returns no emails; `listSlotCounts` counts paused slots as not active; `countPosts` is 0 then 1 after one draft; `getGenerationReadiness` gives `missingSettings` to owner and `null` to admin/editor with the LLM unset (assert via `missingLlmSettings(getLlmStatus().problems)`, never a hard-coded list). Depends on T006–T009.
- [x] T014 Update `src/components/shell/SchedulerHealth.tsx` with required `viewer` prop (owner: today's remedies plus "How to fix this" link to `docsUrl("deployment", "9-is-the-scheduler-running")`; ask: bold headline then "Scheduled posts are not going out. Ask {owners} to start the scheduler.", no `<code>`/link), and `src/components/shell/ReauthBanner.tsx` with `askNames` ("Ask {names} to reconnect it/them."). Update `tests/integration/scheduler-health.test.ts` (render helper passes `viewer: { kind: "owner" }`; add owner/admin/editor × stale/never cases) and `src/components/shell/ReauthBanner.test.ts` (line 30) in the same task.
- [x] T015 Update `src/app/p/[projectSlug]/layout.tsx`: pass `viewer` (owner vs `{ kind: "ask", owners: askOwners(...) }`) to `SchedulerHealth` and `askNames` to `ReauthBanner`; read `listManagers` only when a banner will render and the viewer can't act (research D8). Depends on T006, T014. Add a layout-level case in `tests/integration/roles/` if feasible, otherwise covered by T014.

**Checkpoint**: `pnpm vitest run src/lib/roles src/lib/overview tests/integration/roles tests/integration/overview tests/integration/scheduler-health.test.ts src/components/shell < /dev/null` is green.

---

## Phase 3: User Story 1 — An editor is never sent somewhere they can't act (P1) 🎯 MVP

**Goal**: Banners and every touched route name the managers instead of offering unavailable actions; no privileged text for editors.

**Independent Test**: Render each route as an editor in a project with owner Robin and admin Sam and nothing set up; each "ask" names Robin/Sam and passes `expectNoPrivilegedText`.

Banner work (T014, T015) is the US1 core; the per-route editor assertions accumulate in the route tasks of later phases. This phase adds the sweep.

- [x] T016 [US1] Create `tests/integration/roles/routes.test.tsx`: editor sweep (quickstart scenario 1) rendering Accounts, Calendar, Compose, Posts, Failures, Review, Generate, Jobs, New job (media and CSV), Media and Voice as the editor (use the `sessionModule`/`actAs` pattern from `tests/integration/overview/ui.test.tsx:36-44`; mock `ProblemsCallout` as `review.test.tsx:7-8` does) and calling `expectNoPrivilegedText`; plus scenario 16 (blank owner/admin names fall back to "an owner or admin" / "an owner", never an email). Write the file with cases for every route now; cases for routes not yet implemented are enabled as their story lands — finish and enable all by T045.

**Checkpoint**: Banner tests (T014) pass; sweep file exists.

---

## Phase 4: User Story 2 — An owner sees every prerequisite for generation at once (P1)

**Goal**: One `Checklist` of all missing prerequisites on Generate, both New job pages and Jobs.

**Independent Test**: With AI, accounts and voice all missing, Generate shows one ordered list of three items per role per contracts/ui.md; with all present, it shows the form.

- [x] T017 [US2] Edit `src/app/p/[projectSlug]/generate/page.tsx`: replace the three gates with `<Checklist title={PREREQUISITES_TITLE} items=… />` from `generationPrerequisites(...)` (in place of `GenerateForm` and Recent failures; h1 and mode tabs stay). Update `src/app/p/[projectSlug]/generate/generate.test.tsx` lines ~70, 82 and the "links to Accounts" case (R12) and add owner/admin/editor, partial, and all-ready cases. `generate/policy.test.tsx` must pass unedited. Depends on T010, T015.
- [x] T018 [P] [US2] Edit `src/app/p/[projectSlug]/jobs/new/page.tsx`: keep `notFound()` without `generation: ["run"]`, compute readiness and the media preview, add the `images` item (message "Back to Media" action) when the preview throws or `itemCount === 0`, render h1 + Checklist in place of the form; remove the per-gate EmptyStates and "Back to Media" text link. Add tests in `tests/integration/jobs/ui.test.tsx` or `tests/integration/roles/routes.test.tsx` (four items incl. "Images to generate for"; no form).
- [x] T019 [P] [US2] Edit `src/app/p/[projectSlug]/jobs/new/csv/page.tsx`: same list without the `images` item, in place of `CsvJobForm`. Test: three items, no form.

**Checkpoint**: `pnpm vitest run 'src/app/p/[projectSlug]/generate' tests/integration/jobs < /dev/null` green (Jobs page itself lands in T040).

---

## Phase 5: User Story 3 — Add to queue explains itself before the click (P1)

**Goal**: Compose shows the slot hint and disables Add to queue up front when no selected account has an active slot.

**Independent Test**: `Composer` rendered with accounts whose `hasActiveSlot` is false/mixed/true/null yields the action bar per the components.md table.

- [x] T020 [US3] Edit `src/app/p/[projectSlug]/compose/Composer.tsx`: add `hasActiveSlot` on `AccountOption`, `canManageSlots` (default false), `managersToAsk` (default "an owner or admin"); no-accounts state uses a `buttonStyles({variant:"primary"})` "Connect an account" link for managers and "Ask {managersToAsk} to connect one." for others; action bar per the contracts/components.md table (hint `all`: Add to queue disabled + `secondary` + `aria-describedby={hintId}`, Schedule… last and `cta`; hint `some`: note; unchanged otherwise). `Composer.test.ts:183-189` must keep passing. Add tests for scenario 4 (FR-081), both roles, in `Composer.test.ts`. Depends on T012.
- [x] T021 [P] [US3] Edit `src/app/p/[projectSlug]/compose/page.tsx` and `src/app/p/[projectSlug]/compose/[postId]/page.tsx`: compute `listSlotCounts(scope).catch(() => null)` → `hasActiveSlot` per account (null when unknown), `canManageSlots = scope.can({ slot: ["manage"] })`, `managersToAsk` via `askManagers(await listManagers(scope), "or")` only when the viewer lacks account or slot manage. Add scenario 5 test (account with only a paused slot → props carry `hasActiveSlot: false`). Depends on T007, T020.

**Checkpoint**: `pnpm vitest run 'src/app/p/[projectSlug]/compose' < /dev/null` green.

---

## Phase 6: User Story 4 — Accounts and Calendar for a new owner (P2)

**Goal**: Accounts connect section for managers only with unconfigured platforms in an owner-only closed disclosure; Calendar shows one of five derived states.

**Independent Test**: Scenarios 2 and 3 in quickstart.md.

- [x] T022 [US4] Edit `src/app/p/[projectSlug]/accounts/page.tsx` per contracts/ui.md "Accounts": empty copy by role, `id="add-account"` section for `canManageAccounts` only, order configured groups → mock form → credential forms → owner `<details>` "Not set up on this server ({n})" (closed; summary classes as `Checklist`), admin-with-nothing-connectable fallback "No platforms are set up on this server yet. Ask {O} to set one up."; cards and header action unchanged. Add owner/admin/editor cases to `tests/integration/accounts-ui.test.ts` (line ~154 stays green for owner). Depends on T003, T015.
- [x] T023 [P] [US4] Edit `src/app/p/[projectSlug]/calendar/page.tsx` to render `calendarState(...)` per contracts/ui.md "Calendar" (toolbar+grid hidden for `no_accounts`; EmptyState replacing grid for `no_slots`/`empty_period`; one line plus secondary `sm` button for `no_slots_line`; no `/accounts` link in `empty_period`/`content`; `flex flex-wrap gap-2`). Add scenario 3 tests (a–d) in a new `tests/integration/roles/calendar.test.tsx`. Depends on T007, T011.

**Checkpoint**: accounts and calendar tests green.

---

## Phase 7: User Story 5 — Posts, Failures and Review in an empty project (P2)

**Goal**: Unfiltered empty lists hide their controls and name the next step.

**Independent Test**: Scenarios 6, 7, 8.

- [x] T024 [P] [US5] Edit `src/app/p/[projectSlug]/posts/page.tsx` per contracts/ui.md "Posts" (hide tabs when total is 0 and no status; "No posts yet. Write your first post to see it here." with secondary "Write a post" for `canWritePosts`; filtered-empty "No posts match this filter." + "Show all posts"; button-styled actions). Add tests (scenario 6) in the existing posts route test file or `tests/integration/roles/`.
- [x] T025 [P] [US5] Edit `src/app/p/[projectSlug]/failures/page.tsx` per contracts/ui.md "Failures" using `countPosts` only when the unfiltered list is empty; three empty states; hide counts line, tabs, account filter and Retry all for no-posts. Update `tests/integration/failures/ui.test.tsx` line 70 and add the published-post and filtered cases (R12, scenario 7). Depends on T008.
- [x] T026 [P] [US5] Edit `src/app/p/[projectSlug]/review/page.tsx`: empty copy "Generated posts wait here for approval before they're scheduled. Posts you write yourself don't come here." with primary "Generate a post" to `/generate` for `canRunGeneration`. Update `src/app/p/[projectSlug]/review/review.test.tsx` line 55; add owner/editor cases (scenario 8).

**Checkpoint**: `pnpm vitest run tests/integration/failures 'src/app/p/[projectSlug]/review' < /dev/null` green.

---

## Phase 8: User Story 6 — Media, Voice and Jobs show one clear next step (P3)

**Goal**: One clear action per empty state on Media, Voice and Jobs.

**Independent Test**: Scenarios 11, 12, 13.

- [x] T027 [P] [US6] Edit `src/app/p/[projectSlug]/media/page.tsx` per contracts/ui.md "Media": storage-off EmptyState by role ("Set up storage" `<a href={docsUrl("storage")} target="_blank" rel="noreferrer">` buttonStyles for owner; "Ask {O} to set it up." for others); empty unfiltered library shows only the dropzone (`canEditMedia`) + "No images or videos yet…" copy (no search, tabs, generate link or note); "No images or videos match these filters." keeps controls; info alert replaces the bespoke pill. Add scenario 12 tests (no `role="search"`, no "Filter media" when empty).
- [x] T028 [P] [US6] Edit `src/app/p/[projectSlug]/voice/page.tsx` per contracts/ui.md "Voice" (hide Active/Include-archived tabs when no profiles at all, using one `includeArchived: true` list only when the active list is empty and the archived tab isn't open; manager copy + secondary "Create a voice profile" button; editor "No voice profile yet. Ask {M} to create one."). Update `src/app/p/[projectSlug]/voice/voice.test.tsx` line 57 (`:183` unchanged) and add scenario 13 cases.
- [x] T029 [US6] Edit `src/app/p/[projectSlug]/jobs/page.tsx` per contracts/ui.md "Jobs": header actions only when ready and `canRunGeneration` (primary "New job from CSV", secondary "Choose images in Media" when storage configured); empty copy per FR-045 with no actions; not-ready renders the shared Checklist above the table in place of the bespoke box and hides header actions; existing jobs still listed. Update `tests/integration/jobs/ui.test.tsx` lines 64, 89, 92-95 (configure the fake LLM first for the editor/start-links case) and add scenario 11 cases. Depends on T010, T015 (edits same test file as T018 — sequence after it).

**Checkpoint**: media/voice/jobs tests green.

---

## Phase 9: Polish & Cross-Cutting

- [x] T030 Enable and finish all cases in `tests/integration/roles/routes.test.tsx` (T016) now that every route is implemented, and add scenario 17: confirm `tests/integration/overview/nav.test.tsx`, LeftNav tests and `generate/policy.test.tsx` pass without edits.
- [x] T031 [P] Update docs: `docs/design-system.md` §8 (three States bullets) and §7 `Checklist` row ("also used for prerequisite lists (Generate, Jobs)") per contracts/ui.md "Docs".
- [x] T032 [P] Append "## 028 — Empty states and role awareness (2026-10-09)" with D1–D20 (from research.md "Decisions summary") to `docs/decisions.md`.
- [ ] T033 [P] 🛑 BLOCKED: sandbox refuses writes to .claude/skills (open item logged in docs/decisions.md) — Add the one States line to `.claude/skills/docket-ui/SKILL.md` ("Empty-state actions use `buttonStyles`; unfiltered empty lists hide their filters; prerequisite lists use `Checklist`; 'ask' copy names owners/admins by display name."). If the sandbox refuses writes under `.claude/skills`, record it as an open item in the implement output; do not skip silently.
- [x] T034 Run `pnpm vitest run tests/integration/docs/published-docs.test.ts < /dev/null` (new `docsUrl` anchors exist), then `pnpm lint && pnpm typecheck && pnpm test < /dev/null` and `pnpm build < /dev/null`; fix failures.
- [x] T035 Add a Playwright (or existing e2e harness) check only if the repo already has one configured; otherwise assert the narrow-screen constraint structurally in the T030 tests (no fixed widths; `flex-wrap` classes on the disclosure, Calendar line and Checklist) and note that a real 390 px layout was not measured.
- [ ] T036 🛑 BLOCKED: needs a real browser (chrome-devtools MCP) — run quickstart.md "Manual browser walk-through": focus rings on empty-state actions, keyboard open/close of the "Not set up on this server" disclosure, `document.documentElement.scrollWidth <= 390` on Accounts (expanded), Calendar, Compose, Generate, Jobs and Media, and the editor route sweep.

---

## Dependencies & Execution Order

- **Phase 1** → **Phase 2** (blocks everything). Within Phase 2: T003 → {T006, T010, T011, T012}; T004 → {T007, T011}; T005 → T009 → T010; T006 → T007 (same overview.ts); T014 → T015.
- **US1 (Phase 3)**: banners done in Phase 2; T016 can be started after T002/T015 and is finished at T030.
- **US2 (T017–T019)**, **US3 (T020–T021)**, **US4 (T022–T023)**, **US5 (T024–T026)**, **US6 (T027–T029)** each depend only on Phase 2 and are independent of one another, except T029 shares `tests/integration/jobs/ui.test.tsx` with T018 (do T018 first).
- **Polish** after all stories; T034 last automated step; T036 is human-owned and owed, not blocking.

## Parallel Examples

- After Phase 2: T018, T019, T021, T023, T024, T025, T026, T027, T028 touch distinct files and can run in parallel.
- Phase 2: T004, T005, T008 in parallel; then T003-dependent group.
- Polish: T031, T032, T033 in parallel.

## Implementation Strategy

- **MVP**: Phases 1–2 plus T016 (US1: banners and role-aware "ask" plumbing) then US2/US3 (the other P1s).
- **Incremental**: land each story with its pinned-test updates in the same commit (FR-084); run the scoped Vitest command after each task.
- Don't touch nav labels/order, PageHeader adoption (entry 3) or the Accounts card restructure (entry 4); no schema, dependency, access-rule or server-action changes.

---

## Phase 10: Review remediation

- [x] T037 Make the editor sweep assert the named managers: exact "ask" copy with "Robin"/"Sam" on Accounts, Calendar, Compose, Voice and Media, "Waiting on Robin" / "Waiting on Robin and Sam" on Generate, Jobs and both New job pages, plus one admin case (AI item "Waiting on Robin", no setting name); replace the `/Ask .+ to …/` regexes in tests/integration/accounts-ui.test.ts:207 and tests/integration/jobs/ui.test.tsx:192 with the literal names; delete the dead `PENDING` scaffolding — review F1 (MAJOR), tests/integration/roles/routes.test.tsx:83-91
- [x] T038 Add page-level tests for compose/page.tsx and compose/[postId]/page.tsx (read the `Composer` element's props): paused-only account → `hasActiveSlot: false`, active slot → `true`, `listSlotCounts` failure → `null`, and an editor's `managersToAsk` naming the managers — review F2 (MAJOR), src/app/p/[projectSlug]/compose/page.tsx:26-31
- [x] T039 Complete FR-082 for Generate, Jobs, New job (media) and New job (CSV): an all-three-missing case asserting the three titles and statuses, and a partial case (LLM set, account present, no voice) asserting "Done" ×2 and "To do" ×1; for Jobs, seed without `jobsEnv`'s voice/account and assert no "New job from CSV" header action in the partial case — review F3 (MAJOR), tests/integration/jobs/ui.test.tsx:71-102
- [ ] T040 Commit the implementation and specs/028-empty-states-roles/tasks.md as Conventional Commits staged by explicit path with the trailer (`refactor(roles)` for the joinNames/managersOf/slot-count moves, `feat(empty-states)` for routes and banners, then `test(…)` and `docs(…)`); never `git add -A` or `git add .` — review F4 (MAJOR), .specify/memory/constitution.md:84-89
