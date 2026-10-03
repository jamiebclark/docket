import { getEnv } from "../env";
import { ForbiddenError } from "../dal/errors";
import * as clock from "../dal/clock";
import { readHeartbeats } from "../dal/heartbeats";
import type { ProjectScope } from "../dal/scope";

export type SchedulerHealth = {
  lastSuccessAt: string | null;
  state: "ok" | "stale" | "never";
};

/** Publishing-section heartbeat vs the stale threshold. The threshold itself is never returned (FR-047). */
export async function getSchedulerHealth(scope: ProjectScope): Promise<SchedulerHealth> {
  if (!scope.can({ project: ["view"] })) throw new ForbiddenError();
  const beat = (await readHeartbeats()).find((h) => h.section === "publishing");
  if (!beat) return { lastSuccessAt: null, state: "never" };
  const ageMs = (await clock.now()).getTime() - beat.lastSuccessAt.getTime();
  const stale = ageMs > getEnv().SCHEDULER_STALE_AFTER_MINUTES * 60_000;
  return { lastSuccessAt: beat.lastSuccessAt.toISOString(), state: stale ? "stale" : "ok" };
}
