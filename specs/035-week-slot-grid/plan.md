# Implementation Plan: Reusable week grid for posting slots

**Branch**: `035-week-slot-grid` | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/035-week-slot-grid/spec.md`

## Summary

Replace the per-account Day/Time/Status/Actions table and the weekday-radios-plus-time-input add form on the
Accounts page with one direct-manipulation surface: a reusable `WeekSlotGrid` in `src/components/schedule/`
holding seven Monday–Sunday columns of time-ordered slot chips. Place a slot by clicking a position in a day
column, move it by dragging it, retime it by typing in its move dialog, delete it with an X on the chip, and
pause it by clicking its body — each with a keyboard route that does the same thing and a polite announcement
naming the weekday and time.

The component is presentational: slots in, callbacks out, no account, route or action in it (FR-003). Two
server pieces make a move expressible at all — `moveSlot` in `src/server/services/slots.ts` and
`moveSlotAction` in the accounts actions, both enforcing `slot:["manage"]` inside `scope.transaction` and both
routed through the one existing unique-constraint-to-`ConflictError` translation in the DAL so the duplicate
rule has a single implementation. Moving instead of delete-and-re-add preserves the slot's id, so targets
already pointing at it keep pointing at it and no queued post changes time.

The design decisions planning owned are settled in [research.md](research.md): a 30-minute step (R1); a column
whose own height maps linearly to 00:00–24:00 for hit-testing while chips lay out in time order in flow (R2 —
the one real trade-off, logged for `docs/decisions.md`); the calendar's control-plus-dialog pattern for
keyboard parity, with one dialog serving both the move and the typed-time route (R3); native HTML5 drag, so no
new dependency (R5); and an override-map optimistic model over server props so several in-flight mutations
settle on server truth (R6).

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node 24 LTS, React 19 / Next 16 App Router

**Primary Dependencies**: Next.js, React, Tailwind 4.3.3, Zod, Drizzle ORM (`drizzle-orm/node-postgres`),
Vitest. **No new runtime or dev dependency** — drag is native HTML5 drag events as in `CalendarBoard`, and the
tests are the repo's existing `renderToStaticMarkup` + pure-module shape (R5, R12)

**Storage**: Postgres, `posting_slots`. **No schema change and no migration** — `moveSlot` is an `UPDATE` on
existing columns, and the duplicate rule is the existing `posting_slots_account_time_uq` constraint

**Testing**: Vitest. Pure logic units (`week-slot-grid-logic.test.ts`), rendered-markup assertions
(`WeekSlotGrid.test.tsx`), and integration tests against a real Postgres for the service, the action's authz
row and the page render (R12, [quickstart.md](quickstart.md))

**Target Platform**: Self-hosted web app (Docker Compose or Neon), modern evergreen browsers; usable at 390 px

**Project Type**: Web application — Next.js App Router, single `src/` tree, server components by default with
leaf client components

**Performance Goals**: No new server round trip beyond the one action per user gesture. The grid is a leaf
client component over data the page already fetches (`slots.listSlots` per account, unchanged). Every gesture
paints optimistically before the action answers (FR-034)

**Constraints**: Seven columns readable in one glance at desktop width with no scrolling (SC-010) while chips
stay at the 14 px type scale entry 1 settled — the constraint that drove R2. Full keyboard parity for all five
interactions (SC-004). No hue-only state (SC-005). No motion for `prefers-reduced-motion` (SC-011).
Server-enforced `slot:["manage"]` on every mutation (SC-009)

**Scale/Scope**: One new component plus one logic module (≈2 files, ≈450 lines), one new service function, one
new DAL method, one new Zod schema, one new server action, one rewritten page section, two deleted exports,
four documentation files. Realistic data: 1–7 slots per account per weekday; the busy case the edge cases name
is ~15 on one day

## Constitution Check

*GATE: passed before Phase 0, re-checked after Phase 1 design.*

| Principle | Verdict | Evidence |
|---|---|---|
| **I. Verified facts over memory** | PASS | Every fact the plan rests on was re-read in the tree and tabulated in [research.md](research.md) §"Facts re-verified": slot shape, the weekday range check, where duplicates are actually rejected, the three services' permission shape, the page's wrong capability, the landing's focus selector, the calendar's drag pattern, the announcement primitives, and that Tailwind 4.3.3 ships `pointer-coarse`. No `NEEDS RESEARCH`: nothing here depends on a platform API, and `docs/research/` is not involved |
| **II. Nothing is "working" unless it ran** | PASS with a named gap | §2–§6 of [quickstart.md](quickstart.md) are executable and run in CI. The pointer-drag and hover behaviour cannot be executed here (no browser, no DOM test library the pipeline may install), so it is a human walk-through in §7, scheduled last, blocking nothing — the same standing the calendar's drag has today. Nothing will be reported as working on the strength of §7 until a human runs it |
| **III. Project isolation in one place** | PASS | `moveSlot` goes through `scope.transaction` and `tx.slots.move`, which filters on `projectId` like every other `SlotsRepo` member. The component and the action never touch the DB; the action calls the service only. A slot from another project is a `NotFoundError` (FR-029) |
| **IV. One service layer, many callers** | PASS | The move is one service function. The grid holds no server knowledge, so a second caller gets the same behaviour by passing the same callbacks. The duplicate rule is *reduced* from two sites to one by extracting `asSlotConflict` in the DAL (R8) |
| **V. Providers are plug-ins** | N/A | No provider, scheduler, composer or schema change |
| **VI. Boring, few dependencies** | PASS | No new dependency, runtime or dev. Native HTML5 drag (R5) and the repo's existing test shape (R12). No `NEEDS DEPENDENCY` is raised, with the reasoning recorded in R12 |
| **VII. Secrets never leak** | N/A | A slot holds a weekday, a time and a boolean. No credential is read or rendered |
| **Engineering: times in UTC, Temporal for wall time** | PASS | A slot's `local_time` is already a wall-clock `time` column, deliberately not an instant; this entry adds no conversion at all. The grid takes the zone as a label and renders it (FR-005, FR-006), so no Temporal work and no DST disambiguation arises |
| **Engineering: accessibility** | PASS, and it is the hard part | Full keyboard parity (R3, G11/G8 in the component contract), visible focus, labelled controls, an accessible name per control naming the action and the slot, `aria-live` through the existing `LiveRegion`/`Announce` primitives, `prefers-reduced-motion` honoured by adding no motion (R11), empty and error states for both permission levels |
| **Engineering: server components by default** | PASS | The page stays a server component and keeps fetching through `slots.listSlots`. `WeekSlotGrid` is a leaf client component, which interactivity requires |
| **Workflow: tests required** | PASS | Double-booking is covered for the new path (move conflict, both directions), roles are covered for every mutation including the new action's authz row, and SC-013's "no test deleted to make the suite green" is explicit in the task list |
| **Workflow: docs** | PASS | `docs/design-system.md` §7, the `docket-ui` skill, `docs/accounts.md`, `docs/getting-started.md` §2 and a `docs/decisions.md` entry for R2 and the FR-022 exception |
| **Workflow: checks in proportion** | PASS | Per task, the affected test files; one full `lint && typecheck && test && build` at the end of implement. `pnpm db:check` is skipped — no schema change |

### Deviations requiring a recorded judgement call

Two, both demanded by the spec rather than chosen here, and both to be written into `docs/decisions.md`:

1. **FR-022 — delete without a confirm dialog.** `docs/design-system.md` §7 says a `danger` action always
   confirms in a `Dialog` that names the thing. A slot holds no content, costs one click to re-add in the grid,
   and deleting one changes no scheduled post. The spec requires the exception and requires it recorded beside
   the component (FR-022, FR-052).
2. **R2 — chips are not drawn at the y that placed them.** A click is positional, but a chip lands in its
   column's time order. Chosen because proportional positioning cannot keep chips legible at the settled type
   scale inside a column short enough to satisfy SC-010; the alternatives and their failure modes are in
   [research.md](research.md) R2.

Neither is a new project, a new abstraction layer or a new dependency, so the Complexity Tracking table stays
empty.

## Project Structure

### Documentation (this feature)

```text
specs/035-week-slot-grid/
├── plan.md              # This file
├── research.md          # Phase 0: R1–R13, plus the facts re-verified in the tree
├── data-model.md        # Phase 1: the unchanged schema, moveSlotSchema, the grid's view types
├── quickstart.md        # Phase 1: how to prove it works, incl. the human browser walk-through
├── contracts/
│   ├── week-slot-grid.md   # The component's props, guarantees and keyboard contract
│   └── move-slot.md        # DAL method, service function, server action, authz row
├── checklists/          # Pre-existing
└── tasks.md             # Phase 2 — written by /speckit-tasks, not by this command
```

### Source code (repository root)

```text
src/
├── components/schedule/
│   ├── WeekSlotGrid.tsx              # NEW — the client component (contracts/week-slot-grid.md)
│   ├── WeekSlotGrid.test.tsx         # NEW — renderToStaticMarkup assertions
│   ├── week-slot-grid-logic.ts       # NEW — pure rules: step, clamp, order, conflict, overrides, wording
│   ├── week-slot-grid-logic.test.ts  # NEW — unit tests for all of the above
│   └── explicit-time-text.ts         # unchanged
├── lib/validation/scheduling.ts      # + moveSlotSchema, from the existing weekday/localTime schemas
├── server/
│   ├── dal/slots.ts                  # + move(); isUniqueViolation lifted into asSlotConflict, shared with insert()
│   └── services/slots.ts             # + moveSlot()
└── app/p/[projectSlug]/accounts/
    ├── actions.ts                    # + moveSlotAction
    ├── page.tsx                      # table + SlotEditor out, grid in; canManageSlots; landing focus selector
    ├── AccountSlotGrid.tsx           # NEW — thin client adapter: binds the four actions to the grid's callbacks
    ├── SlotEditor.tsx                # − SlotEditor, − SlotRowActions; ReconnectMockButton + MockBehaviourForm stay
    ├── loading.tsx                   # skeleton card height follows the taller card (design system §8)
    └── ConnectLanding.tsx            # unchanged (the page passes it a new selector)

