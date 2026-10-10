export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface GridSlot {
  id: string;
  weekday: Weekday;
  localTime: string;
  paused: boolean;
}

export type GridSlotState = GridSlot & { pending: boolean };

export type Override =
  | { kind: "patch"; seq: number; weekday: Weekday; localTime: string; paused: boolean }
  | { kind: "deleted"; seq: number };

export interface Addition {
  tempId: string;
  seq: number;
  weekday: Weekday;
  localTime: string;
}

export interface MoveIntent {
  id: string;
  weekday: Weekday;
  localTime: string;
}

export const STEP_MINUTES = 30;
const MINUTES_PER_DAY = 1440;
const LAST_STEP_START = MINUTES_PER_DAY - STEP_MINUTES;

export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

export const DUPLICATE_REFUSAL = "That account already has a slot at that time.";

/** "09:30:00" → "09:30". Already-normalised input passes through unchanged. */
export function hhmm(t: string): string {
  return t.slice(0, 5);
}

/** "09:30" → 570 */
export function minutesOf(time: string): number {
  const [h = 0, m = 0] = hhmm(time).split(":").map(Number);
  return h * 60 + m;
}

/** 570 → "09:30" */
export function timeOfMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Nearest STEP_MINUTES boundary. */
export function roundToStep(m: number): number {
  return Math.round(m / STEP_MINUTES) * STEP_MINUTES;
}

/** Into [0, 1440 - STEP_MINUTES], so a rounded time never lands on the next day. */
export function clampToDay(m: number): number {
  if (m < 0) return 0;
  if (m > LAST_STEP_START) return LAST_STEP_START;
  return m;
}

/** The same formula for a click position and a drop position, so they cannot diverge. */
export function timeAtPosition(offsetY: number, height: number): string {
  const proportion = height > 0 ? offsetY / height : 0;
  const minutes = clampToDay(roundToStep(proportion * MINUTES_PER_DAY));
  return timeOfMinutes(minutes);
}

/** Seven buckets, each ascending by localTime, ties broken by id. */
/**
 * Where a time sits down the column, as a percentage of the day. The inverse of `timeAtPosition`, so a
 * chip dropped at a position renders back at that same position — without this the column maps clicks to
 * times spatially but then renders the chips as a plain ordered list, and dragging one down changes its
 * time while leaving it exactly where it was.
 */
export function topPercentOf(localTime: string): number {
  return (clampToDay(minutesOf(localTime)) / MINUTES_PER_DAY) * 100;
}

/** Hour boundaries down the column, for the background rules and the gutter labels. */
export function hourTicks(): { hour: number; topPercent: number }[] {
  return Array.from({ length: 24 }, (_, hour) => ({ hour, topPercent: (hour / 24) * 100 }));
}

export function slotsByWeekday(slots: GridSlotState[]): GridSlotState[][] {
  const buckets: GridSlotState[][] = [[], [], [], [], [], [], []];
  for (const slot of slots) {
    buckets[slot.weekday - 1]!.push(slot);
  }
  for (const bucket of buckets) {
    bucket.sort((a, b) => {
      const byTime = minutesOf(a.localTime) - minutesOf(b.localTime);
      return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
    });
  }
  return buckets;
}

