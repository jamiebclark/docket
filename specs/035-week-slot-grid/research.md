# Phase 0 research: Reusable week grid for posting slots

**Branch**: `035-week-slot-grid` | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)

No `NEEDS CLARIFICATION` remained after the spec's Assumptions section. Every item below is either a decision
the spec explicitly handed to planning, or a fact re-verified in the tree (constitution I).

## Facts re-verified in the tree

| Fact | Where | Consequence |
|---|---|---|
| Slot row is `{ id, socialAccountId, weekday, localTime, paused }`; `weekday` 1 = Mon … 7 = Sun | `src/server/services/slots.ts:10`, `src/server/db/schema/accounts.ts:105` | No schema change, no migration |
| Duplicates come from the unique constraint, translated in one place: `isUniqueViolation` → `ConflictError("That account already has a slot at that time.", "localTime")` | `src/server/dal/slots.ts:46-60` | A move must go through that same translation, not a new rule (FR-031) |
| `weekdaySchema` and `localTimeSchema` exist; `addSlotSchema` composes them | `src/lib/validation/scheduling.ts:5-13,91` | `moveSlotSchema` reuses them (FR-030) |
| `listSlots` wants `slot:["view"]`; `addSlot`/`setSlotPaused`/`deleteSlot` want `slot:["manage"]`, re-check it inside `scope.transaction`, and check the row exists first | `src/server/services/slots.ts` | `moveSlot` copies that shape exactly (FR-028, FR-029) |
| The accounts page gates every manager block on `scope.can({ account: ["manage"] })` | `src/app/p/[projectSlug]/accounts/page.tsx:69` | Change to `slot:["manage"]` for the grid only (FR-040) |
| Owner and admin hold both `account:manage` and `slot:manage`; editor holds neither | `src/server/auth/access.ts:20-59` | No role's effective access changes |
| Post-connect focus selector is `input[name="slot-day-${id}"]:checked` | `page.tsx:130`, `ConnectLanding.tsx:13` | Must be repointed at a grid control (FR-050) |
| `SlotEditor.tsx` holds `SlotEditor`, `SlotRowActions`, `ReconnectMockButton`, `MockBehaviourForm`; only the first two go | `src/app/p/[projectSlug]/accounts/SlotEditor.tsx` | The file stays and keeps the two mock controls (FR-048) |
| Calendar drag uses native HTML5 drag events; all decision logic sits in `calendar-logic.ts`, unit-tested in `CalendarBoard.test.ts` | `calendar/CalendarBoard.tsx`, `calendar/calendar-logic.ts` | The precedent this entry follows |
| `LiveRegion` is a mounted `role="status"`; `AnnounceProvider`/`useAnnounce()`/`announcedText()` exist, but the accounts page mounts no provider | `src/components/ui/LiveRegion.tsx`, `Announce.tsx`, `page.tsx` | The grid must work with or without a provider (FR-044) |
| No drag library and no DOM testing library in `package.json` | `package.json` | No new dependency (constitution VI) |
| Tailwind is 4.3.3 and ships the `pointer-coarse` / `pointer-fine` variants | `node_modules/tailwindcss/package.json`, `dist/lib.js` | Hover-free reveal of the delete control needs no custom CSS (FR-021) |
| `motion-safe:` is the repo's existing reduced-motion idiom | every `loading.tsx` | FR-045 needs no new mechanism |
| There is no public-API slot endpoint (`grep -rn slot src/app/api/v1/` is empty) | `src/app/api/v1/` | No public API contract changes |
| `src/components/schedule/` already exists, holding `explicit-time-text.ts` | tree | The grid is added to it; the directory is not created |
| `tests/integration/accounts-ui.test.ts` asserts only *ordering* around `id="account-<id>-slots"`, never the table's columns | that file, lines 240-288 | The rewrite for SC-013 is small and additive |

## Decisions

### R1 — Rounding step is 30 minutes

**Decision**: `STEP_MINUTES = 30`, used identically for click-to-place and for drop (FR-009).

**Rationale**: the spec's stated assumption, and the coarser of the two allowed values, so a click lands on a
round time more often. The exact time stays reachable through the retime path (FR-018).

**Alternatives considered**: 15 minutes — rejected. It doubles the number of distinguishable drop positions in
a column of fixed height for no gain, and makes a slightly-off click land on a `:15`/`:45` time nobody asked
for.

