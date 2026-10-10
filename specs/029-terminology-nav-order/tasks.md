---

description: "Task list for terminology, page descriptions and nav order"
---

# Tasks: Terminology, page descriptions and nav order

**Input**: Design documents from `/specs/029-terminology-nav-order/` (plan.md, spec.md, research.md, data-model.md, contracts/ui.md, contracts/modules.md, quickstart.md)

**Tests**: Requested by the spec (FR-090). Test tasks sit beside the change they pin. Change a pinned assertion only in the same task as the string it pins (research R19).

**Scope guard (R20)**: words, headings and order only. No schema, service, DAL, access rule, server action, API, env var or `docker-compose.yml` change.

**Headless note**: Every check below is a `pnpm vitest run …`, `pnpm typecheck`, `pnpm lint` or `pnpm build` command run with `< /dev/null`. No dev server, browser or `curl`. Page tests use `renderToStaticMarkup` (see plan "Mocks in page tests"). Copy comes verbatim from spec FR-012 / FR-051 / FR-060 and `contracts/ui.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1 nav (P1), US2 page headers (P1), US3 roles (P2), US4 terms (P2), US5 `/p/new` (P3)

Paths below are relative to the repo root; `$P` = `src/app/p/[projectSlug]`.

---

## Phase 1: Setup

- [X] T001 Read `specs/029-terminology-nav-order/contracts/ui.md` and `contracts/modules.md`, and `src/components/ui/PageHeader.tsx`, `src/components/ui/StatusBadge.tsx`, `src/components/shell/LeftNav.tsx`; confirm the line references in research.md still hold. No file edits.

---

## Phase 2: Foundational (blocks all stories)

**Purpose**: shared pieces every story uses.

- [X] T002 [P] Add optional `aside?: ReactNode` to `src/components/ui/PageHeader.tsx` per contracts/modules.md §3 (title and aside share a `flex flex-wrap items-center gap-3` row; without `aside` the markup is unchanged; `titleId` unchanged).
- [X] T003 [P] Export `statusTone(status): BadgeTone` from `src/components/ui/StatusBadge.tsx` (unknown → `"neutral"`) and have `StatusBadge` use it internally; output unchanged.
- [X] T004 [P] Create `src/lib/roles/roles.ts` with `ROLE_OPTIONS` (Editor, Admin, Owner; FR-051 wording verbatim), `roleLabel`, `roleDescription` per contracts/modules.md §1 (type-only import of `Role`; no server runtime imports). First check the wording against `src/server/auth/access.ts` and correct the wording if permissions disagree.
- [X] T005 [P] Create `tests/helpers/page-header.ts` exporting `expectPageHeader(html, { title, description })` per contracts/modules.md §7 (one `<h1`, title in it, description is the `<p>` after the heading block; unescape `&#x27;` and `&amp;`).
- [X] T006 [P] Create `src/lib/roles/roles.test.ts`: order, labels, exact FR-051 strings, `roleLabel` fallback capitalises, `roleDescription(unknown)` is `undefined`. Run `pnpm vitest run src/lib/roles/roles.test.ts < /dev/null`.
- [X] T007 [P] Extend `src/components/ui/ui-atoms.test.ts`: for every `postTargetStatus.enumValues`, `statusLabel` has no underscore and isn't the raw key, `statusTone` matches the badge tone, and `statusLabel("something_new")` fallback is unchanged; add a `PageHeader` `aside` case (no-aside markup unchanged, `<h1>` text is only the title). Run `pnpm vitest run src/components/ui/ui-atoms.test.ts < /dev/null`.

**Checkpoint**: shared pieces done; stories can proceed.

---

## Phase 3: User Story 1 - Nav in the order a newcomer acts (P1) 🎯 MVP

**Goal**: Overview / Publish (Compose, Calendar, Posts, Review, Failures) / Create (Generate, Brand voice, Media, Batch jobs) / Project (Accounts, Settings, Activity).

**Independent Test**: `pnpm vitest run tests/integration/terminology/nav.test.tsx tests/integration/failures/nav.test.ts tests/integration/overview/nav.test.tsx < /dev/null`

