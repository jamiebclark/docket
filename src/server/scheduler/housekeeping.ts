// scheduler/housekeeping: bounded deletes of expired rows at the end of a tick (research D16).
import { purgeExpiredIdempotencyKeys } from "../dal/idempotency";
import { crossProject } from "../dal/scope";

export const HOUSEKEEPING_BATCH = 500;

export interface HousekeepingCounts {
  idempotencyPurged: number;
}

export function emptyHousekeepingCounts(): HousekeepingCounts {
  return { idempotencyPurged: 0 };
}

/** Deletes at most one batch per table, so a tick never stalls on a large backlog. */
export async function runHousekeeping(): Promise<HousekeepingCounts> {
  const idempotencyPurged = await crossProject("housekeeping: purge expired idempotency keys", () =>
    purgeExpiredIdempotencyKeys(HOUSEKEEPING_BATCH),
  );
  return { idempotencyPurged };
}
