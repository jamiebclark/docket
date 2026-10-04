import { randomUUID } from "node:crypto";
import * as clock from "../dal/clock";
import { getEnv } from "../env";
import { schedulerConfig, type SchedulerConfig } from "./config";
import { runTokenRefresh } from "./token-refresh";
import { emptyPublishingCounts, runPublishing, type PublishingCounts } from "./publishing";

export type { SchedulerConfig } from "./config";

export type SectionResult<C> = { ok: true; counts: C } | { ok: false; counts: C; error: "section_failed" };

export interface TickSummary {
  tickId: string;
  startedAt: string;
  durationMs: number;
  publishing: SectionResult<PublishingCounts>;
  tokenRefresh: SectionResult<{ refreshed: number; failed: number; deferred: number }>;
}

/**
 * One scheduler tick. Safe to run concurrently in any number of processes (claims skip locked rows).
 * It throws only when the clock query fails, which means the database is down. The summary is counts only.
 */
export async function runTick(options: { config?: Partial<SchedulerConfig> } = {}): Promise<TickSummary> {
  const config = schedulerConfig(getEnv(), options.config);
  const startedAt = await clock.now();
  const t0 = Date.now();
  const tickId = randomUUID();

  const section = async <C>(name: string, run: () => Promise<C>, empty: C): Promise<SectionResult<C>> => {
    try {
      return { ok: true, counts: await run() };
    } catch (error) {
      console.error(`Docket scheduler: ${name} section failed:`, error instanceof Error ? error.message : "unknown error");
      return { ok: false, counts: empty, error: "section_failed" };
    }
  };
  // The sections run concurrently under the same deadline (D7); each handles its own failure.
  const [publishing, tokenRefresh] = await Promise.all([
    section("publishing", () => runPublishing({ config, tickId, startedAt }), emptyPublishingCounts()),
    section("token refresh", () => runTokenRefresh({ config, tickId, startedAt }), { refreshed: 0, failed: 0, deferred: 0 }),
  ]);

  return { tickId, startedAt: startedAt.toISOString(), durationMs: Date.now() - t0, publishing, tokenRefresh };
}
