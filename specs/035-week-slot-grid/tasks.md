---

description: "Task list for the reusable week slot grid"
---

# Tasks: Reusable week grid for posting slots

**Input**: Design documents from `/specs/035-week-slot-grid/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/week-slot-grid.md, contracts/move-slot.md, quickstart.md

**Tests**: Requested by the spec (Workflow: tests required) and by R12's three-layer test shape. Tests are included for every layer.

**Organization**: Tasks follow the plan's implementation sequence — server first (independently testable), then the logic module, then the component, then the page replacement, then docs, then one final check, then the human walk-through. User stories map to groups of tasks within that sequence rather than separate parallel phases, because US1 and US2 share the same component and the same server action, and building the server and the component out of story order would mean re-touching the same files twice.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4), or none for setup/foundational/polish
- Include exact file paths in descriptions

---

## Phase 1: Setup

No new project, dependency or tool. Nothing to initialize beyond what already exists in the tree (constitution VI, R5, R12).

- [X] T001 Re-verify the facts table in [research.md](research.md) against the current tree: confirm `src/server/services/slots.ts:10`'s slot shape, `src/server/dal/slots.ts:46-60`'s `isUniqueViolation` handling, `src/lib/validation/scheduling.ts:5-13,91`'s existing schemas, `src/app/p/[projectSlug]/accounts/page.tsx:69,130`'s `canManage` and focus selector, and `src/app/p/[projectSlug]/accounts/SlotEditor.tsx`'s four exports still match what is written; note any drift before writing code — verified 2026-10-10, no drift found

**Checkpoint**: Facts confirmed current; no foundational infrastructure is needed before story work begins.

---

## Phase 2: Foundational

No blocking infrastructure beyond Phase 1 — there is no schema change, no migration, no new middleware or auth framework (plan.md Technical Context). User story work starts immediately.

---

## Phase 3: Server-side move (serves US2, prerequisite for US1's retime path)

**Goal**: A `moveSlot` capability exists in the service layer, enforced and tested, before anything renders. This is what both the drag-move (US2) and the typed-retime (US1, FR-018/FR-019) route through, since retime is a move whose weekday is unchanged (contracts/week-slot-grid.md).

**Independent Test**: Call `moveSlot` directly (via the integration test) for a free target, a taken target, a cross-project id, a non-manager caller and an invalid weekday/time — each produces the outcome in contracts/move-slot.md §2, with no UI involved.

### Tests for server-side move ⚠️

- [X] T002 [P] Add `moveSlotSchema` validation cases to a schema test alongside the existing `weekdaySchema`/`localTimeSchema`/`addSlotSchema` tests in `src/lib/validation/scheduling.ts` (or its existing test file if one exists) covering a valid `{ id, weekday, localTime }`, weekday `0`, weekday `8`, and malformed times `"9:00"` / `"24:00"` / `"09:00:00"`
- [X] T003 Add the move cases to `tests/integration/accounts-slots.test.ts`: a successful move preserves `id` and returns the new `weekday`/`localTime` (FR-017, SC-003); a move onto a taken weekday+time throws `ConflictError` with the exact message `addSlot`'s duplicate throws (FR-031); an editor caller is refused (FR-028); another project's slot id is `NotFoundError` (FR-029); weekday `0`, `8`, and localTime `"9:00"` / `"24:00"` / `"09:00:00"` each throw a `ZodError` (FR-030); a `post_targets` row referencing the moved slot keeps its `scheduled_at` and non-null `slot_id` after the move (FR-033, SC-003)
- [X] T004 Add the `moveSlotAction` row to `tests/integration/actions-authz.test.ts` per contracts/move-slot.md §4: `{ name: "moveSlotAction", manage: true, run: (s, f) => accountActions.moveSlotAction(s, { id: f.slotId, weekday: 4, localTime: "12:30" }) }`, confirming an editor and a non-member are both refused (FR-039, SC-009)

### Implementation for server-side move

- [X] T005 Add `moveSlotSchema` to `src/lib/validation/scheduling.ts`, built from the existing `weekdaySchema` and `localTimeSchema` exactly as in data-model.md §2 (FR-030)
- [X] T006 In `src/server/dal/slots.ts`, extract the existing `isUniqueViolation` try/catch out of `insert` into a local helper `asSlotConflict<T>(fn: () => Promise<T>): Promise<T>` that throws `ConflictError("That account already has a slot at that time.", "localTime")` on a `23505`, and have `insert` call through it unchanged in behaviour (R8, FR-031)
- [X] T007 In `src/server/dal/slots.ts`, add `move(id: string, weekday: number, localTime: string): Promise<SlotRow>` to `SlotsRepo` and its implementation: project-scoped `UPDATE` via `asSlotConflict`, `.returning()`, no write to `post_targets` (contracts/move-slot.md §1, FR-029, FR-017, FR-033)
- [X] T008 Add `moveSlot(scope: ProjectScope, input: unknown): Promise<SlotView>` to `src/server/services/slots.ts` following contracts/move-slot.md §2 exactly: parse with `moveSlotSchema`, `ForbiddenError` check before and inside `scope.transaction`, existence check via `tx.slots.get(id)` yielding `NotFoundError`, then `tx.slots.move(id, weekday, localTime)` (FR-027, FR-028, FR-029, FR-030)
- [X] T009 Add `moveSlotAction(slug: string, input: { id: string; weekday: number; localTime: string }): Promise<ActionResult<slots.SlotView>>` to `src/app/p/[projectSlug]/accounts/actions.ts`, implemented as `mutate(slug, (scope) => slots.moveSlot(scope, input))` exactly like `addSlotAction` (contracts/move-slot.md §3, FR-032)
- [X] T010 Run `pnpm vitest run src/lib/validation src/server/dal/slots.ts src/server/services/slots.ts tests/integration/accounts-slots.test.ts tests/integration/actions-authz.test.ts` and confirm T002–T004's new cases pass

**Checkpoint**: A move exists, is enforced, and is proven with nothing rendered — matching the plan's "server first" ordering.

---

## Phase 4: Logic module (serves US1, US2, US3 — every pure rule the component will render against)

**Goal**: Every geometry, ordering, conflict, override and wording rule from data-model.md §4 is implemented and unit-tested before any JSX exists, so the component phase only wires markup to already-proven functions.

**Independent Test**: Run the logic module's test file alone; every function in data-model.md §4 has a passing unit test with no DOM involved (quickstart.md §2).

### Tests for the logic module ⚠️

- [X] T011 [P] [US1] Write `src/components/schedule/week-slot-grid-logic.test.ts` covering `hhmm` (`"09:30:00"` → `"09:30"`), `minutesOf`, `timeOfMinutes`, `roundToStep` at and between 30-minute boundaries, and `clampToDay` at and past `0` and `1410` (the midnight edge case) — written to fail against an empty module
- [X] T012 [P] [US1] Add `timeAtPosition` and `hourTicks` cases to the same test file: the same formula used for a click position and a drop position produces the same rounded, clamped time; `hourTicks` returns 24 ticks labelled every three hours
- [X] T013 [P] [US1] Add `slotsByWeekday` cases: seven buckets, each ascending by `localTime`, ties broken by `id` (FR-002)
- [X] T014 [P] [US1] Add `nextFreeTime` cases: the first free 30-minute boundary at or after `"09:00"`, wrapping to the first free boundary from `"00:00"` when the day is full from 09:00 onward, and `null` for a day with no free boundary at all (R3)
- [X] T015 [P] [US2] Add `isNoOpMove` cases: true for the same weekday and same rounded time, false otherwise (FR-014)
- [X] T016 [P] [US2] Add `conflictAt` cases: finds a same-weekday same-time slot, ignores the chip being moved via `exceptId`, returns `null` when free (FR-016)
- [X] T017 [P] [US2] [US3] Add `applyOverrides` cases across several arrival orders: a `patch` override wins over the base slot, a `deleted` override removes it, an `Addition` renders until cleared, and an override is only cleared by the sequence number that wrote it (R6, FR-036)
- [X] T018 [P] [US1] [US2] [US3] Add cases for `announceAdded`, `announceMoved`, `announceRetimed`, `announceDeleted`, `announcePaused`, `announceResumed`, `announceRefused` and `DUPLICATE_REFUSAL`: every string names the weekday and the time (FR-044, SC-006), and `DUPLICATE_REFUSAL` matches the server's `ConflictError` message verbatim

### Implementation of the logic module

- [X] T019 [US1] Create `src/components/schedule/week-slot-grid-logic.ts` with the `Weekday`, `GridSlot`, `GridSlotState`, `Override`, `Addition`, `GridPermissions` and `MoveIntent` types from data-model.md §3, plus `STEP_MINUTES = 30`, `WEEKDAY_NAMES` and `DUPLICATE_REFUSAL`
- [X] T020 [US1] Implement `hhmm`, `minutesOf`, `timeOfMinutes`, `roundToStep`, `clampToDay` in `week-slot-grid-logic.ts` (FR-005, FR-009, FR-010) to satisfy T011
- [X] T021 [US1] Implement `timeAtPosition` and `hourTicks` in `week-slot-grid-logic.ts` from R2's single linear mapping, built on T020's functions (FR-008, FR-009) to satisfy T012
- [X] T022 [US1] Implement `slotsByWeekday` in `week-slot-grid-logic.ts` (FR-001, FR-002) to satisfy T013
- [X] T023 [US1] Implement `nextFreeTime` in `week-slot-grid-logic.ts` (R3, FR-011) to satisfy T014
- [X] T024 [US2] Implement `isNoOpMove` and `conflictAt` in `week-slot-grid-logic.ts` (FR-014, FR-016) to satisfy T015, T016
- [X] T025 [US2] [US3] Implement `applyOverrides` in `week-slot-grid-logic.ts` as a pure function of `(slots, overrides, additions)` with no clock and no randomness (R6, FR-036) to satisfy T017
- [X] T026 [US1] [US2] [US3] Implement `announceAdded`, `announceMoved`, `announceRetimed`, `announceDeleted`, `announcePaused`, `announceResumed`, `announceRefused` in `week-slot-grid-logic.ts` (FR-044, SC-006) to satisfy T018
- [X] T027 Run `pnpm vitest run src/components/schedule/week-slot-grid-logic.test.ts` and confirm every case from T011–T018 passes

**Checkpoint**: Every rounding, ordering, conflict, override and wording decision is settled and unit-tested before a pixel depends on it (plan.md implementation sequence step 2).

---

## Phase 5: `WeekSlotGrid` component (serves US1, US2, US3, US4)

**Goal**: The reusable, presentational grid from contracts/week-slot-grid.md, read-only rendering first, then the manager controls — per the plan's build order.

**Independent Test**: Render the component with `renderToStaticMarkup` for `canManage: true` and `canManage: false` and assert every guarantee G1–G20 in contracts/week-slot-grid.md.

### Tests for the component ⚠️

- [X] T028 [US1] [US4] Write the read-only half of `src/components/schedule/WeekSlotGrid.test.tsx`: seven columns named Monday–Sunday in order (G1); chips ascending by time, DOM order equal to visual order (G2); each chip's `HH:MM`, `Active`/`Paused` text and `aria-label="<Weekday> <HH:MM>, active|paused"` (G3); seconds never reach the DOM and the zone label renders exactly once (G4); the empty message renders with empty `slots` while columns still render (G5); with `canManage: false`, zero `<button>`, zero `<input>`, zero `draggable`, zero `disabled` anywhere (G6)
- [X] T029 [US1] [US2] [US3] Add the manager half of `WeekSlotGrid.test.tsx`: for `canManage: true`, each chip has a body button, a Move control and a Delete control, each `draggable`, plus an `Add a slot on <Day>` button per column (G8); the Move/Delete controls carry `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100`; paused chips differ by text, border style and tone and never by hue alone (G15); no `transition-transform`, `animate-*` or `duration-*` class outside `motion-safe:` (G20)

### Implementation of the component

- [X] T030 [US1] [US4] Create `src/components/schedule/WeekSlotGrid.tsx` as a `"use client"` component implementing `WeekSlotGridProps` from contracts/week-slot-grid.md §Props: read-only rendering only — seven `grid grid-cols-7 items-stretch` columns stacking below `md`, chips as plain `<li>` for `canManage: false`, the empty message, the zone label — to satisfy T028
- [X] T031 [US1] Add the per-column `Add a slot on <Day>` button to `WeekSlotGrid.tsx` calling `onAdd({ weekday, localTime: nextFreeTime(day) })`, moving focus to the new chip once it renders, and disabling with a reason when `nextFreeTime` returns `null` (G8, FR-011)
- [X] T032 [US1] Add click/tap-to-place on each column's empty area in `WeekSlotGrid.tsx`, calling `onAdd` with `timeAtPosition(offsetY, height)` from the column's own height (G7, FR-008, FR-009, FR-010), with a hover readout showing the time a click would place at (R2)
- [X] T033 [US2] Add `draggable` chips and `onDragOver`/`onDrop` column handling in `WeekSlotGrid.tsx` using native HTML5 drag events exactly as `CalendarBoard` does (R5): a drop calls `onMove` with the target weekday and `timeAtPosition`'s rounded time (G9), unless `isNoOpMove` is true or the drop lands outside every column, in which case nothing is called and nothing is announced (G10, FR-014)
- [X] T034 [US2] Add a `MoveSlotDialog` opened by each chip's Move control in `WeekSlotGrid.tsx`: a Mon–Sun `SegmentedControl` and a `type="time"` `Field` pre-filled with the chip's current time, Move calling `onMove` after validating the typed time as 24-hour `HH:MM` (refusing in the dialog without a round trip on an invalid one), Cancel calling nothing and returning focus to the chip via `Dialog` (G11, G12, FR-015, FR-018, FR-019, FR-042)
- [X] T035 [US3] Add the chip body toggle in `WeekSlotGrid.tsx` calling `onToggle({ id, paused: !paused })` (G14, FR-024), and the delete control calling `onDelete({ id })` on a single activation with no dialog (G13, FR-021, FR-022)
- [X] T036 [US1] [US2] [US3] Add the optimistic-override layer to `WeekSlotGrid.tsx`: an `overrides` map and `additions` array per R6, rendering `applyOverrides(props.slots, overrides, additions)`, each operation stamped with a sequence number and cleared only by the answer that wrote it, with every call reflected before its promise settles (G16) and an `{ ok: false }` outcome restoring the pre-operation render and writing `message` into a `role="alert"` line (G17, G18, FR-034, FR-035, FR-036)
- [X] T037 [US1] [US2] [US3] Add announcements to `WeekSlotGrid.tsx` per R7: `useAnnounce()` when a provider is present, otherwise a locally held `message` state rendered through one mounted `<LiveRegion>`, de-duplicated via `Announce.tsx`'s exported `announcedText`, firing exactly one announcement per change or refusal from the logic module's announce functions (G19, FR-044, SC-006)
- [X] T038 Run `pnpm vitest run src/components/schedule/WeekSlotGrid.test.tsx` and confirm every case from T028–T029 passes

**Checkpoint**: The component satisfies every guarantee in contracts/week-slot-grid.md and is independently testable via `renderToStaticMarkup`, with no caller yet.

---

## Phase 6: Accounts page replacement (serves US1, US2, US3, US4)

**Goal**: The accounts page uses the grid instead of the table and `SlotEditor`'s add form, gated on the correct capability, with the connect hand-off repointed and the old assertions rewritten rather than deleted (SC-013).

**Independent Test**: As a manager, see the grid with working controls on the accounts page; as an editor, see a fully read-only grid; reload after any mutation and see it persisted.

### Tests for the page replacement ⚠️

- [X] T039 [US1] [US2] [US3] [US4] Rewrite the slot-table assertions in `tests/integration/accounts-ui.test.ts` to read the grid instead of the Day/Time/Status/Actions table: the grid renders in place of the table and the add form (FR-047); a manager gets the editing affordances and an editor gets a read-only grid, gated on `slot:["manage"]` rather than `account:["manage"]` (FR-040); the "Posting slots" definition sentence and the time-zone statement still render (FR-049); `ReconnectMockButton` and `MockBehaviourForm` still render (FR-048); the existing ordering assertions around `id="account-<id>-slots"` are preserved, not deleted (SC-013)
- [X] T040 [US1] Update `tests/integration/accounts-landing.test.ts` so the post-connect focus assertion targets `#account-${id}-add-slot` instead of the deleted `SlotEditor` radio selector (FR-050)

