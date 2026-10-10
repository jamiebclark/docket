# Phase 1 data model: Reusable week grid for posting slots

**Branch**: `035-week-slot-grid` | **Spec**: [spec.md](spec.md) | **Research**: [research.md](research.md)

**No schema change and no migration.** `posting_slots` already carries everything this entry needs. Everything
below is either an existing persisted shape (restated so the contracts can refer to it) or a client-side view
type that lives only in the grid.

## 1. Persisted — `posting_slots` (unchanged)

`src/server/db/schema/accounts.ts`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | Preserved by a move (FR-017). Targets reference it by `slot_id` |
| `project_id` | uuid, not null | Project isolation (constitution III); every DAL query filters on it |
| `social_account_id` | uuid, not null | One grid instance shows one account's slots |
| `weekday` | int, not null | ISO weekday, 1 = Monday … 7 = Sunday. `posting_slots_weekday_range` check constraint |
| `local_time` | time, not null | Wall-clock time in the project's zone. Read back as `HH:MM:SS`; written as `HH:MM` |
| `paused` | boolean, not null | Active/paused (FR-024) |

**Constraints that carry rules this entry depends on**

| Constraint | Rule |
|---|---|
| `posting_slots_account_time_uq` on `(social_account_id, weekday, local_time)` | No two slots on one account at the same weekday and time. This — not a Zod rule — is what refuses a duplicate add *and* a duplicate move (FR-016, FR-019, FR-031) |
| `posting_slots_weekday_range` | 1 ≤ `weekday` ≤ 7 |
| `post_targets.slot_id` FK, `ON DELETE SET NULL` | Deleting a slot nulls the reference and leaves the target's time alone (FR-023). A move does not touch it at all (FR-033) |

**State transitions.** A slot has exactly one state axis, `paused`, toggled both ways by `setSlotPaused`
(active ⇄ paused). `weekday` and `local_time` change together through `moveSlot` only — the new operation this
entry adds. Nothing else about a slot mutates.

## 2. Server-side types

### `SlotView` (existing, unchanged)

`src/server/services/slots.ts:10` — `Pick<SlotRow, "id" | "socialAccountId" | "weekday" | "localTime" | "paused">`.
`localTime` here is whatever Postgres returned, i.e. `HH:MM:SS`. Every display site strips the seconds; the grid
does it in one place (`hhmm`, §4).

### `moveSlotSchema` (new)

`src/lib/validation/scheduling.ts`, built from the existing pieces so there is no second copy of the rules
(FR-030):

```
moveSlotSchema = z.object({
  id: z.uuid(),
  weekday: weekdaySchema,     // existing, 1..7, "Choose a weekday"
  localTime: localTimeSchema, // existing, /^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour time as HH:MM"
})
```

## 3. Grid view types (`src/components/schedule/week-slot-grid-logic.ts`)

These are the component's own vocabulary. None of them names an account, a route, an action or a DB column —
FR-003.

| Type | Shape | Notes |
|---|---|---|
| `Weekday` | `1 \| 2 \| 3 \| 4 \| 5 \| 6 \| 7` | Same numbering as the column (ISO, Monday first) |
| `GridSlot` | `{ id: string; weekday: Weekday; localTime: string; paused: boolean }` | `localTime` accepted as `HH:MM` or `HH:MM:SS`; normalised on the way in |
| `GridSlotState` | `GridSlot & { pending: boolean }` | `pending` is true while an override for it is unresolved; it drives nothing but a subdued style and `aria-busy` |
| `Override` | `{ kind: "patch"; seq: number; weekday; localTime; paused } \| { kind: "deleted"; seq: number }` | One per slot id, R6 |
| `Addition` | `{ tempId: string; seq: number; weekday: Weekday; localTime: string }` | An optimistic chip with no server id yet; always `paused: false` |
| `GridPermissions` | `{ canManage: boolean }` | The only permission the component knows about; the page computes it from `slot:["manage"]` (FR-040) |
| `MoveIntent` | `{ id: string; weekday: Weekday; localTime: string }` | What a drag, a drop or the dialog produces, and what `onMove` receives |