### R2 — Column geometry: one surface, one linear 00:00–24:00 mapping, chips in flow

**Decision**: each day column is a single `position: relative` box. Its own box height maps linearly to
00:00–24:00, so the time under a pointer is `clampToDay(roundToStep((y / height) * 1440))`. A narrow gutter
down the inside-left of the column draws hour ticks, labelled every three hours, from the *same* formula.
Chips lay out in normal flow, in ascending time order, in the remaining width. All seven columns sit in one
`grid grid-cols-7 items-stretch` row, so they share one height and therefore one identical mapping. Hovering
the column's empty area shows the time a click would place at.

**Rationale**: a chip has to hold a 14 px time (design system §4, the scale entry 1 settled), so it needs
roughly 26 px of height. Twenty-four hours of *proportionally positioned* chips at that height needs ≥ 620 px
of column before two adjacent slots stop overlapping — which breaks SC-010 ("readable in one glance with no
scrolling at a desktop width") and the legibility of the chips themselves. Separating *hit-testing*
(positional, continuous, clamped) from *layout* (flow, time-ordered) satisfies every requirement that touches
geometry: FR-002 ordering, FR-008/FR-009 position→time, FR-010 clamping, the many-slots-on-one-day edge case
(the column simply grows and every chip stays focusable), and FR-046 (columns stack below `md`, where the
mapping is irrelevant because placement there goes through the per-column add button). Because the ticks are
drawn from the same formula as the hit test, what is drawn is always what a click returns, even as a column
grows.

**Trade-off accepted**: a chip does not sit at the y the click happened at — it drops into sort order.
Mitigated by the announcement naming the day and time (FR-044), and by FR-012 (a rounded time is never one you
are stuck with). This is a judgement call and goes in `docs/decisions.md`. The hover readout once mitigated
this too but was dropped — see `docs/decisions.md`'s 035 entry — so do not re-derive it from this note.

**Alternatives considered**: (a) absolutely positioned chips on a 24 h track — rejected above; (b) an
internally scrolling 24 h track at 48 px/hour — rejected, violates SC-010; (c) a 48-row half-hour CSS grid —
rejected, a legible row height makes the grid ~1250 px tall; (d) dropping positional placement for a
per-column "add a time" form — rejected, that is the clunkiness the entry exists to remove, and it contradicts
FR-008 and FR-009.

### R3 — Keyboard parity: a per-column add button and one per-chip move/retime dialog

**Decision**: two affordances, both following the calendar's control-plus-dialog precedent.

1. **Add (FR-011)**: every column header carries an `Add a slot on <Day>` button for a manager. It places at
   the first free `STEP_MINUTES` boundary at or after 09:00 on that day, wrapping to the first free boundary
   from 00:00 when the day is full from 09:00 onwards; a day with no free boundary at all disables the button
   and says why in text. Focus moves to the new chip once it renders.
2. **Move and retime (FR-015, FR-018, FR-019)**: one `MoveSlotDialog` per chip, opened by a `Move…` control on
   the chip. It holds a Mon–Sun `SegmentedControl` (the design system's control for a fixed weekday choice) and
   a `type="time"` `Field` pre-filled with the slot's current `HH:MM`, plus **Move** and **Cancel**. Cancel
   closes, sends nothing, and `Dialog` returns focus to the chip (FR-015). Because the dialog carries both the
   weekday and the time, it is at once the keyboard equivalent of the drag *and* the typed-time route — one
   control, not two.

**Rationale**: FR-015 and FR-018 are the same shape of interaction (choose a day and/or a time, commit or
cancel), and the repo already has exactly this pattern for the calendar's drag. The spec's assumption asks
planning to prefer that over inventing a third pattern.

**Alternatives considered**: arrow-key stepping on a focused chip — rejected: it needs its own mode, its own
escape semantics and its own per-step announcements, with no precedent here. An always-visible inline
`type="time"` input on every chip — rejected: seven columns' worth of input chrome, and it still would not
cover the weekday half of a move.

### R4 — Chip anatomy and accessible names

**Decision**: a chip is an `<li>` whose inner wrapper has `role="group"` and
`aria-label="<Weekday> <HH:MM>, active|paused"` (FR-004), carries `class="group"`, and for a manager also
`draggable`. Inside, for a manager, three controls in tab order:

| Control | Element | Accessible name | Behaviour |
|---|---|---|---|
| Body | `<button>` showing `HH:MM` and the word `Active`/`Paused` | `Pause <Weekday> <HH:MM>` / `Resume <Weekday> <HH:MM>` | toggles paused (FR-024) |
| Move | icon `<button>`, the `clock` icon | `Move or retime <Weekday> <HH:MM>` | opens `MoveSlotDialog` (R3) |
| Delete | icon `<button>`, the `close` icon | `Delete <Weekday> <HH:MM>` | deletes on one activation, no confirm (FR-022) |

Both icon names already exist in `ICONS` in `scripts/generate-icons.mjs` (`clock` → `clock`, `close` → `x`), so
no icon has to be added and `pnpm icons` does not need to run.

Move and Delete carry
`opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100` — hover-revealed
with a mouse, always painted on a touch device, and revealed by focus for a keyboard (FR-021). They stay in the
accessibility tree and in the tab order at all times; only their paint is conditional.

For a read-only viewer the chip renders as a plain `<li>` with the text `<HH:MM> · Active|Paused` and **no**
buttons — not disabled ones (FR-037, FR-038).

Paused is signalled three ways at once (FR-025, FR-026): the word `Paused`, a `warning`-tone `Badge`, and a
dashed border with `text-muted-foreground` — text, shape and hue, never hue alone.

### R5 — Drag uses native HTML5 drag events

**Decision**: `draggable` on the chip wrapper, `dataTransfer.setData("text/plain", slot.id)` with
`effectAllowed = "move"`, a `dragging` ref holding `{ id, weekday, localTime }`, and `onDragOver`/`onDrop` on
the column body computing the target time from the drop `clientY` through R2's mapping. Exactly
`CalendarBoard`'s mechanism.

**Rationale**: constitution VI, and pipeline phases cannot reach the registry. A second drag idiom in the same
codebase would be worse than the one that is already tested.

**Alternatives considered**: `@dnd-kit/core` or `react-dnd` — rejected: a new runtime dependency for one
screen, uninstallable in this pipeline, and `NEEDS DEPENDENCY` would block the entry for no functional gain.

### R6 — Optimistic state is an override map over the server's props

**Decision**: the grid never mirrors the slot list. It holds
`overrides: Map<string, { kind: "patch"; weekday; localTime; paused } | { kind: "deleted" }>` plus
`additions: OptimisticSlot[]` (temporary ids), and renders
`applyOverrides(props.slots, overrides, additions)`. Each operation writes its override, stamps it with a
monotonically increasing sequence number, calls the action, then clears that override whichever way the action
answers. The actions already call `refresh()` on success, so the page re-renders and the grid's base props are
always server truth.

On failure the override is dropped, the previous render returns by itself (FR-035), and the message goes into a
`role="alert"` line and into the announcement. A stale answer cannot win: an override is only cleared by the
answer whose sequence number wrote it, and clearing never *writes* a value (FR-036).

**Rationale**: a mirrored array has to be reconciled on every `refresh()`, which is exactly where
"settles on the order the optimistic updates were applied in" bugs live. Overrides make the server the base and
the optimism a thin, self-erasing layer — which is what FR-036 asks for.

**Alternatives considered**: `useOptimistic` — rejected, it is scoped to one transition and resets on the next
render, which does not survive several concurrent in-flight mutations on different chips (the spec's second
edge case). A mirrored array re-seeded by `useEffect` — rejected as above.

### R7 — Announcements: use a provider when there is one, otherwise own the region

**Decision**: `const api = useAnnounce()`. If a context comes back, announce through it and render no region of
its own. If it returns `null` — today's accounts page — hold a local `message` state, render one
`<LiveRegion>`, and de-duplicate consecutive identical messages with the already-exported
`announcedText(message, count)` from `Announce.tsx`. Every message is built by a pure function in the logic
module, so the wording is unit-tested.

**Rationale**: FR-044 requires both paths, and the spec's assumption states it. Reusing `announcedText` keeps
one de-duplication rule in the codebase instead of adding `CalendarBoard`'s `setTimeout("")` trick to it.

### R8 — The duplicate rule is extracted once in the DAL, not restated

**Decision**: `src/server/dal/slots.ts` grows `move(id, weekday, localTime): Promise<SlotRow>`. The existing
`isUniqueViolation` try/catch is lifted into a local helper `asSlotConflict<T>(fn): Promise<T>`, and both
`insert` and `move` call through it, so the constraint-to-`ConflictError` translation — message *and*
`field: "localTime"` — exists in exactly one place (FR-031). `move` returns the updated row via `.returning()`
so the service can hand back a `SlotView`.

`move` touches no target row, so queued posts keep their times for free (FR-017, FR-033) — the mirror image of
`deleteSlot`'s existing "Targets keep their times" comment, and worth the same one-line comment.

### R9 — The page gates slot editing on `slot:["manage"]`

**Decision**: `page.tsx` adds `const canManageSlots = scope.can({ slot: ["manage"] })` and passes only that to
the grid. `canManage` (`account:["manage"]`) keeps every other manager-only block, including the connect
landing, which is about connecting accounts rather than editing slots. The two capabilities coincide for all
three roles today, so this is a correctness fix with no behaviour change (FR-040).

### R10 — The connect hand-off focuses the Monday add button

**Decision**: the grid accepts an optional `addButtonId` and puts it on the Monday column's add button.
`page.tsx` passes `account-${account.id}-add-slot` and changes `ConnectLanding`'s `focusSelector` to
`#account-${id}-add-slot` (FR-050). A viewer with no add button simply gets no focus move — `ConnectLanding`
already tolerates a selector that matches nothing, and the landing only renders for a manager anyway.

**Alternatives considered**: focusing the column body — rejected, it is deliberately not focusable (R2).
Focusing the slots heading — rejected, a heading does not "begin adding a slot" as FR-050 requires.

### R11 — Reduced motion costs nothing because the grid adds no motion

**Decision**: the grid's only transition is `motion-safe:transition-colors`. There is no snap, slide or settle:
the drag image is the browser's own, and a dropped chip simply re-renders in sort order. FR-045 is satisfied by
having nothing to suppress, and the markup test asserts the grid emits no `transition-transform`, `animate-`
or `duration-` class outside a `motion-safe:` variant.

### R12 — Test shape: pure logic module, static-markup tests, service and action integration tests

**Decision**: no new dependency (constitution VI). Three layers, matching entry 1 and the calendar:

| Layer | File | Covers |
|---|---|---|
| Pure logic units | `src/components/schedule/week-slot-grid-logic.test.ts` | `roundToStep`, `clampToDay`, `timeAtPosition`, tick labels, `slotsByWeekday` ordering, `nextFreeTime`, `isNoOpMove`, `conflictAt`, `applyOverrides`, every announcement and refusal string, `hhmm` seconds-stripping |
| Rendered markup | `src/components/schedule/WeekSlotGrid.test.tsx` via `renderToStaticMarkup` | seven named columns in Mon–Sun order, chips in time order, each chip's `aria-label`, `Active`/`Paused` text, the three controls present for a manager and *absent* (not disabled) for a reader, both empty messages, the zone line, `draggable` only for a manager, no raw palette or `dark:` class, no un-gated motion class |
| Integration | `tests/integration/accounts-slots.test.ts`, `actions-authz.test.ts`, `accounts-ui.test.ts` | `moveSlot` success / conflict / not-found / cross-project / bad weekday / bad time / editor forbidden / id and `slot_id` preserved; `moveSlotAction` in the authz matrix; the accounts page rendering a real grid for a manager and a reader |

What this shape cannot prove is that a pointer drag or a hover reveal behaves in a real browser. That is the
same gap the calendar's drag has today, and it is handled the same way: `NEEDS DEPENDENCY` is deliberately
**not** raised, because every requirement has either decision-logic or markup assertions behind it, and the
browser walk-through is a human task in `quickstart.md` §7. Per the pipeline's human-task rule that task is
ordered last and blocks nothing.

**Alternatives considered**: `@testing-library/react` with `jsdom` or `happy-dom` — rejected: a new dev
dependency the pipeline cannot install, and raising `NEEDS DEPENDENCY` would stall the entry for behaviour the
logic module already pins down.

### R13 — Documentation lands in four places

`docs/design-system.md` §7 gets one components-table row carrying R3's keyboard sequence and FR-022's
no-confirm exception beside the `Button` row's "`danger` always confirms" rule (FR-052). The `docket-ui`
skill's "Lists, tables, calendar" section records the week grid as how posting slots are edited, next to the
existing drag-has-a-keyboard-equivalent rule (FR-053). `docs/accounts.md` and `docs/getting-started.md` §2
describe the new add flow (FR-054). `docs/decisions.md` records R2's trade-off and FR-022's exception
(constitution: Docs).
