import { formatLocal } from "@/components/ui/LocalTime";
import type { ActionResult } from "@/lib/action-result";
import type { PlannedTime } from "@/server/services/queue";

export const announceMoved = (scheduledAt: string, timeZone: string): string => `Moved to ${formatLocal(scheduledAt, timeZone)}`;

/** A chip may only be dropped on an empty slot of its own account. */
export function canDrop(chipAccountId: string, slotAccountId: string): boolean {
  return chipAccountId === slotAccountId;
}

export const REFUSED_OTHER_ACCOUNT = "That slot belongs to another account.";

export interface EmptySlotRef {
  accountId: string;
  slotId: string;
  at: string;
}

export interface MoveDeps {
  /** The project's zone, so announced times read like every other time in the app. */
  timeZone: string;
  moveToOccurrence: (input: { targetId: string; slotId: string; scheduledAt: string }) => Promise<ActionResult<PlannedTime>>;
  announce: (message: string) => void;
  /** Called after a move or a stale refusal, so the page re-reads. */
  refresh: () => void;
  focusAfterRefresh: (targetId: string) => void;
}

export type MoveOutcome = { ok: true } | { ok: false; message: string };

/** Moves a chip into an empty slot. A refusal (taken, paused, published…) is announced and the page refreshed. */
export async function moveChipToSlot(
  deps: MoveDeps,
  chip: { targetId: string; accountId: string },
  slot: EmptySlotRef,
): Promise<MoveOutcome> {
  if (!canDrop(chip.accountId, slot.accountId)) {
    deps.announce(REFUSED_OTHER_ACCOUNT);
    return { ok: false, message: REFUSED_OTHER_ACCOUNT };
  }
  const result = await deps.moveToOccurrence({ targetId: chip.targetId, slotId: slot.slotId, scheduledAt: slot.at });
  if (!result.ok) {
    deps.announce(result.message);
    deps.refresh();
    return { ok: false, message: result.message };
  }
  deps.focusAfterRefresh(chip.targetId);
  deps.announce(announceMoved(result.data.scheduledAt, deps.timeZone));
  deps.refresh();
  return { ok: true };
}
