---

description: "Task list for 033 Accounts restructure and first-post flow"
---

# Tasks: Accounts restructure and first-post flow

**Input**: Design documents from `/specs/033-accounts-first-post/` (plan.md, spec.md, research.md, data-model.md, contracts/modules.md, contracts/ui.md, quickstart.md)

**Tests**: Requested by the plan and quickstart (Vitest on a real Postgres). Every scenario maps to a test. Run tests with stdin closed: `pnpm vitest run <paths> < /dev/null`.

**Organization**: Grouped by user story. US1–US6 are independent after Phase 2, except that US2's message placement sits in the card structure US1 produces.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- Copy and layout live in `contracts/ui.md`; signatures live in `contracts/modules.md`. Read the named section before each task.

## Phase 1: Setup

**Purpose**: Confirm the baseline before changing anything.

- [x] T001 Run `pnpm typecheck < /dev/null` and `pnpm vitest run tests/integration/accounts-ui.test.ts tests/integration/failures/nav.test.ts < /dev/null` on the clean branch and note the green baseline (no file changes). Read `node_modules/next/dist/docs/01-app/03-api-reference/02-components/link.md` around lines 687-702 for hash navigation.

---

## Phase 2: Foundational (pure modules and shared pieces)

**Purpose**: Pure, UI-independent modules that several stories use. These MUST be done first.

- [x] T002 [P] Create `src/lib/accounts/connect-landing.ts` (`LANDING_MAX`, `ConnectLanding`, `classifyConnect`, `landingHref`, `parseLanding` with Zod, `landingMessage`) per contracts/modules.md §1 and research R6. No `@/server` imports.
- [x] T003 [P] Create `src/lib/accounts/chooser-order.ts` exporting `listedOrder` per contracts/modules.md §2.
- [x] T004 [P] Add `countsTowardFirstPost` to `src/lib/overview/derive.ts` and use it in `deriveChecklist` in place of the inline sum (about line 183), behaviour identical, per contracts/modules.md §8.
- [x] T005 [P] Create `src/lib/compose/first-post.ts` (`firstPostCalendarHref`, `zonedDate` using `Intl.DateTimeFormat.formatToParts`) per contracts/modules.md §10 and research R10.
- [x] T006 [P] Write `src/lib/accounts/connect-landing.test.ts` covering every row of research R6, bad/repeated/out-of-range input (0/0, 501, repeated key, non-UUID) and slug encoding.
- [x] T007 [P] Write `src/lib/accounts/chooser-order.test.ts` (roots then children in input order, every element exactly once, orphan parent keys).
- [x] T008 [P] Write `src/lib/compose/first-post.test.ts` (earliest ok time, project-zone date across a date line e.g. 23:30 UTC in Pacific/Auckland, `now` gives the bare calendar, all-failed gives no link).
- [x] T009 [P] Extend the tests in `src/lib/overview/` to cover `countsTowardFirstPost` for every status mix; existing overview tests stay unchanged.
- [x] T010 Run `pnpm vitest run src/lib/accounts src/lib/compose src/lib/overview < /dev/null` and fix until green.

**Checkpoint**: Pure modules ready.

---

## Phase 3: User Story 1 - Account card that leads with what to do next (P1) 🎯 MVP

**Goal**: Card order is status → Posting slots → Posting instructions (closed `<details>`, "· Set"/"· None") → Remove.

**Independent Test**: `tests/integration/accounts-ui.test.ts` renders the Accounts page for an owner and an editor and asserts the order and visibility.

- [x] T011 [US1] Restructure the account card in `src/app/p/[projectSlug]/accounts/page.tsx` per contracts/ui.md §1 and FR-001–FR-009: status block with reconnect and mock controls, Posting slots with the add-slot form, a closed native `<details>` for Posting instructions (open state kept after a failed save), Remove last and visually separated. Keep anchors `#account-{id}`, `#account-{id}-slots`, `#add-account`, and the page-level slot definition once.
- [x] T012 [US1] Update `tests/integration/accounts-ui.test.ts`: change the order assertions at about `:233` and `:240` on purpose, and add cases for scenarios 1–5 in quickstart §2 (order via index of `account-{id}-name`, `account-{id}-slots`, `Posting instructions ·`, Remove; `· Set`/`· None`; needs-reconnect badge and Reconnect before slots; editor sees no form, Remove, Actions column, mock/reconnect controls; definition appears once; anchors exist).
- [x] T013 [US1] Run `pnpm vitest run tests/integration/accounts-ui.test.ts tests/integration/accounts-posting-instructions.test.ts tests/integration/accounts-slots.test.ts < /dev/null` and fix until green.

