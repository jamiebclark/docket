# Quickstart: validating the week slot grid

**Branch**: `035-week-slot-grid` | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

How to prove this entry works. §1–§6 are automated and run in CI; §7 is the one thing this environment cannot
do and a human must.

## 1. Prerequisites

```bash
pnpm install                 # already installed in the pipeline; no new dependency in this entry
docker compose up -d postgres
pnpm db:migrate              # this entry adds no migration; the schema is unchanged
```

Checks are run in proportion to the change (constitution, Quality gates): per task, only the affected files.

## 2. Pure logic — the rounding, ordering and refusal rules

```bash
pnpm vitest run src/components/schedule/week-slot-grid-logic.test.ts
```

Proves, without a DOM: `STEP_MINUTES` rounding is identical for a click and a drop (FR-009); a position above
the column or below it clamps into the day rather than spilling into a neighbour (FR-010, midnight edge case);
`hhmm("09:30:00") === "09:30"` (FR-005, seconds edge case); `slotsByWeekday` buckets into seven and sorts
ascending (FR-001, FR-002); `nextFreeTime` finds the first free 30-minute boundary from 09:00 and returns
`null` for a full day (FR-011); `isNoOpMove` is true for the same weekday and rounded time (FR-014);
`conflictAt` finds a same-day same-time slot and ignores the chip being moved (FR-016); `applyOverrides`
settles on the server list plus only unresolved overrides, in any arrival order (FR-036); and every
announcement string names its weekday and time (FR-044, SC-006).

## 3. Rendered markup — names, states and per-permission controls

```bash
pnpm vitest run src/components/schedule/WeekSlotGrid.test.tsx
```

Proves against `renderToStaticMarkup` output: seven columns named Monday–Sunday in that order; the time zone
named once (FR-006); each chip's `aria-label` carrying weekday, time and state (FR-004, SC-005); `Active` /
`Paused` as text plus a non-hue difference (FR-025, FR-026); for `canManage: true` a body button, a move control
and a delete control per chip plus an add button per column, all `draggable` (FR-008, FR-013, FR-021, FR-024);
for `canManage: false` **zero** buttons, inputs, `draggable` or `disabled` attributes while every slot still
shows its day, time and state (FR-037, FR-038, SC-008); both empty messages (FR-007, FR-041); and no
`transition-transform`, `animate-*` or `duration-*` outside `motion-safe:` (FR-045, SC-011).

## 4. The move operation, end to end against Postgres

```bash
pnpm vitest run tests/integration/accounts-slots.test.ts
```

Covers [contracts/move-slot.md](contracts/move-slot.md) §2: a successful move keeps the slot's `id` and returns
the new weekday and time (FR-017, SC-003); a move onto a taken weekday and time throws `ConflictError` with
*the same message a duplicate add throws* (FR-031); an editor is refused (FR-028); another project's slot id is
a `NotFoundError` (FR-029); weekday `0`, `8` and `"9:00"` / `"24:00"` / `"09:00:00"` all throw (FR-030); and a
target scheduled against the slot still has its original `scheduled_at` and a non-null `slot_id` afterwards
(FR-033, SC-003).

## 5. Server-side authorization

```bash
pnpm vitest run tests/integration/actions-authz.test.ts
```

The new `moveSlotAction` row refuses an editor and a non-member whatever the browser rendered (FR-032, FR-039,
SC-009).

## 6. The accounts page renders the real grid

```bash
pnpm vitest run tests/integration/accounts-ui.test.ts tests/integration/accounts-landing.test.ts
```

Proves the page-level replacement: the Day/Time/Status/Actions table and the add-slot form are gone and the
grid is there instead (FR-047, FR-048); the "Posting slots" definition sentence and the time-zone statement
survive (FR-049); the mock-provider controls still render (FR-048); a manager gets the editing affordances and
an editor gets a read-only grid, gated on `slot:["manage"]` (FR-040); the post-connect hand-off targets a
control that exists in the grid (FR-050); and the existing ordering assertions still hold — rewritten against
the grid, not deleted (SC-013).