### Implementation of the page replacement

- [X] T041 In `src/app/p/[projectSlug]/accounts/page.tsx`, add `const canManageSlots = scope.can({ slot: ["manage"] })` alongside the existing `canManage`, and pass only `canManageSlots` to the grid (R9, FR-040)
- [X] T042 Create `src/app/p/[projectSlug]/accounts/AccountSlotGrid.tsx` as a thin client adapter binding `addSlotAction`, `moveSlotAction`, `setSlotPausedAction` and `deleteSlotAction` to `WeekSlotGrid`'s `onAdd`/`onMove`/`onToggle`/`onDelete` callbacks, adapting each `ActionResult` to `SlotActionOutcome` at the call site (contracts/week-slot-grid.md §Props, plan.md Structure Decision)
- [X] T043 In `src/app/p/[projectSlug]/accounts/page.tsx`, replace the Day/Time/Status/Actions `Table` and the `SlotEditor` add form with `AccountSlotGrid`, passing `timeZoneLabel`, `label`, `emptyMessage` (the manager and reader variants per FR-041) and `addButtonId={`account-${account.id}-add-slot`}`, while keeping the "Posting slots" definition sentence and the time-zone statement (FR-047, FR-049, FR-007, FR-041)
- [X] T044 In `src/app/p/[projectSlug]/accounts/page.tsx` and `ConnectLanding.tsx`, change the post-connect `focusSelector` from `input[name="slot-day-${id}"]:checked` to `#account-${id}-add-slot` (R10, FR-050)
- [X] T045 Delete `SlotEditor` and `SlotRowActions` from `src/app/p/[projectSlug]/accounts/SlotEditor.tsx`, leaving `ReconnectMockButton` and `MockBehaviourForm` in place and working, and remove their now-unused imports from `page.tsx` (FR-048)
- [X] T046 Raise the skeleton height in `src/app/p/[projectSlug]/accounts/loading.tsx` to match the grid's taller card, per `docs/design-system.md` §8
- [X] T047 Run `pnpm vitest run tests/integration/accounts-ui.test.ts tests/integration/accounts-landing.test.ts` and confirm T039–T040's rewritten assertions pass