**Checkpoint**: US1 complete and independently testable.

---

## Phase 4: User Story 2 - Land on the slot editor after connecting (P1)

**Goal**: Every successful connect (chooser, credentials, mock, reconnect) lands on the first new account's Posting slots with focus on the weekday pill, or on the card name for a reconnect, with a visible and announced message.

**Independent Test**: Action tests assert landing URLs; `tests/integration/accounts-landing.test.ts` asserts page markup and that forged or stale params render as no query.

- [x] T014 [US2] Update `src/app/p/[projectSlug]/accounts/actions.ts` per contracts/modules.md §3: pre-read `accounts.listAccounts(scope)` inside the `runAction` callback, call `classifyConnect`, return `landing` (type `ConnectedAccount`) from `connectMockAction`, `reconnectMockAction` and `connectCredentialsAction`, and `redirect(landingHref(...))` from `chooseConnectCandidatesAction`. Failure paths unchanged, no `landing`, no new activity entries.
- [x] T015 [US2] In `src/server/services/connect.ts` sort `chosen` with `listedOrder` before saving in `chooseConnectCandidates`, and in `src/app/p/[projectSlug]/accounts/connect/[attemptId]/ChooserForm.tsx` replace the inline `roots`/`childrenOf` with `listedOrder` (markup unchanged).
- [x] T016 [P] [US2] Create `src/app/p/[projectSlug]/accounts/ConnectLanding.tsx` per contracts/modules.md §4 (scroll, focus with `preventScroll`, announce via `LiveRegion`, `history.replaceState`; never throws if elements are missing).
- [x] T017 [US2] In `src/app/p/[projectSlug]/accounts/page.tsx` parse the landing with `parseLanding`, validate against the page's own account list and `account:manage`, render the message (under the slots heading for new, in the status block for reconnect), give the h3 `tabindex="-1"` only for a reconnect landing, and render `ConnectLanding` once. Stale or forged input renders the normal page. See contracts/ui.md §2.
- [x] T018 [P] [US2] Make `router.push(res.data.landing)` the success path in `src/app/p/[projectSlug]/accounts/ConnectCredentialsForm.tsx`, `ConnectMockForm.tsx` and `ReconnectMockButton` in `SlotEditor.tsx` per contracts/modules.md §5 (secrets cleared before navigation).
- [x] T019 [US2] Add landing cases to `tests/integration/actions-authz.test.ts` (existing assertions kept): chooser with 2 new → `connected=2&reconnected=0#account-{id}-slots`; 1 new + 1 reconnected; refresh-only → `#account-{id}`; credentials and mock return `landing`; failures return none; results never echo field values. Use helpers in `tests/helpers/connect-group.ts` and catch `RedirectSignal`. Also assert the activity row count matches today's (FR-017).
- [x] T020 [US2] Create `tests/integration/accounts-landing.test.ts` for scenarios 10–11 in quickstart §2: valid landing markup (message, `ConnectLanding` once, `tabindex`), and forged or stale landings (unknown id, editor viewer, 0/0, 501, repeated key) render identically to no query.
- [x] T021 [US2] Run `pnpm vitest run tests/integration/accounts-ui.test.ts tests/integration/accounts-landing.test.ts tests/integration/actions-authz.test.ts tests/integration/connect < /dev/null` and fix until green (`connect/callback-hint.test.ts` must be unchanged and green).

**Checkpoint**: US1 and US2 work together.

---

## Phase 5: User Story 3 - Prerequisite lists as a notice (P2)

**Goal**: A shared `SetupNotice` replaces `Checklist` at Generate and the three Batch job gates, content unchanged.

**Independent Test**: Gate tests find the SetupNotice markers for owner and editor and none when ready; the overview still uses `Checklist`.