Then the final pass for the phase, once:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

`pnpm build` is in scope because a new client component and a changed server/client boundary are involved.
`pnpm db:check` is not: the schema does not change.

## 7. Browser walk-through — needs a human

This environment has no running `pnpm dev` and no browser, so the pointer and hover behaviour cannot be
executed here. Sign in as an owner on a project with one connected account and work the table below. Per the
pipeline's human-task rule this is scheduled **last** and blocks nothing; report each row pass or fail.

| # | Do this | Expect |
|---|---|---|
| 1 | Click in the Monday column at about a third of its height | A chip appears on Monday at the 30-minute boundary that click position rounds to, named by the announcement |
| 2 | Repeat in Tue–Fri | Five slots from five clicks, no form submitted (SC-001, SC-002) |
| 3 | Click a position that rounds onto an existing time | Refused in text, "already has a slot at that time", no second chip (FR-016) |
| 4 | Drag the Friday chip into Saturday near the top | It lands on Saturday at the dropped time; Friday no longer shows it (FR-013) |
| 5 | Drag a chip onto a time Saturday already has | Refused in words; the chip is back on Friday at its old time (FR-016) |
| 6 | Drag a chip and release it on the grid's padding | Nothing happens, nothing is announced (FR-014) |
| 7 | Drag a chip and release it where it started | Nothing happens, nothing is announced (FR-014) |
| 8 | Click a chip body, then click it again | Paused, then active; each announced; the paused one is plainly inactive, not a shade of active (FR-024, FR-025) |
| 9 | Hover a chip | The delete X appears; it is not there before the hover on a mouse (FR-021) |
| 10 | Click that X | Gone on one click, no dialog; reload confirms (FR-022) |
| 11 | Reload after step 10 | Any post that was scheduled against it still has its time (FR-023) |
| 12 | Keyboard only: tab to a column's add button and press Enter | A slot is added and the new chip has focus (FR-011) |
| 13 | Keyboard only: tab to a chip's Move control, change day and time, press Move | Same result as the drag; announced (FR-015) |
| 14 | Same, but press Escape | Nothing changes, nothing is sent, focus is back on the chip (FR-015) |
| 15 | Keyboard only: toggle and delete a chip | Both work, both announced (FR-042, SC-004) |
| 16 | With a screen reader, tab across a chip | Day, time and state are spoken; each control says what it does and which slot (FR-004, FR-043) |
| 17 | Set `prefers-reduced-motion: reduce`, repeat 1, 4, 8, 10, 13 | No snap, slide or settle; all five still complete (FR-045, SC-011) |
| 18 | Narrow to 390 px | Columns stack in Mon–Sun order, every X is visible without hover, all five interactions still work (FR-021, FR-046, SC-010) |
| 19 | Desktop width, one account with ~15 slots on one day | The week is readable without scrolling; every chip on the busy day is reachable and focusable (SC-010, many-slots edge case) |
| 20 | In a second tab, add a slot at 09:00, then in the first tab place one at 09:00 | The optimistic chip comes back out and the refusal is stated (first edge case) |
| 21 | Toggle a chip and immediately delete it | The settled state matches what the server did (second edge case, FR-036) |
| 22 | Open Accounts as an editor | Every slot with its day, time and state; no add, drag, X, move or toggle anywhere (FR-037, SC-008) |
| 23 | As an editor with no slots on an account | The empty line names the managers to ask (FR-041) |
| 24 | Connect a new mock account | The page lands on that account's slots with focus on its Monday add button (FR-050) |
| 25 | Check the per-account active/paused counts after a move, a pause and a delete | They match the grid (FR-051, SC-012) |
| 26 | Disconnect an account (mock behaviour → needs reconnect) | Slots still show and still edit (edge case) |