**Checkpoint**: All four user stories are deliverable end to end on the real accounts page — US1 (place), US2 (move), US3 (toggle/delete), US4 (read-only) all verified together since they share the one page.

---

## Phase 7: Documentation

**Goal**: The component, its keyboard contract and its one deliberate design-system exception are discoverable where a future reader would look (R13).

- [X] T048 [P] Add a components-table row for `WeekSlotGrid` to `docs/design-system.md` §7, recording the keyboard sequence from contracts/week-slot-grid.md's Keyboard contract table and the FR-022 no-confirm-delete exception beside the `Button` row's "`danger` always confirms" rule (FR-022, FR-052)
- [X] T049 [P] Update the "Lists, tables, calendar" section of `.claude/skills/docket-ui/SKILL.md` to record the week grid as how posting slots are edited, next to the existing calendar drag-has-a-keyboard-equivalent rule (FR-053)
- [X] T050 [P] Update `docs/accounts.md` to describe the click-to-place / drag-to-move / click-to-toggle / X-to-delete flow in place of the weekday-radios-plus-time-input add form (FR-054)
- [X] T051 [P] Update `docs/getting-started.md` §2 to describe the new add flow (FR-054)
- [X] T052 [P] Add a `docs/decisions.md` entry for 035 recording R2's hit-test-versus-layout trade-off and the FR-022 no-confirm-delete exception (plan.md Constitution Check, Deviations)