- [x] T008 [US1] Edit `NAV_SECTIONS` in `src/components/shell/LeftNav.tsx`: reorder to FR-001, rename labels to "Brand voice" and "Batch jobs", move Activity to group `"Project"` last. Keep URLs, icons, `isNavItemActive`, `NAV_GROUPS` and the render loop unchanged.
- [x] T009 [US1] Edit `tests/integration/failures/nav.test.ts` line 27 only: assert Activity's new place (last in Project) instead of directly after Failures; keep Review-directly-above-Failures, "Failures (2)", ">Failures<" and no-"Failures (" assertions.
- [x] T010 [US1] Create `tests/integration/terminology/nav.test.tsx` (mock `next/navigation` and `next/link` as `failures/nav.test.ts:6-9`): 13 labels in order; group headings Publish/Create/Project in order with their items; Review directly above Failures; "Brand voice" → `/p/x/voice` and "Batch jobs" → `/p/x/jobs` get `aria-current="page"` at those paths; no "Voice"/"Jobs" link text; Overview exact-match not active on `/p/x/compose`. Run the Independent Test command and `pnpm vitest run $P/review/review.test.tsx < /dev/null` (pinned "Review (3)").

**Checkpoint**: nav done.

---

## Phase 4: User Story 2 - Every page says what it is for (P1)

**Goal**: every page in FR-012 uses `PageHeader` with the FR-012 title and one-sentence description; renames applied (FR-006, FR-007, FR-040).

**Independent Test**: `pnpm vitest run tests/integration/terminology/page-headers.test.tsx < /dev/null` plus the per-route files edited below.

### Publish pages

- [X] T011 [P] [US2] `$P/calendar/page.tsx`: `PageHeader` with the shown period as title and description "Scheduled posts and open posting slots, in {tz}."; remove the zone from the title (FR-016).
- [X] T012 [P] [US2] `$P/posts/page.tsx`: `PageHeader` title "Posts", description per FR-012, "New post" in `actions`. (Target badges are T033.)
- [X] T013 [P] [US2] `$P/posts/[postId]/page.tsx`: `PageHeader` title "Post" with `titleId` kept (same id, focusable), description per FR-012, status badge in `aside`, Edit/Delete in `actions`; "Posts" back link stays above.
- [X] T014 [P] [US2] `$P/review/page.tsx`: `PageHeader` "Review" with FR-012 description.
- [X] T015 [P] [US2] `$P/failures/page.tsx`: `PageHeader` "Failures" with `titleId="page-title"` and FR-012 description; totals line stays below (FR-014, FR-015).
- [X] T016 [P] [US2] `$P/compose/Composer.tsx`: no-accounts state (~line 248) uses the same `PageHeader` call as the main form (title `initial ? "Edit post" : "Compose"`, same description).

### Create pages and renames

