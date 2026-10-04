// scheduler/webhooks: the outgoing-webhook delivery section of a tick (contracts/webhooks.md "Delivery section").
import * as clock from "../dal/clock";
import { writeHeartbeat } from "../dal/heartbeats";
import {
  claimDeliveries,
  purgeWebhookHistory,
  readEndpointForDelivery,
  readEventForDelivery,
  recordAttempt,
  recoverDeliveries,
  webhookDb,
  releaseDelivery,
  type ClaimedDelivery,
} from "../dal/webhooks";
import { sendDelivery } from "../services/webhooks/deliver";
import { webhookConfig, type SchedulerConfig } from "./config";

export interface WebhookCounts {
  sent: number;
  succeeded: number;
  failed: number;
  retried: number;
  skipped: number;
  purged: number;
}

export const emptyWebhookCounts = (): WebhookCounts => ({ sent: 0, succeeded: 0, failed: 0, retried: 0, skipped: 0, purged: 0 });

export async function runWebhookDeliveries(opts: {
  config: SchedulerConfig;
  tickId: string;
  startedAt: Date;
}): Promise<WebhookCounts> {
  const cfg = webhookConfig(opts.config);
  const db = webhookDb();
  const counts = emptyWebhookCounts();
  const deadline = opts.startedAt.getTime() + cfg.timeBudgetMs;

  await recoverDeliveries(db);
  const claimed = await claimDeliveries(db, { limit: cfg.maxPerTick, leaseSeconds: Math.ceil(cfg.leaseMs / 1000) });

  const one = async (claim: ClaimedDelivery) => {
    const { delivery, token } = claim;
    const at = await clock.now();
    if (deadline - at.getTime() < cfg.minWindowMs) {
      await releaseDelivery(db, delivery.id, token);
      counts.skipped++;
      return;
    }
    const [endpoint, event] = await Promise.all([
      readEndpointForDelivery(db, delivery.projectId, delivery.endpointId),
      readEventForDelivery(db, delivery.projectId, delivery.eventId),
    ]);
    const outcome =
      endpoint && event
        ? await sendDelivery({ endpoint, event, delivery, now: at, timeoutMs: cfg.timeoutMs })
        : { statusCode: null, errorKind: "internal" as const, durationMs: 0, responseExcerpt: "Endpoint or event no longer exists", ok: false, gone: false };
    counts.sent++;
    const result = await recordAttempt(db, claim, outcome, {
      maxAttempts: cfg.maxAttempts,
      backoffBaseMs: cfg.backoffBaseMs,
      backoffMaxMs: cfg.backoffMaxMs,
      disableAfterFailures: cfg.disableAfterFailures,
    });
    if (result === "succeeded") counts.succeeded++;
    else if (result === "retry") counts.retried++;
    else if (result === "failed") counts.failed++;
  };

  const queue = [...claimed];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      try {
        await one(c);
      } catch (error) {
        console.error("Docket scheduler: webhook delivery errored:", error instanceof Error ? error.message : "unknown error");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(cfg.concurrency, queue.length) }, worker));

  counts.purged = await purgeWebhookHistory(db, cfg.retentionDays);
  await writeHeartbeat("webhooks", await clock.now(), { ...counts });
  return counts;
}