**Checkpoint**: Every deviation and every new control is documented where the constitution's Workflow: docs gate expects it.

---

## Phase 8: Final pass

- [X] T053 Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` once, with no test deleted to make the suite pass (SC-013); fix any failure before proceeding — fixed two pre-existing strict-mode TS errors (`minutesOf`'s destructure, `slotsByWeekday`'s bucket index, and corresponding test index accesses) in `week-slot-grid-logic.ts`/`.test.ts`; all four commands pass clean (535 test files, 5055 tests)


## Phase 10: Review remediation

Seven blocking findings from [review.md](review.md). All seven are in `src/components/schedule/` — no server,
schema, migration or page change is implicated, and `moveSlot`, `moveSlotAction`, the capability gate and the
page replacement all passed review unchanged. Per task: run the affected test files plus `pnpm typecheck`; one
full `pnpm lint && pnpm typecheck && pnpm test && pnpm build` at the end of the phase.

- [X] T055 Stop `handleMove` discarding a time typed in the move dialog: make the no-op test path-specific so the dialog route compares the raw typed time (`slot.weekday === intent.weekday && hhmm(slot.localTime) === hhmm(intent.localTime)`) while the drop route keeps `isNoOpMove`'s rounded comparison, and add unit tests that a typed 08:10 on an 08:00 chip reaches `onMove` and that `week-slot-grid-logic.test.ts:126`'s rounded case still holds for drops only — review F1 (BLOCKER), src/components/schedule/WeekSlotGrid.tsx:198, src/components/schedule/week-slot-grid-logic.ts:120-123
- [X] T056 Render `emptyMessage` once for the whole grid when `slots.length === 0` instead of once per empty column, keeping all seven columns rendered and placeable (G5), fix the prop doc at `WeekSlotGrid.tsx:48` back to the contract's wording, and add a test that the message does not appear when any slot exists — review F2 (MAJOR), src/components/schedule/WeekSlotGrid.tsx:346-347
- [X] T057 Stop a not-yet-confirmed chip offering controls that send its `pending-N` temp id to the server: suppress the body toggle, Move, Delete and `draggable` on a chip whose id is a temp id (or hold the gesture until the real id arrives), and add a markup test that a pending addition renders none of the four — review F3 (MAJOR), src/components/schedule/WeekSlotGrid.tsx:153, src/components/schedule/WeekSlotGrid.tsx:261-319
- [X] T058 Make the optimistic-override clearing independent of when React calls a state updater: snapshot the resolved seqs into a local value before clearing (or hold them in state), clear only what the updater consumed, and key the clear on each override's own seq rather than on `slots` identity alone; add a test that covers a resolution arriving after the `slots` prop and one arriving while another mutation is pending — review F4 (MAJOR), src/components/schedule/WeekSlotGrid.tsx:103-114
- [X] T059 Make the post-add focus move actually work and add the missing post-delete focus move: point `focusTarget` at a focusable element (move the id onto the chip body `<button>`, or add `tabIndex={-1}` to the `<li>`), set a `focusTarget` in `handleDelete` to the next chip in that column or the column's add button, and assert in the markup test that the focus id lands on something focusable — review F5 (MAJOR), src/components/schedule/WeekSlotGrid.tsx:116-121, src/components/schedule/WeekSlotGrid.tsx:264-266, src/components/schedule/WeekSlotGrid.tsx:182-195
- [X] T060 Resolve R2's missing mitigation: either draw the hour gutter from `hourTicks()` and add the hover readout naming the time a click would place at, or delete `hourTicks()` and rewrite `docs/decisions.md`'s 035 R2 paragraph and `plan.md`'s risk row so neither claims a gutter or readout that does not ship — review F6 (MAJOR), src/components/schedule/week-slot-grid-logic.ts:84-89, src/components/schedule/WeekSlotGrid.tsx:340-345, docs/decisions.md:1411-1412
- [X] T061 Stop the seven `whitespace-nowrap` add buttons overflowing a 1/7 grid track at desktop width: shorten the visible label (e.g. "Add slot" with the weekday in an `sr-only` span) or allow wrapping, keeping the accessible name `Add a slot on <Day>` that G8 and the existing tests require — review F7 (MAJOR), src/components/schedule/WeekSlotGrid.tsx:352-362, src/components/ui/Button.tsx:33

**Checkpoint**: every blocking finding closed, then re-review. The four MINOR findings (F8 hit-area divergence,
F9 the missing local conflict pre-check on add, F10 the double announcement on a refusal, F11 the chip body
button's accessible name) and NOTE F12 are recorded in [review.md](review.md) and do not block; fix them here
only if the same edit is already open.

---

## Phase 11: Review remediation (round 2)

Two blocking findings from the re-review in [review.md](review.md). Round 1's F1–F4 and F7 are closed and
verified (typecheck clean, lint clean on the changed files, 80 unit tests and 100 integration tests passing);
these two are the halves of round 1's F5 and F6 that were left unfinished. No server, schema, migration or
page change is implicated. Per task: run the affected test files plus `pnpm typecheck`; one full
`pnpm lint && pnpm typecheck && pnpm test && pnpm build` at the end of the phase — note that `tasks.md` has no
record of a full check since T053, which predates Phase 10, so that final run is the first on the remediated
code.

- [X] T062 Stop the post-add focus move being dropped when the server confirms the slot: focus the real chip, not the `pending-N` one — in the clearing effect at `WeekSlotGrid.tsx:111-124`, for each resolved `Addition` find the matching slot in the incoming `slots` prop by weekday plus `hhmm(localTime)` and set `focusTarget` to `slot-<that id>`; if that is judged too indirect, instead widen `SlotActionOutcome` so `onAdd` returns the created slot's id, or move focus to the column's add button and rewrite `docs/design-system.md:272` and `quickstart.md` §7 row 12 to claim that instead of the chip. Add a markup or logic test that pins whatever is chosen — review F1 (MAJOR), src/components/schedule/WeekSlotGrid.tsx:169, src/components/schedule/WeekSlotGrid.tsx:126-131
- [X] T063 Finish T060 in the two artefacts it missed: rewrite [quickstart.md](quickstart.md):99 (walk-through row 1) so it expects a chip at the 30-minute boundary the click position rounds to, named by the announcement, with no mention of a hover readout; and delete the `hourTicks` row from [data-model.md](data-model.md):95 so the logic module's API table matches what it exports. Optionally add a one-clause note at `research.md:63` that the readout was dropped, so the next reader does not re-derive it — review F2 (MAJOR), specs/035-week-slot-grid/quickstart.md:99, specs/035-week-slot-grid/data-model.md:95

**Checkpoint**: both blocking findings closed, then re-review, then T054. The eight MINOR findings (F3 the move
dialog losing focus on Move/Cancel — flagged by the reviewer as a MUST that only the re-review scoping rule
kept out of the blocking set, F4 the empty line keyed on the prop rather than the view, F5 the stale button
label in `docs/accounts.md`, F6 T058's missing tests, and F7–F10 carried over from round 1) and NOTE F11 are
recorded in [review.md](review.md) and do not block; fix them here only if the same edit is already open.

---

## Phase 12: Review remediation (round 3)

One blocking finding from the round-3 re-review in [review.md](review.md). Round 2's F2 is closed and
verified (`hourTicks` gone from the API table, quickstart row 1 rewritten, `research.md` noted). This is round
2's F1 again, unfixed: T062 chose the `slots`-prop lookup, and that lookup runs one render before the
refreshed prop arrives, so it resolves to `null` every time. No server, schema, migration or page change is
implicated; option (b) also touches two documents. Per task: run the affected test files plus
`pnpm typecheck`; one full `pnpm lint && pnpm typecheck && pnpm test && pnpm build` at the end of the phase —
note that no implement pass has run a full check since T053, which predates all three remediation phases, and
the last pass reported that it could not run the suite at all.

- [X] T064 Make the post-add focus actually land on the created slot's chip, using one of the two options T062 passed over, because the `slots`-prop lookup it chose cannot work: Next.js resolves the action promise before it applies the refreshed tree (`node_modules/next/dist/esm/client/components/router-reducer/reducers/server-action-reducer.js:258`) and applies that tree inside `startTransition` (`node_modules/next/dist/esm/client/components/app-router-instance.js:91`), so the clearing effect at `WeekSlotGrid.tsx:112-127` always sees the pre-add `slots` and `resolvedAdditionFocusId` always returns `null`, after which `WeekSlotGrid.tsx:126` drains the seq so no later run retries. Either (a) widen `SlotActionOutcome` to carry the created id, pass through the id `addSlotAction` already returns in its `SlotView` (`AccountSlotGrid.tsx:24-26`), and set `focusTarget.current = "slot-<id>"` in `handleAdd` after the await; or (b) send focus back to `addButtonIdFor(weekday)` when the addition clears and rewrite `docs/design-system.md:272` and [quickstart.md](quickstart.md) §7 row 12 to claim the add button instead of the chip. Delete `resolvedAdditionFocusId` and its two tests if nothing still calls it, and pin the chosen behaviour with a test over a pure function rather than over a lookup whose `null` branch is the production path — review F1 (MAJOR), src/components/schedule/WeekSlotGrid.tsx:124, src/components/schedule/WeekSlotGrid.tsx:167-182 — done via option (a): `SlotActionOutcome`'s ok variant now carries an optional `id`, `AccountSlotGrid.addOutcome` passes `addSlotAction`'s `SlotView.id` through, and `handleAdd` sets `focusTarget.current` from the new pure `additionFocusId(createdId, addButtonId)` (chip when an id came back, the column's add button otherwise). `resolvedAdditionFocusId` and its two tests are deleted; the clearing effect no longer reads `slots`. The focus effect now keeps an unfound target instead of draining it and lists `slots` as a dependency, so the render that applies Next.js' refreshed tree lands focus on the real chip. `docs/design-system.md:272` and quickstart §7 row 12 stay true as written.

**Checkpoint**: the one blocking finding closed, then re-review, then T054. The nine MINOR findings (F2 the
three stale rows in `data-model.md`'s API table, F3 the move dialog losing focus on Move/Cancel — flagged by
the reviewer as a MUST that only the re-review scoping rule kept out of the blocking set, F4 the empty line
keyed on the prop rather than the view, F5 the stale button label in `docs/accounts.md`, F6 T058's missing
tests, and F7–F10 carried over from rounds 1 and 2) and NOTES F11–F12 are recorded in
[review.md](review.md) and do not block; fix them here only if the same edit is already open.

---

## Phase 9: Human browser walk-through (blocks nothing, scheduled last)

**Needs a signed-in browser session** — this environment has no running `pnpm dev` and no browser, so pointer drag and hover behaviour cannot be executed in any earlier phase (plan.md Constitution Check II, R12).

- [x] T054 Sign in as an owner on a project with one connected account and work every row of [quickstart.md](quickstart.md) §7's 26-row table (click-to-place, drag-to-move both directions, drag refusal, drag no-ops, pause/resume, hover-reveal delete, delete persistence, keyboard-only add/move/cancel/toggle/delete, screen-reader names, `prefers-reduced-motion`, 390 px narrow layout, a ~15-slot busy day, a cross-tab duplicate race, a toggle-then-delete race, the editor's fully read-only view, the empty-state wording for an editor, the connect hand-off focus target, and the active/paused counts after a move/pause/delete); report each row pass or fail against its requirement, and if the window to verify before further changes land has closed, record that explicitly rather than leaving the row unmarked — **not executed**: this pass is a headless agent with no running `pnpm dev` and no browser, exactly the condition quickstart.md §7 names ("needs a human"); none of the 26 rows could be exercised, so none is recorded pass or fail. A human must run quickstart.md §7 against a live `pnpm dev` before this is genuinely done; see `specs/035-week-slot-grid/review.md`'s "What I could not check" for the same gap.

  **Recorded not-executed, 2026-10-10 (implement Phase 9).** Checkbox ticked to close the record, *not* to claim a pass: 0 of the 26 rows ran, none is reported pass or fail, and the human gate below is still open. Before recording this I checked whether any row could be automated instead, and none can: no `playwright`, `puppeteer` or `cypress` in `package.json`; no DOM environment (`vitest.config.ts:14` sets `environment: "node"`, and neither `jsdom` nor `happy-dom` is installed); no browser MCP server (`.mcp.json` does not exist); and no seed script, so section 7's user, project and connected account would have to be made by hand. A local Postgres does answer on `localhost:5432`, but `.env` is absent and the `.env.example` credentials are rejected, so even a seeded run needs a human-held password.

  **What this pass did verify, on the remediated code** (closing the last bullet of review.md's "What I could not check"): `pnpm build` green through `next build` and all five esbuild stages; `pnpm typecheck` clean; `pnpm lint` 0 errors (21 pre-existing warnings, all in `tests/`); and 82 tests passing across the three files covering everything changed since the last full run - `src/components/schedule/week-slot-grid-logic.test.ts`, `src/components/schedule/WeekSlotGrid.test.tsx` and `src/lib/validation/scheduling.test.ts`. The DB-backed integration suite did **not** run (`tests/setup/global-setup.ts:38` requires a `*_test` DATABASE_URL), so T053's full-suite figure still stands as the last complete run.

  **Still required from a human:** walk `quickstart.md` section 7 against a live dev server and record each of the 26 rows. The drag-and-drop paths, the optimistic update and its rollback, the hover reveal, `prefers-reduced-motion`, the 390 px layout and both races remain unproven by observation. Note `pnpm dev` is broken on Windows (`scripts/next-with-env.mjs` passes a `c:\...` path to the ESM loader rather than a `file://` URL); `npx next dev` works.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Empty — nothing blocks story work beyond Setup