tests/integration/
├── accounts-slots.test.ts            # + the move cases
├── actions-authz.test.ts             # + the moveSlotAction row
├── accounts-ui.test.ts               # slot-table assertions rewritten against the grid
└── accounts-landing.test.ts          # unchanged unless the focus-selector change breaks it

docs/
├── design-system.md                  # §7 component row incl. keyboard + the no-confirm exception
├── accounts.md, getting-started.md   # the add flow is now a click in the week
└── decisions.md                      # 035 entry: R2's trade-off, FR-022's exception
.claude/skills/docket-ui/SKILL.md     # the week grid as how posting slots are edited
```

**Structure Decision**: the repo's existing single-`src/` Next.js App Router layout, unchanged. The grid goes in
`src/components/schedule/` (which already exists) because FR-003 requires it to be callable from somewhere
other than the accounts route; the route keeps a thin `AccountSlotGrid.tsx` adapter that is the *only* place
where slots meet server actions, which is what keeps the component reusable rather than merely well-named.

## Implementation sequence

Written out so `/speckit-tasks` has an ordering to follow; it owns the task breakdown.

1. **Server first, because it is independently testable.** `moveSlotSchema` → `asSlotConflict` extraction and
   `SlotsRepo.move` → `moveSlot` service → `moveSlotAction` → the move cases in `accounts-slots.test.ts` and the
   authz row. At this point a move exists and is proven with nothing rendered.
2. **The logic module and its tests**, complete, before any JSX. Every rule in
   [data-model.md](data-model.md) §4 with a unit test, so the geometry, ordering, conflict, override and wording
   decisions are settled and asserted before a pixel depends on them.
3. **`WeekSlotGrid.tsx` plus its markup test**, against
   [contracts/week-slot-grid.md](contracts/week-slot-grid.md) G1–G20. Read-only rendering first (G6, G1–G5 —
   the simplest complete grid), then the manager controls.
4. **The page replacement**: `AccountSlotGrid.tsx` adapter, `canManageSlots`, the grid in place of the table and
   `SlotEditor`, the landing's focus selector, then delete `SlotEditor` and `SlotRowActions` and raise
   `loading.tsx`'s skeleton height so it still matches the layout (design system §8). Rewrite
   `accounts-ui.test.ts`'s slot assertions in the same task that changes the page, so the suite is never green
   by omission (SC-013).
5. **Documentation**: the design-system row, the skill, `docs/accounts.md`, `docs/getting-started.md` §2, and
   the `docs/decisions.md` entry.
6. **Final pass**: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` once.
7. **Last, blocking nothing**: the human browser walk-through, [quickstart.md](quickstart.md) §7.