- [x] T022 [US3] In `src/components/ui/Checklist.tsx` export `checklistStatusText` and `ChecklistRows`, and add the additive `footer` prop (rendered after the list, outside the collapsed `<details>`), per contracts/modules.md §6. Markup for callers without `footer` stays byte-identical.
- [x] T023 [US3] Create `src/components/ui/SetupNotice.tsx` per contracts/modules.md §7 (server-compatible, dashed frame, decorative icon, `<section aria-labelledby>`, `ChecklistRows`).
- [x] T024 [P] [US3] Write `src/components/ui/SetupNotice.test.tsx` (static markup: status in words, at most one action per row, decorative icon, ids) and extend `src/components/ui/ui-atoms.test.ts` for `Checklist` unchanged output and `footer`.
- [x] T025 [US3] Swap `Checklist` for `SetupNotice` in `src/app/p/[projectSlug]/generate/page.tsx`, `jobs/page.tsx`, `jobs/new/page.tsx` and `jobs/new/csv/page.tsx`, keeping titles, items, and statuses exactly (FR-024). See contracts/ui.md §3.
- [x] T026 [US3] Add a marker check (`border-dashed`, `aria-labelledby="setup-notice-title"`) to `tests/integration/roles/routes.test.tsx`, `tests/integration/jobs/ui.test.tsx` and `src/app/p/[projectSlug]/generate/generate.test.tsx`; keep existing "Before you can generate" assertions; `overview/ui.test.tsx` stays unchanged.
- [x] T027 [US3] Run `pnpm vitest run src/components/ui tests/integration/roles/routes.test.tsx tests/integration/jobs/ui.test.tsx "src/app/p/[projectSlug]/generate/generate.test.tsx" src/lib/roles/prerequisites.test.ts < /dev/null` and fix until green.

**Checkpoint**: US3 complete.

---

## Phase 6: User Story 4 - See the first post on the calendar (P2)

**Goal**: The Added to the queue, Scheduled and Publishing dialogs show "See it on the calendar" once, on the action that makes the project's first post.

**Independent Test**: Dialog test with mocked actions: link only with `firstPostDone=false` and at least one ok row.

- [x] T028 [US4] Add `hasFirstPost(scope)` to `src/server/services/overview.ts` per contracts/modules.md §9 (scoped DAL only).
- [x] T029 [US4] Pass `firstPostDone={canSchedule ? await hasFirstPost(scope) : true}` from `src/app/p/[projectSlug]/compose/page.tsx` and `compose/[postId]/page.tsx`, and forward it through `Composer.tsx` (prop defaults to `true`) to the dialogs, per contracts/modules.md §11.
- [x] T030 [US4] In `src/app/p/[projectSlug]/compose/ScheduleDialogs.tsx` capture `wasFirst` on confirm, reset on close, and render the primary-button `Link` "See it on the calendar" (via `firstPostCalendarHref`) when `done && wasFirst && rows.some(ok)`. `compose/actions.ts` stays unchanged (FR-036). See contracts/ui.md §4.
- [x] T031 [US4] (done as static-markup tests of the exported `CalendarLink` in `ScheduleDialogs.test.ts`; no DOM env exists, so "survives the prop flipping" holds by construction — `wasFirst` is state captured on confirm — not by test) Add dialog tests (extend `src/app/p/[projectSlug]/compose/Composer.test.ts` or add a new file beside it, mocking actions as line 9 does) for quickstart scenario 17: link shows, survives the prop flipping to `true`, absent when `firstPostDone=true`, absent when all rows failed.
- [x] T032 [US4] Run `pnpm vitest run tests/integration/compose "src/app/p/[projectSlug]/compose" tests/integration/overview < /dev/null` and fix until green (`compose/actions.test.ts` unchanged).

**Checkpoint**: US4 complete.

---

## Phase 7: User Story 5 - Getting-started guide (P3)

**Goal**: `docs/getting-started.md` in the docs nav and `DocPage`, linked from the overview's Getting started card in full and collapsed forms.

**Independent Test**: Published-docs test, overview UI test and a content guard.

- [X] T033 [P] [US5] Write `docs/getting-started.md` following contracts/ui.md §5 (about 900 words or fewer): connect an account, add posting slots, first post, optional brand voice/generation/review, the three roles in the app's words, where to look afterwards. No command fences, no env var names (pointer to server docs only).
- [X] T034 [P] [US5] Add the nav entry first under "Using Docket" in `mkdocs.yml` and a listing in `docs/index.md`; add `"getting-started"` to `DocPage` in `src/lib/docs.ts`.
- [X] T035 [US5] Pass `footer` to `Checklist` in `src/app/p/[projectSlug]/(overview)/page.tsx` with a link "Read the getting-started guide" (opens in a new tab) via `docsUrl("getting-started")`, shown in both full and "Setup complete" forms, for every role that sees the card (FR-046).
- [X] T036 [US5] Add tests: `docsUrl("getting-started")` in `tests/integration/docs/published-docs.test.ts`; full and collapsed link cases in `tests/integration/overview/ui.test.tsx`; and a content guard (new `tests/integration/docs/getting-started.test.ts`) that reads `docs/getting-started.md` and rejects code fences, `pnpm `, `docker `, and `[A-Z][A-Z0-9]+_[A-Z0-9_]+` tokens.
- [X] T037 [US5] Run `pnpm vitest run tests/integration/overview tests/integration/docs < /dev/null` and fix until green.

