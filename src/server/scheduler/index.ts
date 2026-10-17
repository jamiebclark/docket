import { randomUUID } from "node:crypto";
import * as clock from "../dal/clock";
import { getEnv } from "../env";
import { schedulerConfig, type SchedulerConfig } from "./config";
import { runTokenRefresh } from "./token-refresh";
import { emptyGenerationCounts, runGenerationJobs, type GenerationCounts } from "./generation";
import { emptyHousekeepingCounts, runHousekeeping, type HousekeepingCounts } from "./housekeeping";
import { emptyWebhookCounts, runWebhookDeliveries, type WebhookCounts } from "./webhooks";
import { emptyPublishingCounts, runPublishing, type PublishingCounts } from "./publishing";
import { emptyEmailCounts, runEmailDeliveries, type EmailCounts } from "./email";
import { emptyStandingSeriesCounts, runStandingSeries, type StandingSeriesCounts } from "./standing-series";
import { emptyEngagementReadCounts, runEngagementRead, type EngagementReadCounts } from "./engagement-read";
import { emptyEngagementSendCounts, runEngagementSend, type EngagementSendCounts } from "./engagement-send";

export type { SchedulerConfig } from "./config";

export type SectionResult<C> = { ok: true; counts: C } | { ok: false; counts: C; error: "section_failed" };

export interface TickSummary {
  tickId: string;
  startedAt: string;
  durationMs: number;
  publishing: SectionResult<PublishingCounts>;
  tokenRefresh: SectionResult<{ refreshed: number; failed: number; deferred: number }>;
  generation: SectionResult<GenerationCounts>;
  housekeeping: SectionResult<HousekeepingCounts>;
  webhooks: SectionResult<WebhookCounts>;
  email: SectionResult<EmailCounts>;
  standingSeries: SectionResult<StandingSeriesCounts>;
  engagementRead: SectionResult<EngagementReadCounts>;
  engagementSend: SectionResult<EngagementSendCounts>;
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
  // Engagement-send waits on publishing to resolve first, so a reply never competes with a
  // scheduled post for the same tick's write allowance (FR-042, plan.md "Where the work runs").
  const publishingPromise = section("publishing", () => runPublishing({ config, tickId, startedAt }), emptyPublishingCounts());
  const [publishing, tokenRefresh, generation, housekeeping, webhooks, email, standingSeries, engagementRead, engagementSend] = await Promise.all([
    publishingPromise,
    section("token refresh", () => runTokenRefresh({ config, tickId, startedAt }), { refreshed: 0, failed: 0, deferred: 0, outOfBudget: 0 }),
    section("generation jobs", () => runGenerationJobs({ config, tickId, startedAt }), emptyGenerationCounts()),
    section("housekeeping", () => runHousekeeping(config), emptyHousekeepingCounts()),
    section("webhooks", () => runWebhookDeliveries({ config, tickId, startedAt }), emptyWebhookCounts()),
    section("email", () => runEmailDeliveries({ config, tickId, startedAt }), emptyEmailCounts()),
    section("standing series", () => runStandingSeries({ config, tickId, startedAt }), emptyStandingSeriesCounts()),
    section("engagement read", () => runEngagementRead({ config, tickId, startedAt }), emptyEngagementReadCounts()),
    publishingPromise.then(() => section("engagement send", () => runEngagementSend({ config, tickId, startedAt }), emptyEngagementSendCounts())),
  ]);

  return {
    tickId,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - t0,
    publishing,
    tokenRefresh,
    generation,
    housekeeping,
    webhooks,
    email,
    standingSeries,
    engagementRead,
    engagementSend,
  };
}
