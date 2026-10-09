import { z } from "zod";
import { addSlotSchema } from "@/lib/validation/scheduling";
import { ForbiddenError, NotFoundError } from "../dal/errors";
import { listAccounts } from "./accounts";
import type { SlotRow } from "../dal/slots";
import type { ProjectScope } from "../dal/scope";

const idSchema = z.uuid();

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
