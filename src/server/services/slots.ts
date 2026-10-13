import { z } from "zod";
import { addSlotSchema, addWeekSlotsSchema, moveSlotSchema } from "@/lib/validation/scheduling";
import { ForbiddenError, NotFoundError } from "../dal/errors";
import { listAccounts } from "./accounts";
import type { SlotRow } from "../dal/slots";
import type { ProjectScope } from "../dal/scope";

const idSchema = z.uuid();

/** ISO weekdays, Monday first — the order the grid shows them in. */
const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export type SlotView = Pick<SlotRow, "id" | "socialAccountId" | "weekday" | "localTime" | "paused">;

export async function listSlots(scope: ProjectScope, accountId: string): Promise<SlotView[]> {
  const id = idSchema.parse(accountId);
  if (!scope.can({ slot: ["view"] })) throw new ForbiddenError();
  if (!(await scope.accounts.get(id))) throw new NotFoundError();
  return scope.slots.listForAccount(id);
}

export async function addSlot(scope: ProjectScope, input: unknown): Promise<SlotView> {
  const { accountId, weekday, localTime } = addSlotSchema.parse(input);
  if (!scope.can({ slot: ["manage"] })) throw new ForbiddenError();
  return scope.transaction(async (tx) => {
    if (!tx.can({ slot: ["manage"] })) throw new ForbiddenError();
    if (!(await tx.accounts.get(accountId))) throw new NotFoundError();
    return tx.slots.insert(accountId, weekday, localTime);
  });
}

export interface WeekSlotsResult {
  /** The slots created, ascending by weekday. Empty when every day already had the time. */
  added: SlotView[];
  /** The weekdays that already had it, ascending. Not a failure: the result is the same either way. */
  alreadySet: number[];
}

/**
 * Puts one time on every weekday the account does not already have it on, so booking a time for the
 * whole week is one action rather than seven. Days that already have it are reported, not refused —
 * the point is the end state, and a partly-booked time is the common case.
 */
export async function addSlotsForWeek(scope: ProjectScope, input: unknown): Promise<WeekSlotsResult> {
  const { accountId, localTime } = addWeekSlotsSchema.parse(input);
  if (!scope.can({ slot: ["manage"] })) throw new ForbiddenError();
  return scope.transaction(async (tx) => {
    if (!tx.can({ slot: ["manage"] })) throw new ForbiddenError();
    if (!(await tx.accounts.get(accountId))) throw new NotFoundError();
    // `local_time` is a `time` column, so a row reads back as "09:30:00" against a "09:30" request.
    const existing = await tx.slots.listForAccount(accountId);
    const taken = new Set(existing.filter((s) => s.localTime.slice(0, 5) === localTime).map((s) => s.weekday));
    const added = await tx.slots.insertWeek(
      accountId,
      ALL_WEEKDAYS.filter((d) => !taken.has(d)),
      localTime,
    );
    const created = new Set(added.map((s) => s.weekday));
    return {
      added: [...added].sort((a, b) => a.weekday - b.weekday),
      // Read from the weekdays that have no new row rather than from `taken`: a day lost to a
      // concurrent insert was not in `taken` but is set all the same.
      alreadySet: ALL_WEEKDAYS.filter((d) => !created.has(d)),
    };
  });
}

/** Changes a slot's weekday and time in place. Targets keep their times: nothing reads `slot_id` here. */
export async function moveSlot(scope: ProjectScope, input: unknown): Promise<SlotView> {
  const { id, weekday, localTime } = moveSlotSchema.parse(input);
  if (!scope.can({ slot: ["manage"] })) throw new ForbiddenError();
  return scope.transaction(async (tx) => {
    if (!tx.can({ slot: ["manage"] })) throw new ForbiddenError();
    if (!(await tx.slots.get(id))) throw new NotFoundError();
    return tx.slots.move(id, weekday, localTime);
  });
}

export async function setSlotPaused(scope: ProjectScope, slotId: string, paused: boolean): Promise<void> {
  const id = idSchema.parse(slotId);
  if (!scope.can({ slot: ["manage"] })) throw new ForbiddenError();
  await scope.transaction(async (tx) => {
    if (!tx.can({ slot: ["manage"] })) throw new ForbiddenError();
    if (!(await tx.slots.get(id))) throw new NotFoundError();
    await tx.slots.setPaused(id, paused);
  });
}

/** Targets keep their times: `slot_id` goes NULL by the foreign key. */
export async function deleteSlot(scope: ProjectScope, slotId: string): Promise<void> {
  const id = idSchema.parse(slotId);
  if (!scope.can({ slot: ["manage"] })) throw new ForbiddenError();
  await scope.transaction(async (tx) => {
    if (!tx.can({ slot: ["manage"] })) throw new ForbiddenError();
    if (!(await tx.slots.get(id))) throw new NotFoundError();
    await tx.slots.delete(id);
  });
}

export type AccountSlotCount = { accountId: string; providerAvailable: boolean; active: number; paused: number };

/** Slot counts per account, in `listAccounts` order: one `listSlots` per account. */
export async function listSlotCounts(scope: ProjectScope): Promise<AccountSlotCount[]> {
  const accounts = await listAccounts(scope);
  return Promise.all(
    accounts.map(async (a) => {
      const slots = await listSlots(scope, a.id);
      const paused = slots.filter((s) => s.paused).length;
      return { accountId: a.id, providerAvailable: a.providerAvailable, active: slots.length - paused, paused };
    }),
  );
}