## Risks

| Risk | Mitigation |
|---|---|
| R2's hit-test-versus-layout split confuses someone the first time they use it | The hour gutter is drawn from the same formula as the hit test, the hover readout names the time before the click, and the announcement names it after. Walk-through rows 1–3 and 19 are where a human judges whether that is enough |
| Optimistic overrides and `refresh()` fighting each other on a slow connection | R6 makes the server props the base and overrides self-erasing; `applyOverrides` is pure and unit-tested across arrival orders (quickstart §2), and walk-through rows 20–21 are the live check |
| The hover-reveal pattern (`opacity-0` + `group-hover` + `group-focus-within` + `pointer-coarse`) is not exercised by `renderToStaticMarkup` | The classes are asserted in the markup test, and the behaviour is walk-through rows 9 and 18. `pointer-coarse` was verified present in the installed Tailwind rather than assumed |
| Deleting `SlotEditor` silently breaks the post-connect hand-off | FR-050 is handled in the same task as the deletion (`addButtonId` → the page's new `focusSelector`), and `accounts-landing.test.ts` covers the flow |

## Complexity Tracking

> No Constitution Check violations to justify. The two recorded judgement calls above are spec-mandated
> deviations from `docs/design-system.md` and from pixel-faithful positioning, not added complexity — no new
> project, abstraction layer or dependency.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| — | — | — |