**Invariants**

1. `localTime` inside the grid is always normalised `HH:MM` (FR-005). `hhmm` is the single normaliser.
2. A rendered column's chips are ascending by `localTime`, ties broken by `id` for a stable order (FR-002).
3. `applyOverrides` is a pure function of `(slots, overrides, additions)` with no clock and no randomness, so
   every ordering case is unit-testable (FR-036).
4. An `Addition`'s `tempId` never leaves the component; it is replaced wholesale when the refreshed props
   arrive.
5. `weekday` is only ever produced by the column it came from, so an out-of-range weekday cannot originate in
   the UI; the server still validates it (FR-030).

## 4. Pure functions over those types

Named here because the contracts and the task list refer to them; all live in
`src/components/schedule/week-slot-grid-logic.ts` and are unit-tested in R12's first layer.

| Function | Signature | Rule it encodes |
|---|---|---|
| `STEP_MINUTES` | `30` | FR-009 / R1 |
| `hhmm` | `(t: string) => string` | `"09:30:00"` → `"09:30"`; FR-005 and the seconds edge case |
| `minutesOf` | `(hhmm: string) => number` | `"09:30"` → 570 |
| `timeOfMinutes` | `(m: number) => string` | 570 → `"09:30"` |
| `roundToStep` | `(m: number) => number` | nearest `STEP_MINUTES` boundary; FR-009 |
| `clampToDay` | `(m: number) => number` | into `[0, 1440 - STEP_MINUTES]`; FR-010 and the midnight edge case |
| `timeAtPosition` | `(offsetY: number, height: number) => string` | R2's mapping, then `roundToStep`, then `clampToDay`; one function for click and for drop so they cannot diverge (FR-009) |
| `hourTicks` | `() => { minutes: number; label?: string }[]` | 24 ticks, labelled every three hours, from the same mapping as `timeAtPosition` |
| `slotsByWeekday` | `(slots: GridSlotState[]) => GridSlotState[][]` | seven buckets, each sorted; FR-001, FR-002 |
| `nextFreeTime` | `(day: GridSlotState[], from = "09:00") => string \| null` | the keyboard add's target time; `null` when the day has no free boundary (R3) |
| `isNoOpMove` | `(slot: GridSlot, intent: MoveIntent) => boolean` | same weekday and same rounded time → send nothing, announce nothing (FR-014) |
| `conflictAt` | `(slots: GridSlotState[], intent: MoveIntent, exceptId?) => GridSlotState \| null` | the local duplicate check, used to refuse before a round trip; the server's check stays authoritative (FR-016) |
| `applyOverrides` | `(slots, overrides, additions) => GridSlotState[]` | R6 |
| `announceAdded` / `announceMoved` / `announceRetimed` / `announceDeleted` / `announcePaused` / `announceResumed` / `announceRefused` | `(…) => string` | every string in FR-044 / SC-006, each naming the weekday and time |
| `WEEKDAY_NAMES` | `readonly ["Monday", …, "Sunday"]` | one source for column labels, accessible names and announcements |
| `DUPLICATE_REFUSAL` | `"That account already has a slot at that time."` | the client-side wording, identical to the server's `ConflictError` message so a local and a server refusal read the same (FR-016) |

## 5. What is *not* modelled

- No new field, table or granularity: no dates, recurrence rules, durations or per-account time zones
  (spec, Not included).
- No conversion: the grid takes `timeZoneLabel: string` and renders it. All times stay wall-clock in the
  project's zone, so a project time-zone change cannot silently reinterpret a stored time (FR-005, FR-006, and
  the time-zone-change edge case).
- No cross-account state: one grid instance is one account's slots, so the duplicate rule has no cross-account
  case to resolve.
