# Contract: `WeekSlotGrid` component

`src/components/schedule/WeekSlotGrid.tsx` — a `"use client"` presentational component. It knows about slots,
callbacks and a time-zone label, and about nothing else: no account, no route, no server action, no data access
(FR-003). The accounts page is its only caller in this entry; this contract is what a second caller would code
against.

## Props

```ts
export interface WeekSlotGridProps {
  /** One account's slots. `localTime` may be `HH:MM` or `HH:MM:SS`; both normalise to `HH:MM`. */
  slots: readonly GridSlot[];
  /** The project's time zone, named once for the grid. Rendered as text; never used to convert. */
  timeZoneLabel: string;
  /** Whether this viewer may change anything. False renders a complete read-only grid. */
  canManage: boolean;
  /** Labels the grid for assistive technology, e.g. "Posting slots for Studio Page". */
  label: string;
  /** Shown instead of chips when `slots` is empty. The caller owns the wording, including the
   *  "Ask Robin or Sam to …" form for a reader who cannot manage slots (FR-041). */
  emptyMessage: string;
  /** Put on the Monday column's add button so a caller can target it, e.g. the post-connect hand-off (FR-050). */
  addButtonId?: string;

  onAdd(input: { weekday: Weekday; localTime: string }): Promise<SlotActionOutcome>;
  onMove(input: MoveIntent): Promise<SlotActionOutcome>;
  onToggle(input: { id: string; paused: boolean }): Promise<SlotActionOutcome>;
  onDelete(input: { id: string }): Promise<SlotActionOutcome>;
}

/** Narrower than `ActionResult<T>` on purpose: the grid needs the outcome and the words, nothing more. */
export type SlotActionOutcome = { ok: true } | { ok: false; message: string };
```

`GridSlot`, `Weekday` and `MoveIntent` are defined in [data-model.md](../data-model.md) §3 and exported from
`week-slot-grid-logic.ts`.

Retime has **no** callback of its own: a typed time is a move whose weekday happens to be unchanged, so it goes
through `onMove` (FR-019 gets the same duplicate refusal as FR-016 for free).

## Guarantees the component makes

| # | Guarantee | Requirement |
|---|---|---|
| G1 | Renders exactly seven columns in one horizontal row at `md` and above, Monday first, each an `aria-label`led region naming its day; below `md` they stack in the same order | FR-001, FR-046 |
| G2 | Each column lists that day's chips ascending by time, ties broken by id; DOM order equals visual order, so tab order is time order | FR-002, FR-043 |
| G3 | Every chip shows `HH:MM` and `Active`/`Paused`, and carries `aria-label="<Weekday> <HH:MM>, active\|paused"` | FR-004, FR-005, FR-026 |
| G4 | Seconds never reach the DOM; `timeZoneLabel` is rendered exactly once for the grid | FR-005, FR-006 |
| G5 | With `slots` empty, the seven columns still render and still accept a placement; `emptyMessage` shows in place of chips | FR-007 |
| G6 | With `canManage: false`, the grid renders **no** button, **no** input, **no** `draggable` and **no** `disabled` control; chips are plain list items | FR-037, FR-038 |
| G7 | A click or tap in a column's empty area calls `onAdd` with that column's weekday and `timeAtPosition(...)` — rounded to 30 minutes and clamped into the day | FR-008, FR-009, FR-010 |
| G8 | Each column has an `Add a slot on <Day>` button; it calls `onAdd` with `nextFreeTime(day)` and moves focus to the new chip. A day with no free boundary disables it and says why | FR-011 |
| G9 | A chip dragged within its column calls `onMove` with the same weekday and the dropped time; dragged into another column, with that column's weekday | FR-013 |
| G10 | A drop at the same weekday and rounded time, or outside every column, calls nothing and announces nothing | FR-014 |
| G11 | `Move…` on a chip opens a dialog with a Mon–Sun choice and a `type="time"` input; **Move** calls `onMove`, **Cancel** calls nothing and returns focus to the chip | FR-015, FR-018, FR-042 |
| G12 | A time typed into that dialog is validated as 24-hour `HH:MM` before `onMove` is called; an invalid one is refused in the dialog without a round trip | FR-019 |
| G13 | Every chip has a delete control, revealed on hover, always painted on a coarse pointer, and revealed by focus; one activation calls `onDelete` with no dialog and no second click | FR-021, FR-022 |
| G14 | Activating a chip's body calls `onToggle` with the inverse of its current `paused` | FR-024 |
| G15 | Paused chips differ by text, by border style and by tone — never by hue alone | FR-025, FR-026 |
| G16 | Every call is reflected in the rendered grid before its promise settles | FR-034 |
| G17 | An `{ ok: false }` outcome removes that optimistic change, restores the pre-operation render, writes `message` into a `role="alert"` line and announces it | FR-035 |
| G18 | With several calls outstanding, the settled render is the caller's `slots` plus only the still-unresolved overrides, never an accumulation of applied ones | FR-036 |
| G19 | Every change and every refusal produces exactly one polite announcement naming the weekday and time, through `useAnnounce()` when a provider is above it and through its own mounted `LiveRegion` when not | FR-044, SC-006 |
| G20 | Emits no `transition-transform`, `animate-*` or `duration-*` class outside a `motion-safe:` variant | FR-045 |

## Keyboard contract (FR-042, documented in `docs/design-system.md` per FR-052)

| From | Key | Effect |
|---|---|---|
| A column's add button | `Enter` / `Space` | adds a slot on that day at the next free 30-minute boundary from 09:00; focus moves to the new chip |
| A chip body | `Enter` / `Space` | toggles active ⇄ paused |
| A chip | `Tab` | body → Move → Delete → next chip |
| A chip's Move control | `Enter` / `Space` | opens the move dialog, focus inside it |
| The move dialog | `Tab` / arrows | weekday segmented control, then the time input, then Move / Cancel |
| The move dialog | `Enter` on Move | commits; focus returns to the chip |
| The move dialog | `Escape` or Cancel | commits nothing; focus returns to the chip |
| A chip's Delete control | `Enter` / `Space` | deletes immediately; focus moves to the next chip in that column, or to the column's add button |

The column body itself is deliberately **not** focusable: it is a pointer convenience whose every function is
also on the add button and in the move dialog.

## What the component must never do

- Import from `src/server/**`, `src/app/**`, `next/navigation` or `next/cache`.
- Mention an account, a provider, a project slug or a route.
- Convert a time between zones, or read the clock.
- Render a control a viewer cannot use, in any state including `disabled`.
- Assume an `AnnounceProvider` is above it.
