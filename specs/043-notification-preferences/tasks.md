---

description: "Task list template for feature implementation"
---

# Tasks: Per-kind and per-platform notification preferences

**Input**: Design documents from `specs/043-notification-preferences/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Requested explicitly (FR-027) — Vitest against real Postgres, per the project's existing
pattern (no external mocks). Test tasks for each user story are listed before that story's
implementation tasks.

**Organization**: Tasks are grouped by user story (spec.md priorities) to enable independent
implementation and testing of each story, after one shared Foundational phase that every story needs
(the table, the migration, the pure rule, and the write path all stories call).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1–US6)
- Every task names its exact file path(s)

---

## Phase 1: Setup

**Purpose**: Define the new store and register it with the project-isolation harness before any logic
is written against it.

- [X] T001 Add the `notificationPreferences` table (`project_id`, `user_id`, `axis`, `switch_key`,
  `on_from_seq`, `created_at`, `updated_at`, the composite PK, the member FK `ON DELETE CASCADE`, and
  the four `CHECK`s for `axis`, non-negative `on_from_seq`, the N1 kind vocabulary, and the key-format
  regex) in `src/server/db/schema/notifications.ts`, and drop the `muted` column from
  `notificationStates` in the same file (data-model.md §1)
- [X] T002 [P] Register `{ table: "notification_preferences", scopeColumn: "project_id" }` in
  `src/server/db/project-owned.ts` (constitution III, FR-022, data-model.md §1)
- [X] T003 Run `pnpm db:generate`, then hand-order the output into `drizzle/0021_*.sql` exactly as
  data-model.md §5 specifies — `CREATE TABLE` → the FK → the `muted = true` → all-kinds-off `INSERT`
  (`ON CONFLICT DO NOTHING`) → `ALTER TABLE … DROP COLUMN "muted"`, each separated by
  `--> statement-breakpoint` — and confirm `pnpm db:check` is green (FR-023, FR-024, Q24)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The pure rule, the wording, and the DAL/service surfaces every user story's tests and
screens call. No user story can be implemented until this phase is complete.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T004 [P] Create `src/lib/notifications/eligibility.ts`: `OFF_SEQ`, `ATTENTION_KINDS`,
  `PreferenceRow`, `ProjectPreferences`, `preferencesOf`, `thresholdOf`, `kindOn`, `anyKindOn`,
  `platformFloorOf`, `mayNotify`, `EligibilityPlan`, `compileEligibility`, `offeredPlatforms`,
  `switchesToTurnAllOn`, `switchesToTurnAllOff` — pure, no I/O, never throws (data-model.md §3,
  contracts/services.md §1)
- [X] T005 Write `src/lib/notifications/eligibility.test.ts`: every kind/platform threshold
  combination, `anyKindOn`'s roll-up, `platformFloorOf` including the empty-keys case (N30),
  `compileEligibility`'s branch/group shapes (Q5), and `offeredPlatforms`' registry ordering (N32,
  FR-019) — depends on T004
- [X] T006 [P] Add the switch wording to `src/lib/notifications/text.ts`: `switchConfirmation`,
  `projectSwitchConfirmation`, `parseSwitchChange`, `preferenceHelpText`, `projectOffText`,
  `platformsOffNote`, `switchLabel`; remove `mutedConfirmation` once its last caller is gone
  (contracts/services.md §6)
- [X] T007 Extend `src/lib/notifications/text.test.ts` for every function added in T006, and confirm
  `tests/lint/date-format.test.ts` still passes (no date is formatted in any of the new sentences) —
  depends on T006
- [X] T008 Add `preferences(): Promise<ProjectPreferences>` and `setSwitches(input)` to
  `NotificationsRepo` in `src/server/dal/notifications.ts`, reusing R3's locked transaction verbatim
  (`SET LOCAL lock_timeout` → `projects` row `FOR UPDATE` → the test hook → membership re-check → load
  current switches and drop requested switches already in the wanted state → for `on: true`,
  `newestAttentionSeq` → the `GREATEST`/`NULL` upsert → for `on: true`, the redundant-mark prune),
  returning `{ outcome, marksPruned }` (data-model.md §4.1, §4.6, §4.7; contracts/services.md §2) —
  depends on T004
- [X] T009 Change `unreadBranches`/`unreadCount`/`countUnread` in `src/server/dal/notifications.ts` to
  take an `EligibilityPlan` instead of `unmutedOnly`: one branch per `memberGroups` entry (outcome
  literals, `seq > minSeq` when non-zero), one branch for `connectFailed`, and no branch at all when
  both are empty (data-model.md §4.2) — depends on T008
- [X] T010 Add the platform clause (the correlated `unnest(provider_keys)` / literal `VALUES` map
  comparison) to every branch built in T009, emitted only when `plan.platforms` is non-null
  (data-model.md §4.3, §4.6) — depends on T009
- [X] T011 [P] Add `platformKeys(): Promise<string[]>` to `AccountsRepo` in
  `src/server/dal/accounts.ts` — distinct `provider_key` for live accounts in one project, registry
  order (data-model.md §4.9)
- [X] T012 [P] Update `listAttention` in `src/server/dal/activity.ts` to take the per-project
  `EligibilityPlan` and apply the same member-group and platform clauses, without applying the floor
  (the panel lists read rows too) (data-model.md §4.4) — depends on T004
- [X] T013 Update `nextChangeAt` in `src/server/dal/notifications.ts` to join each live snooze to its
  event through `activity_events` and apply the compiled plans, so a snooze whose kind or platform is
  now off never arms the poller (data-model.md §4.5, Q13) — depends on T010
- [X] T014 Add `preferencesByProject(): Promise<Map<string, ProjectPreferences>>` to
  `NotificationsSetReader` in `src/server/dal/notifications.ts` and `platformsByProject(): Promise<Map<string, string[]>>`
  (built from T011) inside `runForProjectSet`, one `UNION ALL` branch per project id each
  (data-model.md §4.1, §4.9, Q16, Q17) — depends on T010, T011
- [X] T015 [P] Update `MyProject` in `src/server/dal/my-projects.ts`: drop `muted`, keep
  `notifications: { seenSeq } | null`, add `preferences: ProjectPreferences`; rename `unmutedIds` to
  `notifyingIds` (projects where `anyKindOn`); wire `ProjectSetScope.notifications` to expose
  `preferencesByProject()`, `platformsByProject()` and `setSwitches(projectId, input)`, each resolving
  an out-of-set project id to `NotFoundError` before any SQL (contracts/services.md §3) — depends on
  T014
- [X] T016 [P] Remove `setNotificationsBySlug`, `setMyProjectNotifications`, `myProjectStates` and
  `myStateForProject` from `src/server/services/notifications/index.ts` (contracts/services.md §4
  "Removed")

**Checkpoint**: Foundation ready — the rule, the wording, the writes and the project-set reads all
exist. User story implementation can now begin.

---

## Phase 3: User Story 1 - Hear about the problems I can act on, and not the others (Priority: P1) 🎯 MVP

**Goal**: Turning one attention kind off for a project stops it from reaching the bell, panel and
callout, while the other three kinds and Activity are unaffected.

**Independent Test**: Seed one event of each of the four kinds above the floor; turn one kind off;
check the count drops by exactly that kind, the panel omits it, the callout matches, and Activity is
unchanged for everyone.

### Tests for User Story 1

- [X] T017 [P] [US1] Integration test `tests/integration/notifications/preferences.test.ts`: counting
  under each kind on/off combination (acceptance scenarios 1–4, 6), the 100-event cap unaffected, a
  person with no preference row behaving like today's unmuted project, another member's count
  unaffected by this person's switch, and the anti-drift check — over a seeded matrix of events and
  every combination of switches, the database's count equals `mayNotify`'s count for the same events
  (quickstart.md §3 "US1", Q4)

### Implementation for User Story 1

- [X] T018 [US1] Add `myNotificationPreferences(set): Promise<ProjectPreferenceRow[]>` and
  `myPreferencesForProject(scope): Promise<ProjectPreferenceRow>` to
  `src/server/services/notifications/index.ts` — the kinds axis, in display order, resolved through
  `switchLabel`/`OUTCOME_LABEL` (contracts/services.md §4) — depends on T015, T006
- [X] T019 [US1] Update `unreadSummary`, `recentPanel` and `projectUnread` in
  `src/server/services/notifications/index.ts` to compile and apply the plan from `preferencesByProject`
  / `preferences()`, so "all kinds off" reads as zero everywhere without touching the log
  (contracts/services.md §4 "Unchanged in signature, changed in behaviour") — depends on T009, T010,
  T013

**Checkpoint**: At this point, User Story 1 is fully functional and testable independently.

---

## Phase 4: User Story 2 - Stop hearing about a platform I do not run (Priority: P1)

**Goal**: Turning a platform switch off stops that platform's events from notifying the person, keyed
by platform rather than account, surviving account removal.

**Independent Test**: Seed accounts and failed events on two platforms; turn one off; check only the
other platform's events count; remove that platform's accounts; check the switch is still listed, still
off, and still excludes the historical events.

### Tests for User Story 2

- [X] T020 [P] [US2] Integration test `tests/integration/notifications/preferences-platforms.test.ts`:
  one platform off vs. both on (acceptance scenario 1), a platform whose accounts are all later removed
  (scenario 2), a platform with accounts and no switch (scenario 3), a platform with neither, absent
  from the controls, on by default once an account is connected (scenario 4), a connect failure
  spanning Facebook+Instagram counting once with either on and not at all with both off (scenario 5),
  and an event with no platform recorded governed by its kind alone — asserted on the pure rule and by
  running the §4.3 SQL expression directly against `ARRAY[]::text[]` since the log's `CHECK` makes a
  zero-platform row unreachable (scenario 6, Q22)

### Implementation for User Story 2

- [X] T021 [US2] Add the platform axis to `myNotificationPreferences`/`myPreferencesForProject` in
  `src/server/services/notifications/index.ts`: the offered set from `offeredPlatforms()`, using
  `AccountsRepo.platformKeys()`/`platformsByProject()` for the project's live accounts and
  `platformName()` for display, in registry order (N32, FR-019, contracts/services.md §4) — depends on
  T018, T011, T014

**Checkpoint**: At this point, User Stories 1 AND 2 both work independently.

---

## Phase 5: User Story 3 - Turning something back on does not dump a backlog (Priority: P1)

**Goal**: Turning a switch (kind, platform, or "Turn all on") back on starts counting only from that
moment; turning one off marks nothing read.

**Independent Test**: With a kind off, write 150 events of that kind; turn the kind on; check the count
is 0, then 1 after one more event. Repeat for a platform switch and for "Turn all on".

### Tests for User Story 3

- [X] T022 [P] [US3] Integration test `tests/integration/notifications/preferences-fresh-start.test.ts`:
  the fresh-start position per kind, per platform and via "Turn all on" (scenarios 1–3), switching off
  marking nothing read and leaving other kinds' counts unchanged (scenario 4), an individually read or
  snoozed event whose kind is cycled off/on not counting and leaving no stale mark (scenario 5), pruning
  at the 200-mark cap restoring row actions (scenario 6), "Mark all as read"/a problems view raising the
  floor while a kind was off still hiding everything below it once the kind returns (scenario 7), two
  concurrent on-writes never lowering the recorded position, and an event committed just after the
  switch flips still counting (edge cases)

### Implementation for User Story 3

- [X] T023 [US3] Add `setSwitchBySlug(set, input)` and `setMySwitchForProject(scope, input)` to
  `src/server/services/notifications/index.ts`: the Zod boundary
  (`{ projectSlug?, axis, key?, on }`) and the order of refusal — no session (handled by the caller),
  API-key actor → `ForbiddenError`, project outside the caller's set or unknown → `NotFoundError` (same
  sentence for both), invalid shape/kind/platform key → `ZodError`, then the write
  (contracts/services.md §4, Q21) — depends on T008, T015
- [X] T024 [US3] Resolve `axis: "project"` in both functions from T023 to the switch lists from
  `switchesToTurnAllOn`/`switchesToTurnAllOff` and write them in the one transaction from T008 (Q9,
  Q12) — depends on T023, T004

**Checkpoint**: User Stories 1, 2 and 3 all work independently; the write path is fully exercised.

---

## Phase 6: User Story 4 - Set it all from one place, or from the project (Priority: P2)

**Goal**: The personal Notifications page shows every project as a grid row with its kind and platform
switches and a project-level control; the same control appears on each project's settings page for
every member role; both work with no client JavaScript.

**Independent Test**: With a person in three projects, change a kind in one project and a platform in
another using the keyboard only, confirm each save names the project, and repeat with JavaScript
disabled; as an editor, change the same switches from the project's settings page.

### Tests for User Story 4

- [X] T025 [P] [US4] Component test `tests/integration/notifications/ui.test.tsx`: the grid renders one
  row per project with four kind switches, the platform `<details>` disclosure and the project-level
  controls (scenario 1), a change saves and confirms by project and switch name (scenario 2), every
  control is a plain form post with no `onClick` and no client component so it works with JavaScript
  unavailable (scenario 3), the tab order name → kinds → all-off → all-on → Platforms → platform
  switches with visible focus and accessible names naming both project and switch (scenario 4), an
  editor can submit every switch from the project settings card (scenario 5), a person in no project
  sees the empty state rather than an error (scenario 6), and a renamed project's rows/labels follow the
  new name on reload (scenario 7)

### Implementation for User Story 4

- [X] T026 [P] [US4] Build `NotificationSwitch` (server component) in
  `src/components/notifications/NotificationSwitch.tsx`: one `<form>`, one state-showing submit button,
  hidden `on` input carrying the **target** state, the accessible name pattern `"On — turn off <label>
  notifications for <project>"`, no `aria-pressed` (contracts/ui.md §1, Q18); remove
  `src/components/notifications/NotificationToggle.tsx` once its last caller (T028/T030) is gone
