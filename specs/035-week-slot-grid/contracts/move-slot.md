# Contract: moving a slot (service, DAL, server action)

The one server-side capability this entry adds. Shapes follow the three existing slot operations exactly, so a
reviewer can diff them against `addSlot` / `setSlotPaused` / `deleteSlot`.

## 1. DAL — `src/server/dal/slots.ts`

```ts
export interface SlotsRepo {
  // … existing members unchanged …
  /** Changes a slot's weekday and local time in place. Targets are untouched: `slot_id` keeps pointing here. */
  move(id: string, weekday: number, localTime: string): Promise<SlotRow>;
}
```

| Rule | Detail |
|---|---|
| Project scoping | `where(and(eq(postingSlots.projectId, projectId), eq(postingSlots.id, id)))`, like every other member (constitution III) |
| Duplicate translation | Goes through the extracted `asSlotConflict` helper, which `insert` now also uses, so `23505` becomes `ConflictError("That account already has a slot at that time.", "localTime")` in exactly one place (FR-031) |
| Return | The updated row via `.returning()`; a row that the project filter excluded yields `undefined`, which the service has already ruled out with its existence check |
| Targets | No write to `post_targets`. A moved slot keeps its id, so every target that referenced it still does (FR-017, FR-033) |

## 2. Service — `src/server/services/slots.ts`

```ts
/** Changes a slot's weekday and time in place. Targets keep their times: nothing reads `slot_id` here. */
export async function moveSlot(scope: ProjectScope, input: unknown): Promise<SlotView>;
```

| Step | Behaviour | Requirement |
|---|---|---|
| 1 | `moveSlotSchema.parse(input)` — the existing `weekdaySchema` and `localTimeSchema`, no second copy | FR-030 |
| 2 | `if (!scope.can({ slot: ["manage"] })) throw new ForbiddenError()` | FR-028 |
| 3 | `scope.transaction(async (tx) => { … })` | FR-029 |
| 4 | Inside the transaction, `if (!tx.can({ slot: ["manage"] })) throw new ForbiddenError()` | FR-028 |
| 5 | Inside the transaction, `if (!(await tx.slots.get(id))) throw new NotFoundError()` — a slot in another project is not visible through the scope, so it is a not-found | FR-029 |
| 6 | `return tx.slots.move(id, weekday, localTime)` | FR-027 |

**Outcomes**

| Input | Result |
|---|---|
| Valid, free target weekday + time | The updated `SlotView`; same `id`, new `weekday` / `localTime`, `paused` unchanged |
| Target weekday + time already taken on that account | `ConflictError("That account already has a slot at that time.", "localTime")` |
| Caller without `slot:["manage"]` (editor) | `ForbiddenError` |
| Unknown slot id, or one belonging to another project | `NotFoundError` |
| `weekday` outside 1–7, or a non-integer | `ZodError` — "Choose a weekday" |
| `localTime` not 24-hour `HH:MM` (`"9:00"`, `"24:00"`, `"09:00:00"`) | `ZodError` — "Use 24-hour time as HH:MM" |
| Moving to the weekday and time it already has | Succeeds and is a no-op write. The grid never sends this (FR-014); the service does not special-case it |

## 3. Server action — `src/app/p/[projectSlug]/accounts/actions.ts`

```ts
export async function moveSlotAction(
  slug: string,
  input: { id: string; weekday: number; localTime: string },
): Promise<ActionResult<slots.SlotView>>;
```

Implemented as `mutate(slug, (scope) => slots.moveSlot(scope, input))` — the same wrapper `addSlotAction` uses,
so `runAction` maps the errors and `refresh()` runs on success and keeps the server-rendered slot counts correct
(FR-032, FR-051).

| Thrown | Returned |
|---|---|
| — | `{ ok: true, data: SlotView }` |
| `ConflictError` | `{ ok: false, error: "conflict", message: "That account already has a slot at that time.", fieldErrors: { localTime: "…" } }` |
| `ForbiddenError` | `{ ok: false, error: "forbidden", message: "You don't have permission to do that." }` |
| `NotFoundError` | `{ ok: false, error: "not_found", message: "Not found." }` |
| `ZodError` | `{ ok: false, error: "validation", … }` via `runAction`'s existing handling |

No other action changes. `addSlotAction`, `setSlotPausedAction` and `deleteSlotAction` already have the shape the
grid needs; the grid adapts each `ActionResult` to `SlotActionOutcome` at the call site in the page.

## 4. Authorization matrix row

`tests/integration/actions-authz.test.ts` gains one row next to the three existing slot actions:

```ts
{ name: "moveSlotAction", manage: true,
  run: (s, f) => accountActions.moveSlotAction(s, { id: f.slotId, weekday: 4, localTime: "12:30" }) },
```

so an editor and a non-member are both refused by the server regardless of what was rendered (FR-039, SC-009).

## 5. Public API

Unchanged. `src/app/api/v1/` exposes no slot endpoint today, so there is no external contract to version.
