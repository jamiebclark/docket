"use client";

import { WeekSlotGrid, type SlotActionOutcome, type WeekAddOutcome, type WeekSlotGridProps } from "@/components/schedule/WeekSlotGrid";
import type { GridSlot, Weekday } from "@/components/schedule/week-slot-grid-logic";
import type { ActionResult } from "@/lib/action-result";
import { addSlotAction, addWeekSlotsAction, deleteSlotAction, moveSlotAction, setSlotPausedAction } from "./actions";

const FAILED = "Something went wrong.";

function outcome(result: { ok: boolean; message?: string }): SlotActionOutcome {
  return result.ok ? { ok: true } : { ok: false, message: result.message ?? FAILED };
}

/** Like `outcome`, but hands the created slot's id back so the grid can focus its chip. */
function addOutcome(result: ActionResult<{ id: string }>): SlotActionOutcome {
  return result.ok ? { ok: true, id: result.data.id } : { ok: false, message: result.message };
}

/** Like `outcome`, but reports which weekdays the server created and which already had the time. */
function weekOutcome(result: ActionResult<{ added: { weekday: number }[]; alreadySet: number[] }>): WeekAddOutcome {
  return result.ok
    ? { ok: true, added: result.data.added.map((s) => s.weekday as Weekday), alreadySet: result.data.alreadySet as Weekday[] }
    : { ok: false, message: result.message };
}

/** Thin client adapter binding the accounts page's slot server actions to `WeekSlotGrid`'s callbacks. */
export function AccountSlotGrid({
  slug,
  accountId,
  ...props
}: Omit<WeekSlotGridProps, "onAdd" | "onAddWeek" | "onMove" | "onToggle" | "onDelete"> & {
  slug: string;
  accountId: string;
  slots: readonly GridSlot[];
}) {
  return (
    <WeekSlotGrid
      {...props}
      onAdd={async ({ weekday, localTime }: { weekday: Weekday; localTime: string }) =>
        addOutcome(await addSlotAction(slug, { accountId, weekday, localTime }))
      }
      onAddWeek={async ({ localTime }: { localTime: string }) => weekOutcome(await addWeekSlotsAction(slug, { accountId, localTime }))}
      onMove={async ({ id, weekday, localTime }) => outcome(await moveSlotAction(slug, { id, weekday, localTime }))}
      onToggle={async ({ id, paused }) => outcome(await setSlotPausedAction(slug, { id, paused }))}
      onDelete={async ({ id }) => outcome(await deleteSlotAction(slug, { id }))}
    />
  );
}