- [X] T027 [US4] Build `NotificationPreferenceGrid` (server component) in
  `src/components/notifications/NotificationPreferenceGrid.tsx`: `Table grouped` with the Project / four
  kind / "This project" columns, one `RowGroup` per project (the kind switches, "Turn all off"/"Turn all
  on"), and a `DetailRow` holding the `<details>` platform disclosure summarising "Platforms (n of m
  on) — `<project>`" built from `NotificationSwitch` (contracts/ui.md §2, Q19) — depends on T026
- [X] T028 [US4] Rewrite `src/app/notifications/page.tsx`: the "Projects" card becomes
  `NotificationPreferenceGrid` fed by `myNotificationPreferences`, confirmations resolved via
  `parseSwitchChange`/`switchConfirmation`/`projectSwitchConfirmation`, `preferenceHelpText()` below the
  grid, and the existing `EmptyState` for a person in no project (contracts/http.md, contracts/ui.md
  §4) — depends on T018, T021, T027, T006
- [X] T029 [US4] Rewrite `src/app/notifications/actions.ts`: `setNotifications(prev, formData)` reading
  `projectSlug`/`axis`/`key`/`on`, calling `setSwitchBySlug`, and redirecting to
  `/notifications?changed=<slug>&axis=…[&key=…]&on=0|1` or `?notifications=<code>`
  (contracts/services.md §5) — depends on T023, T024
- [X] T030 [US4] Rewrite the "Your notifications" card in
  `src/app/p/[projectSlug]/settings/page.tsx` to use the same `NotificationSwitch`/grid-row pieces fed
  by `myPreferencesForProject`, in a `Card` separate from `SettingsForm`, visible to every member role
  (contracts/ui.md §3, FR-016) — depends on T018, T021, T026
- [X] T031 [US4] Rewrite `src/app/p/[projectSlug]/settings/actions.ts`:
  `setMyProjectNotifications(prev, formData)` calling `setMySwitchForProject` and redirecting to
  `/p/<slug>/settings?changed=1&axis=…&key=…&on=…` or `?notifications=<code>`
  (contracts/services.md §5) — depends on T023, T024
- [X] T032 [US4] Update `src/components/notifications/NotificationPanel.tsx`'s copy for the
  `all_muted` state to the N33 roll-up meaning ("no project of yours has any kind on") while keeping the
  wire value `all_muted` and the sentence "Notifications are off for all of your projects." unchanged
  (Q15, FR-012) — depends on T019

**Checkpoint**: All four P1/P2 interactive user stories (US1–US4) are independently functional.

---

## Phase 7: User Story 5 - Nobody else's switches, and nothing leaked (Priority: P1)

**Goal**: Every preference read and write is confined to the caller's own resolved project set; an
unknown project and one the caller does not belong to are indistinguishable.

**Independent Test**: Call every preference mutation with no session, an expired session, another
member's user, a foreign/unknown project, and a public-API key; check each is refused identically with
nothing written.

### Tests for User Story 5

- [X] T033 [P] [US5] Integration test `tests/integration/notifications/preferences-authz.test.ts`: no
  session and an expired session refused (scenario 1), a request naming another person changing nothing
  of theirs (scenario 2), a foreign project and an unknown project giving the identical "not found" with
  nothing written or revealed (scenario 3), a public-API key refused on every path (scenario 4), a
  removed member's rows and switches gone from their next load (scenario 5), membership removal deleting
  preferences in the same transaction and a rolled-back removal ("last owner") leaving them intact
  (scenario 6), and project/user deletion taking the preferences with it (scenario 7)

### Implementation for User Story 5

- [X] T034 [US5] Extend `tests/helpers/scope-check.ts`'s project-owned assertions to cover
  `notification_preferences`, confirming every statement built in T008–T014 is pinned to a project or
  runs inside `runForProjectSet` (constitution III, FR-022) — depends on T002, T008–T014
- [X] T035 [US5] Close any gap T033 finds in the refusal order built in T023 (`ForbiddenError` for
  API-key actors before `NotFoundError`, `NotFoundError` before `ZodError`, identical sentence for a
  foreign and an unknown project) — depends on T023, T033

**Checkpoint**: All five P1 stories and the P2 UI story are independently functional and isolated.

---

## Phase 8: User Story 6 - An existing install upgrades without losing anyone's choice (Priority: P1)

**Goal**: Migration 0021 turns every `muted = true` row into all-kinds-off and leaves `muted = false`
rows with nothing stored, touching no reading position, timestamp or sparse mark, with no operator
step.

**Independent Test**: Seed `notification_states` rows with both `muted` values, non-zero positions,
`seen_at` and sparse marks; apply the migration; check muted rows read as off, unmuted rows read as
fully on, and nothing else changed.

### Tests for User Story 6

- [X] T036 [P] [US6] Migration test `tests/integration/notifications/mute-migration.test.ts`, modelled
  on `marks-migration.test.ts` (builds and drops its own database): seeds muted/unmuted rows with
  positions, `seen_at` values and sparse marks; applies 0021; asserts every muted row now has all four
  kinds off and reads as off (scenario 1), every unmuted row has no preference row and an unchanged
  count (scenario 2), every position/`seen_at`/mark is byte-identical (scenario 3), a previously-muted
  person turning one kind on gets the fresh-start rule from that moment, not from when they muted
  (scenario 4), the migration succeeds with no operator step (scenario 5), and `pnpm db:check` is green
  (scenario 6) — depends on T003

### Implementation for User Story 6

- [X] T037 [US6] Rename `tests/integration/notifications/mute.test.ts` to `project-switch.test.ts`,
  rewriting its assertions from the `muted` boolean to the roll-up, the busy/locking behaviour and the
  project-level controls (plan.md Project Structure) — depends on T024
- [X] T038 [US6] Update every remaining test that reads or seeds `muted` —
  `tests/integration/notifications/cap.test.ts`, `mark-all.test.ts`, `mark-read.test.ts`,
  `marks.test.ts`, `membership.test.ts`, `performance.test.ts`, `routes.test.ts`, `scope.test.ts`,
  `snooze.test.ts`, `start-migration.test.ts`, `view-mark.test.ts` — and extend
  `tests/helpers/notifications.ts` with helpers to seed a switch, seed a muted-equivalent (all four
  kinds off), and seed events on given platforms — depends on T009, T010, T023

**Checkpoint**: All six user stories are independently functional; an existing install upgrades safely.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: The performance case the plan names, the docs this entry owes, and the full-suite
validation — plus the one check that needs a human because it needs a browser.

- [X] T039 [P] Extend `tests/integration/notifications/performance.test.ts` with a second seeded person
  who has all four kind switches stored and every platform switched off — the pathological case for the
  platform clause (Q7) — and assert the count, refresh route and panel each stay under 100 ms (median of
  5 after warm-up) for both people (SC-007)
- [X] T040 [P] Append decisions N25–N41 to `docs/decisions.md`, each next to the decision it replaces or
  extends (N5, N6, N10, and 022's R1, R4, R5, R14), stating the reversal, the replacement and the fate
  of the data written under the old rule; append plan decisions Q1–Q24 next to the same shipped
  decisions (FR-025)
- [X] T041 [P] Update `docs/activity.md` §Notifications: replace the "Muting" bullet with per-kind and
  per-platform preferences, the roll-up, the one-click all-off/all-on, the fresh-start rule, and the
  unchanged fact that delivery outside Docket is webhooks (FR-025)
- [X] T042 [P] Update `docs/design-system.md` §7 with "a switch that saves on activation" (Q18) and the
  control-matrix exception to the five-column ceiling (Q19); add `NotificationSwitch` and
  `NotificationPreferenceGrid` to the component table (FR-025)
- [X] T043 [P] Update `.claude/skills/docket-ui/SKILL.md`: rename the `/notifications` structure entry
  from "mute settings" to "the per-project notification grid" and name the new switch/grid patterns
  (contracts/ui.md §7)
- [X] T044 Run the full validation from quickstart.md §2: `pnpm lint && pnpm typecheck && pnpm test &&
  pnpm db:check && pnpm build && node scripts/check-contrast.mjs` — depends on every prior task.
  Lint (0 errors), typecheck, the full suite (5281 passed/55 skipped), build and the contrast check are
  all green. `pnpm db:check`'s own script fails in this Windows/Git-Bash environment with a
  `spawnSync pnpm ENOENT` — Node's `spawnSync("pnpm", …)` without `shell: true` cannot resolve
  `pnpm.cmd` on Windows, a pre-existing property of the script (unchanged by this feature) rather than a
  migration problem: `pnpm exec drizzle-kit check` run directly reports "Everything's fine" against the
  real database, confirming the journal and 0021's snapshot are consistent.
- [ ] T045 [Human-owned — needs a running `pnpm dev` server, a signed-in browser session, and two
  accounts in one project; none of which any pipeline phase has] Walk through quickstart.md §5 by hand:
  turn *Needs reconnecting* off for one project with the keyboard alone and check the confirmation and
  bell count; confirm the events are still in Activity; open the Platforms disclosure with `Enter` and
  turn one platform off; use "Turn all off" then "Turn all on"; repeat the kind and platform steps with
  JavaScript disabled in DevTools; as an editor, change every switch from `/p/<slug>/settings`; narrow
  the window to phone width and check each row reads as labelled "kind: On/Off" lines. Record a pass/fail
  per step — if the window for this walkthrough closes (e.g. the feature is superseded before it is
  run), mark this task as unachievable and say why rather than leaving it open indefinitely — depends on
  T044

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Setup (the schema must exist before the rule and DAL are
  written against it) — BLOCKS all user stories.
- **User Stories (Phase 3–8)**: All depend on Foundational completion.
  - US1 (T017–T019) and US2 (T020–T021) can proceed in parallel; US2's implementation task (T021)
    extends the same read models US1 builds (T018), so US2 should start after T018 lands even though
    its test (T020) can be written immediately.
  - US3 (T022–T024) can start as soon as Foundational is done; it does not depend on US1/US2.
  - US4 (T025–T032) depends on US1's and US2's read models (T018, T021) and US3's mutation services
    (T023, T024) existing, since the screens call all of them.
  - US5 (T033–T035) depends on every DAL/service statement built so far (T002, T008–T014, T023) to have
    something to test the isolation of.
  - US6 (T036–T038) depends on the migration (T003) and the mutation/counting paths (T009, T010, T023,
    T024) it updates tests against.
- **Polish (Phase 9)**: Depends on all six user stories being complete, except T045 which also depends
  on T044.

### User Story Dependencies

- **US1 (P1)**: Foundational only.
- **US2 (P1)**: Foundational, and US1's T018 (extends the same functions).
- **US3 (P1)**: Foundational only.
- **US4 (P2)**: Foundational, US1 (T018), US2 (T021), US3 (T023, T024) — the grid and card are the one
  screen that calls every read model and every mutation.
- **US5 (P1)**: Foundational, and whatever DAL/service surface exists by the time it runs (it tests
  isolation of the whole surface, so it is easiest to run last among the P1 stories).
- **US6 (P1)**: The migration (Phase 1, T003) plus the counting/mutation paths it asserts against (US1,
  US3).

### Within Each User Story

- Tests are written before that story's implementation tasks and should be run again once the
  implementation lands.
- DAL/service work precedes the screens that call it.
- Each story's checkpoint is independently demonstrable before the next story starts.

### Parallel Opportunities

- Setup: T002 can run alongside T001 (different files); T003 must follow T001.
- Foundational: T004, T006, T011, T012, T015, T016 touch different files and can run in parallel once
  their stated dependencies are met; T005 follows T004 and T007 follows T006; T008→T009→T010→T013→T014
  are sequential (same file, `src/server/dal/notifications.ts`).
- Once Foundational is done, US1's and US3's test tasks (T017, T022) and US5's and US6's test tasks
  (T033, T036) can all be written in parallel — they touch different files and read, not change, the
  implementation.
- US4's two new components (T026 then T027) and its two page/action pairs (T028+T029,
  T030+T031) touch disjoint files from each other once T026/T027 exist, so the notifications-page pair
  and the settings-page pair can proceed in parallel.
- Polish: T039–T043 are five independent files and can all run in parallel; T044 and T045 are
  sequential and last.

---

## Parallel Example: User Story 1

```bash
# Once Foundational (Phase 2) is done:
Task: "Integration test for counting under every kind combination in tests/integration/notifications/preferences.test.ts"

# Then, sequentially (both touch src/server/services/notifications/index.ts):
Task: "Add myNotificationPreferences/myPreferencesForProject to src/server/services/notifications/index.ts"
Task: "Update unreadSummary/recentPanel/projectUnread in src/server/services/notifications/index.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories).
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: run `preferences.test.ts`; confirm the kind axis behaves exactly as the old
   per-project mute did for a person who has only ever touched kind switches.

### Incremental Delivery

1. Setup + Foundational → the table, the rule, the writes and the project-set reads all exist.
2. Add US1 (kinds) → test independently.
3. Add US2 (platforms) → test independently; the read models from US1 now carry both axes.
4. Add US3 (fresh start) → test independently; the write path is now fully exercised.
5. Add US4 (the screens) → test independently; everything built so far becomes reachable without
   JavaScript.
6. Add US5 (isolation) → test independently; confirms the whole surface refuses what it should.
7. Add US6 (the migration) → test independently; confirms an existing install upgrades losslessly.
8. Polish: performance, docs, full-suite validation, and the by-hand walkthrough, last.

### Notes

- [P] tasks = different files, no dependencies.
- [Story] label maps task to specific user story for traceability.
- The browser/visual-judgement task (T045) is deliberately last, per the roadmap rule that no such task
  starves the automated implement loop.
- Commit after each task or logical group; stop at any checkpoint to validate a story independently.