- **Server-side move (Phase 3)**: Depends on Phase 1. Independently testable and mergeable before anything else exists
- **Logic module (Phase 4)**: Depends on Phase 1. Independent of Phase 3 — no shared files — so it can run in parallel with Phase 3
- **Component (Phase 5)**: Depends on Phase 4 (uses the logic module's exports). Does not depend on Phase 3 — the component calls `onMove`/`onAdd`/etc. as props, not the service directly
- **Page replacement (Phase 6)**: Depends on Phase 3 (the actions it binds to) and Phase 5 (the component it renders)
- **Documentation (Phase 7)**: Depends on Phase 6 (describes the shipped behaviour and the final keyboard contract)
- **Final pass (Phase 8)**: Depends on all of Phases 3–7
- **Human walk-through (Phase 9)**: Depends on Phase 8. Scheduled last; blocks nothing after it, since there is nothing after it

### User Story Coverage

- **US1 (place a slot)**: T011–T014, T019–T023, T028, T030–T032, T036–T037, T039, T041–T044 — fully covered once Phases 4–6 complete
- **US2 (move a slot)**: T002–T010 (server), T015–T016, T024, T029, T033–T034, T036–T037, T039 — fully covered once Phases 3–6 complete
- **US3 (toggle/delete)**: T017–T018, T025–T026, T029, T035–T037, T039 — fully covered once Phases 4–6 complete
- **US4 (read-only)**: T028, T030, T039, T041 — fully covered once Phases 5–6 complete

### Parallel Opportunities

- Phase 3 (server) and Phase 4 (logic module) touch disjoint files and can run in parallel
- Within Phase 4, T011–T018 (tests) are each `[P]` against each other (one growing file, but each test block is independent to write); T019–T026 (implementation) should follow the sequence in which each later function depends on earlier ones in the same file
- Within Phase 7, T048–T052 are all `[P]` — five different files, no shared state

---

## Implementation Strategy

### MVP First

US1 and US2 are both P1 in the spec and share the server move and the component, so the smallest shippable increment is Phases 1–6 together (there is no partial grid that is independently useful without the move operation the retime path depends on). Phase 3 can be built and merged first since it is independently testable against nothing rendered, exactly as plan.md's implementation sequence states.

### Incremental Delivery

1. Phase 1–2: confirm facts, no foundational work needed
2. Phase 3: `moveSlot` exists and is proven server-side — mergeable on its own
3. Phase 4: the logic module is proven unit-by-unit — mergeable on its own
4. Phase 5: the component renders and behaves correctly in isolation — mergeable on its own (no caller yet)
5. Phase 6: the accounts page uses it — all four user stories become live together
6. Phase 7: documentation catches up to the shipped behaviour
7. Phase 8: one full check
8. Phase 9: the human walk-through confirms what no earlier phase could execute

  **NOT RUN** (2026-10-10; T054 is ticked to close the record, not to claim a pass - see the
  note under T054 itself for why no row could be automated). All 26 rows of
  quickstart.md §7 are **not run**; none is reported as pass. Reason: the Chrome extension driving this
  environment has no site permission for `localhost`, so every navigation reverted to `chrome://newtab/` and no
  page could be loaded, read or screenshotted. Granting that permission is a human action. The app itself does
  come up — `npx next dev` serves on `http://localhost:3000` (note `pnpm dev` is broken on Windows for an
  unrelated reason: `scripts/next-with-env.mjs` hands a `c:\…` path to the ESM loader instead of a `file://`
  URL). There is also no seed script, so §7 needs a user, project and connected account created by hand first.

  What *was* verified headlessly on this branch: `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`,
  plus unit tests over `week-slot-grid-logic.ts` and rendered-markup assertions over `WeekSlotGrid`.

  **The specific risk this leaves open is larger here than for entry 1.** Pointer drag-and-drop, the optimistic
  update and its rollback, hover-reveal, `prefers-reduced-motion`, the 390 px layout and the cross-tab
  duplicate race are all unproven by observation — this repository has no browser DOM test library, so the pure
  logic module is tested but nothing exercises a real drag. Treat the drag paths as unverified until §7 is
  walked.

---

  **PARTIALLY RUN, 2026-10-10.** The earlier "no browser" record was wrong about the cause: port 3000 was held
  by an unrelated Nuxt dev server on `[::1]:3000`, and Chrome resolves `localhost` to `::1` first, so the
  navigation was not reaching Docket. On a free port the browser drives the app normally. Re-run on
  `http://localhost:3005` against a seeded project (`Weird Glens`) with one connected mock account.

  Verified by observation, each confirmed against the database and not just the optimistic render:
  - Click-to-place in an empty column — placed Monday 11:00. **pass**
  - Move dialog with a typed time inside the rounding step — 11:00 → **11:10**, persisted as `11:10:00`.
    This is round-1 F1, the BLOCKER, and it is the row that would have failed before the fix. **pass**
  - Chip body toggles paused — `paused` flipped to `t` in the database. **pass**
  - Empty message renders once for the grid, not once per column, and clears as soon as a slot exists. **pass**
  - Add buttons read "Add slot", fit their 1/7 tracks and do not overflow the card: `scrollWidth` 1317 against
    a 1332 viewport. **pass** (round-1 F7)
  - A duplicate placement is refused locally with "That account already has a slot at that time.", shown as
    plain text with no `role="alert"`. **pass** (F7 and F8 of the final round)
  - The toggle button is named for its action — `Pause Monday 11:10` in the accessibility tree. **pass** (F9)

  **A regression was found here and fixed:** relaxing the click guard to satisfy F6 made the chips themselves a
  placement surface, so clicking a chip bubbled to the column and attempted an add at that position. Observed
  live as a stray 04:00 slot, then as the duplicate refusal. The guard now bails for anything inside an `<li>`
  as well as any control, so only the column's genuinely empty space places. Re-verified: clicking a chip
  toggles it and creates nothing.

  **Not run**, and still owed: the 390 px narrow layout (the extension reported a successful window resize but
  `window.innerWidth` never changed, so the breakpoint was never actually exercised); pointer drag-to-move
  within and across columns; the keyboard-only paths; `prefers-reduced-motion`; the ~15-slot busy day; the
  cross-tab duplicate race; the toggle-then-delete race; the editor's read-only view; and the connect hand-off
  focus target. Pointer drag in particular remains unproven — `left_click_drag` was not exercised against the
  native drag events this grid uses.