/** The first free STEP_MINUTES boundary at or after `from`, wrapping to 00:00; null if the day is full. */
export function nextFreeTime(day: GridSlotState[], from = "09:00"): string | null {
  const taken = new Set(day.map((slot) => hhmm(slot.localTime)));
  const start = clampToDay(roundToStep(minutesOf(from)));
  const stepsInDay = MINUTES_PER_DAY / STEP_MINUTES;
  for (let i = 0; i < stepsInDay; i++) {
    const minutes = (start + i * STEP_MINUTES) % MINUTES_PER_DAY;
    const candidate = timeOfMinutes(minutes);
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Same weekday and same time → send nothing, announce nothing. A drop's time has already been rounded by
 * `timeAtPosition`, so the default compares against the rounded intent time. Set `exact` for a typed time (the
 * Move dialog), which must match the chip's time without rounding — a nearby typed time is not a no-op.
 */
export function isNoOpMove(slot: GridSlot, intent: MoveIntent, exact = false): boolean {
  if (exact) return slot.weekday === intent.weekday && hhmm(slot.localTime) === hhmm(intent.localTime);
  const roundedIntentTime = timeOfMinutes(clampToDay(roundToStep(minutesOf(intent.localTime))));
  return slot.weekday === intent.weekday && hhmm(slot.localTime) === roundedIntentTime;
}

/** The local duplicate check: finds a same-weekday same-time slot, ignoring the chip being moved. */
/**
 * The slot already occupying `intent`'s day and time, or null. Takes only the day and the time so
 * the add path — which has no slot id yet — can refuse a duplicate before the round trip, the same
 * way the move path does.
 */
export function conflictAt(
  slots: GridSlotState[],
  intent: Pick<MoveIntent, "weekday" | "localTime">,
  exceptId?: string,
): GridSlotState | null {
  const target = hhmm(intent.localTime);
  return slots.find((s) => s.id !== exceptId && s.weekday === intent.weekday && hhmm(s.localTime) === target) ?? null;
}

/**
 * Drop every optimistic override and addition whose sequence number the server has confirmed.
 *
 * Extracted from the clearing effect because this rule is what three separate review findings turned
 * on, and an effect is not testable here — the repository has no DOM harness. `doneSeqs` is read, never
 * mutated, so a caller may hand over a snapshot and clear its own set afterwards.
 */
export function clearResolved(
  overrides: ReadonlyMap<string, Override>,
  additions: readonly Addition[],
  doneSeqs: ReadonlySet<number>,
): { overrides: Map<string, Override>; additions: Addition[] } {
  const nextOverrides = new Map<string, Override>();
  for (const [id, override] of overrides) if (!doneSeqs.has(override.seq)) nextOverrides.set(id, override);
  return { overrides: nextOverrides, additions: additions.filter((a) => !doneSeqs.has(a.seq)) };
}

/** Pure function of (slots, overrides, additions), with no clock and no randomness. */
export function applyOverrides(
  slots: readonly GridSlot[],
  overrides: ReadonlyMap<string, Override>,
  additions: readonly Addition[],
): GridSlotState[] {
  const result: GridSlotState[] = [];
  for (const slot of slots) {
    const override = overrides.get(slot.id);
    if (!override) {
      result.push({ ...slot, localTime: hhmm(slot.localTime), pending: false });
      continue;
    }
    if (override.kind === "deleted") continue;
    result.push({
      id: slot.id,
      weekday: override.weekday,
      localTime: hhmm(override.localTime),
      paused: override.paused,
      pending: true,
    });
  }
  for (const addition of additions) {
    result.push({
      id: addition.tempId,
      weekday: addition.weekday,
      localTime: hhmm(addition.localTime),
      paused: false,
      pending: true,
    });
  }
  return result;
}

/**
 * Where focus goes once an add resolves: the created slot's chip, or the column's add button when the
 * caller reported no id. The id has to come from the add callback — a server action's promise resolves
 * before Next.js applies the refreshed tree, so looking the new slot up in `slots` at that moment
 * always misses.
 */
export function additionFocusId(createdId: string | undefined, addButtonId: string): string {
  return createdId ? `slot-${createdId}` : addButtonId;
}

function describe(weekday: Weekday, localTime: string): string {
  return `${WEEKDAY_NAMES[weekday - 1]} ${hhmm(localTime)}`;
}

export const announceAdded = (weekday: Weekday, localTime: string): string => `Added a slot on ${describe(weekday, localTime)}`;

export const announceMoved = (weekday: Weekday, localTime: string): string => `Moved to ${describe(weekday, localTime)}`;

export const announceRetimed = (weekday: Weekday, localTime: string): string => `Retimed to ${describe(weekday, localTime)}`;

export const announceDeleted = (weekday: Weekday, localTime: string): string => `Deleted the slot on ${describe(weekday, localTime)}`;

export const announcePaused = (weekday: Weekday, localTime: string): string => `Paused ${describe(weekday, localTime)}`;

export const announceResumed = (weekday: Weekday, localTime: string): string => `Resumed ${describe(weekday, localTime)}`;

export const announceRefused = (weekday: Weekday, localTime: string, reason: string): string =>
  `${reason} ${describe(weekday, localTime)} unchanged.`;
