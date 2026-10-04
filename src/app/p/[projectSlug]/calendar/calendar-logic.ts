import type { ActionResult } from "@/lib/action-result";
import type { PlannedTime } from "@/server/services/queue";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-06T09:00 Europe/London" → "Tue 6 Oct 09:00 Europe/London". Anything else is returned as is. */
export function formatPlanned(localTime: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})(?::\d{2})?\s+(.+)$/.exec(localTime);
  if (!m) return localTime;
  const [, y, mo, d, hm, zone] = m;
  const weekday = WEEKDAYS[new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).getUTCDay()];
  return `${weekday} ${Number(d)} ${MONTHS[Number(mo) - 1]} ${hm} ${zone}`;
}

export const announceMoved = (localTime: string): string => `Moved to ${formatPlanned(localTime)}`;

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
  deps.announce(announceMoved(result.data.localTime));
  deps.refresh();
  return { ok: true };
}