- [X] T017 [P] [US2] `$P/generate/page.tsx`: `PageHeader` "Generate" with FR-012 description; mode tabs below.
- [X] T018 [P] [US2] `$P/generate/result/[postId]/page.tsx`: `PageHeader` "Generated post" with description; badge in `aside`.
- [X] T019 [P] [US2] `$P/generate/series/[seriesId]/page.tsx`: `PageHeader` "Series" with description; brief stays below.
- [X] T020 [P] [US2] `$P/voice/page.tsx`: rename heading and `metadata` title to "Brand voice", `PageHeader` with "How generated posts should sound.", "New voice profile" link in `actions`.
- [X] T021 [P] [US2] `$P/voice/loading.tsx` and `$P/voice/[profileId]/loading.tsx`: heading text "Brand voice".
- [X] T022 [P] [US2] `$P/voice/new/page.tsx`: `PageHeader` "New voice profile" with description.
- [X] T023 [P] [US2] `$P/voice/[profileId]/page.tsx` (profile name title) and `$P/voice/[profileId]/history/page.tsx` ("{profile name}: history"; back link below): `PageHeader` with FR-012 descriptions.
- [X] T024 [P] [US2] `$P/media/page.tsx`: `PageHeader` "Media" with description.
- [X] T025 [P] [US2] `$P/jobs/page.tsx`: heading and `metadata` title "Batch jobs", `PageHeader` with description, CSV/Media links in `actions`, create link text "New batch job from CSV".
- [X] T026 [P] [US2] `$P/jobs/new/page.tsx` ("New batch job") and `$P/jobs/new/csv/page.tsx` ("New batch job from CSV"): headings, `metadata` titles, `PageHeader` descriptions.
- [X] T027 [P] [US2] `$P/jobs/[jobId]/page.tsx`: `PageHeader` titled by source summary, status badge and "Open: accepting items" marker in `aside`/below (FR-015), FR-012 description; the "Targets" row becomes "Accounts" with values unchanged (FR-040).
- [X] T028 [US2] Update pinned strings in the same task as T025/T026 behaviour: `tests/integration/roles/routes.test.tsx` lines 176 and 187 and `tests/integration/jobs/ui.test.tsx` lines 66, 76, 107 → "New batch job from CSV" (keep each assertion's polarity). Run `pnpm vitest run tests/integration/roles/routes.test.tsx tests/integration/jobs/ui.test.tsx < /dev/null`.

### Project, settings and invitations pages

- [X] T029 [P] [US2] `$P/accounts/connect/[attemptId]/page.tsx`: `PageHeader` in both branches ("Connect {platform group}" / "Connect accounts", description "Choose which accounts to add to this project."); expiry sentence, notices and missing list below.
- [X] T030 [P] [US2] `$P/settings/page.tsx` ("Project settings"), `$P/settings/members/page.tsx` ("Members & invitations"), `$P/settings/api-keys/page.tsx` (first sentence → description, rest and links below), `$P/settings/webhooks/page.tsx` (sentence → description), `$P/settings/webhooks/[endpointId]/page.tsx` ("Webhook: {host}"; "All webhooks" link above): `PageHeader` with FR-012 descriptions.
- [X] T031 [P] [US2] `src/app/invitations/page.tsx`: `PageHeader` "Invitations" with "Projects you've been invited to join."

### Tests

- [X] T032 [US2] Create `tests/integration/terminology/page-headers.test.tsx` using `expectPageHeader`, `sessionModule` swap, `postsEnv`/`jobsEnv`, factories and `createFakeLlm`; mock `ProblemsCallout` as `roles/routes.test.tsx:11-12`. Cover every FR-012 page renderable with fixtures (incl. Series and Generated post, Compose with no accounts, Invitations); Calendar in `Europe/London` shows the zone once in the description; Failures and Post detail keep `id="page-title"` with `tabindex="-1"`; Batch job badge sits outside the `<h1>` and has an "Accounts" row; tab titles via `metadata`/`generateMetadata` say "Brand voice" and "Batch jobs"; SC-007 copy guard (no env-var-style names, `pnpm`/`docker` or `@` in descriptions, role descriptions, hints). Also add `expectPageHeader` cases to `tests/integration/connect/chooser-ui.test.ts`, `tests/integration/api-keys/ui.test.tsx`, `tests/integration/notifications/ui.test.tsx` (Project settings), `tests/integration/accounts-ui.test.ts` (Members) and the Batch job case in `tests/integration/jobs/ui.test.tsx`. Run `pnpm vitest run tests/integration/terminology tests/integration/connect tests/integration/api-keys tests/integration/notifications tests/integration/accounts-ui.test.ts tests/integration/jobs < /dev/null`.

**Checkpoint**: all pages signposted.

---

## Phase 5: User Story 3 - Roles explained (P2)

**Goal**: one source of role names/descriptions, shown on the invite form, signup and Invitations.

**Independent Test**: `pnpm vitest run tests/integration/terminology/roles.test.tsx < /dev/null`

- [x] T033 [US3] `$P/settings/members/invitations-panel.tsx`: invite-form `SegmentedControl layout="cards"` options from `ROLE_OPTIONS` (owner sees 3; admin sees Editor and Admin only via the existing filter; Editor default); pending table role cell uses `roleLabel`.
- [x] T034 [P] [US3] `$P/settings/members/members-panel.tsx` and `src/lib/overview/derive.ts`: use `roleLabel` (rendered text identical; `ROLE_LABEL` = `` `an ${roleLabel(r)}` ``). Run `pnpm vitest run tests/integration/overview < /dev/null` to confirm "You're an Owner" unchanged.
- [x] T035 [P] [US3] `src/app/signup/page.tsx`: name the role by `roleLabel` and show `roleDescription` below the summary in all three states (sign up, log in to accept, accept).
- [x] T036 [US3] `src/app/invitations/page.tsx`: each invitation names `roleLabel` and shows `roleDescription` (same file as T031; do after it).
- [x] T037 [US3] Create `tests/integration/terminology/roles.test.tsx`: invite form as owner (3 cards, Editor checked) and admin (2 cards, no Owner); signup in `signup`, `login_required` and `accept` states for editor/admin/owner invitations; Invitations page for an admin invitation; same label and description in each place (SC-004). Run the Independent Test command.

---

## Phase 6: User Story 4 - Terms explained where met (P2)

**Goal**: posting-slot definition, readable target statuses, voice hints.

**Independent Test**: `pnpm vitest run tests/integration/terminology $P/voice/voice.test.tsx < /dev/null`

- [x] T038 [P] [US4] `$P/accounts/page.tsx`: when at least one account exists, render once, in the connected-accounts section above the cards, "Weekly times this account posts at. Add to queue fills the next free slot." for every role; not repeated per account; no other page adds a definition (FR-020, FR-021).
- [x] T039 [P] [US4] `$P/posts/page.tsx` (after T012): per-target badge reads "{account}: {statusLabel(status)}" with tone from `statusTone`; delete the local tone map and `replaceAll("_", " ")` (FR-030, FR-031).
- [x] T040 [P] [US4] `$P/voice/VoiceEditor.tsx`: `Area` hint `<p>` gets `id={`${id}-hint`}`, error `<p>` gets `id={`${id}-error`}`, textarea gets `aria-describedby` with present ids; pass the four FR-060 hint strings to Voice and tone, Audience, Topics and pillars, Avoid. Shown in edit and read-only modes; leave the "Voice" field-group legend unchanged (FR-008).
- [x] T041 [US4] Extend `$P/voice/voice.test.tsx`: four hints in edit and read-only modes, each textarea's `aria-describedby` contains its hint id, an error still shows; keep the line-129 loop unchanged.
- [x] T042 [US4] Add tests in `tests/integration/terminology/page-headers.test.tsx` (or `terminology/posts-statuses.test.tsx` / `terminology/accounts.test.tsx`): Accounts definition appears once with 2 accounts for owner and editor and is absent with 0 accounts; a post with targets in all 7 statuses (set by a test-only scoped update of `post_targets.status`) renders "{account}: {label}" with no raw key. Run the Independent Test command.

---

## Phase 7: User Story 5 - `/p/new` copy (P3)

**Independent Test**: `pnpm vitest run tests/integration/terminology/p-new.test.tsx < /dev/null`

- [x] T043 [P] [US5] `src/app/p/new/page.tsx`: sentence "Next you'll connect a social account and choose when it posts."
- [x] T044 [P] [US5] `src/app/p/new/new-project-form.tsx`: pass `hint="Posting times and the calendar use this zone."` to `TimeZoneField`; leave Project settings' hint unchanged.
- [x] T045 [US5] Create `tests/integration/terminology/p-new.test.tsx`: sentence present, hint present and its id is in the combobox's `aria-describedby`. Run the Independent Test command.

---

## Phase 8: Docs and final checks

- [x] T046 [P] Update `docs/design-system.md` §6: shell diagram and Sidebar bullet show the FR-001 groups and items (Activity under Project); Page anatomy states every page in the project shell has a `PageHeader` with a one-line description (FR-080).
- [x] T047 [P] Update `docs/generator.md` lines ~55 and ~61: "Batch jobs → New batch job from CSV" wording.
- [ ] T048 [P] 🛑 BLOCKED: sandbox refuses writes to .claude/skills; exact text is in docs/decisions.md "029" Open item. Edit `.claude/skills/docket-ui/SKILL.md`: app-shell bullet lists the FR-001 groups ("Overview first" too), add one line that every route has a one-line `PageHeader` description, and one that role names/descriptions come from `src/lib/roles/roles.ts`; fold in the owed 028 "States" line. If the sandbox refuses the write, put the exact text in T049's "Open item" and say so in the output; don't skip silently (FR-081).
- [x] T049 Add a "029" section (D1–D12 decisions, "no `docker-compose.yml` or env change", any skill-file Open item from T048) to `docs/decisions.md`.
- [x] T050 Run `pnpm lint < /dev/null`, `pnpm typecheck < /dev/null`, `pnpm test < /dev/null`, `pnpm build < /dev/null`; fix failures. Then `git diff --stat -- tests src/**/*.test.*` and confirm the only changed existing assertions are those listed in research R19 (SC-006).
- [ ] T051 [US2] 🛑 BLOCKED: needs a real browser and a running app — owner walk-through of quickstart §4 at desktop width and 390 px (nav order, one title and sentence per page, hints, Failures focus return, no sideways scroll). Everything else is covered by T010, T032, T037, T041, T042 and T045.

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 (T002–T007 all `[P]`) → stories. Stories are independent of one another after Phase 2, with these file overlaps: T012 → T039 (posts page); T031 → T036 (invitations page); T025/T026 with T028; T032 before T042 (same test file).
- US1 (T008–T010) is the MVP and needs only the unmodified shared code.
- T033/T034/T035/T036 need T004. T039 needs T003. T013/T018/T027 need T002.
- Docs (T046–T049) after the stories; T050 last; T051 is human-owned and does not gate T050.

## Parallel Example

```text
After Phase 2: T011–T027, T029–T031 touch different files and run together.
US3: T034, T035 in parallel with T033.
Docs: T046, T047, T048 together.
```

## Implementation Strategy

1. Setup + Foundational → 2. US1 nav (MVP, validate) → 3. US2 headers → 4. US3 roles → 5. US4 terms → 6. US5 `/p/new` → 7. Docs and the full lint/typecheck/test/build.
Commit per area with conventional messages and explicit paths: `feat(nav)`, `feat(ui)`, `refactor(roles)`, `test(…)`, `docs(…)`.

---

## Phase 9: Review remediation

- [x] T052 Point the Accounts ordering assertion at the card heading (`html.indexOf("Posting slots (")`) so the new posting-slot definition no longer breaks it, record it with the other changed pinned assertions in the docs/decisions.md 029 section, then run `pnpm vitest run tests/integration/accounts-ui.test.ts < /dev/null` and the full `pnpm test < /dev/null` — review F1 (MAJOR), tests/integration/accounts-ui.test.ts:240
- [x] T053 Replace the `/p/new` sentence so the `<p>` under "Create a project" reads only "Next you'll connect a social account and choose when it posts." (drop "A project holds its own accounts, posting slots, voice and team."), and tighten `tests/integration/terminology/p-new.test.tsx` to assert that `<p>` equals the sentence exactly — review F2 (MAJOR), src/app/p/new/page.tsx:19
- [x] T054 Add the missing FR-090/SC-001 tests: an `expectPageHeader` case for the Webhook detail page ("Webhook: {host}", "Where this webhook sends events, and its recent deliveries."), and tab-title assertions for `jobs/new` ("New batch job"), `jobs/new/csv` ("New batch job from CSV") and `jobs/[jobId]` `generateMetadata` ("Batch job: {sourceSummary}") in tests/integration/terminology/page-headers.test.tsx — review F3 (MAJOR), src/app/p/[projectSlug]/settings/webhooks/[endpointId]/page.tsx:74