**Checkpoint**: US5 complete.

---

## Phase 8: User Story 6 - Two accessibility fixes (P3)

**Goal**: The switcher's accessible name is the project name only with `aria-keyshortcuts`; the setup password hint is always linked and visible.

**Independent Test**: Render `ProjectSwitcher` and `SetupField` and assert attributes.

- [x] T038 [P] [US6] In `src/components/shell/ProjectSwitcher.tsx` add `aria-keyshortcuts="Control+K Meta+K"` to the button and `aria-hidden="true"` to the `<kbd>`; nothing else changes (contracts/modules.md §13).
- [x] T039 [P] [US6] In `src/app/setup/setup-form.tsx` extract/export `SetupField` per contracts/modules.md §14: `aria-describedby` joins the hint id and error id, the hint is always rendered; `SetupForm` uses three `SetupField`s with today's arguments.
- [x] T040 [US6] Add tests: render `ProjectSwitcher` with `next/navigation` mocked (name, `aria-keyshortcuts`, `kbd` hidden), and `SetupField` with and without `error` (describedby, hint visible). Place beside each component.
- [x] T041 [US6] Run the new tests plus `pnpm vitest run tests/integration/failures/nav.test.ts < /dev/null` and fix until green.

**Checkpoint**: All user stories complete.

---

## Phase 9: Polish & Cross-Cutting

- [x] T042 [P] Update `docs/design-system.md` §7: add the SetupNotice row (props, when to use it, that it is an EmptyState variant), and update the Checklist row (no prerequisite lists, has `footer`).
- [x] T043 [P] Update the posting-instructions placement sentence in `docs/accounts.md`.
- [x] T044 [P] Add the "033" section to `docs/decisions.md`: navigation-not-behaviour change (FR-019), what is not included (FR-062), Intl instead of Temporal (research R10), and the intentionally changed `accounts-ui.test.ts` assertions.
- [x] T045 Update the docket-ui skill (`.claude/skills/docket-ui/SKILL.md`) to say prerequisite gates use SetupNotice (FR-027). If the sandbox refuses the write, instead add an open item to the 033 section of `docs/decisions.md` stating the exact owed edit.
- [x] T046 Final pass: run `pnpm lint < /dev/null && pnpm typecheck < /dev/null && pnpm test < /dev/null`, then `pnpm build < /dev/null`. Check SC-009 with `git diff main -- tests 'src/**/*.test.*'`: only the intended `accounts-ui.test.ts` assertions changed.
- [ ] T047 🛑 BLOCKED: needs a real browser and a human (the headless implement phase has none) — one survey walk-through at desktop width and 390 px against the local mock setup, following quickstart §4 steps 1–9 (landing focus and VoiceOver announcement, card order, reconnect, SetupNotice gates, first-post link, overview guide link, switcher name, `/setup` hint, editor view). Report all findings in one pass.
- [ ] T048 🛑 BLOCKED: needs the PR's CI run — the strict mkdocs build (`.github/workflows/docs.yml`) cannot run in the sandbox; confirm it passes on the PR. Report as "verified by CI", not as run locally.

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 (blocks everything) → Phases 3–8 → Phase 9.
- US1 first (US2's message placement uses its card structure). US3's T022 (`Checklist` exports and `footer`) precedes US5's T035. Otherwise US3–US6 are independent of each other.
- Within US2: T014, T015 → T017 → T018; T016 is parallel with T014; tests T019–T020 follow their code.
- T011 and T017 both edit `accounts/page.tsx`; T022 and T035 touch separate files but T035 needs T022.

### Parallel opportunities

- Phase 2: T002–T005 together, then T006–T009 together.
- US2: T016 and T018 in parallel with the actions work.
- US5: T033 and T034. US6: T038 and T039. Phase 9: T042–T044.

## Implementation Strategy

- **MVP**: Phases 1–3 plus the first half of Phase 4 (US1 and US2 are both P1; ship them together).
- Then US3 and US4 (P2), then US5 and US6 (P3), then Polish. Each story ends with a green targeted test run.
- T047 and T048 are owed to a human or CI and do not block the other work.
